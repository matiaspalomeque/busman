use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOutcome {
    pub sent: u64,
    pub settled: u64,
    pub send_unconfirmed: u64,
    pub settlement_unconfirmed: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_contract_preserves_partial_outcomes() {
        let value =
            serde_json::from_str(include_str!("../../contracts/operation-outcome.json")).unwrap();
        let result = OperationOutcome::parse(value, "contract-run").unwrap();
        assert_eq!(result.exit_code(), -2);
        assert_eq!(result.counts.totals.sent, 5);
        assert_eq!(result.counts.sources["dlq"].settlement_unconfirmed, 1);
    }

    #[test]
    fn rejects_mismatched_run_or_version() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/operation-outcome.json")).unwrap();
        assert!(OperationOutcome::parse(value.clone(), "other-run").is_err());
        value["version"] = serde_json::json!(2);
        assert!(OperationOutcome::parse(value, "contract-run").is_err());
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OperationCounts {
    #[serde(flatten)]
    pub totals: SourceOutcome,
    pub sources: BTreeMap<String, SourceOutcome>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Success,
    Error,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationOutcome {
    pub version: u8,
    pub run_id: String,
    pub status: OperationStatus,
    pub started_at: String,
    pub finished_at: String,
    pub counts: OperationCounts,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl OperationOutcome {
    pub fn parse(value: serde_json::Value, run_id: &str) -> Result<Self, String> {
        let mut outcome: Self =
            serde_json::from_value(value).map_err(|e| format!("Invalid operation outcome: {e}"))?;
        if outcome.version != 1 || outcome.run_id != run_id {
            return Err("Operation outcome version or run ID mismatch".into());
        }
        outcome.error_message = outcome
            .error_message
            .map(|e| crate::commands::worker::redact_secrets(&e));
        Ok(outcome)
    }

    pub fn exit_code(&self) -> i32 {
        match self.status {
            OperationStatus::Success => 0,
            OperationStatus::Error => -1,
            OperationStatus::Stopped => 130,
            OperationStatus::Unknown => -2,
        }
    }
}
