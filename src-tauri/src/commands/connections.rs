use crate::{
    crypto,
    error::BusmanError,
    models::{Connection, ConnectionsConfig},
    store,
};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// Guards all connection config mutations to prevent TOCTOU races.
/// The load → modify → save cycle must be atomic — without this lock,
/// concurrent commands can overwrite each other's changes.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn load_connections(app: AppHandle) -> Result<ConnectionsConfig, String> {
    store::load(&app).map(public_config)
}

#[tauri::command]
pub fn get_connection_for_edit(app: AppHandle, id: String) -> Result<Connection, String> {
    store::load(&app)?
        .connections
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| BusmanError::NotFound(format!("Connection not found: {id}")).into())
}

#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    connection: Connection,
) -> Result<ConnectionsConfig, String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| BusmanError::Internal(format!("Config lock poisoned: {e}")))?;

    let mut config = store::load(&app)?;

    if connection.id.is_empty() {
        let mut new_conn = connection;
        new_conn.id = Uuid::new_v4().to_string();
        config.connections.push(new_conn);
    } else {
        match config
            .connections
            .iter_mut()
            .find(|c| c.id == connection.id)
        {
            Some(existing) => *existing = connection,
            None => {
                return Err(BusmanError::NotFound(format!(
                    "Connection not found: {}",
                    connection.id
                ))
                .into())
            }
        }
    }

    store::save(&app, &config)?;
    Ok(public_config(config))
}

#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<ConnectionsConfig, String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| BusmanError::Internal(format!("Config lock poisoned: {e}")))?;

    let mut config = store::load(&app)?;
    config.connections.retain(|c| c.id != id);
    if config.active_connection_id.as_deref() == Some(&id) {
        config.active_connection_id = None;
    }
    store::save(&app, &config)?;
    Ok(public_config(config))
}

#[tauri::command]
pub fn set_active_connection(
    app: AppHandle,
    id: Option<String>,
) -> Result<ConnectionsConfig, String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| BusmanError::Internal(format!("Config lock poisoned: {e}")))?;

    let mut config = store::load(&app)?;
    if let Some(ref cid) = id {
        if !config.connections.iter().any(|c| &c.id == cid) {
            return Err(BusmanError::NotFound(format!("Connection not found: {cid}")).into());
        }
    }
    config.active_connection_id = id;
    store::save(&app, &config)?;
    Ok(public_config(config))
}

#[tauri::command]
pub fn export_connections(app: AppHandle, path: String, password: String) -> Result<(), String> {
    validate_path(&app, &path, true)?;

    let config = store::load(&app)?;
    let plaintext = serde_json::to_vec(&config.connections)
        .map_err(|e| BusmanError::Internal(format!("Serialization failed: {e}")))?;

    let payload = crypto::encrypt(&plaintext, &password)?;
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| BusmanError::Internal(format!("Serialization failed: {e}")))?;

    std::fs::write(&path, json)
        .map_err(|e| BusmanError::Io(format!("Failed to write export file: {e}")))?;

    Ok(())
}

#[tauri::command]
pub fn import_connections(
    app: AppHandle,
    path: String,
    password: String,
    merge: bool,
) -> Result<ConnectionsConfig, String> {
    validate_path(&app, &path, false)?;

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| BusmanError::Io(format!("Failed to read import file: {e}")))?;

    let payload: crypto::EncryptedPayload = serde_json::from_str(&raw)
        .map_err(|_| BusmanError::Validation("Invalid or corrupted export file".to_string()))?;

    let decrypted = crypto::decrypt(&payload, &password).map_err(BusmanError::Validation)?;

    let imported: Vec<Connection> = serde_json::from_slice(&decrypted)
        .map_err(|_| BusmanError::Validation("Invalid or corrupted export file".to_string()))?;

    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| BusmanError::Internal(format!("Config lock poisoned: {e}")))?;

    let mut config = store::load(&app)?;

    if merge {
        for mut conn in imported {
            conn.id = Uuid::new_v4().to_string();
            config.connections.push(conn);
        }
    } else {
        config.connections = imported
            .into_iter()
            .map(|mut c| {
                c.id = Uuid::new_v4().to_string();
                c
            })
            .collect();
        config.active_connection_id = None;
    }

    store::save(&app, &config)?;
    Ok(public_config(config))
}

