use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(rename = "connectionString")]
    pub connection_string: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct ConnectionsConfig {
    pub connections: Vec<Connection>,
    #[serde(rename = "activeConnectionId")]
    pub active_connection_id: Option<String>,
}

/// Emitted to frontend per stdout/stderr line during script execution.
#[derive(Debug, Serialize, Clone)]
pub struct ScriptOutputLine {
    pub line: String,
    #[serde(rename = "isStderr")]
    pub is_stderr: bool,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

/// Emitted when a \r-overwrite progress update is received.
#[derive(Debug, Serialize, Clone)]
pub struct ScriptProgress {
    pub text: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

/// Emitted when script exits.
#[derive(Debug, Serialize, Clone)]
pub struct ScriptDonePayload {
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}
