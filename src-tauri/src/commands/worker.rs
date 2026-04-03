use crate::models::{ScriptDonePayload, ScriptOutputLine, ScriptProgress};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
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
    sync::{oneshot, Mutex},
    task::JoinHandle,
};
use uuid::Uuid;

pub(crate) static WORKER_PID: AtomicU32 = AtomicU32::new(0);
static WORKER_STATE: OnceLock<Mutex<Option<ActiveWorker>>> = OnceLock::new();

/// Pending response channels keyed by request ID.
/// Uses `std::sync::Mutex` (not tokio) since we only do quick insert/remove, never hold across await.
type PendingMap = std::sync::Arc<
    std::sync::Mutex<HashMap<String, oneshot::Sender<Result<Value, WorkerCallError>>>>,
>;

/// A running worker process with a background reader task.
pub(crate) struct ActiveWorker {
    child: Child,
    stdin: Mutex<ChildStdin>,
    pending: PendingMap,
    reader_handle: JoinHandle<()>,
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

impl From<WorkerCallError> for crate::error::BusmanError {
    fn from(err: WorkerCallError) -> Self {
        match err {
            WorkerCallError::Transport(msg) => Self::Internal(msg),
            WorkerCallError::Worker(msg) => Self::Worker(msg),
        }
    }
}

pub(crate) fn worker_state() -> &'static Mutex<Option<ActiveWorker>> {
    WORKER_STATE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn set_worker_pid(pid: Option<u32>) {
    WORKER_PID.store(pid.unwrap_or(0), Ordering::Release);
}

/// Redact secret values from Azure Service Bus connection strings before they are forwarded
/// to the frontend. Handles SharedAccessKey and SharedAccessSignature patterns.
pub(crate) fn redact_secrets(s: &str) -> String {
    const MARKERS: &[&str] = &["SharedAccessKey=", "SharedAccessSignature="];
    const REDACTED: &str = "[REDACTED]";
    let mut out = s.to_owned();
    for marker in MARKERS {
        let marker_lower = marker.to_ascii_lowercase();
        // Loop to redact ALL occurrences, advancing past each replacement to avoid
        // re-matching the marker prefix that remains in the output string.
        let mut search_from = 0;
        loop {
            let lower = out.to_ascii_lowercase();
            let Some(rel_idx) = lower[search_from..].find(&marker_lower) else {
                break;
            };
            let idx = search_from + rel_idx;
            let val_start = idx + marker.len();
            let val_end = out[val_start..]
                .find(';')
                .map(|p| val_start + p)
                .unwrap_or(out.len());
            out.replace_range(val_start..val_end, REDACTED);
            search_from = val_start + REDACTED.len();
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

#[cfg(target_os = "windows")]
fn embedded_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("bin").join("worker-sidecar.exe"))
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))
}

#[cfg(target_os = "windows")]
fn ensure_sidecar_extracted(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = embedded_sidecar_path(app)?;
    let expected_len = WORKER_SIDECAR_BYTES.len() as u64;

    // Check if existing extraction is valid (correct size).
    if dest.exists() {
        let actual_len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if actual_len == expected_len {
            return Ok(dest);
        }
        // Size mismatch — partial write or stale version. Re-extract.
        let _ = std::fs::remove_file(&dest);
    }

    let parent = dest
        .parent()
        .ok_or_else(|| "Invalid sidecar destination path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create sidecar bin dir: {e}"))?;

    // Write to a temp file then atomically rename to prevent partial binaries.
    let tmp = dest.with_extension("exe.tmp");
    std::fs::write(&tmp, WORKER_SIDECAR_BYTES)
        .map_err(|e| format!("Cannot write embedded sidecar: {e}"))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("Cannot finalize sidecar extraction: {e}"))?;

    Ok(dest)
}

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

// ─── Worker event emission ──────────────────────────────────────────────────

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

// ─── Worker lifecycle ───────────────────────────────────────────────────────

