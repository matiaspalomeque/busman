use super::worker::redact_secrets;

const MAX_LOG_FIELD_CHARS: usize = 20_000;

fn sanitize_for_log(value: &str) -> String {
    let redacted = redact_secrets(value);
    if redacted.chars().count() <= MAX_LOG_FIELD_CHARS {
        return redacted;
    }

    let mut truncated = redacted
        .chars()
        .take(MAX_LOG_FIELD_CHARS)
        .collect::<String>();
    truncated.push_str("...[truncated]");
    truncated
}

#[tauri::command]
pub fn log_frontend_event(
    level: String,
    message: String,
    details: Option<String>,
) -> Result<(), String> {
    let message = sanitize_for_log(&message);
    let details = details.map(|value| sanitize_for_log(&value));
    let full_message = match details {
        Some(details) if !details.trim().is_empty() => {
            format!("[frontend] {message} | details={details}")
        }
        _ => format!("[frontend] {message}"),
    };

    match level.as_str() {
        "error" => log::error!("{full_message}"),
        "warn" => log::warn!("{full_message}"),
        "info" => log::info!("{full_message}"),
        other => log::warn!("[frontend] invalid log level '{other}': {full_message}"),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_redacts_connection_string_secrets() {
        let value = "Endpoint=sb://x;SharedAccessKey=secret;SharedAccessSignature=sig";
        let result = sanitize_for_log(value);
        assert!(result.contains("SharedAccessKey=[REDACTED]"));
        assert!(result.contains("SharedAccessSignature=[REDACTED]"));
        assert!(!result.contains("secret"));
        assert!(!result.contains("sig"));
    }

    #[test]
    fn sanitize_truncates_large_payloads() {
        let value = "a".repeat(MAX_LOG_FIELD_CHARS + 1);
        let result = sanitize_for_log(&value);
        assert!(result.ends_with("...[truncated]"));
        assert!(result.len() > MAX_LOG_FIELD_CHARS);
    }
}
