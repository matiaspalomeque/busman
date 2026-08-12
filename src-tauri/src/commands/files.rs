use crate::error::BusmanError;
use tauri::{AppHandle, Manager};

// ─── File I/O commands ──────────────────────────────────────────────────────

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
