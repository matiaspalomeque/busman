use crate::error::BusmanError;
use crate::models::ConnectionsConfig;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

/// Returns path to: {app_data_dir}/connections.json
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("connections.json"))
        .map_err(|e| format!("Cannot access app data dir: {e}"))
}

pub fn load(app: &tauri::AppHandle) -> Result<ConnectionsConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(ConnectionsConfig::default());
    }
    match read_config_file(&path) {
        Ok(config) => Ok(config),
        Err(primary_err) => {
            let backup = backup_config_path(&path);
            if backup.exists() {
                if let Ok(config) = read_config_file(&backup) {
                    return Ok(config);
                }
            }
            Err(primary_err)
        }
    }
}

pub fn save(app: &tauri::AppHandle, config: &ConnectionsConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    let tmp_path = temp_config_path(&path);
    let backup_path = backup_config_path(&path);

    {
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temporary config: {e}"))?;

        // Restrict permissions so other OS users cannot read connection strings.
        #[cfg(unix)]
        {
            use std::fs::Permissions;
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(Permissions::from_mode(0o600))
                .map_err(|e| format!("Failed to set temporary config permissions: {e}"))?;
        }

        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write temporary config: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync temporary config: {e}"))?;
    }

    if path.exists() {
        let _ = std::fs::copy(&path, &backup_path);
    }

    replace_config_file(&tmp_path, &path)?;

    // Restrict permissions so other OS users cannot read connection strings.
    #[cfg(unix)]
    {
        use std::fs::Permissions;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set config permissions: {e}"))?;
    }

    Ok(())
}

fn read_config_file(path: &PathBuf) -> Result<ConnectionsConfig, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse config: {e}"))
}

fn temp_config_path(path: &PathBuf) -> PathBuf {
    path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json")
    ))
}

fn backup_config_path(path: &PathBuf) -> PathBuf {
    path.with_extension(format!(
        "{}.bak",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json")
    ))
}

#[cfg(not(target_os = "windows"))]
fn replace_config_file(tmp_path: &PathBuf, path: &PathBuf) -> Result<(), String> {
    std::fs::rename(tmp_path, path).map_err(|e| format!("Failed to replace config: {e}"))?;
    sync_parent_dir(path);
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_config_file(tmp_path: &PathBuf, path: &PathBuf) -> Result<(), String> {
    let backup_path = backup_config_path(path);
    if path.exists() {
        let _ = std::fs::remove_file(&backup_path);
        std::fs::rename(path, &backup_path)
            .map_err(|e| format!("Failed to stage existing config for replacement: {e}"))?;
    }
    if let Err(err) = std::fs::rename(tmp_path, path) {
        if backup_path.exists() {
            let _ = std::fs::rename(&backup_path, path);
        }
        return Err(format!("Failed to replace config: {err}"));
    }
    let _ = std::fs::remove_file(backup_path);
    sync_parent_dir(path);
    Ok(())
}

fn sync_parent_dir(path: &PathBuf) {
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

/// Resolves the environment variables for a saved connection.
/// Builds a HashMap with `SERVICE_BUS_CONNECTION_STRING` set to the connection's
/// stored credential, merged with any user-defined custom env vars.
/// This keeps connection strings on the Rust side — the frontend only sends an ID.
pub fn resolve_connection_env(
    app: &tauri::AppHandle,
    connection_id: &str,
) -> Result<HashMap<String, String>, String> {
    let config = load(app)?;
    let conn = config
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| BusmanError::NotFound(format!("Connection not found: {connection_id}")))?;
    let mut env = conn.env.clone();
    env.insert(
        "SERVICE_BUS_CONNECTION_STRING".to_string(),
        conn.connection_string.clone(),
    );
    Ok(env)
}
