use serde::Serialize;
use std::io::ErrorKind;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("[{code}] {message}")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_param(message: impl Into<String>) -> Self {
        Self::new("INVALID_PARAMETER", message)
    }

    pub fn cancelled() -> Self {
        Self::new("TASK_CANCELLED", "Operation was cancelled by user.")
    }

    pub fn same_input_output() -> Self {
        Self::new(
            "SAME_INPUT_AND_OUTPUT",
            "Output file path cannot be the same as the source file.",
        )
    }

    pub fn target_exists() -> Self {
        Self::new(
            "TARGET_ALREADY_EXISTS",
            "A file already exists at the selected output path.",
        )
    }

    pub fn size_limit(message: impl Into<String>) -> Self {
        Self::new("SIZE_LIMIT_EXCEEDED", message)
    }

    pub fn decode_failed(message: impl Into<String>) -> Self {
        Self::new("DECODE_FAILED", message)
    }

    pub fn from_io(err: std::io::Error, context: &str) -> Self {
        #[cfg(windows)]
        if let Some(raw) = err.raw_os_error() {
            // ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33)
            if raw == 32 || raw == 33 {
                return Self::new(
                    "FILE_LOCKED",
                    format!("{context}: the file is currently in use by another process."),
                );
            }
            // ERROR_ACCESS_DENIED (5), ERROR_WRITE_PROTECT (19)
            if raw == 5 || raw == 19 {
                return Self::new(
                    "PERMISSION_DENIED",
                    format!("{context}: access denied or directory is read-only."),
                );
            }
            // ERROR_DISK_FULL (112)
            if raw == 112 {
                return Self::new("DISK_FULL", format!("{context}: insufficient disk space."));
            }
        }

        match err.kind() {
            ErrorKind::NotFound => Self::new(
                "FILE_NOT_FOUND",
                format!("{context}: file or directory does not exist."),
            ),
            ErrorKind::PermissionDenied => Self::new(
                "PERMISSION_DENIED",
                format!("{context}: permission denied or read-only location."),
            ),
            ErrorKind::AlreadyExists => Self::target_exists(),
            _ => Self::new("IO_ERROR", format!("{context}: {}", err.kind())),
        }
    }
}
