use crate::crypto::{self, DATA_KEY_LENGTH};
use crate::error::BusmanError;
use crate::models::{Connection, ConnectionsConfig};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const CONFIG_VERSION: u32 = 2;
const PER_CONNECTION_CONFIG_VERSION: u32 = 1;
const CREDENTIAL_PAYLOAD_VERSION: u32 = 1;
const CREDENTIAL_SERVICE: &str = "com.busman.app.azure-service-bus";
const CREDENTIAL_REFERENCE_PREFIX: &str = "connection/";
const MASTER_KEY_REFERENCE: &str = "master-key/v1";
const SECRET_BUNDLE_VERSION: u32 = 1;

/// Serializes config recovery, migration, and writes. Read commands can otherwise race
/// the first legacy migration and share the same temporary file paths.
static STORE_LOCK: Mutex<()> = Mutex::new(());
static MASTER_KEY_CACHE: Mutex<Option<[u8; DATA_KEY_LENGTH]>> = Mutex::new(None);

/// Narrow abstraction around the platform credential store. Tests use an in-memory
/// implementation so they never read from or write to the developer's real keychain.
trait CredentialStore {
    fn get(&self, reference: &str) -> Result<Option<String>, String>;
    fn set(&self, reference: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, reference: &str) -> Result<(), String>;
}

/// Narrow filesystem boundary for the two fallible commit points and legacy-artifact
/// cleanup. Production delegates to the platform helpers; tests inject one-shot failures
/// without changing process-global filesystem state.
trait ConfigFilesystem {
    fn replace_primary(
        &self,
        tmp_path: &Path,
        path: &Path,
        backup_mode: BackupMode,
    ) -> Result<(), String>;
    fn replace_backup(&self, tmp_path: &Path, backup_path: &Path) -> Result<(), String>;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
    fn copy_file(&self, source: &Path, destination: &Path) -> std::io::Result<u64>;
}

struct OsConfigFilesystem;

impl ConfigFilesystem for OsConfigFilesystem {
    fn replace_primary(
        &self,
        tmp_path: &Path,
        path: &Path,
        backup_mode: BackupMode,
    ) -> Result<(), String> {
        if matches!(backup_mode, BackupMode::ReplaceLegacy) {
            replace_migrated_config_file(tmp_path, path)
        } else {
            replace_config_file(tmp_path, path)
        }
    }

    fn replace_backup(&self, tmp_path: &Path, backup_path: &Path) -> Result<(), String> {
        replace_backup_file(tmp_path, backup_path)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn copy_file(&self, source: &Path, destination: &Path) -> std::io::Result<u64> {
        std::fs::copy(source, destination)
    }
}

struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(reference: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(CREDENTIAL_SERVICE, reference)
            .map_err(|err| credential_store_error("open", err))
    }
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, reference: &str) -> Result<Option<String>, String> {
        match Self::entry(reference)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(credential_store_error("read from", err)),
        }
    }

    fn set(&self, reference: &str, secret: &str) -> Result<(), String> {
        Self::entry(reference)?
            .set_password(secret)
            .map_err(|err| credential_store_error("write to", err))
    }

    fn delete(&self, reference: &str) -> Result<(), String> {
        match Self::entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(credential_store_error("delete from", err)),
        }
    }
}

fn credential_store_error(action: &str, err: keyring::Error) -> String {
    #[cfg(target_os = "linux")]
    let hint = " Ensure a Secret Service provider (such as GNOME Keyring or KWallet) is running and unlocked for this desktop session.";
    #[cfg(not(target_os = "linux"))]
    let hint = "";

    format!("Failed to {action} the operating system credential store: {err}.{hint}")
}

/// The connection representation written to disk. Metadata remains readable for
/// startup; secret-bearing fields exist only inside the authenticated encrypted blob.
#[derive(Debug, Serialize, Clone)]
struct PersistedConnectionsConfig {
    version: u32,
    connections: Vec<PersistedConnection>,
    #[serde(rename = "activeConnectionId")]
    active_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secrets: Option<crypto::SealedPayload>,
}

#[derive(Debug, Serialize, Clone)]
struct PersistedConnection {
    id: String,
    name: String,
    endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "credentialRef")]
    credential_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "environmentColor")]
    environment_color: Option<String>,
}

/// Permissive read model for plaintext, per-connection-keyring, and encrypted formats.
/// It is never serializable, so legacy secrets cannot be written back accidentally.
#[derive(Deserialize)]
struct DiskConnectionsConfig {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    connections: Vec<DiskConnection>,
    #[serde(default, rename = "activeConnectionId")]
    active_connection_id: Option<String>,
    #[serde(default)]
    secrets: Option<crypto::SealedPayload>,
}

#[derive(Deserialize)]
struct DiskConnection {
    id: String,
    name: String,
    #[serde(default, rename = "credentialRef")]
    credential_ref: Option<String>,
    #[serde(default)]
    endpoint: String,
    #[serde(default, rename = "connectionString")]
    legacy_connection_string: Option<String>,
    #[serde(default, rename = "env")]
    legacy_env: HashMap<String, String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default, rename = "environmentColor")]
    environment_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CredentialPayload {
    version: u32,
    #[serde(rename = "connectionString")]
    connection_string: String,
    #[serde(default)]
    env: HashMap<String, String>,
}

impl CredentialPayload {
    fn from_connection(connection: &Connection) -> Self {
        Self {
            version: CREDENTIAL_PAYLOAD_VERSION,
            connection_string: connection.connection_string.clone(),
            env: connection.env.clone(),
        }
    }

    fn parse(secret: &str, reference: &str) -> Result<Self, String> {
        let payload: Self = serde_json::from_str(secret).map_err(|_| {
            format!("Connection credential '{reference}' has an invalid secure-store payload")
        })?;
        if payload.version != CREDENTIAL_PAYLOAD_VERSION {
            return Err(format!(
                "Connection credential '{reference}' uses unsupported payload version {}",
                payload.version
            ));
        }
        Ok(payload)
    }

    #[cfg(test)]
    fn serialize(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map_err(|err| format!("Failed to serialize connection credential: {err}"))
    }
}

#[derive(Serialize, Deserialize)]
struct CredentialBundle {
    version: u32,
    credentials: HashMap<String, CredentialPayload>,
}

#[derive(Clone, Copy)]
enum BackupMode {
    CurrentOnly,
    ReplaceLegacy,
}

/// Returns path to: {app_data_dir}/connections.json
pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("connections.json"))
        .map_err(|e| format!("Cannot access app data dir: {e}"))
}

pub fn load_public(app: &tauri::AppHandle) -> Result<ConnectionsConfig, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|err| format!("Connection store lock poisoned: {err}"))?;
    let path = config_path(app)?;
    load_public_from_path(&path)
}

pub fn load(app: &tauri::AppHandle) -> Result<ConnectionsConfig, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|err| format!("Connection store lock poisoned: {err}"))?;
    let path = config_path(app)?;
    load_from_path_with_store_and_fs_and_cache(
        &path,
        &OsCredentialStore,
        &OsConfigFilesystem,
        Some(&MASTER_KEY_CACHE),
    )
}

pub fn load_connection(app: &tauri::AppHandle, connection_id: &str) -> Result<Connection, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|err| format!("Connection store lock poisoned: {err}"))?;
    let path = config_path(app)?;
    load_connection_from_path_with_store_and_fs_and_cache(
        &path,
        connection_id,
        &OsCredentialStore,
        &OsConfigFilesystem,
        Some(&MASTER_KEY_CACHE),
    )
}

pub fn set_active(app: &tauri::AppHandle, id: Option<String>) -> Result<ConnectionsConfig, String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|err| format!("Connection store lock poisoned: {err}"))?;
    let path = config_path(app)?;
    set_active_from_path_with_fs(&path, id, &OsConfigFilesystem)
}

