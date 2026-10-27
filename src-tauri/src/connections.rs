//! Saved connection settings. No secrets here: passwords are in the Keychain (see `secrets`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    #[default]
    Postgres,
    Mysql,
    /// A database file; `database` holds its path.
    Sqlite,
    /// DuckDB through its CLI; `database` is a file path, or empty for an in-memory database.
    Duckdb,
    /// Commands, not SQL; `database` is the database number.
    Redis,
    /// ClickHouse over its HTTP interface.
    Clickhouse,
    Sqlserver,
    /// MongoDB; queries are shell-style (`db.users.find({...})`).
    Mongodb,
}

impl Engine {
    /// File-based engines: no host, port or user.
    pub fn is_file(self) -> bool {
        matches!(self, Engine::Sqlite | Engine::Duckdb)
    }

    /// Engines that need a user name to connect.
    fn needs_user(self) -> bool {
        matches!(self, Engine::Postgres | Engine::Mysql | Engine::Sqlserver)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    /// Use TLS if the server offers it, without verifying the certificate.
    Prefer,
    /// Always use TLS, without verifying the certificate.
    Require,
    /// Always use TLS and verify the certificate and hostname against the macOS trust store.
    VerifyFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Environment {
    Local,
    Staging,
    Prod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuth {
    /// Keys from the running ssh-agent (SSH_AUTH_SOCK).
    Agent,
    /// A private key file; its passphrase, if any, is in the Keychain.
    Key,
    /// A password, kept in the Keychain.
    Password,
}

/// Reach the database through an SSH bastion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: Uuid,
    /// Connections saved before MySQL support have no engine: they are Postgres.
    #[serde(default)]
    pub engine: Engine,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub ssl_mode: SslMode,
    pub environment: Environment,
    pub color: String,
    /// Server-enforced read-only sessions.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Groups connections on the Connections screen.
    #[serde(default)]
    pub folder: Option<String>,
    /// Natural-language SQL may send this connection's schema (names and types, never rows)
    /// to the Claude API. Off by default; never allowed on prod.
    #[serde(default)]
    pub ai_enabled: bool,
    /// PEM files: a CA to trust (beyond the system's), and a client certificate and its key.
    #[serde(default)]
    pub ssl_ca: Option<String>,
    #[serde(default)]
    pub ssl_cert: Option<String>,
    #[serde(default)]
    pub ssl_key: Option<String>,
    /// Sign in to Amazon RDS with IAM instead of a password (Postgres, MySQL).
    #[serde(default)]
    pub aws_iam: Option<AwsIam>,
}

/// AWS credentials come from this profile in ~/.aws/credentials (or the AWS_* environment variables).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsIam {
    #[serde(default)]
    pub profile: Option<String>,
    /// Defaults to the region in the RDS host name.
    #[serde(default)]
    pub region: Option<String>,
}

impl ConnectionConfig {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::Invalid("Name is required".into()));
        }
        if self.engine == Engine::Sqlite && self.database.trim().is_empty() {
            return Err(AppError::Invalid("Choose a database file".into()));
        }
        if self.engine.is_file() {
            return Ok(());
        }
        if self.host.trim().is_empty() {
            return Err(AppError::Invalid("Host is required".into()));
        }
        if self.engine.needs_user() && self.user.trim().is_empty() {
            return Err(AppError::Invalid("User is required".into()));
        }
        if let Some(ssh) = &self.ssh
            && (ssh.host.trim().is_empty() || ssh.user.trim().is_empty())
        {
            return Err(AppError::Invalid("SSH host and user are required".into()));
        }
        Ok(())
    }
}

/// Connections persisted as JSON in the app config directory.
pub struct ConnectionStore {
    path: PathBuf,
    connections: Vec<ConnectionConfig>,
}

impl ConnectionStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        let connections = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| AppError::Invalid(format!("{}: {e}", path.display())))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, connections })
    }

    pub fn list(&self) -> &[ConnectionConfig] {
        &self.connections
    }

    pub fn get(&self, id: &Uuid) -> Option<&ConnectionConfig> {
        self.connections.iter().find(|c| &c.id == id)
    }

    pub fn upsert(&mut self, config: ConnectionConfig) -> Result<()> {
        match self.connections.iter_mut().find(|c| c.id == config.id) {
            Some(existing) => *existing = config,
            None => self.connections.push(config),
        }
        self.save()
    }

    /// Puts connections in the given order; any not listed keep their place at the end.
    pub fn reorder(&mut self, ids: &[Uuid]) -> Result<()> {
        let position = |id: &Uuid| ids.iter().position(|i| i == id).unwrap_or(usize::MAX);
        self.connections.sort_by_key(|c| position(&c.id));
        self.save()
    }

    pub fn remove(&mut self, id: &Uuid) -> Result<()> {
        self.connections.retain(|c| &c.id != id);
        self.save()
    }

    /// Write to a temp file then rename, so a crash never leaves a half-written file.
    fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(&self.connections)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            engine: Engine::Postgres,
            name: name.into(),
            host: "localhost".into(),
            port: 5432,
            user: "postgres".into(),
            database: "postgres".into(),
            ssl_mode: SslMode::Prefer,
            environment: Environment::Local,
            color: "#3b82f6".into(),
            read_only: false,
            ssh: None,
            folder: None,
            ai_enabled: false,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            aws_iam: None,
        }
    }

    #[test]
    fn reorder_keeps_unlisted_connections_last() {
        let dir = std::env::temp_dir().join(format!("onyx-test-{}", Uuid::new_v4()));
        let mut store = ConnectionStore::load(dir.join("connections.json")).unwrap();
        let (a, b, c) = (sample("a"), sample("b"), sample("c"));
        for x in [&a, &b, &c] {
            store.upsert(x.clone()).unwrap();
        }
        store.reorder(&[c.id, a.id]).unwrap();
        let names: Vec<&str> = store.list().iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["c", "a", "b"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_engines_need_no_host() {
        let mut config = sample("file");
        config.engine = Engine::Sqlite;
        config.host = String::new();
        config.user = String::new();
        config.database = "/tmp/x.db".into();
        assert!(config.validate().is_ok());
        config.database = String::new();
        assert!(config.validate().is_err());
    }

    #[test]
    fn store_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("onyx-test-{}", Uuid::new_v4()));
        let path = dir.join("connections.json");

        let mut store = ConnectionStore::load(path.clone()).unwrap();
        assert!(store.list().is_empty());

        let mut a = sample("a");
        store.upsert(a.clone()).unwrap();
        store.upsert(sample("b")).unwrap();
        a.name = "renamed".into();
        store.upsert(a.clone()).unwrap();

        let reloaded = ConnectionStore::load(path).unwrap();
        assert_eq!(reloaded.list().len(), 2);
        assert_eq!(reloaded.get(&a.id).unwrap().name, "renamed");

        let mut reloaded = reloaded;
        reloaded.remove(&a.id).unwrap();
        assert_eq!(reloaded.list().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn connections_saved_without_an_engine_are_postgres() {
        let json = r##"{"id":"6f1c2c3e-1d2b-4c5d-9e8f-0a1b2c3d4e5f","name":"old","host":"h","port":5432,
            "user":"u","database":"d","sslMode":"prefer","environment":"local","color":"#000"}"##;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.engine, Engine::Postgres);
    }

    #[test]
    fn ssl_mode_uses_libpq_spelling() {
        assert_eq!(serde_json::to_string(&SslMode::VerifyFull).unwrap(), "\"verify-full\"");
    }
}
