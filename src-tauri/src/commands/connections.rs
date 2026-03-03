use crate::{
    models::{Connection, ConnectionsConfig},
    store,
};
use tauri::AppHandle;
use uuid::Uuid;

#[tauri::command]
pub fn load_connections(app: AppHandle) -> Result<ConnectionsConfig, String> {
    store::load(&app)
}

#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    connection: Connection,
) -> Result<ConnectionsConfig, String> {
    let mut config = store::load(&app)?;

    if connection.id.is_empty() {
        // New connection
        let mut new_conn = connection;
        new_conn.id = Uuid::new_v4().to_string();
        config.connections.push(new_conn);
    } else {
        // Update existing
        match config.connections.iter_mut().find(|c| c.id == connection.id) {
            Some(existing) => *existing = connection,
            None => return Err(format!("Connection not found: {}", connection.id)),
        }
    }

    store::save(&app, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<ConnectionsConfig, String> {
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
    let mut config = store::load(&app)?;
    if let Some(ref cid) = id {
        if !config.connections.iter().any(|c| &c.id == cid) {
            return Err(format!("Connection not found: {cid}"));
        }
    }
    config.active_connection_id = id;
    store::save(&app, &config)?;
    Ok(config)
}