fn set_active_from_path_with_fs(
    path: &Path,
    id: Option<String>,
    filesystem: &dyn ConfigFilesystem,
) -> Result<ConnectionsConfig, String> {
    let mut disk = load_disk_config(path)?;
    validate_connection_ids(&disk.connections)?;
    if let Some(ref connection_id) = id {
        if !disk
            .connections
            .iter()
            .any(|connection| &connection.id == connection_id)
        {
            return Err(
                BusmanError::NotFound(format!("Connection not found: {connection_id}")).into(),
            );
        }
    }
    disk.active_connection_id = id.clone();
    let public = public_config_from_disk(&disk)?;

    let mut raw: serde_json::Value = if path.exists() {
        let contents = std::fs::read(path)
            .map_err(|err| format!("Failed to read config for active-connection update: {err}"))?;
        serde_json::from_slice(&contents)
            .map_err(|err| format!("Failed to parse config for active-connection update: {err}"))?
    } else {
        serde_json::json!({
            "version": CONFIG_VERSION,
            "connections": [],
            "activeConnectionId": null,
        })
    };
    let object = raw
        .as_object_mut()
        .ok_or_else(|| "Connection config root must be an object".to_string())?;
    object.insert(
        "activeConnectionId".to_string(),
        id.map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    write_config_with_fs(path, &raw, BackupMode::CurrentOnly, filesystem)?;
    Ok(public)
}

fn load_public_from_path(path: &Path) -> Result<ConnectionsConfig, String> {
    let disk = load_disk_config(path)?;
    public_config_from_disk(&disk)
}

#[cfg(test)]
fn load_from_path_with_store(
    path: &Path,
    credentials: &dyn CredentialStore,
) -> Result<ConnectionsConfig, String> {
    load_from_path_with_store_and_fs(path, credentials, &OsConfigFilesystem)
}

#[cfg(test)]
fn load_from_path_with_store_and_fs(
    path: &Path,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
) -> Result<ConnectionsConfig, String> {
    load_from_path_with_store_and_fs_and_cache(path, credentials, filesystem, None)
}

fn load_from_path_with_store_and_fs_and_cache(
    path: &Path,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<ConnectionsConfig, String> {
    let disk = load_disk_config(path)?;
    match disk_format(&disk)? {
        DiskFormat::Encrypted => {
            let (config, old_references) = hydrate_encrypted_config(disk, credentials, key_cache)?;
            if !old_references.is_empty() {
                migrate_config(
                    path,
                    &config,
                    &old_references,
                    credentials,
                    filesystem,
                    key_cache,
                )?;
            }
            if path.exists() {
                cleanup_legacy_artifacts(path, filesystem)?;
            }
            Ok(config)
        }
        DiskFormat::Plaintext | DiskFormat::PerConnection => {
            let (config, old_references) = hydrate_legacy_config(disk, credentials)?;
            migrate_config(
                path,
                &config,
                &old_references,
                credentials,
                filesystem,
                key_cache,
            )?;
            Ok(config)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiskFormat {
    Plaintext,
    PerConnection,
    Encrypted,
}

fn disk_format(disk: &DiskConnectionsConfig) -> Result<DiskFormat, String> {
    match disk.version {
        None => Ok(DiskFormat::Plaintext),
        Some(PER_CONNECTION_CONFIG_VERSION) => Ok(DiskFormat::PerConnection),
        Some(CONFIG_VERSION) => Ok(DiskFormat::Encrypted),
        Some(version) => Err(format!(
            "Unsupported connection config version {version}; expected {CONFIG_VERSION}"
        )),
    }
}

fn validate_connection_ids(connections: &[DiskConnection]) -> Result<(), String> {
    let mut seen_ids = HashSet::new();
    for connection in connections {
        if connection.id.is_empty() {
            return Err("Connection config contains an empty connection ID".to_string());
        }
        if !seen_ids.insert(&connection.id) {
            return Err(format!(
                "Connection config contains duplicate connection ID '{}'",
                connection.id
            ));
        }
    }
    Ok(())
}

fn public_config_from_disk(disk: &DiskConnectionsConfig) -> Result<ConnectionsConfig, String> {
    let format = disk_format(disk)?;
    validate_connection_ids(&disk.connections)?;

    let mut connections = Vec::with_capacity(disk.connections.len());
    for connection in &disk.connections {
        let endpoint = match format {
            DiskFormat::Encrypted => {
                if connection.legacy_connection_string.is_some()
                    || !connection.legacy_env.is_empty()
                {
                    return Err(format!(
                        "Encrypted connection metadata for '{}' contains legacy credential fields",
                        connection.id
                    ));
                }
                connection.endpoint.clone()
            }
            DiskFormat::Plaintext => connection
                .legacy_connection_string
                .as_deref()
                .map(public_endpoint)
                .ok_or_else(|| {
                    format!(
                        "Connection '{}' is missing its legacy connection string",
                        connection.id
                    )
                })?,
            DiskFormat::PerConnection => connection
                .legacy_connection_string
                .as_deref()
                .map(public_endpoint)
                .unwrap_or_else(|| connection.endpoint.clone()),
        };

        connections.push(Connection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            connection_string: endpoint,
            env: HashMap::new(),
            environment: connection.environment.clone(),
            environment_color: connection.environment_color.clone(),
        });
    }

    Ok(ConnectionsConfig {
        connections,
        active_connection_id: disk.active_connection_id.clone(),
    })
}

fn load_disk_config(path: &Path) -> Result<DiskConnectionsConfig, String> {
    if !path.exists() {
        let backup = backup_config_path(path);
        if backup.exists() {
            let config = read_disk_config_file(&backup)?;
            restore_primary_from_backup(path, &backup)?;
            log::warn!(
                "Recovered missing connection config from backup: {}",
                path.display()
            );
            return Ok(config);
        }
        return Ok(DiskConnectionsConfig {
            version: Some(CONFIG_VERSION),
            connections: Vec::new(),
            active_connection_id: None,
            secrets: None,
        });
    }

    match read_disk_config_file(path) {
        Ok(config) => Ok(config),
        Err(primary_err) => {
            let backup = backup_config_path(path);
            if backup.exists() {
                if let Ok(config) = read_disk_config_file(&backup) {
                    restore_primary_from_backup(path, &backup)?;
                    log::warn!(
                        "Recovered invalid connection config from backup: {}",
                        path.display()
                    );
                    return Ok(config);
                }
            }
            Err(primary_err)
        }
    }
}

fn hydrate_legacy_config(
    disk: DiskConnectionsConfig,
    credentials: &dyn CredentialStore,
) -> Result<(ConnectionsConfig, HashSet<String>), String> {
    let format = disk_format(&disk)?;
    if format == DiskFormat::Encrypted {
        return Err("Encrypted connection config was sent through legacy migration".to_string());
    }
    validate_connection_ids(&disk.connections)?;

    let mut old_references = HashSet::new();
    let mut runtime_connections = Vec::with_capacity(disk.connections.len());

    for connection in disk.connections {
        let payload = match connection.legacy_connection_string {
            Some(connection_string) => CredentialPayload {
                version: CREDENTIAL_PAYLOAD_VERSION,
                connection_string,
                env: connection.legacy_env,
            },
            None => {
                let reference = connection.credential_ref.ok_or_else(|| {
                    format!(
                        "Connection '{}' has neither a credential reference nor a legacy connection string",
                        connection.id
                    )
                })?;
                if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX)
                    || !old_references.insert(reference.clone())
                {
                    return Err(format!(
                        "Connection config contains an invalid or duplicate credential reference for '{}'",
                        connection.id
                    ));
                }
                let secret = credentials.get(&reference)?.ok_or_else(|| {
                    format!(
                        "Connection credential '{}' is missing from the operating system credential store",
                        reference
                    )
                })?;
                let mut payload = CredentialPayload::parse(&secret, &reference)?;
                if !connection.legacy_env.is_empty() {
                    payload.env = connection.legacy_env;
                }
                payload
            }
        };

        runtime_connections.push(Connection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            connection_string: payload.connection_string,
            env: payload.env,
            environment: connection.environment.clone(),
            environment_color: connection.environment_color.clone(),
        });
    }

    Ok((
        ConnectionsConfig {
            connections: runtime_connections,
            active_connection_id: disk.active_connection_id,
        },
        old_references,
    ))
}

#[cfg(test)]
fn credential_reference(connection_id: &str) -> String {
    format!("{CREDENTIAL_REFERENCE_PREFIX}{connection_id}")
}

fn hydrate_encrypted_config(
    disk: DiskConnectionsConfig,
    credentials: &dyn CredentialStore,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<(ConnectionsConfig, HashSet<String>), String> {
    validate_connection_ids(&disk.connections)?;
    if disk.connections.is_empty() && disk.secrets.is_none() {
        return Ok((
            ConnectionsConfig {
                connections: Vec::new(),
                active_connection_id: disk.active_connection_id,
            },
            HashSet::new(),
        ));
    }

    let mut payloads = match disk.secrets.as_ref() {
        Some(sealed) => {
            let (key, _) = master_key(credentials, false, key_cache)?;
            open_credential_bundle(sealed, &key)?
        }
        None => HashMap::new(),
    };
    let mut old_references = HashSet::new();
    let mut runtime_connections = Vec::with_capacity(disk.connections.len());
    for connection in disk.connections {
        if connection.legacy_connection_string.is_some() || !connection.legacy_env.is_empty() {
            return Err(format!(
                "Encrypted connection metadata for '{}' contains legacy credential fields",
                connection.id
            ));
        }
        let reference = connection.credential_ref.clone();
        if let Some(reference) = reference.as_ref() {
            if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX)
                || !old_references.insert(reference.clone())
            {
                return Err(format!(
                    "Connection config contains an invalid or duplicate credential reference for '{}'",
                    connection.id
                ));
            }
        }
        let payload = match payloads.remove(&connection.id) {
            Some(payload) => payload,
            None => {
                let reference = reference.ok_or_else(|| {
                    format!(
                        "Connection credential '{}' is missing from the encrypted credential bundle",
                        connection.id
                    )
                })?;
                let secret = credentials.get(&reference)?.ok_or_else(|| {
                    format!(
                        "Connection credential '{}' is missing from the operating system credential store",
                        reference
                    )
                })?;
                CredentialPayload::parse(&secret, &reference)?
            }
        };
        if payload.version != CREDENTIAL_PAYLOAD_VERSION {
            return Err(format!(
                "Connection credential '{}' uses unsupported payload version {}",
                connection.id, payload.version
            ));
        }

        runtime_connections.push(Connection {
            id: connection.id,
            name: connection.name,
            connection_string: payload.connection_string,
            env: payload.env,
            environment: connection.environment,
            environment_color: connection.environment_color,
        });
    }
    if !payloads.is_empty() {
        return Err("Encrypted credential bundle contains orphaned connections".to_string());
    }

    Ok((
        ConnectionsConfig {
            connections: runtime_connections,
            active_connection_id: disk.active_connection_id,
        },
        old_references,
    ))
}

fn open_credential_bundle(
    sealed: &crypto::SealedPayload,
    key: &[u8; DATA_KEY_LENGTH],
) -> Result<HashMap<String, CredentialPayload>, String> {
    let plaintext = crypto::open_with_key(sealed, key)?;
    let bundle: CredentialBundle = serde_json::from_slice(&plaintext)
        .map_err(|_| "Connection credential store is corrupted".to_string())?;
    if bundle.version != SECRET_BUNDLE_VERSION {
        return Err(format!(
            "Unsupported connection credential bundle version {}",
            bundle.version
        ));
    }
    Ok(bundle.credentials)
}

fn load_connection_from_path_with_store_and_fs_and_cache(
    path: &Path,
    connection_id: &str,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<Connection, String> {
    let disk = load_disk_config(path)?;
    match disk_format(&disk)? {
        DiskFormat::Plaintext => {
            load_from_path_with_store_and_fs_and_cache(path, credentials, filesystem, key_cache)?
                .connections
                .into_iter()
                .find(|connection| connection.id == connection_id)
                .ok_or_else(|| {
                    BusmanError::NotFound(format!("Connection not found: {connection_id}")).into()
                })
        }
        DiskFormat::PerConnection => migrate_one_per_connection_entry(
            path,
            disk,
            connection_id,
            credentials,
            filesystem,
            key_cache,
        ),
        DiskFormat::Encrypted => load_one_encrypted_connection(
            path,
            disk,
            connection_id,
            credentials,
            filesystem,
            key_cache,
        ),
    }
}

fn migrate_one_per_connection_entry(
    path: &Path,
    mut disk: DiskConnectionsConfig,
    connection_id: &str,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<Connection, String> {
    validate_connection_ids(&disk.connections)?;
    let target_index = disk
        .connections
        .iter()
        .position(|connection| connection.id == connection_id)
        .ok_or_else(|| BusmanError::NotFound(format!("Connection not found: {connection_id}")))?;

    let fetched_target = if disk.connections[target_index]
        .legacy_connection_string
        .is_none()
    {
        let reference = disk.connections[target_index]
            .credential_ref
            .as_ref()
            .ok_or_else(|| {
                format!(
                    "Connection '{}' has neither a credential reference nor a legacy connection string",
                    connection_id
                )
            })?;
        if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX) {
            return Err(format!(
                "Connection config contains an invalid credential reference for '{connection_id}'"
            ));
        }
        let secret = credentials.get(reference)?.ok_or_else(|| {
            format!(
                "Connection credential '{}' is missing from the operating system credential store",
                reference
            )
        })?;
        Some(CredentialPayload::parse(&secret, reference)?)
    } else {
        None
    };

    let mut fetched_target = fetched_target;
    let mut encrypted_payloads = HashMap::new();
    let mut migrated_references = HashSet::new();
    let mut selected = None;
    for connection in &mut disk.connections {
        let payload = match connection.legacy_connection_string.take() {
            Some(connection_string) => Some(CredentialPayload {
                version: CREDENTIAL_PAYLOAD_VERSION,
                connection_string,
                env: std::mem::take(&mut connection.legacy_env),
            }),
            None if connection.id == connection_id => fetched_target.take(),
            None => None,
        };
        let Some(payload) = payload else {
            continue;
        };

        if let Some(reference) = connection.credential_ref.take() {
            if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX)
                || !migrated_references.insert(reference.clone())
            {
                return Err(format!(
                    "Connection config contains an invalid or duplicate credential reference for '{}'",
                    connection.id
                ));
            }
        }
        connection.endpoint = public_endpoint(&payload.connection_string);
        if connection.id == connection_id {
            selected = Some(connection_from_payload(connection, payload.clone())?);
        }
        encrypted_payloads.insert(connection.id.clone(), payload);
    }

    let selected = selected
        .ok_or_else(|| format!("Connection credential '{connection_id}' could not be migrated"))?;
    let (key, created) = master_key(credentials, true, key_cache)?;
    persist_partial_encrypted_config(
        path,
        disk,
        encrypted_payloads,
        &migrated_references,
        key,
        created,
        BackupMode::ReplaceLegacy,
        credentials,
        filesystem,
        key_cache,
    )?;
    Ok(selected)
}

fn load_one_encrypted_connection(
    path: &Path,
    mut disk: DiskConnectionsConfig,
    connection_id: &str,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<Connection, String> {
    validate_connection_ids(&disk.connections)?;
    let target_index = disk
        .connections
        .iter()
        .position(|connection| connection.id == connection_id)
        .ok_or_else(|| BusmanError::NotFound(format!("Connection not found: {connection_id}")))?;
    if disk.connections.iter().any(|connection| {
        connection.legacy_connection_string.is_some() || !connection.legacy_env.is_empty()
    }) {
        return Err("Encrypted connection metadata contains legacy plaintext fields".to_string());
    }

    let (mut payloads, existing_key) = match disk.secrets.as_ref() {
        Some(sealed) => {
            let (key, _) = master_key(credentials, false, key_cache)?;
            (open_credential_bundle(sealed, &key)?, Some(key))
        }
        None => (HashMap::new(), None),
    };
    let known_ids: HashSet<_> = disk
        .connections
        .iter()
        .map(|connection| connection.id.as_str())
        .collect();
    if payloads.keys().any(|id| !known_ids.contains(id.as_str())) {
        return Err("Encrypted credential bundle contains orphaned connections".to_string());
    }

    if let Some(payload) = payloads.get(connection_id).cloned() {
        return connection_from_payload(&disk.connections[target_index], payload);
    }

    let reference = disk.connections[target_index]
        .credential_ref
        .clone()
        .ok_or_else(|| {
            format!(
                "Connection credential '{}' is missing from the encrypted credential bundle",
                connection_id
            )
        })?;
    if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX) {
        return Err(format!(
            "Connection config contains an invalid credential reference for '{connection_id}'"
        ));
    }
    let secret = credentials.get(&reference)?.ok_or_else(|| {
        format!(
            "Connection credential '{}' is missing from the operating system credential store",
            reference
        )
    })?;
    let payload = CredentialPayload::parse(&secret, &reference)?;
    let selected = connection_from_payload(&disk.connections[target_index], payload.clone())?;
    disk.connections[target_index].endpoint = public_endpoint(&payload.connection_string);
    disk.connections[target_index].credential_ref = None;
    payloads.insert(connection_id.to_string(), payload);

    let (key, created) = match existing_key {
        Some(key) => (key, false),
        None => master_key(credentials, true, key_cache)?,
    };
    persist_partial_encrypted_config(
        path,
        disk,
        payloads,
        &HashSet::from([reference]),
        key,
        created,
        BackupMode::CurrentOnly,
        credentials,
        filesystem,
        key_cache,
    )?;
    Ok(selected)
}

fn connection_from_payload(
    metadata: &DiskConnection,
    payload: CredentialPayload,
) -> Result<Connection, String> {
    if payload.version != CREDENTIAL_PAYLOAD_VERSION {
        return Err(format!(
            "Connection credential '{}' uses unsupported payload version {}",
            metadata.id, payload.version
        ));
    }
    Ok(Connection {
        id: metadata.id.clone(),
        name: metadata.name.clone(),
        connection_string: payload.connection_string,
        env: payload.env,
        environment: metadata.environment.clone(),
        environment_color: metadata.environment_color.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn persist_partial_encrypted_config(
    path: &Path,
    disk: DiskConnectionsConfig,
    payloads: HashMap<String, CredentialPayload>,
    migrated_references: &HashSet<String>,
    key: [u8; DATA_KEY_LENGTH],
    created_key: bool,
    backup_mode: BackupMode,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<(), String> {
    let result = (|| {
        let sealed = seal_credential_bundle(payloads, &key)?;
        let persisted = persisted_config_from_disk(disk, Some(sealed))?;
        write_config_with_fs(path, &persisted, backup_mode, filesystem)
    })();
    if let Err(err) = result {
        return if created_key {
            Err(rollback_new_master_key(credentials, key_cache, key, err))
        } else {
            Err(err)
        };
    }
    if let Err(err) = cleanup_legacy_artifacts(path, filesystem) {
        return Err(format!(
            "Connection credentials were encrypted, but legacy plaintext cleanup is incomplete: {err}. Close applications that may be using the files and retry."
        ));
    }
    for reference in migrated_references {
        if let Err(err) = credentials.delete(reference) {
            log::warn!("Failed to remove migrated connection credential '{reference}': {err}");
        }
    }
    Ok(())
}

fn persisted_config_from_disk(
    disk: DiskConnectionsConfig,
    secrets: Option<crypto::SealedPayload>,
) -> Result<PersistedConnectionsConfig, String> {
    validate_connection_ids(&disk.connections)?;
    let mut references = HashSet::new();
    let mut connections = Vec::with_capacity(disk.connections.len());
    for connection in disk.connections {
        if connection.legacy_connection_string.is_some() || !connection.legacy_env.is_empty() {
            return Err(format!(
                "Connection '{}' still contains legacy plaintext fields",
                connection.id
            ));
        }
        if let Some(reference) = connection.credential_ref.as_ref() {
            if !reference.starts_with(CREDENTIAL_REFERENCE_PREFIX)
                || !references.insert(reference.clone())
            {
                return Err(format!(
                    "Connection config contains an invalid or duplicate credential reference for '{}'",
                    connection.id
                ));
            }
        }
        connections.push(PersistedConnection {
            id: connection.id,
            name: connection.name,
            endpoint: connection.endpoint,
            credential_ref: connection.credential_ref,
            environment: connection.environment,
            environment_color: connection.environment_color,
        });
    }
    Ok(PersistedConnectionsConfig {
        version: CONFIG_VERSION,
        connections,
        active_connection_id: disk.active_connection_id,
        secrets,
    })
}

fn seal_credential_bundle(
    credentials: HashMap<String, CredentialPayload>,
    key: &[u8; DATA_KEY_LENGTH],
) -> Result<crypto::SealedPayload, String> {
    let bundle = CredentialBundle {
        version: SECRET_BUNDLE_VERSION,
        credentials,
    };
    let plaintext = serde_json::to_vec(&bundle)
        .map_err(|err| format!("Failed to serialize connection credentials: {err}"))?;
    crypto::seal_with_key(&plaintext, key)
}

fn master_key(
    credentials: &dyn CredentialStore,
    allow_create: bool,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<([u8; DATA_KEY_LENGTH], bool), String> {
    if let Some(cache) = key_cache {
        if let Some(key) = *cache
            .lock()
            .map_err(|err| format!("Master-key cache lock poisoned: {err}"))?
        {
            return Ok((key, false));
        }
    }

    let (key, created) =
        match credentials.get(MASTER_KEY_REFERENCE)? {
            Some(encoded) => (decode_master_key(&encoded)?, false),
            None if allow_create => {
                let key = crypto::generate_data_key();
                credentials.set(MASTER_KEY_REFERENCE, &BASE64.encode(key))?;
                (key, true)
            }
            None => return Err(
                "Connection encryption key is missing from the operating system credential store"
                    .to_string(),
            ),
        };

    if let Some(cache) = key_cache {
        *cache
            .lock()
            .map_err(|err| format!("Master-key cache lock poisoned: {err}"))? = Some(key);
    }
    Ok((key, created))
}

fn decode_master_key(encoded: &str) -> Result<[u8; DATA_KEY_LENGTH], String> {
    let bytes = BASE64.decode(encoded).map_err(|_| {
        "Connection encryption key in the operating system credential store is invalid".to_string()
    })?;
    bytes.try_into().map_err(|_| {
        "Connection encryption key in the operating system credential store has an invalid length"
            .to_string()
    })
}

fn rollback_new_master_key(
    credentials: &dyn CredentialStore,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
    key: [u8; DATA_KEY_LENGTH],
    cause: String,
) -> String {
    if let Some(cache) = key_cache {
        if let Ok(mut cached) = cache.lock() {
            if cached.as_ref() == Some(&key) {
                *cached = None;
            }
        }
    }
    match credentials.delete(MASTER_KEY_REFERENCE) {
        Ok(()) => cause,
        Err(err) => format!(
            "{cause}. The newly created master-key rollback also failed: {err}; the existing config was not rewritten"
        ),
    }
}

fn migrate_config(
    path: &Path,
    config: &ConnectionsConfig,
    old_references: &HashSet<String>,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<(), String> {
    let (key, created) = if config.connections.is_empty() {
        (None, false)
    } else {
        let (key, created) = master_key(credentials, true, key_cache)?;
        (Some(key), created)
    };
    let persisted = match persisted_config(config, key.as_ref()) {
        Ok(persisted) => persisted,
        Err(err) if created => {
            return Err(rollback_new_master_key(
                credentials,
                key_cache,
                key.expect("a created master key must be present"),
                err,
            ))
        }
        Err(err) => return Err(err),
    };
    if let Err(err) = write_config_with_fs(path, &persisted, BackupMode::ReplaceLegacy, filesystem)
    {
        return if created {
            Err(rollback_new_master_key(
                credentials,
                key_cache,
                key.expect("a created master key must be present"),
                err,
            ))
        } else {
            Err(err)
        };
    }

    if let Err(err) = cleanup_legacy_artifacts(path, filesystem) {
        return Err(format!(
            "Connection credentials were encrypted, but legacy plaintext cleanup is incomplete: {err}. Close applications that may be using the files and retry."
        ));
    }

    for reference in old_references {
        if let Err(err) = credentials.delete(reference) {
            log::warn!("Failed to remove migrated connection credential '{reference}': {err}");
        }
    }
    log::info!(
        "Migrated {} connection credential(s) to the encrypted connection store",
        config.connections.len()
    );
    Ok(())
}

pub fn save(app: &tauri::AppHandle, config: &ConnectionsConfig) -> Result<(), String> {
    let _guard = STORE_LOCK
        .lock()
        .map_err(|err| format!("Connection store lock poisoned: {err}"))?;
    let path = config_path(app)?;
    save_to_path_with_store_and_fs_and_cache(
        &path,
        config,
        &OsCredentialStore,
        &OsConfigFilesystem,
        Some(&MASTER_KEY_CACHE),
    )
}

#[cfg(test)]
fn save_to_path_with_store(
    path: &Path,
    config: &ConnectionsConfig,
    credentials: &dyn CredentialStore,
) -> Result<(), String> {
    save_to_path_with_store_and_fs(path, config, credentials, &OsConfigFilesystem)
}

#[cfg(test)]
fn save_to_path_with_store_and_fs(
    path: &Path,
    config: &ConnectionsConfig,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
) -> Result<(), String> {
    save_to_path_with_store_and_fs_and_cache(path, config, credentials, filesystem, None)
}

fn save_to_path_with_store_and_fs_and_cache(
    path: &Path,
    config: &ConnectionsConfig,
    credentials: &dyn CredentialStore,
    filesystem: &dyn ConfigFilesystem,
    key_cache: Option<&Mutex<Option<[u8; DATA_KEY_LENGTH]>>>,
) -> Result<(), String> {
    let existing = load_disk_config(path)?;
    if disk_format(&existing)? != DiskFormat::Encrypted {
        return Err(
            "Legacy connection config must be loaded and migrated before it can be saved"
                .to_string(),
        );
    }
    let allow_create = existing.connections.is_empty() && existing.secrets.is_none();
    let (key, created) = if config.connections.is_empty() {
        (None, false)
    } else {
        let (key, created) = master_key(credentials, allow_create, key_cache)?;
        (Some(key), created)
    };
    let persisted = match persisted_config(config, key.as_ref()) {
        Ok(persisted) => persisted,
        Err(err) if created => {
            return Err(rollback_new_master_key(
                credentials,
                key_cache,
                key.expect("a created master key must be present"),
                err,
            ))
        }
        Err(err) => return Err(err),
    };
    if let Err(err) = write_config_with_fs(path, &persisted, BackupMode::CurrentOnly, filesystem) {
        return if created {
            Err(rollback_new_master_key(
                credentials,
                key_cache,
                key.expect("a created master key must be present"),
                err,
            ))
        } else {
            Err(err)
        };
    }
    Ok(())
}

fn persisted_config(
    config: &ConnectionsConfig,
    key: Option<&[u8; DATA_KEY_LENGTH]>,
) -> Result<PersistedConnectionsConfig, String> {
    let mut seen_ids = HashSet::new();
    let mut connections = Vec::with_capacity(config.connections.len());
    let mut credentials = HashMap::with_capacity(config.connections.len());

    for connection in &config.connections {
        if connection.id.is_empty() {
            return Err("Cannot save a connection with an empty ID".to_string());
        }
        if !seen_ids.insert(connection.id.clone()) {
            return Err(format!(
                "Cannot save duplicate connection ID '{}'",
                connection.id
            ));
        }

        credentials.insert(
            connection.id.clone(),
            CredentialPayload::from_connection(connection),
        );
        connections.push(PersistedConnection {
            id: connection.id.clone(),
            name: connection.name.clone(),
            endpoint: public_endpoint(&connection.connection_string),
            credential_ref: None,
            environment: connection.environment.clone(),
            environment_color: connection.environment_color.clone(),
        });
    }

    let secrets = if credentials.is_empty() {
        None
    } else {
        let key = key.ok_or_else(|| "Connection encryption key is unavailable".to_string())?;
        let bundle = CredentialBundle {
            version: SECRET_BUNDLE_VERSION,
            credentials,
        };
        let plaintext = serde_json::to_vec(&bundle)
            .map_err(|err| format!("Failed to serialize connection credentials: {err}"))?;
        Some(crypto::seal_with_key(&plaintext, key)?)
    };

    Ok(PersistedConnectionsConfig {
        version: CONFIG_VERSION,
        connections,
        active_connection_id: config.active_connection_id.clone(),
        secrets,
    })
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

fn write_config_with_fs<T: Serialize + ?Sized>(
    path: &Path,
    config: &T,
    backup_mode: BackupMode,
    filesystem: &dyn ConfigFilesystem,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    let tmp_path = temp_config_path(path);
    let backup_path = backup_config_path(path);
    let backup_tmp_path = temp_config_path(&backup_path);
    let previous_primary = read_optional_file(path, "existing config")?;
    let previous_backup = read_optional_file(&backup_path, "existing config backup")?;
    write_staged_config(&tmp_path, json.as_bytes())?;
    if let Err(err) = write_staged_config(&backup_tmp_path, json.as_bytes()) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    // Commit the recovery copy first. Until it succeeds, the authoritative primary is
    // untouched. If the primary commit then fails, restore the previous backup before
    // returning so callers can safely roll back the credential-store changes.
    if let Err(err) = filesystem.replace_backup(&backup_tmp_path, &backup_path) {
        let rollback =
            restore_backup_snapshot(&backup_path, previous_backup.as_deref(), filesystem);
        let _ = std::fs::remove_file(&tmp_path);
        let _ = std::fs::remove_file(&backup_tmp_path);
        return Err(config_commit_error(
            err,
            rollback.err().into_iter().collect(),
        ));
    }

    if let Err(err) = filesystem.replace_primary(&tmp_path, path, backup_mode) {
        let mut rollback_errors = Vec::new();
        if let Err(rollback_err) =
            restore_primary_snapshot(path, previous_primary.as_deref(), filesystem)
        {
            rollback_errors.push(rollback_err);
        }
        if let Err(rollback_err) =
            restore_backup_snapshot(&backup_path, previous_backup.as_deref(), filesystem)
        {
            rollback_errors.push(rollback_err);
        }
        let _ = std::fs::remove_file(&tmp_path);
        let _ = std::fs::remove_file(&backup_tmp_path);
        return Err(config_commit_error(err, rollback_errors));
    }

    Ok(())
}

fn read_optional_file(path: &Path, description: &str) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Failed to snapshot {description}: {err}")),
    }
}

fn restore_primary_snapshot(
    path: &Path,
    previous: Option<&[u8]>,
    filesystem: &dyn ConfigFilesystem,
) -> Result<(), String> {
    restore_file_snapshot(path, previous, filesystem, false)
}

fn restore_backup_snapshot(
    path: &Path,
    previous: Option<&[u8]>,
    filesystem: &dyn ConfigFilesystem,
) -> Result<(), String> {
    restore_file_snapshot(path, previous, filesystem, true)
}

fn restore_file_snapshot(
    path: &Path,
    previous: Option<&[u8]>,
    filesystem: &dyn ConfigFilesystem,
    is_backup: bool,
) -> Result<(), String> {
    let Some(contents) = previous else {
        if !path.exists() {
            return Ok(());
        }
        return filesystem.remove_file(path).map_err(|err| {
            format!("Failed to remove newly committed config during rollback: {err}")
        });
    };

    let tmp_path = temp_config_path(path);
    write_staged_config(&tmp_path, contents)
        .map_err(|err| format!("Failed to stage config rollback: {err}"))?;
    let result = if is_backup {
        filesystem.replace_backup(&tmp_path, path)
    } else {
        filesystem.replace_primary(&tmp_path, path, BackupMode::CurrentOnly)
    };
    result.map_err(|err| format!("Failed to restore config during rollback: {err}"))
}

fn config_commit_error(cause: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        cause
    } else {
        format!(
            "{cause}. Config-file rollback also failed: {}",
            rollback_errors.join("; ")
        )
    }
}

fn write_staged_config(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create temporary config: {e}"))?;

    #[cfg(unix)]
    {
        use std::fs::Permissions;
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set temporary config permissions: {e}"))?;
    }

    file.write_all(contents)
        .map_err(|e| format!("Failed to write temporary config: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync temporary config: {e}"))
}

fn read_disk_config_file(path: &Path) -> Result<DiskConnectionsConfig, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse config: {e}"))
}

fn restore_primary_from_backup(path: &Path, backup: &Path) -> Result<(), String> {
    let tmp_path = temp_config_path(path);
    std::fs::copy(backup, &tmp_path)
        .map_err(|e| format!("Failed to stage backup config for recovery: {e}"))?;
    sync_file(&tmp_path, "recovered config")?;

    #[cfg(target_os = "windows")]
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("Failed to remove invalid config during recovery: {e}"))?;
    }

    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to restore config backup: {e}"))?;
    secure_file_permissions(path, "recovered config")?;
    sync_parent_dir(path);
    Ok(())
}

fn sync_file(path: &Path, description: &str) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("Failed to open {description} for sync: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync {description}: {e}"))
}

#[cfg(unix)]
fn secure_file_permissions(path: &Path, description: &str) -> Result<(), String> {
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, Permissions::from_mode(0o600))
        .map_err(|e| format!("Failed to secure {description}: {e}"))
}

