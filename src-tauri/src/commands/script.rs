use super::worker::{
    call_worker, downloads_dir, emit_done, kill_process_by_pid, redact_secrets,
    resolve_sidecar_path, scripts_dir, stop_worker, worker_sidecar_name, worker_state, WORKER_PID,
};
use crate::models::ScriptOutputLine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::atomic::Ordering, time::Instant};
use tauri::{AppHandle, Emitter, Manager};

// ─── Public commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn stop_current_operation(app: AppHandle, run_id: Option<String>) -> Result<(), String> {
    let pid = WORKER_PID.load(Ordering::Acquire);
    let _ = kill_process_by_pid(pid);

    if let Some(run_id) = run_id {
        emit_done(&app, &run_id, 130, 0);
    }

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
            Err(_) => return false, // fail-safe: assume installed
        };
        let exe_lower = exe.to_string_lossy().to_lowercase();
        // ProgramFiles, ProgramFiles(x86), and LOCALAPPDATA are locale-independent
        // Windows env vars — they always contain the real directory path.
        // NSIS installs machine-wide to ProgramFiles and per-user to LOCALAPPDATA\Programs.
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
    // Resource dir takes precedence (dev + installed builds).
    if scripts_dir(&app)
        .map(|scripts| scripts.join(worker_sidecar_name()).exists())
        .unwrap_or(false)
    {
        return true;
    }
    // Windows portable: the sidecar is always embedded in the binary.
    cfg!(target_os = "windows")
}

#[tauri::command]
pub async fn ensure_scripts_ready(app: AppHandle) -> Result<(), String> {
    // Validates the sidecar is reachable (extracts embedded bytes if needed on Windows portable).
    resolve_sidecar_path(&app)?;
    let _ = call_worker(&app, "health", json!({})).await?;
    Ok(())
}

// ─── Operation args structs ───────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct EmptyMessagesArgs {
    #[serde(rename = "queueName")]
    pub queue_name: String,
    pub mode: String,
    pub env: HashMap<String, String>,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[derive(serde::Deserialize)]
pub struct MoveMessagesArgs {
    #[serde(rename = "sourceQueue")]
    pub source_queue: String,
    #[serde(rename = "destQueue")]
    pub dest_queue: String,
    pub mode: String,
    pub env: HashMap<String, String>,
    #[serde(rename = "runId")]
    pub run_id: String,
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
    pub env: HashMap<String, String>,
    #[serde(rename = "runId")]
    pub run_id: String,
}

// ─── Streaming operation commands ────────────────────────────────────────────

