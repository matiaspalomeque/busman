use crate::models::{ScriptDonePayload, ScriptOutputLine, ScriptProgress};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU32, Ordering},
        OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
use uuid::Uuid;

pub(crate) static WORKER_PID: AtomicU32 = AtomicU32::new(0);
static WORKER_STATE: OnceLock<Mutex<Option<WorkerProcess>>> = OnceLock::new();

pub(crate) struct WorkerProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
}

#[derive(Serialize)]
struct WorkerRequest<'a> {
    id: &'a str,
    method: &'a str,
    params: Value,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum WorkerMessage {
    #[serde(rename = "event")]
    Event {
        #[serde(rename = "runId")]
        run_id: Option<String>,
        kind: String,
        line: Option<String>,
        text: Option<String>,
        #[serde(rename = "match")]
        match_data: Option<Value>,
        #[serde(rename = "isStderr")]
        is_stderr: Option<bool>,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: Option<u64>,
    },
    #[serde(rename = "response")]
    Response {
        id: String,
        ok: bool,
        result: Option<Value>,
        error: Option<String>,
    },
}

pub(crate) enum WorkerCallError {
    Transport(String),
    Worker(String),
}

pub(crate) fn worker_state() -> &'static Mutex<Option<WorkerProcess>> {
    WORKER_STATE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn set_worker_pid(pid: Option<u32>) {
    WORKER_PID.store(pid.unwrap_or(0), Ordering::Release);
}

/// Redact secret values from Azure Service Bus connection strings before they are forwarded
/// to the frontend. Handles SharedAccessKey and SharedAccessSignature patterns.
pub(crate) fn redact_secrets(s: &str) -> String {
    const MARKERS: &[&str] = &["SharedAccessKey=", "SharedAccessSignature="];
    let mut out = s.to_owned();
    for marker in MARKERS {
        let marker_lower = marker.to_ascii_lowercase();
        // Recompute lowercase view on each outer iteration (string may have changed length).
        let lower = out.to_ascii_lowercase();
        if let Some(idx) = lower.find(&marker_lower) {
            let val_start = idx + marker.len();
            let val_end = out[val_start..]
                .find(';')
                .map(|p| val_start + p)
                .unwrap_or(out.len());
            out.replace_range(val_start..val_end, "[REDACTED]");
        }
    }
    out
}

/// On Windows portable builds the sidecar is embedded at compile time so the app ships
/// as a single .exe. The bytes are only included on Windows (compile-time gate).
#[cfg(target_os = "windows")]
static WORKER_SIDECAR_BYTES: &[u8] = include_bytes!("../../scripts/worker-sidecar.exe");

pub(crate) fn scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|p| p.join("scripts"))
        .map_err(|e| format!("Cannot resolve resource dir: {e}"))
}

pub(crate) fn worker_sidecar_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "worker-sidecar.exe"
    } else {
        "worker-sidecar"
    }
}

/// Path where the embedded sidecar is extracted on Windows portable runs.
#[cfg(target_os = "windows")]
fn embedded_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("bin").join("worker-sidecar.exe"))
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))
}

/// Extract the embedded sidecar to app data dir if it isn't already there.
/// Returns the path to the extracted binary.
#[cfg(target_os = "windows")]
fn ensure_sidecar_extracted(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = embedded_sidecar_path(app)?;
    if !dest.exists() {
        let parent = dest
            .parent()
            .ok_or_else(|| "Invalid sidecar destination path".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create sidecar bin dir: {e}"))?;
        std::fs::write(&dest, WORKER_SIDECAR_BYTES)
            .map_err(|e| format!("Cannot write embedded sidecar: {e}"))?;
    }
    Ok(dest)
}

/// Resolve the worker sidecar path:
///   1. Resource dir (covers dev and installed NSIS/MSI builds on all platforms)
///   2. Embedded extraction fallback (Windows portable single-exe distribution)
pub(crate) fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(scripts) = scripts_dir(app) {
        let candidate = scripts.join(worker_sidecar_name());
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    #[cfg(target_os = "windows")]
    {
        return ensure_sidecar_extracted(app);
    }

    #[cfg(not(target_os = "windows"))]
    Err("Worker sidecar not found in resource dir. Run `bun run build-sidecar`.".to_string())
}

pub(crate) fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("downloads"))
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))
}

async fn spawn_worker(app: &AppHandle) -> Result<WorkerProcess, String> {
    let worker_sidecar = resolve_sidecar_path(app)?;
    let sidecar_dir = worker_sidecar
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| worker_sidecar.clone());

    let mut cmd = Command::new(&worker_sidecar);
    cmd.current_dir(&sidecar_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Service Bus worker: {e}"))?;
    set_worker_pid(child.id());

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Worker stdin pipe unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Worker stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Worker stderr pipe unavailable".to_string())?;

    // Log all worker stderr output so crashes and JS exceptions are visible in Tauri logs.
    tokio::spawn(log_worker_stderr(stderr));

    Ok(WorkerProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

async fn log_worker_stderr(stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    log::warn!("[worker stderr] {}", trimmed);
                }
                line.clear();
            }
            Err(e) => {
                log::warn!("[worker stderr] read error: {e}");
                break;
            }
        }
    }
}

pub(crate) async fn stop_worker(state: &mut Option<WorkerProcess>) {
    if let Some(worker) = state.as_mut() {
        let _ = worker.child.start_kill();
        let _ = worker.child.wait().await;
    }
    set_worker_pid(None);
    *state = None;
}