#[cfg(not(unix))]
fn secure_file_permissions(_path: &Path, _description: &str) -> Result<(), String> {
    Ok(())
}

fn temp_config_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json")
    ))
}

fn backup_config_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.bak",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json")
    ))
}

fn migration_old_config_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.migration-old",
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("json")
    ))
}

#[cfg(not(target_os = "windows"))]
fn replace_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    std::fs::rename(tmp_path, path).map_err(|e| format!("Failed to replace config: {e}"))?;
    sync_parent_dir(path);
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    let old_path = migration_old_config_path(path);
    let _ = std::fs::remove_file(&old_path);
    if path.exists() {
        std::fs::rename(path, &old_path)
            .map_err(|e| format!("Failed to stage existing config for replacement: {e}"))?;
    }
    if let Err(err) = std::fs::rename(tmp_path, path) {
        if old_path.exists() {
            let _ = std::fs::rename(&old_path, path);
        }
        return Err(format!("Failed to replace config: {err}"));
    }
    let _ = std::fs::remove_file(&old_path);
    sync_parent_dir(path);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_migrated_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    replace_config_file(tmp_path, path)
}

#[cfg(target_os = "windows")]
fn replace_migrated_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    let old_path = migration_old_config_path(path);
    let _ = std::fs::remove_file(&old_path);
    if path.exists() {
        std::fs::rename(path, &old_path)
            .map_err(|e| format!("Failed to stage legacy config for migration: {e}"))?;
    }
    if let Err(err) = std::fs::rename(tmp_path, path) {
        if old_path.exists() {
            let _ = std::fs::rename(&old_path, path);
        }
        return Err(format!("Failed to replace legacy config: {err}"));
    }

    sync_parent_dir(path);
    Ok(())
}

