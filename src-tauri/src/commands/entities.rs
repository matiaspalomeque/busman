use super::worker::{call_worker, redact_secrets};
use crate::error::BusmanError;
use crate::store;
use serde_json::json;
use std::{collections::HashMap, time::Duration};
use tauri::AppHandle;

// ─── Entity inspection ──────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ListEntitiesResult {
    pub queues: Vec<String>,
    pub topics: HashMap<String, Vec<String>>,
}

#[derive(serde::Serialize)]
pub struct TestConnectionResult {
    #[serde(rename = "queueCount")]
    pub queue_count: usize,
    #[serde(rename = "topicCount")]
    pub topic_count: usize,
}

/// Validate a connection string by listing entities with a short timeout.
/// This is the ONLY command that still accepts a raw connection string,
/// because it's used to test unsaved connections before persisting.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    connection_string: String,
) -> Result<TestConnectionResult, String> {
    let trimmed = connection_string.trim();
    if !trimmed.to_lowercase().starts_with("endpoint=sb://") {
        return Err(BusmanError::Validation("Invalid Service Bus connection string format".to_string()).into());
    }
    let mut env = HashMap::new();
    env.insert("SERVICE_BUS_CONNECTION_STRING".to_string(), trimmed.to_string());
    let value = call_worker(
        &app,
        "listEntities",
        json!({ "env": env }),
        Some(Duration::from_secs(10)),
    )
    .await
    .map_err(|e| redact_secrets(&e))?;
    let entities: ListEntitiesResult =
        serde_json::from_value(value).map_err(|e| format!("Failed to parse: {e}"))?;
    Ok(TestConnectionResult {
        queue_count: entities.queues.len(),
        topic_count: entities.topics.len(),
    })
}

#[derive(serde::Deserialize)]
pub struct ListEntitiesArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
}

/// List queues/topics/subscriptions through the long-lived Service Bus worker.
#[tauri::command]
pub async fn list_entities(
    app: AppHandle,
    args: ListEntitiesArgs,
) -> Result<ListEntitiesResult, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    let value = call_worker(&app, "listEntities", json!({ "env": env }), Some(Duration::from_secs(60)))
        .await
        .map_err(|e| redact_secrets(&e))?;
    serde_json::from_value(value).map_err(|e| format!("Failed to parse entity list: {e}"))
}

// ─── Entity counts ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubscriptionRef {
    pub topic: String,
    pub name: String,
}

#[derive(serde::Deserialize)]
pub struct GetEntityCountsArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub queues: Vec<String>,
    pub subscriptions: Vec<SubscriptionRef>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct QueueCountResult {
    pub name: String,
    pub active: i64,
    pub dlq: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubscriptionCountResult {
    pub topic: String,
    pub subscription: String,
    pub active: i64,
    pub dlq: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct EntityCountsResult {
    pub queues: Vec<QueueCountResult>,
    pub subscriptions: Vec<SubscriptionCountResult>,
}

#[tauri::command]
pub async fn get_entity_counts(
    app: AppHandle,
    args: GetEntityCountsArgs,
) -> Result<EntityCountsResult, String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    let value = call_worker(
        &app,
        "getEntityCounts",
        serde_json::json!({
            "env": env,
            "queues": args.queues,
            "subscriptions": args.subscriptions,
        }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))?;

    serde_json::from_value(value).map_err(|e| format!("Failed to parse entity counts: {e}"))
}

// ─── Entity CRUD ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct CreateQueueArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub name: String,
    #[serde(default)]
    pub options: serde_json::Value,
}

#[tauri::command]
pub async fn create_queue(app: AppHandle, args: CreateQueueArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "createQueue",
        json!({ "env": env, "name": args.name, "options": args.options }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct CreateTopicArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub name: String,
    #[serde(default)]
    pub options: serde_json::Value,
}

#[tauri::command]
pub async fn create_topic(app: AppHandle, args: CreateTopicArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "createTopic",
        json!({ "env": env, "name": args.name, "options": args.options }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct CreateSubscriptionArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "topicName")]
    pub topic_name: String,
    #[serde(rename = "subscriptionName")]
    pub subscription_name: String,
    #[serde(default)]
    pub options: serde_json::Value,
}

#[tauri::command]
pub async fn create_subscription(app: AppHandle, args: CreateSubscriptionArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "createSubscription",
        json!({
            "env": env,
            "topicName": args.topic_name,
            "subscriptionName": args.subscription_name,
            "options": args.options,
        }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct DeleteQueueArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub name: String,
}

#[tauri::command]
pub async fn delete_queue(app: AppHandle, args: DeleteQueueArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "deleteQueue",
        json!({ "env": env, "name": args.name }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct DeleteTopicArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub name: String,
}

#[tauri::command]
pub async fn delete_topic(app: AppHandle, args: DeleteTopicArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "deleteTopic",
        json!({ "env": env, "name": args.name }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}

#[derive(serde::Deserialize)]
pub struct DeleteSubscriptionArgs {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "topicName")]
    pub topic_name: String,
    #[serde(rename = "subscriptionName")]
    pub subscription_name: String,
}

#[tauri::command]
pub async fn delete_subscription(app: AppHandle, args: DeleteSubscriptionArgs) -> Result<(), String> {
    let env = store::resolve_connection_env(&app, &args.connection_id)?;
    call_worker(
        &app,
        "deleteSubscription",
        json!({
            "env": env,
            "topicName": args.topic_name,
            "subscriptionName": args.subscription_name,
        }),
        Some(Duration::from_secs(60)),
    )
    .await
    .map_err(|e| redact_secrets(&e))
    .map(|_| ())
}
