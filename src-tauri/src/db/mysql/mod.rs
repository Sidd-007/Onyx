//! MySQL sessions: an editor connection and an introspection connection.

mod introspect;
mod query;

pub(crate) use query::find_word;

use std::time::Duration;

use mysql_async::prelude::Queryable;
use std::collections::HashMap;
use std::sync::Arc;

use mysql_async::{Conn, DriverError, OptsBuilder};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use super::tls;
use crate::connections::{ConnectionConfig, SslMode};
use crate::error::{AppError, Result};
use crate::ssh::Tunnel;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One editor connection: the shared one, or a query tab's own.
pub struct Editor {
    conn: Mutex<Conn>,
    /// Server thread id, for `KILL QUERY`.
    thread: u32,
}

pub struct MySession {
    pub server_version: String,
    /// The shared editor connection (table browsing, menus, tabs without their own).
    query: Arc<Editor>,
    meta: Mutex<Conn>,
    /// Kept open for as long as the session lives.
    tunnel: Option<Tunnel>,
    /// How to open more connections (query tabs get their own).
    opts: OptsBuilder,
    read_only: bool,
    /// Query tabs' own connections, so a transaction or SET in one tab stays in that tab.
    tabs: Mutex<HashMap<String, Arc<Editor>>>,
    iam: Option<crate::aws::IamTarget>,
}

impl MySession {
    pub async fn connect(
        config: &ConnectionConfig,
        password: Option<Zeroizing<String>>,
        tunnel: Option<Tunnel>,
    ) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let iam = crate::aws::IamTarget::of(config)?;
        let token = iam.as_ref().map(|t| t.token()).transpose()?;
        let password = token.as_ref().or(password.as_ref()).map(|p| p.as_str());
        let local_port = tunnel.as_ref().map(|t| t.local_port);
        let mut opts = options(config, password, config.ssl_mode, local_port);
        let (query, mut meta) = match open_pair(config, &opts).await {
            // `prefer`: fall back to plaintext when the server has no TLS.
            Err(AppError::MySql(mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer)))
                if config.ssl_mode == SslMode::Prefer =>
            {
                opts = options(config, password, SslMode::Disable, local_port);
                open_pair(config, &opts).await?
            }
            other => other?,
        };
        let server_version: String = meta.query_first("SELECT VERSION()").await?.unwrap_or_default();
        let mut query = query;
        if config.read_only {
            for conn in [&mut query, &mut meta] {
                conn.query_drop("SET SESSION TRANSACTION READ ONLY").await?;
            }
        }
        let query = Arc::new(Editor { thread: query.id(), conn: Mutex::new(query) });
        Ok(Self {
            server_version,
            query,
            meta: Mutex::new(meta),
            tunnel,
            opts,
            read_only: config.read_only,
            tabs: Default::default(),
            iam,
        })
    }

    /// The tab's own connection (opened on first use), or the shared one.
    pub(crate) async fn editor(&self, tab: Option<&str>) -> Result<Arc<Editor>> {
        let Some(tab) = tab else { return Ok(self.query.clone()) };
        let mut tabs = self.tabs.lock().await;
        if let Some(editor) = tabs.get(tab) {
            return Ok(editor.clone());
        }
        // IAM tokens last 15 minutes: each new connection signs a fresh one.
        let opts = match &self.iam {
            Some(target) => self.opts.clone().pass(Some(target.token()?.as_str())),
            None => self.opts.clone(),
        };
        let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(opts))
            .await
            .map_err(|_| AppError::Invalid("Timed out opening a connection for this tab".into()))??;
        if self.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY").await?;
        }
        let editor = Arc::new(Editor { thread: conn.id(), conn: Mutex::new(conn) });
        tabs.insert(tab.to_owned(), editor.clone());
        Ok(editor)
    }

    /// Closes a tab's connection; the server rolls back anything it left open.
    pub async fn close_tab(&self, tab: &str) {
        let editor = self.tabs.lock().await.remove(tab);
        if let Some(editor) = editor.and_then(|e| Arc::try_unwrap(e).ok()) {
            let _ = editor.conn.into_inner().disconnect().await;
        }
    }

    /// MySQL has no out-of-band cancel: kill the statement from the introspection connection.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        let thread = match tab {
            Some(t) => match self.tabs.lock().await.get(t) {
                Some(e) => e.thread,
                None => return Ok(()),
            },
            None => self.query.thread,
        };
        let mut meta = self.meta.lock().await;
        meta.query_drop(format!("KILL QUERY {thread}")).await?;
        Ok(())
    }
}