fn replace_backup_file(tmp_path: &Path, backup_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if backup_path.exists() {
        std::fs::remove_file(backup_path)
            .map_err(|e| format!("Failed to replace config backup: {e}"))?;
    }

    std::fs::rename(tmp_path, backup_path)
        .map_err(|e| format!("Failed to replace config backup: {e}"))?;
    secure_file_permissions(backup_path, "config backup")?;
    sync_parent_dir(backup_path);
    Ok(())
}

fn cleanup_legacy_artifacts(path: &Path, filesystem: &dyn ConfigFilesystem) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("Connection config has no parent directory for legacy cleanup".to_string());
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err("Connection config filename is not valid UTF-8 for legacy cleanup".to_string());
    };
    let corrupt_prefix = format!("{file_name}.corrupt-");
    let mut artifacts = Vec::new();

    let entries = std::fs::read_dir(parent)
        .map_err(|err| format!("Failed to enumerate legacy connection config artifacts: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| {
            format!("Failed to inspect a legacy connection config artifact: {err}")
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&corrupt_prefix) {
            artifacts.push((entry.path(), format!("legacy artifact '{name}'")));
        }
    }

    let old_path = migration_old_config_path(path);
    if old_path.exists() {
        artifacts.push((old_path, "migration staging file".to_string()));
    }

    let mut errors = Vec::new();
    for (artifact, description) in artifacts {
        if let Err(err) =
            remove_or_sanitize_legacy_artifact(&artifact, path, &description, filesystem)
        {
            errors.push(err);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn remove_or_sanitize_legacy_artifact(
    artifact: &Path,
    sanitized_config: &Path,
    description: &str,
    filesystem: &dyn ConfigFilesystem,
) -> Result<(), String> {
    match filesystem.remove_file(artifact) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(remove_err) => {
            if let Err(overwrite_err) = filesystem.copy_file(sanitized_config, artifact) {
                return Err(format!(
                    "Failed to remove or sanitize connection config {description}: remove failed: {remove_err}; sanitized overwrite failed: {overwrite_err}"
                ));
            }

            sync_file(artifact, description).map_err(|verify_err| {
                format!(
                    "Failed to verify sanitized connection config {description} after removal failed ({remove_err}): {verify_err}"
                )
            })?;
            secure_file_permissions(artifact, description).map_err(|verify_err| {
                format!(
                    "Failed to secure sanitized connection config {description} after removal failed ({remove_err}): {verify_err}"
                )
            })?;

            let expected = std::fs::read(sanitized_config).map_err(|verify_err| {
                format!("Failed to read authoritative sanitized config while verifying {description}: {verify_err}")
            })?;
            let actual = std::fs::read(artifact).map_err(|verify_err| {
                format!("Failed to read sanitized {description} for verification: {verify_err}")
            })?;
            if actual != expected {
                return Err(format!(
                    "Sanitized overwrite verification failed for connection config {description}"
                ));
            }
            Ok(())
        }
    }
}

fn sync_parent_dir(path: &Path) {
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
    let conn = load_connection(app, connection_id)?;
    let mut env = conn.env.clone();
    env.insert(
        "SERVICE_BUS_CONNECTION_STRING".to_string(),
        conn.connection_string.clone(),
    );
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct FakeCredentialStore {
        values: RefCell<HashMap<String, String>>,
        fail_get: RefCell<Option<String>>,
        fail_set: RefCell<Option<String>>,
        fail_delete: RefCell<Option<String>>,
        get_calls: Cell<usize>,
        set_calls: Cell<usize>,
        delete_calls: Cell<usize>,
        get_references: RefCell<Vec<String>>,
    }

    impl FakeCredentialStore {
        fn secret(&self, reference: &str) -> Option<String> {
            self.values.borrow().get(reference).cloned()
        }
    }

    impl CredentialStore for FakeCredentialStore {
        fn get(&self, reference: &str) -> Result<Option<String>, String> {
            self.get_calls.set(self.get_calls.get() + 1);
            self.get_references.borrow_mut().push(reference.to_string());
            if self.fail_get.borrow().as_deref() == Some(reference) {
                return Err(format!("injected get failure for {reference}"));
            }
            Ok(self.values.borrow().get(reference).cloned())
        }

        fn set(&self, reference: &str, secret: &str) -> Result<(), String> {
            self.set_calls.set(self.set_calls.get() + 1);
            if self.fail_set.borrow().as_deref() == Some(reference) {
                return Err(format!("injected set failure for {reference}"));
            }
            self.values
                .borrow_mut()
                .insert(reference.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, reference: &str) -> Result<(), String> {
            self.delete_calls.set(self.delete_calls.get() + 1);
            if self.fail_delete.borrow().as_deref() == Some(reference) {
                return Err(format!("injected delete failure for {reference}"));
            }
            self.values.borrow_mut().remove(reference);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FaultingConfigFilesystem {
        fail_primary_replacements: Cell<usize>,
        fail_backup_replacements: Cell<usize>,
        fail_removals: RefCell<HashSet<PathBuf>>,
        fail_copies: RefCell<HashSet<PathBuf>>,
    }

    impl ConfigFilesystem for FaultingConfigFilesystem {
        fn replace_primary(
            &self,
            tmp_path: &Path,
            path: &Path,
            backup_mode: BackupMode,
        ) -> Result<(), String> {
            let remaining = self.fail_primary_replacements.get();
            if remaining > 0 {
                self.fail_primary_replacements.set(remaining - 1);
                return Err("injected primary replacement failure".to_string());
            }
            OsConfigFilesystem.replace_primary(tmp_path, path, backup_mode)
        }

        fn replace_backup(&self, tmp_path: &Path, backup_path: &Path) -> Result<(), String> {
            let remaining = self.fail_backup_replacements.get();
            if remaining > 0 {
                self.fail_backup_replacements.set(remaining - 1);
                return Err("injected backup replacement failure".to_string());
            }
            OsConfigFilesystem.replace_backup(tmp_path, backup_path)
        }

        fn remove_file(&self, path: &Path) -> std::io::Result<()> {
            if self.fail_removals.borrow().contains(path) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected artifact removal failure",
                ));
            }
            OsConfigFilesystem.remove_file(path)
        }

        fn copy_file(&self, source: &Path, destination: &Path) -> std::io::Result<u64> {
            if self.fail_copies.borrow().contains(destination) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected artifact sanitize failure",
                ));
            }
            OsConfigFilesystem.copy_file(source, destination)
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("busman-store-{name}-{}", std::process::id()))
    }

    fn reset_test_dir(name: &str) -> (PathBuf, PathBuf) {
        let dir = test_dir(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");
        (dir, path)
    }

    fn connection(id: &str, name: &str, secret: &str) -> Connection {
        Connection {
            id: id.to_string(),
            name: name.to_string(),
            connection_string: secret.to_string(),
            env: HashMap::from([("API_TOKEN".to_string(), format!("{secret}-env"))]),
            environment: Some("dev".to_string()),
            environment_color: Some("#123456".to_string()),
        }
    }

    fn config(connections: Vec<Connection>) -> ConnectionsConfig {
        ConnectionsConfig {
            active_connection_id: connections.first().map(|connection| connection.id.clone()),
            connections,
        }
    }

    fn write_per_connection_config(
        path: &Path,
        config: &ConnectionsConfig,
        credentials: &FakeCredentialStore,
    ) {
        let connections: Vec<_> = config
            .connections
            .iter()
            .map(|connection| {
                let reference = credential_reference(&connection.id);
                credentials
                    .set(
                        &reference,
                        &CredentialPayload::from_connection(connection)
                            .serialize()
                            .unwrap(),
                    )
                    .unwrap();
                serde_json::json!({
                    "id": connection.id,
                    "name": connection.name,
                    "credentialRef": reference,
                    "environment": connection.environment,
                    "environmentColor": connection.environment_color,
                })
            })
            .collect();
        let value = serde_json::json!({
            "version": PER_CONNECTION_CONFIG_VERSION,
            "connections": connections,
            "activeConnectionId": config.active_connection_id,
        });
        std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn public_load_reads_metadata_without_opening_the_credential_store() {
        let (dir, path) = reset_test_dir("public-load");
        let credentials = FakeCredentialStore::default();
        let expected = config(vec![connection(
            "conn-1",
            "Production",
            "Endpoint=sb://example.servicebus.windows.net/;SharedAccessKey=secret",
        )]);
        save_to_path_with_store(&path, &expected, &credentials).unwrap();
        credentials.get_calls.set(0);
        *credentials.fail_get.borrow_mut() = Some(MASTER_KEY_REFERENCE.to_string());

        let public = load_public_from_path(&path).unwrap();

        assert_eq!(credentials.get_calls.get(), 0);
        assert_eq!(public.connections.len(), 1);
        assert_eq!(
            public.connections[0].connection_string,
            "Endpoint=sb://example.servicebus.windows.net/;"
        );
        assert!(public.connections[0].env.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selecting_one_connection_migrates_only_that_legacy_keychain_entry() {
        let (dir, path) = reset_test_dir("incremental-migration");
        let credentials = FakeCredentialStore::default();
        let expected = config(vec![
            connection("conn-1", "One", "secret-one"),
            connection("conn-2", "Two", "secret-two"),
            connection("conn-3", "Three", "secret-three"),
        ]);
        write_per_connection_config(&path, &expected, &credentials);
        let cache = Mutex::new(None);

        set_active_from_path_with_fs(&path, Some("conn-2".to_string()), &OsConfigFilesystem)
            .unwrap();
        assert!(credentials.get_references.borrow().is_empty());

        let selected = load_connection_from_path_with_store_and_fs_and_cache(
            &path,
            "conn-2",
            &credentials,
            &OsConfigFilesystem,
            Some(&cache),
        )
        .unwrap();

        assert_eq!(selected.connection_string, "secret-two");
        assert_eq!(
            *credentials.get_references.borrow(),
            vec![
                credential_reference("conn-2"),
                MASTER_KEY_REFERENCE.to_string()
            ]
        );
        assert_eq!(credentials.values.borrow().len(), 3);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        assert!(credentials
            .secret(&credential_reference("conn-2"))
            .is_none());

        load_connection_from_path_with_store_and_fs_and_cache(
            &path,
            "conn-2",
            &credentials,
            &OsConfigFilesystem,
            Some(&cache),
        )
        .unwrap();
        assert_eq!(credentials.get_references.borrow().len(), 2);

        for connection_id in ["conn-1", "conn-3"] {
            load_connection_from_path_with_store_and_fs_and_cache(
                &path,
                connection_id,
                &credentials,
                &OsConfigFilesystem,
                Some(&cache),
            )
            .unwrap();
        }
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"version\": 2"));
        assert!(!raw.contains("credentialRef"));
        assert!(!raw.contains("secret-two"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_per_connection_entries_to_one_master_key() {
        let (dir, path) = reset_test_dir("per-connection-migration");
        let credentials = FakeCredentialStore::default();
        let expected = config(vec![
            connection("conn-1", "One", "secret-one"),
            connection("conn-2", "Two", "secret-two"),
        ]);
        write_per_connection_config(&path, &expected, &credentials);

        let public = load_public_from_path(&path).unwrap();
        assert_eq!(public.connections.len(), 2);
        assert_eq!(credentials.get_calls.get(), 0);

        let loaded = load_from_path_with_store(&path, &credentials).unwrap();

        assert_eq!(loaded.connections[0].connection_string, "secret-one");
        assert_eq!(loaded.connections[1].connection_string, "secret-two");
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        assert!(credentials
            .secret(&credential_reference("conn-1"))
            .is_none());
        assert!(credentials
            .secret(&credential_reference("conn-2"))
            .is_none());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"version\": 2"));
        assert!(raw.contains("\"secrets\""));
        assert!(!raw.contains("credentialRef"));
        assert!(!raw.contains("secret-one"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn master_key_cache_avoids_reopening_the_credential_store() {
        let (dir, path) = reset_test_dir("key-cache");
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "One", "secret-one")]),
            &credentials,
        )
        .unwrap();
        credentials.get_calls.set(0);
        let cache = Mutex::new(None);

        load_from_path_with_store_and_fs_and_cache(
            &path,
            &credentials,
            &OsConfigFilesystem,
            Some(&cache),
        )
        .unwrap();
        load_from_path_with_store_and_fs_and_cache(
            &path,
            &credentials,
            &OsConfigFilesystem,
            Some(&cache),
        )
        .unwrap();

        assert_eq!(credentials.get_calls.get(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_plaintext_and_sanitizes_primary_backup_and_artifacts() {
        let (dir, path) = reset_test_dir("migration");
        let backup = backup_config_path(&path);
        let corrupt = path.with_extension("json.corrupt-legacy");
        let expected = config(vec![connection(
            "conn-1",
            "Legacy",
            "Endpoint=sb://legacy/;SharedAccessKey=legacy-secret",
        )]);
        let legacy = serde_json::to_vec_pretty(&expected).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        std::fs::write(&backup, &legacy).unwrap();
        std::fs::write(&corrupt, &legacy).unwrap();
        let credentials = FakeCredentialStore::default();

        let loaded = load_from_path_with_store(&path, &credentials).unwrap();

        assert_eq!(
            loaded.connections[0].connection_string,
            expected.connections[0].connection_string
        );
        assert_eq!(loaded.connections[0].env, expected.connections[0].env);
        for persisted_path in [&path, &backup] {
            let raw = std::fs::read_to_string(persisted_path).unwrap();
            assert!(!raw.contains("legacy-secret"));
            assert!(!raw.contains("connectionString"));
            assert!(!raw.contains("API_TOKEN"));
            assert!(!raw.contains("credentialRef"));
            assert!(raw.contains("\"secrets\""));
            assert!(raw.contains("\"endpoint\""));
        }
        assert!(!corrupt.exists());
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_master_key_set_failure_keeps_plaintext() {
        let (dir, path) = reset_test_dir("migration-set-failure");
        let expected = config(vec![
            connection("conn-1", "One", "secret-one"),
            connection("conn-2", "Two", "secret-two"),
        ]);
        let legacy = serde_json::to_string_pretty(&expected).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        let credentials = FakeCredentialStore::default();
        *credentials.fail_set.borrow_mut() = Some(MASTER_KEY_REFERENCE.to_string());

        let err = load_from_path_with_store(&path, &credentials).unwrap_err();

        assert!(err.contains("injected set failure"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        assert!(credentials.values.borrow().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_write_failure_keeps_plaintext_and_rolls_back_credential() {
        let (dir, path) = reset_test_dir("migration-write-failure");
        let expected = config(vec![connection("conn-1", "One", "legacy-secret")]);
        let legacy = serde_json::to_string_pretty(&expected).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        std::fs::create_dir(temp_config_path(&path)).unwrap();
        let credentials = FakeCredentialStore::default();

        let err = load_from_path_with_store(&path, &credentials).unwrap_err();

        assert!(err.contains("temporary config"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn create_update_and_delete_round_trip_through_secure_store() {
        let (dir, path) = reset_test_dir("crud");
        let credentials = FakeCredentialStore::default();
        let first = connection("conn-1", "One", "secret-one");
        let second = connection("conn-2", "Two", "secret-two");
        save_to_path_with_store(&path, &config(vec![first, second]), &credentials).unwrap();

        let mut updated = connection("conn-1", "Renamed", "secret-one-updated");
        updated.environment = Some("prod".to_string());
        save_to_path_with_store(&path, &config(vec![updated.clone()]), &credentials).unwrap();

        let loaded = load_from_path_with_store(&path, &credentials).unwrap();
        assert_eq!(loaded.connections.len(), 1);
        assert_eq!(loaded.connections[0].name, "Renamed");
        assert_eq!(
            loaded.connections[0].connection_string,
            "secret-one-updated"
        );
        assert_eq!(loaded.connections[0].environment.as_deref(), Some("prod"));
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_write_failure_restores_previous_credential_and_metadata() {
        let (dir, path) = reset_test_dir("save-rollback");
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "Before", "old-secret")]),
            &credentials,
        )
        .unwrap();
        let previous_json = std::fs::read_to_string(&path).unwrap();
        let previous_key = credentials.secret(MASTER_KEY_REFERENCE).unwrap();
        std::fs::create_dir(temp_config_path(&path)).unwrap();

        let err = save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "After", "new-secret")]),
            &credentials,
        )
        .unwrap_err();

        assert!(err.contains("temporary config"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), previous_json);
        assert_eq!(credentials.secret(MASTER_KEY_REFERENCE), Some(previous_key));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_refresh_failure_rolls_back_delete_before_it_can_be_reported_successful() {
        let (dir, path) = reset_test_dir("backup-rollback");
        let backup = backup_config_path(&path);
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "One", "secret-one")]),
            &credentials,
        )
        .unwrap();
        let previous_primary = std::fs::read(&path).unwrap();
        let previous_backup = std::fs::read(&backup).unwrap();
        let previous_key = credentials.secret(MASTER_KEY_REFERENCE).unwrap();
        let filesystem = FaultingConfigFilesystem::default();
        filesystem.fail_backup_replacements.set(1);

        let err =
            save_to_path_with_store_and_fs(&path, &config(Vec::new()), &credentials, &filesystem)
                .unwrap_err();

        assert!(err.contains("injected backup replacement failure"));
        assert_eq!(std::fs::read(&path).unwrap(), previous_primary);
        assert_eq!(std::fs::read(&backup).unwrap(), previous_backup);
        assert_eq!(credentials.secret(MASTER_KEY_REFERENCE), Some(previous_key));

        std::fs::remove_file(&path).unwrap();
        let recovered = load_from_path_with_store(&path, &credentials).unwrap();
        assert_eq!(recovered.connections.len(), 1);
        assert_eq!(recovered.connections[0].id, "conn-1");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_refresh_failure_rolls_back_import_replacement_before_corrupt_recovery() {
        let (dir, path) = reset_test_dir("backup-import-rollback");
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-old", "Old", "old-secret")]),
            &credentials,
        )
        .unwrap();
        let filesystem = FaultingConfigFilesystem::default();
        filesystem.fail_backup_replacements.set(1);

        let err = save_to_path_with_store_and_fs(
            &path,
            &config(vec![connection("conn-imported", "Imported", "new-secret")]),
            &credentials,
            &filesystem,
        )
        .unwrap_err();

        assert!(err.contains("injected backup replacement failure"));
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());

        std::fs::write(&path, "{broken").unwrap();
        let recovered = load_from_path_with_store(&path, &credentials).unwrap();
        assert_eq!(recovered.connections.len(), 1);
        assert_eq!(recovered.connections[0].id, "conn-old");
        assert_eq!(recovered.connections[0].connection_string, "old-secret");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn primary_replace_failure_restores_backup_and_credentials() {
        let (dir, path) = reset_test_dir("primary-rollback");
        let backup = backup_config_path(&path);
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-old", "Old", "old-secret")]),
            &credentials,
        )
        .unwrap();
        let previous_primary = std::fs::read(&path).unwrap();
        let previous_backup = std::fs::read(&backup).unwrap();
        let filesystem = FaultingConfigFilesystem::default();
        filesystem.fail_primary_replacements.set(1);

        let err = save_to_path_with_store_and_fs(
            &path,
            &config(vec![connection("conn-new", "New", "new-secret")]),
            &credentials,
            &filesystem,
        )
        .unwrap_err();

        assert!(err.contains("injected primary replacement failure"));
        assert_eq!(std::fs::read(&path).unwrap(), previous_primary);
        assert_eq!(std::fs::read(&backup).unwrap(), previous_backup);
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn successful_delete_updates_recovery_backup_and_cannot_resurrect() {
        let (dir, path) = reset_test_dir("delete-recovery");
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "One", "secret-one")]),
            &credentials,
        )
        .unwrap();

        save_to_path_with_store(&path, &config(Vec::new()), &credentials).unwrap();
        assert_eq!(credentials.values.borrow().len(), 1);
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());

        std::fs::write(&path, "{broken").unwrap();
        let recovered = load_from_path_with_store(&path, &credentials).unwrap();
        assert!(recovered.connections.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_cleanup_failure_is_actionable_and_keeps_secure_config_authoritative() {
        let (dir, path) = reset_test_dir("migration-cleanup-failure");
        let backup = backup_config_path(&path);
        let old = migration_old_config_path(&path);
        let expected = config(vec![connection("conn-1", "One", "legacy-secret")]);
        let legacy = serde_json::to_vec_pretty(&expected).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        std::fs::write(&backup, &legacy).unwrap();
        std::fs::write(&old, &legacy).unwrap();
        let credentials = FakeCredentialStore::default();
        let filesystem = FaultingConfigFilesystem::default();
        filesystem.fail_removals.borrow_mut().insert(old.clone());
        filesystem.fail_copies.borrow_mut().insert(old.clone());

        let err = load_from_path_with_store_and_fs(&path, &credentials, &filesystem).unwrap_err();

        assert!(err.contains("legacy plaintext cleanup is incomplete"));
        assert!(err.contains("injected artifact removal failure"));
        assert!(err.contains("injected artifact sanitize failure"));
        for persisted_path in [&path, &backup] {
            let raw = std::fs::read_to_string(persisted_path).unwrap();
            assert!(!raw.contains("legacy-secret"));
            assert!(!raw.contains("connectionString"));
            assert!(!raw.contains("credentialRef"));
            assert!(raw.contains("\"secrets\""));
        }
        assert!(std::fs::read_to_string(&old)
            .unwrap()
            .contains("legacy-secret"));
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());

        let loaded = load_from_path_with_store(&path, &credentials).unwrap();
        assert_eq!(loaded.connections[0].connection_string, "legacy-secret");
        assert!(!old.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_verifies_sanitized_overwrite_when_artifact_removal_fails() {
        let (dir, path) = reset_test_dir("migration-sanitize-fallback");
        let old = migration_old_config_path(&path);
        let expected = config(vec![connection("conn-1", "One", "legacy-secret")]);
        let legacy = serde_json::to_vec_pretty(&expected).unwrap();
        std::fs::write(&path, &legacy).unwrap();
        std::fs::write(&old, &legacy).unwrap();
        let credentials = FakeCredentialStore::default();
        let filesystem = FaultingConfigFilesystem::default();
        filesystem.fail_removals.borrow_mut().insert(old.clone());

        let loaded = load_from_path_with_store_and_fs(&path, &credentials, &filesystem).unwrap();

        assert_eq!(loaded.connections[0].connection_string, "legacy-secret");
        let sanitized = std::fs::read(&path).unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), sanitized);
        assert!(!String::from_utf8(sanitized)
            .unwrap()
            .contains("legacy-secret"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn per_connection_migration_delete_failure_leaves_only_an_orphan() {
        let (dir, path) = reset_test_dir("migration-delete-failure");
        let credentials = FakeCredentialStore::default();
        let expected = config(vec![connection("conn-1", "One", "secret-one")]);
        write_per_connection_config(&path, &expected, &credentials);
        *credentials.fail_delete.borrow_mut() = Some(credential_reference("conn-1"));

        let loaded = load_from_path_with_store(&path, &credentials).unwrap();

        assert_eq!(loaded.connections[0].connection_string, "secret-one");
        assert!(credentials
            .secret(&credential_reference("conn-1"))
            .is_some());
        assert!(credentials.secret(MASTER_KEY_REFERENCE).is_some());
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("secret-one"));
        assert!(!raw.contains("credentialRef"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persisted_serialization_contains_only_metadata_and_encrypted_blob() {
        let secret = "Endpoint=sb://example/;SharedAccessKey=do-not-persist";
        let runtime = config(vec![connection("conn-1", "Production", secret)]);
        let key = crypto::generate_data_key();
        let persisted = persisted_config(&runtime, Some(&key)).unwrap();

        let raw = serde_json::to_string_pretty(&persisted).unwrap();

        assert!(!raw.contains(secret));
        assert!(!raw.contains("do-not-persist-env"));
        assert!(!raw.contains("connectionString"));
        assert!(!raw.contains("\"env\""));
        assert!(!raw.contains("credentialRef"));
        assert!(raw.contains("\"endpoint\""));
        assert!(raw.contains("\"secrets\""));
    }

    #[test]
    fn secure_store_round_trip_preserves_encrypted_export_import_shape() {
        let (dir, path) = reset_test_dir("encrypted-export");
        let credentials = FakeCredentialStore::default();
        let expected = connection(
            "conn-1",
            "Exported",
            "Endpoint=sb://example/;SharedAccessKey=export-secret",
        );
        save_to_path_with_store(&path, &config(vec![expected.clone()]), &credentials).unwrap();
        let hydrated = load_from_path_with_store(&path, &credentials).unwrap();

        let plaintext = serde_json::to_vec(&hydrated.connections).unwrap();
        let encrypted = crate::crypto::encrypt(&plaintext, "password").unwrap();
        let decrypted = crate::crypto::decrypt(&encrypted, "password").unwrap();
        let imported: Vec<Connection> = serde_json::from_slice(&decrypted).unwrap();

        assert_eq!(imported[0].connection_string, expected.connection_string);
        assert_eq!(imported[0].env, expected.env);
        assert_eq!(imported[0].environment, expected.environment);
        assert_eq!(imported[0].environment_color, expected.environment_color);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restores_valid_backup_when_primary_is_corrupt() {
        let (dir, path) = reset_test_dir("recovery");
        let backup = backup_config_path(&path);
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "Recovered", "secret")]),
            &credentials,
        )
        .unwrap();
        std::fs::copy(&path, &backup).unwrap();
        std::fs::write(&path, "{broken").unwrap();

        let recovered = load_from_path_with_store(&path, &credentials).unwrap();

        assert_eq!(recovered.connections.len(), 1);
        assert_eq!(recovered.connections[0].name, "Recovered");
        assert!(read_disk_config_file(&path).is_ok());
        assert!(!std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restores_backup_when_primary_is_missing() {
        let (dir, path) = reset_test_dir("missing-primary");
        let backup = backup_config_path(&path);
        let credentials = FakeCredentialStore::default();
        save_to_path_with_store(
            &path,
            &config(vec![connection("conn-1", "Recovered", "secret")]),
            &credentials,
        )
        .unwrap();
        std::fs::copy(&path, &backup).unwrap();
        std::fs::remove_file(&path).unwrap();

        let recovered = load_from_path_with_store(&path, &credentials).unwrap();

        assert_eq!(recovered.connections.len(), 1);
        assert!(path.exists());
        assert!(read_disk_config_file(&path).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
