use serde::{Serialize, Serializer};

use crate::guard::Risk;
use crate::ssh::HostKeyIssue;

/// Every error a command can return. Serialized for the UI as `ErrorPayload`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Db(#[from] tokio_postgres::Error),
    #[error(transparent)]
    MySql(#[from] mysql_async::Error),
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Keychain: {0}")]
    Keychain(String),
    #[error("TLS: {0}")]
    Tls(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("Not connected")]
    NotConnected,
    #[error("SSH: {0}")]
    Ssh(String),
    #[error(
        "Onyx's encrypted storage is locked: macOS Keychain access was denied ({0}). \
         Try again and choose Always Allow."
    )]
    Locked(String),
    #[error("{0}")]
    HostKey(HostKeyIssue),
    /// Prod guard: these statements need the user's confirmation first.
    #[error("This SQL needs confirmation on a prod connection")]
    NeedsConfirmation(Vec<Risk>),
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;

/// What the UI receives for any error. Postgres errors fill in the optional fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character offset into the SQL that was sent.
    pub position: Option<u32>,
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risks: Option<Vec<Risk>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<HostKeyIssue>,
}

impl From<&AppError> for ErrorPayload {
    fn from(err: &AppError) -> Self {
        if let AppError::Db(e) = err {
            if let Some(db) = e.as_db_error() {
                return ErrorPayload {
                    message: db.message().to_owned(),
                    detail: db.detail().map(str::to_owned),
                    hint: db.hint().map(str::to_owned),
                    position: match db.position() {
                        Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                        _ => None,
                    },
                    code: Some(db.code().code().to_owned()),
                    risks: None,
                    host_key: None,
                };
            }
            // Connection-level errors: include the underlying cause (e.g. "Connection refused").
            let mut message = e.to_string();
            if let Some(source) = std::error::Error::source(e) {
                let source = source.to_string();
                if !message.contains(&source) {
                    message = format!("{message}: {source}");
                }
            }
            return ErrorPayload { message, detail: None, hint: None, position: None, code: None, risks: None, host_key: None };
        }
        if let AppError::MySql(mysql_async::Error::Server(e)) = err {
            return ErrorPayload {
                message: e.message.clone(),
                detail: None,
                hint: None,
                position: None,
                code: Some(e.state.clone()),
                risks: None,
                host_key: None,
            };
        }
        let risks = match err {
            AppError::NeedsConfirmation(risks) => Some(risks.clone()),
            _ => None,
        };
        let host_key = match err {
            AppError::HostKey(issue) => Some(issue.clone()),
            _ => None,
        };
        ErrorPayload { message: err.to_string(), detail: None, hint: None, position: None, code: None, risks, host_key }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload::from(self).serialize(serializer)
    }
}