impl MySession {
    /// On the introspection connection, so it never lands inside an editor transaction.
    pub async fn apply(&self, statements: &[crate::db::edit::EditStatement]) -> Result<u64> {
        let mut conn = self.meta.lock().await;
        conn.query_drop("START TRANSACTION").await?;
        let applied: Result<u64> = async {
            let mut total = 0;
            for s in statements {
                let params: Vec<mysql_async::Value> = s
                    .params
                    .iter()
                    .map(|p| p.clone().map_or(mysql_async::Value::NULL, |v| mysql_async::Value::Bytes(v.into_bytes())))
                    .collect();
                conn.exec_drop(&s.sql, params).await?;
                let changed = conn.affected_rows();
                crate::db::postgres::check_one_row(s, changed)?;
                total += changed;
            }
            Ok(total)
        }
        .await;
        match applied {
            Ok(total) => {
                conn.query_drop("COMMIT").await?;
                Ok(total)
            }
            Err(e) => {
                let _ = conn.query_drop("ROLLBACK").await;
                Err(e)
            }
        }
    }
}

impl MySession {
    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    /// Plain SQL on the introspection connection (BEGIN / COMMIT around bulk inserts).
    pub async fn execute_meta(&self, sql: &str) -> Result<()> {
        self.meta.lock().await.query_drop(sql).await?;
        Ok(())
    }

    /// SQL on a tab's own session: the .sql file runner (its USE stays there).
    pub async fn execute_on_tab(&self, sql: &str, tab: &str) -> Result<()> {
        self.editor(Some(tab)).await?.conn.lock().await.query_drop(sql).await?;
        Ok(())
    }

    /// A parameterized statement on the introspection connection; values bound as text.
    pub async fn execute_params(&self, sql: &str, params: Vec<Option<String>>) -> Result<u64> {
        let mut conn = self.meta.lock().await;
        let params: Vec<mysql_async::Value> =
            params.into_iter().map(|p| p.map_or(mysql_async::Value::NULL, |v| mysql_async::Value::Bytes(v.into_bytes()))).collect();
        conn.exec_drop(sql, params).await?;
        Ok(conn.affected_rows())
    }
}

/// Connection options. `local_port`: the local end of an SSH tunnel to use instead of the host.
fn options(config: &ConnectionConfig, password: Option<&str>, mode: SslMode, local_port: Option<u16>) -> OptsBuilder {
    let host = config.host.trim();
    let mut ssl = tls::mysql_ssl_opts(mode, tls::TlsFiles::of(config));
    if local_port.is_some() {
        // Verify TLS against the real host, not 127.0.0.1.
        ssl = ssl.map(|s| s.with_danger_tls_hostname_override(Some(host.to_owned())));
    }
    OptsBuilder::default()
        .ip_or_hostname(if local_port.is_some() { "127.0.0.1" } else { host })
        .tcp_port(local_port.unwrap_or(config.port))
        .user(Some(config.user.trim()))
        .pass(password)
        .db_name(Some(config.database.trim()).filter(|d| !d.is_empty()))
        .prefer_socket(false)
        // RDS IAM tokens go to the server in clear text (inside TLS).
        .enable_cleartext_plugin(config.aws_iam.is_some())
        .ssl_opts(ssl)
}

/// The editor and introspection connections.
async fn open_pair(config: &ConnectionConfig, opts: &OptsBuilder) -> Result<(Conn, Conn)> {
    let open = || async {
        tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(opts.clone()))
            .await
            .map_err(|_| AppError::Invalid(format!("Timed out connecting to {}:{}", config.host, config.port)))?
            .map_err(AppError::from)
    };
    tokio::try_join!(open(), open())
}
