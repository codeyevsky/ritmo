//! One error type crosses the IPC boundary, so the frontend can branch on
//! `code` instead of string-matching messages.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    BadRequest(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("http error: {0}")]
    Http(String),

    #[error("audio error: {0}")]
    Audio(String),

    #[error("decode error: {0}")]
    Decode(String),

    #[error("no audio output device available")]
    NoDevice,

    #[error("operation cancelled")]
    Cancelled,

    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// Stable machine-readable discriminant mirrored by the TypeScript side.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::BadRequest(_) => "bad_request",
            AppError::Io(_) => "io",
            AppError::Db(_) => "db",
            AppError::Http(_) => "network",
            AppError::Audio(_) => "device",
            AppError::Decode(_) => "decode",
            AppError::NoDevice => "device",
            AppError::Cancelled => "cancelled",
            AppError::Other(_) => "unknown",
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // Keep the whole chain: the root cause is usually the useful part.
        AppError::Other(format!("{e:#}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

/// Wire shape. Tauri requires command errors to be `Serialize`.
#[derive(Serialize)]
pub struct WireError {
    pub code: &'static str,
    pub message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        WireError { code: self.code(), message: self.to_string() }.serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;
