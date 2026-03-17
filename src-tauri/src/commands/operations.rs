use super::worker::{
    call_worker, downloads_dir, emit_done, kill_process_by_pid, redact_secrets,
    resolve_sidecar_path, scripts_dir, stop_worker, worker_sidecar_name, worker_state, WORKER_PID,
};
use crate::models::ScriptOutputLine;
use crate::store;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::atomic::Ordering, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

// ─── Worker lifecycle commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn stop_current_operation(app: AppHandle, run_id: Option<String>) -> Result<(), String> {
    let pid = WORKER_PID.load(Ordering::Acquire);
    let _ = kill_process_by_pid(pid);

    if let Some(run_id) = run_id {
        emit_done(&app, &run_id, 130, 0);
    }

    // Use try_lock to avoid blocking if another command holds the mutex.
    // The kill_process_by_pid above already terminated the worker; this just cleans up state.
    if let Ok(mut state) = worker_state().try_lock() {
        stop_worker(&mut state).await;
    }

    Ok(())
}

#[tauri::command]
pub fn is_portable() -> bool {
    #[cfg(target_os = "windows")]
    {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return false,
        };
        let exe_lower = exe.to_string_lossy().to_lowercase();
        let install_roots = [
            std::env::var("ProgramFiles").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];
        let is_installed = install_roots
            .iter()
            .flatten()
            .any(|root| exe_lower.starts_with(&root.to_lowercase()));
        !is_installed
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn check_worker(app: AppHandle) -> bool {
    if scripts_dir(&app)
        .map(|scripts| scripts.join(worker_sidecar_name()).exists())
        .unwrap_or(false)
    {
        return true;
    }
    cfg!(target_os = "windows")
}

#[tauri::command]
pub async fn ensure_scripts_ready(app: AppHandle) -> Result<(), String> {
    resolve_sidecar_path(&app)?;
    let _ = call_worker(&app, "health", json!({}), Some(Duration::from_secs(30))).await?;
    Ok(())
}

// ─── Streaming operation helpers ────────────────────────────────────────────

async fn run_worker_operation(
    app: &AppHandle,
    method: &str,
    params: Value,
    run_id: &str,
) -> Result<(), String> {
    let started = Instant::now();
    match call_worker(app, method, params, None).await {
        Ok(_) => {
            emit_done(app, run_id, 0, started.elapsed().as_millis() as u64);
            Ok(())
        }
        Err(err) => {
            let _ = app.emit(
                &format!("script-output:{run_id}"),
                ScriptOutputLine {
                    line: redact_secrets(&format!("Error: {err}")),
                    is_stderr: true,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            );
            emit_done(app, run_id, -1, started.elapsed().as_millis() as u64);
            Ok(())
        }
    }
}

// ─── Streaming operation commands ───────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct EmptyMessagesArgs {
    #[serde(rename = "queueName")]
    pub queue_name: String,
    pub mode: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn empty_messages(app: AppHandle, args: EmptyMessagesArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "emptyMessages",
        json!({
            "queueName": args.queue_name,
            "mode": args.mode,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct MoveMessagesArgs {
    #[serde(rename = "sourceQueue")]
    pub source_queue: String,
    #[serde(rename = "destQueue")]
    pub dest_queue: String,
    pub mode: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn move_messages(app: AppHandle, args: MoveMessagesArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "moveMessages",
        json!({
            "sourceQueue": args.source_queue,
            "destQueue": args.dest_queue,
            "mode": args.mode,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct SearchMessagesArgs {
    #[serde(rename = "queueName")]
    pub queue_name: String,
    #[serde(rename = "searchString")]
    pub search_string: String,
    pub mode: String,
    #[serde(rename = "maxMatches")]
    pub max_matches: u32,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn search_messages(app: AppHandle, args: SearchMessagesArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "searchMessages",
        json!({
            "queueName": args.queue_name,
            "searchString": args.search_string,
            "mode": args.mode,
            "maxMatches": args.max_matches,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

// ─── Peek messages ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, Deserialize)]
pub struct PeekResult {
    pub messages: serde_json::Value,
    pub filename: String,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
}

#[derive(serde::Deserialize)]
pub struct PeekArgs {
    pub argv: Vec<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn peek_messages(app: AppHandle, args: PeekArgs) -> Result<PeekResult, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    let started = Instant::now();
    let run_id = args.run_id.clone();
    let mut dl_dir = downloads_dir(&app)?;
    let safe_id = std::path::Path::new(args.connection_id.as_str())
        .file_name()
        .ok_or_else(|| "Invalid connection ID".to_string())?;
    dl_dir = dl_dir.join(safe_id);
    std::fs::create_dir_all(&dl_dir).map_err(|e| format!("Cannot create downloads dir: {e}"))?;

    let worker_result = call_worker(
        &app,
        "peekMessages",
        json!({
          "argv": args.argv,
          "env": env,
          "runId": run_id,
          "downloadsDir": dl_dir.to_string_lossy().to_string(),
        }),
        None,
    )
    .await;

    match worker_result {
        Ok(value) => {
            let result: PeekResult = serde_json::from_value(value)
                .map_err(|e| format!("Invalid peek result from worker: {e}"))?;
            emit_done(&app, &run_id, 0, started.elapsed().as_millis() as u64);
            Ok(result)
        }
        Err(err) => {
            emit_done(&app, &run_id, -1, started.elapsed().as_millis() as u64);
            Err(redact_secrets(&err))
        }
    }
}

// ─── Send message ───────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SendMessageArgs {
    #[serde(rename = "entityName")]
    pub entity_name: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub message: serde_json::Value,
}

#[tauri::command]
pub async fn send_message(app: AppHandle, args: SendMessageArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "sendMessage",
        json!({
            "entityName": args.entity_name,
            "env": env,
            "message": args.message,
        }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}
