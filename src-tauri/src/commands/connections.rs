use crate::{
    error::BusmanError,
    models::{Connection, ConnectionsConfig},
    store,
};
use std::sync::Mutex;
use tauri::AppHandle;
use uuid::Uuid;

/// Guards all connection config mutations to prevent TOCTOU races.
/// The load → modify → save cycle must be atomic — without this lock,
/// concurrent commands can overwrite each other's changes.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn load_connections(app: AppHandle) -> Result<ConnectionsConfig, String> {
    store::load(&app)
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
    Ok(config)
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
    Ok(config)
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
    Ok(config)
}
