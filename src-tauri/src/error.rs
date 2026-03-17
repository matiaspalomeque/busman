use std::fmt;

/// Typed error for internal use across Busman commands.
///
/// Commands still expose `Result<T, String>` at the Tauri boundary for frontend
/// compatibility. Use `.into()` or `?` with the `From<BusmanError> for String` impl
/// to convert at command boundaries.
#[derive(Debug)]
pub enum BusmanError {
    /// Input validation failures (bad format, missing fields, out-of-range values).
    Validation(String),
    /// Errors from the Go worker sidecar (Service Bus SDK failures).
    Worker(String),
    /// Worker communication timeout.
    Timeout(String),
    /// File system or I/O errors.
    Io(String),
    /// Requested resource not found (connection, entity, file).
    NotFound(String),
    /// Internal/unexpected errors (serialization failures, lock poisoning, etc.).
    Internal(String),
}

impl fmt::Display for BusmanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(msg) => write!(f, "{msg}"),
            Self::Worker(msg) => write!(f, "{msg}"),
            Self::Timeout(msg) => write!(f, "{msg}"),
            Self::Io(msg) => write!(f, "{msg}"),
            Self::NotFound(msg) => write!(f, "{msg}"),
            Self::Internal(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for BusmanError {}

impl From<BusmanError> for String {
    fn from(err: BusmanError) -> String {
        err.to_string()
    }
}

impl From<std::io::Error> for BusmanError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

impl From<serde_json::Error> for BusmanError {
    fn from(err: serde_json::Error) -> Self {
        Self::Internal(format!("JSON error: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_preserves_message() {
        let err = BusmanError::Validation("bad input".to_string());
        assert_eq!(err.to_string(), "bad input");

        let err = BusmanError::NotFound("missing".to_string());
        assert_eq!(err.to_string(), "missing");
    }

    #[test]
    fn into_string_conversion() {
        let err = BusmanError::Worker("worker failed".to_string());
        let s: String = err.into();
        assert_eq!(s, "worker failed");
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let err: BusmanError = io_err.into();
        assert!(matches!(err, BusmanError::Io(_)));
        assert!(err.to_string().contains("file missing"));
    }

    #[test]
    fn from_serde_error() {
        let serde_err = serde_json::from_str::<serde_json::Value>("invalid").unwrap_err();
        let err: BusmanError = serde_err.into();
        assert!(matches!(err, BusmanError::Internal(_)));
        assert!(err.to_string().starts_with("JSON error:"));
    }

    #[test]
    fn all_variants_display() {
        let variants = [
            BusmanError::Validation("v".into()),
            BusmanError::Worker("w".into()),
            BusmanError::Timeout("t".into()),
            BusmanError::Io("i".into()),
            BusmanError::NotFound("n".into()),
            BusmanError::Internal("x".into()),
        ];
        let expected = ["v", "w", "t", "i", "n", "x"];
        for (err, exp) in variants.iter().zip(expected.iter()) {
            assert_eq!(err.to_string(), *exp);
        }
    }
}
