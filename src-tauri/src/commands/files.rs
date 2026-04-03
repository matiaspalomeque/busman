use super::worker::downloads_dir;
use crate::error::BusmanError;
use tauri::{AppHandle, Manager};

// ─── Downloaded file types ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DownloadedFile {
    pub filename: String,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

// ─── File I/O commands ──────────────────────────────────────────────────────

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

/// Write text content to a file path chosen via the frontend save dialog.
/// The path must have a `.json` extension to limit the scope of writes.
#[tauri::command]
pub async fn write_json_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);

    // Only allow .json files — this command is exclusively for exporting peek results.
    if target.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err(BusmanError::Validation("Only .json files are allowed".to_string()).into());
    }

    // Block writes outside the user's home directory tree as a safety net.
    // The frontend enforces the native save dialog, but we validate server-side too.
    let home = app
        .path()
        .home_dir()
        .map_err(|e| BusmanError::Io(format!("Cannot resolve home directory: {e}")))?;
    let canonical_home = home.canonicalize().unwrap_or(home);
    let canonical_target = target
        .parent()
        .ok_or_else(|| {
            BusmanError::Validation("Invalid file path: no parent directory".to_string())
        })?
        .canonicalize()
        .map_err(|e| BusmanError::Io(format!("Cannot resolve target directory: {e}")))?;
    if !canonical_target.starts_with(&canonical_home) {
        return Err(BusmanError::Validation(
            "Write path must be within the user's home directory".to_string(),
        )
        .into());
    }

    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}
