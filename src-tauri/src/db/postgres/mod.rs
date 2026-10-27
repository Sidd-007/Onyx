//! Postgres sessions: an editor client and an introspection client.

mod introspect;
mod query;

pub(crate) use introspect::trigger_timing;

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio_postgres::{CancelToken, Client};
use tokio_postgres_rustls::MakeRustlsConnect;
use zeroize::Zeroizing;

use super::tls;
use crate::connections::{ConnectionConfig, SslMode};
use crate::error::Result;
use crate::ssh::Tunnel;

/// One editor connection: the default one, or a query tab's own.
pub struct Editor {
    client: Client,
    cancel: CancelToken,
}

pub struct PgSession {
    pub server_version: String,
    /// The shared editor connection (table browsing, menus, tabs without their own).
    query: Arc<Editor>,
    meta: Client,
    tls: MakeRustlsConnect,
    /// Kept open for as long as the session lives.
    tunnel: Option<Tunnel>,
    /// How to open more connections (query tabs get their own).
    pg: tokio_postgres::Config,
    read_only: bool,
    /// Query tabs' own connections, so a transaction or SET in one tab stays in that tab.
    tabs: tokio::sync::Mutex<HashMap<String, Arc<Editor>>>,
    iam: Option<crate::aws::IamTarget>,
}

impl PgSession {
    pub async fn connect(
        config: &ConnectionConfig,
        password: Option<Zeroizing<String>>,
        tunnel: Option<Tunnel>,
    ) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let iam = crate::aws::IamTarget::of(config)?;
        let password = match &iam {
            Some(target) => Some(target.token()?),
            None => password,
        };
        let tls = tls::postgres_connector(config)?;
        let mut pg = tokio_postgres::Config::new();
        pg.host(&config.host)
            .port(tunnel.as_ref().map_or(config.port, |t| t.local_port))
            .user(&config.user)
            .dbname(&config.database)
            .application_name("Onyx")
            .connect_timeout(Duration::from_secs(10))
            .ssl_mode(match config.ssl_mode {
                SslMode::Disable => tokio_postgres::config::SslMode::Disable,
                SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
                SslMode::Require | SslMode::VerifyFull => tokio_postgres::config::SslMode::Require,
            });
        if let Some(password) = &password {
            pg.password(password.as_bytes());
        }
        // Through a tunnel: connect to the local end, but verify TLS against the real host.
        if tunnel.is_some() {
            pg.hostaddr(Ipv4Addr::LOCALHOST.into());
        }

        let (query, meta) = tokio::try_join!(open(&pg, &tls), open(&pg, &tls))?;
        if config.read_only {
            for client in [&query, &meta] {
                client.batch_execute("SET default_transaction_read_only = on").await?;
            }
        }
        let server_version = meta
            .query_one("SELECT current_setting('server_version')", &[])
            .await?
            .get(0);
        let query = Arc::new(Editor { cancel: query.cancel_token(), client: query });
        Ok(Self { server_version, query, meta, tls, tunnel, pg, read_only: config.read_only, tabs: Default::default(), iam })
    }

    /// The tab's own connection (opened on first use), or the shared one.
    pub(crate) async fn editor(&self, tab: Option<&str>) -> Result<Arc<Editor>> {
        let Some(tab) = tab else { return Ok(self.query.clone()) };
        let mut tabs = self.tabs.lock().await;
        if let Some(editor) = tabs.get(tab) {
            if !editor.client.is_closed() {
                return Ok(editor.clone());
            }
            tabs.remove(tab);
            return Err(crate::error::AppError::Invalid(crate::db::LOST_TAB.into()));
        }
        // IAM tokens last 15 minutes: each new connection signs a fresh one.
        let client = match &self.iam {
            Some(target) => {
                let mut pg = self.pg.clone();
                pg.password(target.token()?.as_bytes());
                open(&pg, &self.tls).await?
            }
            None => open(&self.pg, &self.tls).await?,
        };
        if self.read_only {
            client.batch_execute("SET default_transaction_read_only = on").await?;
        }
        let editor = Arc::new(Editor { cancel: client.cancel_token(), client });
        tabs.insert(tab.to_owned(), editor.clone());
        Ok(editor)
    }

    /// Closes a tab's connection; the server rolls back anything it left open.
    pub async fn close_tab(&self, tab: &str) {
        self.tabs.lock().await.remove(tab);
    }

    /// Ask the server to cancel whatever the editor connection (the tab's, or the shared one) is running.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        let editor = match tab {
            Some(t) => match self.tabs.lock().await.get(t) {
                Some(e) => e.clone(),
                None => return Ok(()),
            },
            None => self.query.clone(),
        };
        editor.cancel.cancel_query(self.tls.clone()).await?;
        Ok(())
    }
}

impl PgSession {
    /// On the introspection client, so it never lands inside an editor transaction.
    pub async fn apply(&self, statements: &[crate::db::edit::EditStatement]) -> Result<u64> {
        let client = &self.meta;
        client.batch_execute("BEGIN").await?;
        let applied: Result<u64> = async {
            let mut total = 0;
            for s in statements {
                let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                    s.params.iter().map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
                let changed = client.execute(&s.sql, &params).await?;
                check_one_row(s, changed)?;
                total += changed;
            }
            Ok(total)
        }
        .await;
        match applied {
            Ok(total) => {
                client.batch_execute("COMMIT").await?;
                Ok(total)
            }
            Err(e) => {
                let _ = client.batch_execute("ROLLBACK").await;
                Err(e)
            }
        }
    }
}

impl PgSession {
    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    /// Plain SQL on the introspection client (BEGIN / COMMIT around bulk inserts).
    pub async fn execute_meta(&self, sql: &str) -> Result<()> {
        self.meta.batch_execute(sql).await?;
        Ok(())
    }

    /// SQL (many statements allowed) on a tab's own session: the .sql file runner.
    pub async fn execute_on_tab(&self, sql: &str, tab: &str) -> Result<()> {
        self.editor(Some(tab)).await?.client.batch_execute(sql).await?;
        Ok(())
    }

    /// `COPY … FROM stdin` with its data (from a pg_dump file), on a tab's own session.
    pub async fn copy_in(&self, statement: &str, data: Vec<u8>, tab: &str) -> Result<u64> {
        use futures_util::SinkExt;
        let editor = self.editor(Some(tab)).await?;
        let sink = editor.client.copy_in::<_, bytes::Bytes>(statement).await?;
        futures_util::pin_mut!(sink);
        sink.send(bytes::Bytes::from(data)).await?;
        Ok(sink.finish().await?)
    }

    /// A parameterized statement on the introspection client; values are text, so the SQL casts.
    pub async fn execute_params(&self, sql: &str, params: Vec<Option<String>>) -> Result<u64> {
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            params.iter().map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
        Ok(self.meta.execute(sql, &refs).await?)
    }
}

pub(crate) fn check_one_row(s: &crate::db::edit::EditStatement, changed: u64) -> Result<()> {
    if s.expect_one_row && changed != 1 {
        return Err(crate::error::AppError::Invalid(format!(
            "Nothing was saved: expected to change 1 row but changed {changed} (was the row changed or deleted?): {}",
            s.display
        )));
    }
    Ok(())
}

async fn open(pg: &tokio_postgres::Config, tls: &MakeRustlsConnect) -> Result<Client> {
    let (client, connection) = pg.connect(tls.clone()).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            crate::redact::log(format!("postgres connection closed: {e}"));
        }
    });
    Ok(client)
}
