use crate::error::BusmanError;
use crate::models::ConnectionsConfig;
use std::collections::HashMap;
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
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse config: {e}"))
}

pub fn save(app: &tauri::AppHandle, config: &ConnectionsConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write config: {e}"))?;

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
