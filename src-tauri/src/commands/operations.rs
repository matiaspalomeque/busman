use super::worker::{
    call_worker, emit_done, redact_secrets, resolve_sidecar_path, scripts_dir, worker_sidecar_name,
    WORKER_CANCELLED_PREFIX,
};
use crate::models::ScriptOutputLine;
use crate::store;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// ─── Worker lifecycle commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn stop_current_operation(app: AppHandle, run_id: String) -> Result<(), String> {
    call_worker(
        &app,
        "cancelRun",
        json!({ "runId": &run_id }),
        Some(Duration::from_secs(12)),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub fn is_portable() -> bool {
    #[cfg(target_os = "windows")]
    {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return false,
        };
        let exe_lower = exe.to_string_lossy().to_lowercase();
        let install_roots = [
            std::env::var("ProgramFiles").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];
        let is_installed = install_roots
            .iter()
            .flatten()
            .any(|root| exe_lower.starts_with(&root.to_lowercase()));
        !is_installed
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn check_worker(app: AppHandle) -> bool {
    if scripts_dir(&app)
        .map(|scripts| scripts.join(worker_sidecar_name()).exists())
        .unwrap_or(false)
    {
        return true;
    }
    cfg!(target_os = "windows")
}

#[tauri::command]
pub async fn ensure_scripts_ready(app: AppHandle) -> Result<(), String> {
    resolve_sidecar_path(&app)?;
    let _ = call_worker(&app, "health", json!({}), Some(Duration::from_secs(30))).await?;
    Ok(())
}

// ─── Streaming operation helpers ────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCompletion {
    pub exit_code: i32,
    pub elapsed_ms: u64,
    pub error_message: Option<String>,
    pub result: Option<Value>,
}

async fn run_worker_operation(
    app: &AppHandle,
    method: &str,
    params: Value,
    run_id: &str,
) -> Result<OperationCompletion, String> {
    let started = Instant::now();
    let response = call_worker(app, method, params, None).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let completion = match response {
        Ok(result) => {
            if matches!(
                method,
                "emptyMessages"
                    | "moveMessages"
                    | "republishSubscriptionDlq"
                    | "singleMessageAction"
            ) {
                match crate::operation_outcome::OperationOutcome::parse(result, run_id) {
                    Ok(outcome) => OperationCompletion {
                        exit_code: outcome.exit_code(),
                        elapsed_ms,
                        error_message: outcome.error_message.clone(),
                        result: Some(json!(outcome)),
                    },
                    Err(error) => OperationCompletion {
                        exit_code: -2,
                        elapsed_ms,
                        error_message: Some(error),
                        result: None,
                    },
                }
            } else {
                OperationCompletion {
                    exit_code: 0,
                    elapsed_ms,
                    error_message: None,
                    result: Some(result),
                }
            }
        }
        Err(err) if err.starts_with(WORKER_CANCELLED_PREFIX) => OperationCompletion {
            exit_code: 130,
            elapsed_ms,
            error_message: None,
            result: None,
        },
        Err(err) => {
            let error = redact_secrets(&err);
            let _ = app.emit(
                &format!("script-output:{run_id}"),
                ScriptOutputLine {
                    line: format!("Error: {error}"),
                    is_stderr: true,
                    elapsed_ms,
                },
            );
            OperationCompletion {
                exit_code: -2,
                elapsed_ms,
                error_message: Some(error),
                result: None,
            }
        }
    };
    // Both transports carry the terminal result. A lost event cannot strand the UI.
    let _ = app.emit(&format!("script-done:{run_id}"), &completion);
    Ok(completion)
}

// ─── Streaming operation commands ───────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct EmptyMessagesArgs {
    #[serde(rename = "queueName", default)]
    pub queue_name: Option<String>,
    #[serde(rename = "topicName", default)]
    pub topic_name: Option<String>,
    #[serde(rename = "subscriptionName", default)]
    pub subscription_name: Option<String>,
    pub mode: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn empty_messages(
    app: AppHandle,
    args: EmptyMessagesArgs,
) -> Result<OperationCompletion, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "emptyMessages",
        json!({
            "queueName": args.queue_name.unwrap_or_default(),
            "topicName": args.topic_name.unwrap_or_default(),
            "subscriptionName": args.subscription_name.unwrap_or_default(),
            "mode": args.mode,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct MoveMessagesArgs {
    #[serde(rename = "sourceQueue", default)]
    pub source_queue: Option<String>,
    #[serde(rename = "destQueue")]
    pub dest_queue: String,
    #[serde(rename = "topicName", default)]
    pub topic_name: Option<String>,
    #[serde(rename = "subscriptionName", default)]
    pub subscription_name: Option<String>,
    pub mode: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn move_messages(
    app: AppHandle,
    args: MoveMessagesArgs,
) -> Result<OperationCompletion, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "moveMessages",
        json!({
            "sourceQueue": args.source_queue.unwrap_or_default(),
            "destQueue": args.dest_queue,
            "topicName": args.topic_name.unwrap_or_default(),
            "subscriptionName": args.subscription_name.unwrap_or_default(),
            "mode": args.mode,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct RepublishSubscriptionDlqArgs {
    #[serde(rename = "topicName")]
    pub topic_name: String,
    #[serde(rename = "subscriptionName")]
    pub subscription_name: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn republish_subscription_dlq(
    app: AppHandle,
    args: RepublishSubscriptionDlqArgs,
) -> Result<OperationCompletion, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "republishSubscriptionDlq",
        json!({
            "topicName": args.topic_name,
            "subscriptionName": args.subscription_name,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct SearchMessagesArgs {
    #[serde(rename = "queueName")]
    pub queue_name: String,
    #[serde(rename = "searchString")]
    pub search_string: String,
    pub mode: String,
    #[serde(rename = "maxMatches")]
    pub max_matches: u32,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn search_messages(
    app: AppHandle,
    args: SearchMessagesArgs,
) -> Result<OperationCompletion, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "searchMessages",
        json!({
            "queueName": args.queue_name,
            "searchString": args.search_string,
            "mode": args.mode,
            "maxMatches": args.max_matches,
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

// ─── Peek messages ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, Deserialize)]
pub struct PeekResult {
    pub messages: serde_json::Value,
}

const PEEK_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(serde::Deserialize)]
pub struct PeekArgs {
    pub argv: Vec<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn peek_messages(app: AppHandle, args: PeekArgs) -> Result<PeekResult, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    let started = Instant::now();
    let run_id = args.run_id.clone();

    let worker_result = call_worker(
        &app,
        "peekMessages",
        json!({
          "argv": args.argv,
          "env": env,
          "runId": run_id,
        }),
        Some(PEEK_REQUEST_TIMEOUT),
    )
    .await;

    match worker_result {
        Ok(value) => {
            let result: PeekResult = serde_json::from_value(value)
                .map_err(|e| format!("Invalid peek result from worker: {e}"))?;
            emit_done(&app, &run_id, 0, started.elapsed().as_millis() as u64);
            Ok(result)
        }
        Err(err) => {
            if err.starts_with(WORKER_CANCELLED_PREFIX) {
                emit_done(&app, &run_id, 130, started.elapsed().as_millis() as u64);
                Err("Operation cancelled.".to_string())
            } else {
                emit_done(&app, &run_id, -1, started.elapsed().as_millis() as u64);
                Err(redact_secrets(&err))
            }
        }
    }
}

// ─── Send message ───────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SendMessageArgs {
    #[serde(rename = "entityName")]
    pub entity_name: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "entityKind")]
    pub entity_kind: SendEntityKind,
    pub message: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SendEntityKind {
    Queue,
    Topic,
}

impl SendEntityKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Topic => "topic",
        }
    }
}

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn parse_sequence_number(value: &str) -> Result<i64, String> {
    let bytes = value.as_bytes();
    let canonical = value == "0"
        || (!bytes.is_empty()
            && matches!(bytes[0], b'1'..=b'9')
            && bytes[1..].iter().all(u8::is_ascii_digit));
    if !canonical {
        return Err("sequenceNumber must be a canonical non-negative decimal string".to_string());
    }
    value
        .parse::<i64>()
        .map_err(|_| "sequenceNumber must be within the signed 64-bit range".to_string())
}

fn deserialize_sequence_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SequenceNumberInput {
        String(String),
        LegacyInteger(i64),
    }

    match SequenceNumberInput::deserialize(deserializer)? {
        SequenceNumberInput::String(value) => {
            parse_sequence_number(&value).map_err(serde::de::Error::custom)?;
            Ok(value)
        }
        SequenceNumberInput::LegacyInteger(value)
            if (0..=JAVASCRIPT_MAX_SAFE_INTEGER).contains(&value) =>
        {
            Ok(value.to_string())
        }
        SequenceNumberInput::LegacyInteger(_) => Err(serde::de::Error::custom(
            "numeric sequenceNumber is accepted only within JavaScript's exact integer range; send a decimal string",
        )),
    }
}

#[cfg(test)]
mod sequence_number_tests {
    use super::*;

    #[derive(Deserialize)]
    struct SequenceNumberArg {
        #[serde(
            rename = "sequenceNumber",
            deserialize_with = "deserialize_sequence_number"
        )]
        sequence_number: String,
    }

    #[test]
    fn parses_boundary_sequence_number_strings_exactly() {
        for value in [
            "0",
            "9007199254740993",
            "9288674231451771",
            "9223372036854775807",
        ] {
            let parsed = parse_sequence_number(value).unwrap();
            assert_eq!(parsed.to_string(), value);
        }
    }

    #[test]
    fn rejects_non_canonical_and_out_of_range_sequence_numbers() {
        for value in [
            "",
            "-1",
            "+1",
            "01",
            " 1",
            "1 ",
            "1.0",
            "9223372036854775808",
        ] {
            assert!(parse_sequence_number(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn accepts_only_exact_legacy_numeric_ipc_values() {
        let parsed: SequenceNumberArg =
            serde_json::from_value(json!({ "sequenceNumber": 42 })).unwrap();
        assert_eq!(parsed.sequence_number, "42");

        let rounded_risk = serde_json::from_value::<SequenceNumberArg>(
            json!({ "sequenceNumber": 9_007_199_254_740_992_i64 }),
        );
        assert!(rounded_risk.is_err());
    }

    #[test]
    fn atomic_worker_payload_uses_the_exact_i64_target() {
        let parsed = parse_sequence_number("9007199254740993").unwrap();
        let payload = json!({ "sequenceNumber": parsed });
        assert_eq!(
            payload["sequenceNumber"].as_i64(),
            Some(9_007_199_254_740_993)
        );
        assert_eq!(
            payload.to_string(),
            r#"{"sequenceNumber":9007199254740993}"#
        );
    }
}

#[derive(serde::Deserialize)]
pub struct SingleMessageActionArgs {
    pub action: String,
    #[serde(
        rename = "sequenceNumber",
        deserialize_with = "deserialize_sequence_number"
    )]
    pub sequence_number: String,
    #[serde(rename = "messageId", default)]
    pub message_id: Option<String>,
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(rename = "sourceSubQueue", default)]
    pub source_sub_queue: Option<String>,
    #[serde(rename = "isDlq")]
    pub is_dlq: bool,
    #[serde(rename = "queueName", default)]
    pub queue_name: Option<String>,
    #[serde(rename = "topicName", default)]
    pub topic_name: Option<String>,
    #[serde(rename = "subscriptionName", default)]
    pub subscription_name: Option<String>,
    #[serde(rename = "destQueue", default)]
    pub dest_queue: Option<String>,
    #[serde(rename = "destTopic", default)]
    pub dest_topic: Option<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

#[tauri::command]
pub async fn single_message_action(
    app: AppHandle,
    args: SingleMessageActionArgs,
) -> Result<OperationCompletion, String> {
    let sequence_number = parse_sequence_number(&args.sequence_number)?;
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    run_worker_operation(
        &app,
        "singleMessageAction",
        json!({
            "action": args.action,
            "sequenceNumber": sequence_number,
            "messageId": args.message_id.unwrap_or_default(),
            "sessionId": args.session_id,
            "state": args.state.unwrap_or_default(),
            "source": args.source.unwrap_or_default(),
            "sourceSubQueue": args.source_sub_queue.unwrap_or_default(),
            "isDlq": args.is_dlq,
            "queueName": args.queue_name.unwrap_or_default(),
            "topicName": args.topic_name.unwrap_or_default(),
            "subscriptionName": args.subscription_name.unwrap_or_default(),
            "destQueue": args.dest_queue.unwrap_or_default(),
            "destTopic": args.dest_topic.unwrap_or_default(),
            "env": env,
            "runId": args.run_id,
        }),
        &args.run_id,
    )
    .await
}

#[tauri::command]
pub async fn send_message(app: AppHandle, args: SendMessageArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "sendMessage",
        json!({
            "entityName": args.entity_name,
            "entityKind": args.entity_kind.as_str(),
            "env": env,
            "message": args.message,
        }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

// ─── Known-session state management ───────────────────────────────────────

const MAX_SESSION_STATE_BYTES: usize = (32 * 1024 * 1024 * 3 / 4) - (64 * 1024);
const MAX_SESSION_STATE_BASE64_BYTES: usize = MAX_SESSION_STATE_BYTES.div_ceil(3) * 4;

#[derive(serde::Deserialize)]
pub struct SessionStateTargetArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "queueName", default)]
    pub queue_name: Option<String>,
    #[serde(rename = "topicName", default)]
    pub topic_name: Option<String>,
    #[serde(rename = "subscriptionName", default)]
    pub subscription_name: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(serde::Deserialize)]
pub struct SetSessionStateArgs {
    #[serde(flatten)]
    pub target: SessionStateTargetArgs,
    #[serde(rename = "stateBase64")]
    pub state_base64: String,
}

fn validate_session_state_base64(value: &str) -> Result<(), String> {
    if value.len() > MAX_SESSION_STATE_BASE64_BYTES {
        return Err(format!(
            "Session state exceeds the {MAX_SESSION_STATE_BYTES}-byte decoded payload limit"
        ));
    }
    let decoded = BASE64
        .decode(value)
        .map_err(|_| "Session state must be canonical standard base64".to_string())?;
    if decoded.len() > MAX_SESSION_STATE_BYTES || BASE64.encode(decoded) != value {
        return Err("Session state must be canonical standard base64".to_string());
    }
    Ok(())
}

fn session_state_worker_params(
    args: &SessionStateTargetArgs,
    action: &str,
    state_base64: Option<&str>,
) -> Result<Value, String> {
    if args.session_id.trim().is_empty() {
        return Err("Session Id is required".to_string());
    }
    let queue = args.queue_name.as_deref().filter(|name| !name.is_empty());
    let topic = args.topic_name.as_deref().filter(|name| !name.is_empty());
    let subscription = args
        .subscription_name
        .as_deref()
        .filter(|name| !name.is_empty());
    match (queue, topic, subscription) {
        (Some(_), None, None) | (None, Some(_), Some(_)) => {}
        _ => {
            return Err(
                "Provide exactly one parent queue or one topic/subscription pair".to_string(),
            )
        }
    }

    let mut payload = json!({
        "action": action,
        "queueName": queue.unwrap_or_default(),
        "topicName": topic.unwrap_or_default(),
        "subscriptionName": subscription.unwrap_or_default(),
        "sessionId": args.session_id,
    });
    if let Some(state) = state_base64 {
        payload["stateBase64"] = Value::String(state.to_string());
    }
    Ok(payload)
}

async fn call_session_state(
    app: &AppHandle,
    args: &SessionStateTargetArgs,
    action: &str,
    state_base64: Option<&str>,
) -> Result<Value, String> {
    if let Some(state) = state_base64 {
        validate_session_state_base64(state)?;
    }
    let env = store::resolve_connection_env(app, &args.connection_id)?;
    let mut params = session_state_worker_params(args, action, state_base64)?;
    params["env"] = json!(env);
    call_worker(app, "sessionState", params, Some(Duration::from_secs(60)))
        .await
        .map_err(|e| redact_secrets(&e))
}

#[tauri::command]
pub async fn get_session_state(
    app: AppHandle,
    args: SessionStateTargetArgs,
) -> Result<Value, String> {
    call_session_state(&app, &args, "get", None).await
}

#[tauri::command]
pub async fn set_session_state(app: AppHandle, args: SetSessionStateArgs) -> Result<Value, String> {
    call_session_state(&app, &args.target, "set", Some(&args.state_base64)).await
}

#[tauri::command]
pub async fn clear_session_state(
    app: AppHandle,
    args: SessionStateTargetArgs,
) -> Result<Value, String> {
    call_session_state(&app, &args, "clear", None).await
}

#[cfg(test)]
mod session_state_tests {
    use super::*;

    #[test]
    fn send_entity_kind_is_explicit_and_rejects_unknown_values() {
        let queue: SendMessageArgs = serde_json::from_value(json!({
            "entityName": "orders",
            "entityKind": "queue",
            "connectionId": "connection-1",
            "message": {},
        }))
        .unwrap();
        assert_eq!(queue.entity_kind.as_str(), "queue");
        assert!(serde_json::from_value::<SendMessageArgs>(json!({
            "entityName": "events",
            "entityKind": "subscription",
            "connectionId": "connection-1",
            "message": {},
        }))
        .is_err());
    }

    #[test]
    fn known_session_target_maps_only_parent_queue_or_subscription() {
        let queue: SessionStateTargetArgs = serde_json::from_value(json!({
            "connectionId": "connection-1",
            "queueName": "orders",
            "sessionId": "session-42",
        }))
        .unwrap();
        let payload = session_state_worker_params(&queue, "get", None).unwrap();
        assert_eq!(payload["queueName"], "orders");
        assert_eq!(payload["topicName"], "");
        assert_eq!(payload["sessionId"], "session-42");

        let subscription: SessionStateTargetArgs = serde_json::from_value(json!({
            "connectionId": "connection-1",
            "topicName": "events",
            "subscriptionName": "processor",
            "sessionId": "session-42",
        }))
        .unwrap();
        let payload = session_state_worker_params(&subscription, "clear", None).unwrap();
        assert_eq!(payload["queueName"], "");
        assert_eq!(payload["topicName"], "events");
        assert_eq!(payload["subscriptionName"], "processor");

        let ambiguous: SessionStateTargetArgs = serde_json::from_value(json!({
            "connectionId": "connection-1",
            "queueName": "orders/$DeadLetterQueue",
            "topicName": "events",
            "subscriptionName": "processor",
            "sessionId": "session-42",
        }))
        .unwrap();
        assert!(session_state_worker_params(&ambiguous, "get", None).is_err());
    }

    #[test]
    fn session_state_base64_validation_is_lossless_canonical_and_bounded() {
        assert!(validate_session_state_base64("AP+A").is_ok());
        for invalid in ["_w==", "AA", "A===", " AA==", "AA==\n"] {
            assert!(validate_session_state_base64(invalid).is_err());
        }
        let oversized = "A".repeat(MAX_SESSION_STATE_BASE64_BYTES + 1);
        let error = validate_session_state_base64(&oversized).unwrap_err();
        assert!(error.contains("payload limit"));
    }
}