/// Return only endpoint metadata to the long-lived frontend store. The full
/// credential remains in Rust and is exposed transiently only when editing.
fn public_config(mut config: ConnectionsConfig) -> ConnectionsConfig {
    for connection in &mut config.connections {
        connection.connection_string = public_endpoint(&connection.connection_string);
        connection.env.clear();
    }
    config
}

fn public_endpoint(connection_string: &str) -> String {
    connection_string
        .split(';')
        .find_map(|part| {
            let (key, value) = part.split_once('=')?;
            key.trim()
                .eq_ignore_ascii_case("Endpoint")
                .then(|| format!("Endpoint={};", value.trim()))
        })
        .unwrap_or_default()
}

/// Validates that `path` is within the user's home directory.
/// When `check_extension` is true, also verifies the `.busman` extension.
fn validate_path(app: &AppHandle, path: &str, check_extension: bool) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| BusmanError::Io(format!("Cannot resolve home directory: {e}")))?;
    let canonical_home = home.canonicalize().unwrap_or(home);
    check_path(Path::new(path), check_extension, &canonical_home)
}

/// Pure path validation — separated from AppHandle so it can be unit-tested.
fn check_path(target: &Path, check_extension: bool, canonical_home: &Path) -> Result<(), String> {
    if check_extension && target.extension().and_then(|e| e.to_str()) != Some("busman") {
        return Err(BusmanError::Validation(
            "Export file must have a .busman extension".to_string(),
        )
        .into());
    }

    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| BusmanError::Io(format!("Cannot resolve path: {e}")))?
    } else {
        let parent = target.parent().ok_or_else(|| {
            BusmanError::Validation("Invalid file path: no parent directory".to_string())
        })?;
        parent
            .canonicalize()
            .map_err(|e| BusmanError::Io(format!("Cannot resolve parent directory: {e}")))?
            .join(target.file_name().unwrap_or_default())
    };

    if !canonical_target.starts_with(canonical_home) {
        return Err(BusmanError::Validation(
            "File path must be within the user's home directory".to_string(),
        )
        .into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir().canonicalize().unwrap()
    }

    #[test]
    fn accepts_busman_extension_within_home() {
        let home = tmp();
        // File doesn't need to exist — parent dir (tmp) does.
        let path = home.join("connections.busman");
        assert!(check_path(&path, true, &home).is_ok());
    }

    #[test]
    fn rejects_wrong_extension() {
        let home = tmp();
        let path = home.join("connections.json");
        let err = check_path(&path, true, &home).unwrap_err();
        assert!(err.contains(".busman"), "unexpected error: {err}");
    }

    #[test]
    fn extension_check_skipped_for_import() {
        let home = tmp();
        let path = home.join("connections.json");
        assert!(check_path(&path, false, &home).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn rejects_path_outside_home() {
        let home = tmp();
        // /etc/hosts always exists on Unix/macOS and is clearly outside tmp.
        let outside = std::path::Path::new("/etc/hosts");
        let err = check_path(outside, false, &home).unwrap_err();
        assert!(err.contains("home directory"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_nonexistent_parent_dir() {
        let home = tmp();
        // A path whose parent directory doesn't exist can't be canonicalized.
        let path = home.join("nonexistent_subdir_xyz").join("file.busman");
        let result = check_path(&path, true, &home);
        assert!(result.is_err());
    }

    #[test]
    fn public_config_does_not_expose_credentials_or_custom_environment() {
        let config = ConnectionsConfig {
            connections: vec![Connection {
                id: "conn-1".to_string(),
                name: "Production".to_string(),
                connection_string: "Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=secret".to_string(),
                env: std::collections::HashMap::from([(
                    "API_TOKEN".to_string(),
                    "secret-token".to_string(),
                )]),
                environment: Some("prod".to_string()),
                environment_color: None,
            }],
            active_connection_id: Some("conn-1".to_string()),
        };

        let public = public_config(config);

        assert_eq!(
            public.connections[0].connection_string,
            "Endpoint=sb://example.servicebus.windows.net/;"
        );
        assert!(public.connections[0].env.is_empty());
    }
}