async fn ensure_worker_running(
    app: &AppHandle,
    state: &mut Option<WorkerProcess>,
) -> Result<(), String> {
    let worker_exited = if let Some(worker) = state.as_mut() {
        matches!(worker.child.try_wait(), Ok(Some(_)))
    } else {
        false
    };

    if worker_exited {
        set_worker_pid(None);
        *state = None;
    }

    if state.is_none() {
        *state = Some(spawn_worker(app).await?);
    }

    Ok(())
}

struct WorkerEventParams {
    run_id: String,
    kind: String,
    line: Option<String>,
    text: Option<String>,
    match_data: Option<Value>,
    is_stderr: Option<bool>,
    elapsed_ms: Option<u64>,
}

fn emit_worker_event(app: &AppHandle, params: &WorkerEventParams) {
    let elapsed = params.elapsed_ms.unwrap_or(0);
    let run_id = &params.run_id;
    match params.kind.as_str() {
        "output" => {
            let output = redact_secrets(
                &params
                    .line
                    .clone()
                    .or_else(|| params.text.clone())
                    .unwrap_or_else(|| "<empty worker output event>".to_string()),
            );
            let _ = app.emit(
                &format!("script-output:{run_id}"),
                ScriptOutputLine {
                    line: output,
                    is_stderr: params.is_stderr.unwrap_or(false),
                    elapsed_ms: elapsed,
                },
            );
        }
        "progress" => {
            let progress = redact_secrets(
                &params
                    .text
                    .clone()
                    .or_else(|| params.line.clone())
                    .unwrap_or_else(|| "<empty worker progress event>".to_string()),
            );
            let _ = app.emit(
                &format!("script-progress:{run_id}"),
                ScriptProgress {
                    text: progress,
                    elapsed_ms: elapsed,
                },
            );
        }
        "searchMatch" => {
            if let Some(ref data) = params.match_data {
                let _ = app.emit(&format!("search-match:{run_id}"), data);
            }
        }
        _ => {}
    }
}

async fn read_worker_response(
    app: &AppHandle,
    worker: &mut WorkerProcess,
    request_id: &str,
) -> Result<Value, WorkerCallError> {
    loop {
        let mut line = String::new();
        let read = worker
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|e| WorkerCallError::Transport(format!("Failed reading worker output: {e}")))?;

        if read == 0 {
            return Err(WorkerCallError::Transport(
                "Service Bus worker exited unexpectedly".to_string(),
            ));
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Guard against a runaway worker sending enormous payloads.
        const MAX_LINE_BYTES: usize = 100 * 1024 * 1024; // 100 MB
        if trimmed.len() > MAX_LINE_BYTES {
            return Err(WorkerCallError::Transport(
                "Worker response exceeded size limit (100 MB)".to_string(),
            ));
        }

        let parsed: WorkerMessage = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(e) => {
                // Non-protocol output (e.g. runtime warnings) — keep channel resilient.
                log::debug!("Worker non-protocol line skipped ({e}): {trimmed}");
                continue;
            }
        };

        match parsed {
            WorkerMessage::Event {
                run_id,
                kind,
                line,
                text,
                match_data,
                is_stderr,
                elapsed_ms,
            } => {
                if let Some(run_id) = run_id {
                    emit_worker_event(
                        app,
                        &WorkerEventParams {
                            run_id,
                            kind,
                            line,
                            text,
                            match_data,
                            is_stderr,
                            elapsed_ms,
                        },
                    );
                }
            }
            WorkerMessage::Response {
                id,
                ok,
                result,
                error,
            } => {
                if id != request_id {
                    continue;
                }

                if ok {
                    return Ok(result.unwrap_or(Value::Null));
                }

                return Err(WorkerCallError::Worker(
                    error.unwrap_or_else(|| "Unknown worker error".to_string()),
                ));
            }
        }
    }
}

pub(crate) async fn call_worker(
    app: &AppHandle,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let mut state = worker_state().lock().await;
    ensure_worker_running(app, &mut state).await?;
    let request_id = Uuid::new_v4().to_string();
    let request = WorkerRequest {
        id: &request_id,
        method,
        params,
    };
    let serialized = serde_json::to_string(&request)
        .map_err(|e| format!("Worker request serialize failed: {e}"))?;

    let worker = state
        .as_mut()
        .ok_or_else(|| "Worker unavailable".to_string())?;

    let write_result = async {
        worker
            .stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|e| format!("Failed writing to worker stdin: {e}"))?;
        worker
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed writing worker request newline: {e}"))?;
        worker
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Failed flushing worker stdin: {e}"))
    }
    .await;

    if let Err(err) = write_result {
        stop_worker(&mut state).await;
        return Err(err);
    }

    let read_future = read_worker_response(app, worker, &request_id);

    let result = if let Some(dur) = timeout {
        match tokio::time::timeout(dur, read_future).await {
            Ok(inner) => inner,
            Err(_) => {
                stop_worker(&mut state).await;
                return Err("Service Bus worker request timed out".to_string());
            }
        }
    } else {
        read_future.await
    };

    match result {
        Ok(value) => Ok(value),
        Err(WorkerCallError::Worker(message)) => Err(message),
        Err(WorkerCallError::Transport(message)) => {
            stop_worker(&mut state).await;
            Err(message)
        }
    }
}

pub(crate) fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Failed to stop worker process {pid}: {e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let term_status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| format!("Failed to stop worker process {pid}: {e}"))?;

        if !term_status.success() {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status()
                .map_err(|e| format!("Failed to force stop worker process {pid}: {e}"))?;
        }

        Ok(())
    }
}

pub(crate) fn emit_done(app: &AppHandle, run_id: &str, exit_code: i32, elapsed_ms: u64) {
    let _ = app.emit(
        &format!("script-done:{run_id}"),
        ScriptDonePayload {
            exit_code,
            elapsed_ms,
        },
    );
}