async fn spawn_worker(app: &AppHandle) -> Result<ActiveWorker, String> {
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

    tokio::spawn(log_worker_stderr(stderr));

    let pending: PendingMap = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    let reader_app = app.clone();
    let reader_handle = tokio::spawn(reader_loop(
        reader_app,
        BufReader::new(stdout),
        reader_pending,
    ));

    Ok(ActiveWorker {
        child,
        stdin: Mutex::new(stdin),
        pending,
        reader_handle,
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

/// Background task that reads worker stdout, routes responses by ID, and emits events.
async fn reader_loop(app: AppHandle, mut stdout: BufReader<ChildStdout>, pending: PendingMap) {
    let mut line = String::new();
    // Rate-limit progress events to avoid flooding the frontend with re-renders.
    // Progress events are display-only overwrites — skipping intermediate ones is safe.
    let mut last_progress_emit = std::time::Instant::now() - Duration::from_secs(1);
    const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(50);
    loop {
        line.clear();
        let read = match stdout.read_line(&mut line).await {
            Ok(n) => n,
            Err(e) => {
                log::warn!("Worker stdout read error: {e}");
                drain_pending(&pending, &format!("Worker read error: {e}"));
                break;
            }
        };

        if read == 0 {
            // Worker exited — error all pending requests.
            drain_pending(&pending, "Service Bus worker exited unexpectedly");
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Guard against a runaway worker sending enormous payloads.
        const MAX_LINE_BYTES: usize = 100 * 1024 * 1024; // 100 MB
        if trimmed.len() > MAX_LINE_BYTES {
            log::error!("Worker response exceeded size limit (100 MB), skipping");
            continue;
        }

        let parsed: WorkerMessage = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(e) => {
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
                    // Rate-limit progress events to reduce frontend re-render pressure.
                    if kind == "progress" {
                        let now = std::time::Instant::now();
                        if now.duration_since(last_progress_emit) < PROGRESS_MIN_INTERVAL {
                            continue;
                        }
                        last_progress_emit = now;
                    }
                    emit_worker_event(
                        &app,
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
                let sender = pending.lock().unwrap().remove(&id);
                if let Some(sender) = sender {
                    let response = if ok {
                        Ok(result.unwrap_or(Value::Null))
                    } else {
                        Err(WorkerCallError::Worker(
                            error.unwrap_or_else(|| "Unknown worker error".to_string()),
                        ))
                    };
                    let _ = sender.send(response);
                }
                // If no sender found, the caller timed out — silently discard.
            }
        }
    }
}

/// Error all pending requests (e.g. on worker crash/exit).
fn drain_pending(pending: &PendingMap, message: &str) {
    let mut map = pending.lock().unwrap();
    for (_, sender) in map.drain() {
        let _ = sender.send(Err(WorkerCallError::Transport(message.to_string())));
    }
}

pub(crate) async fn stop_worker(state: &mut Option<ActiveWorker>) {
    if let Some(worker) = state.as_mut() {
        let _ = worker.child.start_kill();
        let _ = worker.child.wait().await;
        // Reader task will see EOF and drain pending requests.
        worker.reader_handle.abort();
    }
    set_worker_pid(None);
    *state = None;
}

async fn ensure_worker_running(
    app: &AppHandle,
    state: &mut Option<ActiveWorker>,
) -> Result<(), String> {
    let worker_dead = match state.as_ref() {
        Some(worker) => worker.reader_handle.is_finished(),
        None => false,
    };

    if worker_dead {
        set_worker_pid(None);
        *state = None;
    }

    if state.is_none() {
        *state = Some(spawn_worker(app).await?);
    }

    Ok(())
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Send a JSON-RPC request to the worker and await the response.
///
/// The state mutex is held only during the write phase (ensure running + write + flush).
/// It is released BEFORE awaiting the response, so concurrent callers can pipeline writes.
/// The background reader task routes responses to the correct caller via the pending map.
pub(crate) async fn call_worker(
    app: &AppHandle,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let request_id = Uuid::new_v4().to_string();
    let request = WorkerRequest {
        id: &request_id,
        method,
        params,
    };
    let serialized = serde_json::to_string(&request)
        .map_err(|e| format!("Worker request serialize failed: {e}"))?;

    // Phase 1: Acquire state lock → ensure running → register pending → write → release lock.
    let rx = {
        let mut state = worker_state().lock().await;
        ensure_worker_running(app, &mut state).await?;

        let worker = state
            .as_ref()
            .ok_or_else(|| "Worker unavailable".to_string())?;

        // Register response channel BEFORE writing to avoid a race with the reader.
        let (tx, rx) = oneshot::channel();
        worker
            .pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);

        // Write request — holds stdin lock briefly.
        let write_result = {
            let mut stdin = worker.stdin.lock().await;
            let r = async {
                stdin
                    .write_all(serialized.as_bytes())
                    .await
                    .map_err(|e| format!("Failed writing to worker stdin: {e}"))?;
                stdin
                    .write_all(b"\n")
                    .await
                    .map_err(|e| format!("Failed writing worker request newline: {e}"))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Failed flushing worker stdin: {e}"))
            }
            .await;
            r
        };

        if let Err(err) = write_result {
            worker.pending.lock().unwrap().remove(&request_id);
            stop_worker(&mut state).await;
            return Err(err);
        }

        rx
        // state lock is dropped here — other callers can now enter Phase 1
    };

    // Phase 2: Await response with no locks held.
    let result = if let Some(dur) = timeout {
        match tokio::time::timeout(dur, rx).await {
            Ok(Ok(inner)) => inner,
            Ok(Err(_)) => {
                // Channel closed unexpectedly — worker probably crashed.
                return Err("Worker response channel closed unexpectedly".to_string());
            }
            Err(_) => {
                // Timeout — clean up pending entry but keep worker alive.
                // The Go goroutine will finish on its own; killing the worker
                // would cascade-fail every other in-flight request.
                let state = worker_state().lock().await;
                if let Some(worker) = state.as_ref() {
                    worker.pending.lock().unwrap().remove(&request_id);
                }
                return Err(crate::error::BusmanError::Timeout(
                    "Service Bus worker request timed out".to_string(),
                )
                .into());
            }
        }
    } else {
        rx.await
            .map_err(|_| "Worker response channel closed unexpectedly".to_string())?
    };

    match result {
        Ok(value) => Ok(value),
        Err(WorkerCallError::Worker(message)) => Err(message),
        Err(WorkerCallError::Transport(message)) => {
            let mut state = worker_state().lock().await;
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

#[cfg(test)]
mod tests {
    use super::*;

    // ─── redact_secrets ─────────────────────────────────────────────────

    #[test]
    fn redact_single_shared_access_key() {
        let input = "Endpoint=sb://foo.servicebus.windows.net/;SharedAccessKeyName=RootKey;SharedAccessKey=abc123secret";
        let result = redact_secrets(input);
        assert!(result.contains("SharedAccessKey=[REDACTED]"));
        assert!(!result.contains("abc123secret"));
    }

    #[test]
    fn redact_key_followed_by_semicolon() {
        let input = "SharedAccessKey=secret;EntityPath=myqueue";
        let result = redact_secrets(input);
        assert_eq!(result, "SharedAccessKey=[REDACTED];EntityPath=myqueue");
    }

    #[test]
    fn redact_shared_access_signature() {
        let input = "SharedAccessSignature=sr%3Dhttps%3A%2F%2Ffoo";
        let result = redact_secrets(input);
        assert_eq!(result, "SharedAccessSignature=[REDACTED]");
    }

    #[test]
    fn redact_multiple_occurrences_same_marker() {
        let input = "First: SharedAccessKey=secret1; Second: SharedAccessKey=secret2";
        let result = redact_secrets(input);
        assert!(!result.contains("secret1"));
        assert!(!result.contains("secret2"));
        // Both should be redacted
        assert_eq!(result.matches("[REDACTED]").count(), 2);
    }

    #[test]
    fn redact_both_key_and_signature() {
        let input = "SharedAccessKey=key123;SharedAccessSignature=sig456";
        let result = redact_secrets(input);
        assert!(!result.contains("key123"));
        assert!(!result.contains("sig456"));
        assert_eq!(result.matches("[REDACTED]").count(), 2);
    }

    #[test]
    fn redact_case_insensitive() {
        let input = "sharedaccesskey=CaSeSeCrEt;end";
        let result = redact_secrets(input);
        assert!(!result.contains("CaSeSeCrEt"));
        assert!(result.contains("[REDACTED]"));
    }

    #[test]
    fn redact_no_secrets_returns_unchanged() {
        let input = "This is a normal error message with no secrets";
        let result = redact_secrets(input);
        assert_eq!(result, input);
    }

    #[test]
    fn redact_empty_string() {
        assert_eq!(redact_secrets(""), "");
    }

    #[test]
    fn redact_key_at_end_of_string_no_semicolon() {
        let input = "SharedAccessKey=trailingSecret";
        let result = redact_secrets(input);
        assert_eq!(result, "SharedAccessKey=[REDACTED]");
    }

    #[test]
    fn redact_preserves_surrounding_text() {
        let input = "Error connecting: Endpoint=sb://x.windows.net/;SharedAccessKeyName=key;SharedAccessKey=s3cr3t;EntityPath=q1 - retrying";
        let result = redact_secrets(input);
        assert!(result.contains("Endpoint=sb://x.windows.net/"));
        assert!(result.contains("SharedAccessKeyName=key"));
        assert!(result.contains("EntityPath=q1 - retrying"));
        assert!(!result.contains("s3cr3t"));
    }

    // ─── kill_process_by_pid ────────────────────────────────────────────

    #[test]
    fn kill_pid_zero_is_noop() {
        assert!(kill_process_by_pid(0).is_ok());
    }
}