async fn run_worker_operation(
    app: &AppHandle,
    method: &str,
    params: Value,
    run_id: &str,
) -> Result<(), String> {
    let started = Instant::now();
    match call_worker(app, method, params).await {
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

#[tauri::command]
pub async fn empty_messages(app: AppHandle, args: EmptyMessagesArgs) -> Result<(), String> {
    run_worker_operation(
        &app,
        "emptyMessages",
        json!({
            "queueName": args.queue_name,
            "mode": args.mode,
            "env": args.env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[tauri::command]
pub async fn move_messages(app: AppHandle, args: MoveMessagesArgs) -> Result<(), String> {
    run_worker_operation(
        &app,
        "moveMessages",
        json!({
            "sourceQueue": args.source_queue,
            "destQueue": args.dest_queue,
            "mode": args.mode,
            "env": args.env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[tauri::command]
pub async fn search_messages(app: AppHandle, args: SearchMessagesArgs) -> Result<(), String> {
    run_worker_operation(
        &app,
        "searchMessages",
        json!({
            "queueName": args.queue_name,
            "searchString": args.search_string,
            "mode": args.mode,
            "maxMatches": args.max_matches,
            "env": args.env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Serialize)]
pub struct PeekResult {
    pub messages: serde_json::Value,
    pub filename: String,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
}

#[derive(Deserialize)]
struct WorkerPeekResult {
    messages: serde_json::Value,
    filename: String,
    #[serde(rename = "savedAt")]
    saved_at: String,
}

#[derive(serde::Deserialize)]
pub struct PeekArgs {
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "connectionId", default)]
    pub connection_id: Option<String>,
}

#[tauri::command]
pub async fn peek_messages(app: AppHandle, args: PeekArgs) -> Result<PeekResult, String> {
    let started = Instant::now();
    let run_id = args.run_id.clone();
    let mut dl_dir = downloads_dir(&app)?;
    if let Some(ref conn_id) = args.connection_id {
        let safe_id = std::path::Path::new(conn_id.as_str())
            .file_name()
            .ok_or_else(|| "Invalid connection ID".to_string())?;
        dl_dir = dl_dir.join(safe_id);
    }
    std::fs::create_dir_all(&dl_dir).map_err(|e| format!("Cannot create downloads dir: {e}"))?;

    let worker_result = call_worker(
        &app,
        "peekMessages",
        json!({
          "argv": args.argv,
          "env": args.env,
          "runId": run_id,
          "downloadsDir": dl_dir.to_string_lossy().to_string(),
        }),
    )
    .await;

    match worker_result {
        Ok(value) => {
            let parsed: WorkerPeekResult = serde_json::from_value(value)
                .map_err(|e| format!("Invalid peek result from worker: {e}"))?;
            emit_done(&app, &run_id, 0, started.elapsed().as_millis() as u64);
            Ok(PeekResult {
                messages: parsed.messages,
                filename: parsed.filename,
                saved_at: parsed.saved_at,
            })
        }
        Err(err) => {
            emit_done(&app, &run_id, -1, started.elapsed().as_millis() as u64);
            Err(err)
        }
    }
}

#[derive(serde::Serialize)]
pub struct DownloadedFile {
    pub filename: String,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[tauri::command]
pub fn get_downloaded_files(
    app: AppHandle,
    connection_id: Option<String>,
) -> Result<Vec<DownloadedFile>, String> {
    let mut dl_dir = downloads_dir(&app)?;
    if let Some(ref conn_id) = connection_id {
        let safe_id = std::path::Path::new(conn_id.as_str())
            .file_name()
            .ok_or_else(|| "Invalid connection ID".to_string())?;
        dl_dir = dl_dir.join(safe_id);
    }
    if !dl_dir.exists() {
        return Ok(vec![]);
    }

    let mut files: Vec<DownloadedFile> = std::fs::read_dir(&dl_dir)
        .map_err(|e| format!("Cannot read downloads dir: {e}"))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .map(|entry| {
            let meta = entry.metadata().ok();
            DownloadedFile {
                filename: entry.file_name().to_string_lossy().to_string(),
                saved_at: meta
                    .as_ref()
                    .and_then(|metadata| metadata.modified().ok())
                    .map(|modified| {
                        let dt: chrono::DateTime<chrono::Local> = modified.into();
                        dt.to_rfc3339()
                    })
                    .unwrap_or_default(),
                size_bytes: meta.map(|metadata| metadata.len()).unwrap_or(0),
            }
        })
        .collect();

    files.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(files)
}

#[tauri::command]
pub fn load_downloaded_file(
    app: AppHandle,
    filename: String,
    connection_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut dl_dir = downloads_dir(&app)?;
    if let Some(ref conn_id) = connection_id {
        let safe_id = std::path::Path::new(conn_id.as_str())
            .file_name()
            .ok_or_else(|| "Invalid connection ID".to_string())?;
        dl_dir = dl_dir.join(safe_id);
    }
    // Extract only the final filename component to block path traversal (e.g. "../secrets.json").
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .ok_or_else(|| "Invalid filename".to_string())?;

    let path = dl_dir.join(safe_name);
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON: {e}"))
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ListEntitiesResult {
    pub queues: Vec<String>,
    pub topics: HashMap<String, Vec<String>>,
}

/// List queues/topics/subscriptions through the long-lived Service Bus worker.
#[tauri::command]
pub async fn list_entities(
    app: AppHandle,
    env: HashMap<String, String>,
) -> Result<ListEntitiesResult, String> {
    let value = call_worker(&app, "listEntities", json!({ "env": env })).await?;
    serde_json::from_value(value).map_err(|e| format!("Failed to parse entity list: {e}"))
}

/// Write text content to a file path chosen via the frontend save dialog.
/// The path must have a `.json` extension to limit the scope of writes.
#[tauri::command]
pub async fn write_json_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);

    // Only allow .json files — this command is exclusively for exporting peek results.
    if target.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("Only .json files are allowed".to_string());
    }

    // Block writes outside the user's home directory tree as a safety net.
    // The frontend enforces the native save dialog, but we validate server-side too.
    if let Ok(home) = app.path().home_dir() {
        let canonical_home = home.canonicalize().unwrap_or(home);
        let canonical_target = target
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| target.to_path_buf());
        if !canonical_target.starts_with(&canonical_home) {
            return Err("Write path must be within the user's home directory".to_string());
        }
    }

    tokio::fs::write(&path, content).await.map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct SendMessageArgs {
    #[serde(rename = "entityName")]
    pub entity_name: String,
    pub env: HashMap<String, String>,
    pub message: serde_json::Value,
}

#[tauri::command]
pub async fn send_message(app: AppHandle, args: SendMessageArgs) -> Result<(), String> {
    call_worker(
        &app,
        "sendMessage",
        json!({
            "entityName": args.entity_name,
            "env": args.env,
            "message": args.message,
        }),
    )
    .await
    .map(|_| ())
}
