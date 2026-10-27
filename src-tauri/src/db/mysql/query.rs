//! Runs editor SQL with the text protocol, so every value arrives as text.

use std::borrow::Cow;

use mysql_async::prelude::Queryable;
use mysql_async::Value;

use super::MySession;
use crate::db::stream::{Events, Run, RunSummary};
use crate::error::{AppError, ErrorPayload, Result};

/// ER_QUERY_INTERRUPTED: the statement was stopped by `KILL QUERY`.
const QUERY_INTERRUPTED: u16 = 1317;

impl MySession {
    #[cfg(test)]
    pub async fn run(&self, sql: &str, events: &Events) -> Result<RunSummary> {
        self.run_limited(sql, events, None, None).await
    }

    /// `tab`: run on that query tab's own connection.
    pub async fn run_limited(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let mut run = Run::with_limit(events, limit);
        let editor = match self.editor(tab).await {
            Ok(e) => e,
            Err(e) => {
                let payload = ErrorPayload::from(&e);
                return run.finish(Err(e), Some((payload, false)));
            }
        };
        let mut conn = editor.conn.lock().await;
        if self.read_only {
            // Back to read-only before every run, whatever an earlier run changed.
            let _ = conn.query_drop("SET SESSION TRANSACTION READ ONLY").await;
        }
        let outcome: Result<()> = async {
            let mut result = conn.query_iter(sql).await?;
            while !result.is_empty() {
                let Some(columns) = result.columns() else { break };
                if columns.is_empty() {
                    run.command(result.affected_rows())?;
                    result.next().await?; // moves on to the next statement's result
                } else {
                    run.start_result(columns.iter().map(|c| c.name_str().into_owned()).collect())?;
                    while let Some(row) = result.next().await? {
                        run.push_row((0..row.len()).map(|i| text(row.as_ref(i))))?;
                    }
                    run.end_result(None)?;
                }
            }
            // An error in a later statement only surfaces once the result is drained.
            result.drop_result().await?;
            Ok(())
        }
        .await;

        drop(conn);
        // A dropped tab connection: forget it, so the next run opens a fresh one, and say so.
        let lost = matches!(&outcome, Err(AppError::MySql(mysql_async::Error::Io(_) | mysql_async::Error::Driver(mysql_async::DriverError::ConnectionClosed))));
        if lost && let Some(tab) = tab {
            self.tabs.lock().await.remove(tab);
        }
        let error = outcome.as_ref().err().map(|err| {
            let mut payload = ErrorPayload::from(err);
            if lost && tab.is_some() {
                payload.message = format!("{} ({})", crate::db::LOST_TAB, payload.message);
            }
            if payload.position.is_none() {
                payload.position = error_position(sql, &payload.message);
            }
            (payload, is_cancel(err))
        });
        run.finish(outcome, error)
    }
}

impl MySession {
    /// A small query on the introspection connection (server activity, KILL), all rows as
    /// text, so it works while the editor's query is still running.
    pub async fn admin_rows(&self, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>)> {
        let mut conn = self.meta.lock().await;
        let mut result = conn.query_iter(sql).await?;
        let columns = result.columns().map(|c| c.iter().map(|c| c.name_str().into_owned()).collect()).unwrap_or_default();
        let mut rows = Vec::new();
        while let Some(row) = result.next().await? {
            rows.push((0..row.len()).map(|i| text(row.as_ref(i)).map(|v| v.into_owned())).collect());
        }
        result.drop_result().await?;
        Ok((columns, rows))
    }
}

fn is_cancel(err: &AppError) -> bool {
    matches!(err, AppError::MySql(mysql_async::Error::Server(e)) if e.code == QUERY_INTERRUPTED)
}

/// A text-protocol value as the mysql CLI would show it. Bytes that aren't UTF-8 show as hex.
fn text(value: Option<&Value>) -> Option<Cow<'_, str>> {
    match value? {
        Value::NULL => None,
        Value::Bytes(bytes) => Some(match std::str::from_utf8(bytes) {
            Ok(s) => Cow::Borrowed(s),
            Err(_) => Cow::Owned(bytes.iter().fold(String::from("0x"), |mut s, b| {
                s.push_str(&format!("{b:02x}"));
                s
            })),
        }),
        other => Some(Cow::Owned(other.as_sql(true))),
    }
}

/// MySQL errors carry no position; recover one (1-based, in characters) from the message.
fn error_position(sql: &str, message: &str) -> Option<u32> {
    let to_position = |byte: usize| sql[..byte].chars().count() as u32 + 1;

    // Syntax errors: "... near 'nope from t' at line 2"
    if let Some(start) = message.find("near '") {
        let rest = &message[start + 6..];
        let end = rest.rfind("' at line ")?;
        let line: usize = rest[end + 10..].trim().parse().ok()?;
        let probe: String = rest[..end].chars().take(24).collect();
        if probe.is_empty() {
            return None; // "near ''": the statement ended early
        }
        let line_start: usize = sql.split_inclusive('\n').take(line.saturating_sub(1)).map(str::len).sum();
        return sql.get(line_start..)?.find(&probe).map(|i| to_position(line_start + i));
    }

    // "Unknown column 'u.nope' in 'field list'", "Table 'db.nope' doesn't exist", ...
    for prefix in ["Unknown column '", "Table '", "Unknown table '", "FUNCTION "] {
        if let Some(start) = message.find(prefix) {
            let quoted = message[start + prefix.len()..].split(['\'', ' ']).next()?;
            let name = quoted.rsplit('.').next()?;
            return find_word(sql, name).map(to_position);
        }
    }
    None
}

/// First occurrence of `word` as a whole identifier, ignoring case.
pub(crate) fn find_word(sql: &str, word: &str) -> Option<usize> {
    if word.is_empty() {
        return None;
    }
    let haystack = sql.to_ascii_lowercase();
    let needle = word.to_ascii_lowercase();
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    haystack.match_indices(&needle).map(|(i, _)| i).find(|&i| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + needle.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_positions_in_mysql_error_messages() {
        let sql = "select id,\n  nope from users";
        assert_eq!(error_position(sql, "Unknown column 'nope' in 'field list'"), Some(14));
        assert_eq!(error_position(sql, "Unknown column 'users.nope' in 'field list'"), Some(14));
        assert_eq!(
            error_position(
                "select 1;\nselec 2",
                "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'selec 2' at line 2"
            ),
            Some(11)
        );
        assert_eq!(error_position("select * from nope", "Table 'onyx_dev.nope' doesn't exist"), Some(15));
        assert_eq!(error_position("select * from", "... to use near '' at line 1"), None);
        // Whole identifiers only: "id" must not match inside "kid".
        assert_eq!(find_word("select kid, id", "id"), Some(12));
    }

    #[test]
    fn shows_binary_values_as_hex() {
        assert_eq!(text(Some(&Value::Bytes(vec![0xff, 0x00]))).unwrap(), "0xff00");
        assert_eq!(text(Some(&Value::Bytes(b"hi".to_vec()))).unwrap(), "hi");
        assert_eq!(text(Some(&Value::NULL)), None);
    }
}

/// Integration tests against a real server. Run with the dev database up:
/// `ONYX_TEST_MYSQL=1 cargo test` (expects scripts/seed-dev-mysql.sql loaded on localhost:33069).
#[cfg(test)]
mod integration {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use arrow_array::{Array, StringArray};
    use uuid::Uuid;
    use zeroize::Zeroizing;

    use super::*;
    use crate::connections::{ConnectionConfig, Engine, Environment, SslMode};
    use crate::db::stream::testing::{batches, event_types, events, recorder};

    fn config(user: &str, ssl_mode: SslMode) -> Option<ConnectionConfig> {
        std::env::var("ONYX_TEST_MYSQL").ok()?;
        Some(ConnectionConfig {
            id: Uuid::new_v4(),
            engine: Engine::Mysql,
            name: "test".into(),
            host: "127.0.0.1".into(),
            port: 33069,
            user: user.into(),
            database: "onyx_dev".into(),
            ssl_mode,
            environment: Environment::Local,
            color: "#000".into(),
            read_only: false,
            ssh: None,
            folder: None,
            ai_enabled: false,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            aws_iam: None,
        })
    }

    async fn root() -> Option<MySession> {
        let config = config("root", SslMode::Disable)?;
        Some(MySession::connect(&config, None, None).await.unwrap())
    }

    #[tokio::test]
    async fn streams_rows_with_nulls() {
        let Some(session) = root().await else { return };
        let (channel, log) = recorder();
        session.run("SELECT id, kind FROM events ORDER BY id LIMIT 25000", &channel).await.unwrap();

        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["resultStart", "resultEnd", "done"]);
        assert_eq!(events(&log)[1]["rowCount"], 25000);
        let batches = batches(&log);
        assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 25_000);
        let kinds = batches[0].column(1).as_any().downcast_ref::<StringArray>().unwrap();
        assert!(kinds.is_null(9), "id 10 has a NULL kind in the seed data");
        assert_eq!(kinds.value(0), "event-1");
    }

    #[tokio::test]
    async fn reports_multiple_statements_commands_and_errors() {
        let Some(session) = root().await else { return };
        let (channel, log) = recorder();
        let sql = "CREATE TEMPORARY TABLE t (x int); INSERT INTO t VALUES (1), (2); SELECT * FROM t; SELECT nope FROM t;";
        session.run(sql, &channel).await.unwrap();

        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["command", "command", "resultStart", "resultEnd", "error", "done"]);
        let events = events(&log);
        assert_eq!(events[1]["rowsAffected"], 2);
        assert_eq!(events[3]["rowCount"], 2);
        assert_eq!(events[4]["error"]["code"], "42S22");
        assert_eq!(events[4]["error"]["position"], sql.find("nope").unwrap() as u64 + 1);
        assert_eq!(events[4]["cancelled"], false);
    }

    #[tokio::test]
    async fn cancel_kills_a_running_query() {
        let Some(session) = root().await else { return };
        let session = Arc::new(session);
        let (channel, log) = recorder();
        let runner = {
            let session = session.clone();
            tokio::spawn(async move {
                session.run("SELECT COUNT(*) FROM events a JOIN events b ON a.bucket = b.bucket", &channel).await
            })
        };
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        session.cancel(None).await.unwrap();
        runner.await.unwrap().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));

        let error = {
            let log = log.lock().unwrap();
            events(&log).into_iter().find(|e| e["type"] == "error").unwrap().clone()
        };
        assert_eq!(error["cancelled"], true, "{error}");

        // The connection is still usable afterwards.
        let (channel, log) = recorder();
        session.run("SELECT 1", &channel).await.unwrap();
        assert_eq!(event_types(&log.lock().unwrap()), ["resultStart", "resultEnd", "done"]);
    }

    #[tokio::test]
    async fn each_tab_has_its_own_session() {
        let Some(session) = root().await else { return };
        let (channel, _) = recorder();
        session
            .run_limited("CREATE TEMPORARY TABLE only_a (x int); INSERT INTO only_a VALUES (1)", &channel, None, Some("a"))
            .await
            .unwrap();
        for tab in [Some("b"), None] {
            let (channel, log) = recorder();
            session.run_limited("SELECT * FROM only_a", &channel, None, tab).await.unwrap();
            assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()), "{tab:?} sees tab A's temp table");
        }
        let (channel, log) = recorder();
        session.run_limited("SELECT count(*) FROM only_a", &channel, None, Some("a")).await.unwrap();
        assert_eq!(event_types(&log.lock().unwrap()), ["resultStart", "resultEnd", "done"]);
        session.cancel(Some("b")).await.unwrap();
        session.close_tab("a").await;
        let (channel, log) = recorder();
        session.run_limited("SELECT * FROM only_a", &channel, None, Some("a")).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()), "a reopened tab starts fresh");
    }

    #[tokio::test]
    async fn read_only_connections_refuse_writes() {
        let Some(config) = config("root", SslMode::Disable) else { return };
        let session = MySession::connect(&ConnectionConfig { read_only: true, ..config }, None, None).await.unwrap();
        let (channel, log) = recorder();
        session.run("INSERT INTO users (email) VALUES ('ro@example.com')", &channel).await.unwrap();
        let log = log.lock().unwrap();
        let error = events(&log).into_iter().find(|e| e["type"] == "error").unwrap().clone();
        assert!(error["error"]["message"].as_str().unwrap().contains("READ ONLY"), "{error}");
    }

    #[tokio::test]
    async fn introspects_schema() {
        let Some(session) = root().await else { return };
        assert!(session.schemas().await.unwrap().contains(&"onyx_dev".to_owned()));

        let objects = session.objects("onyx_dev").await.unwrap();
        let kinds: Vec<(&str, &str)> = objects.iter().map(|o| (o.name.as_str(), o.kind)).collect();
        assert!(kinds.contains(&("users", "table")));
        assert!(kinds.contains(&("paid_orders", "view")));
        assert!(kinds.contains(&("user_revenue", "function")));
        assert!(kinds.contains(&("recent_orders", "procedure")));
        let events_table = objects.iter().find(|o| o.name == "events").unwrap();
        assert!(events_table.estimated_rows.unwrap() > 500_000);

        let columns = session.columns("onyx_dev", "orders").await.unwrap();
        assert_eq!(columns[0].name, "id");
        assert!(columns[0].primary_key);
        assert_eq!(columns[1].data_type, "bigint");
        assert!(!columns[1].nullable);

        let tables = session.completion_tables().await.unwrap();
        let events = tables.iter().find(|t| t.name == "events").unwrap();
        assert_eq!(events.columns, ["id", "hash", "bucket", "at", "kind"]);
    }

    fn password() -> Option<Zeroizing<String>> {
        Some(Zeroizing::new("onyx-dev-pass".into()))
    }

    #[tokio::test]
    async fn tls_modes_against_a_self_signed_server() {
        // The dev server has MySQL's auto-generated, self-signed certificate.
        let Some(require) = config("onyx", SslMode::Require) else { return };
        let session = MySession::connect(&require, password(), None).await.unwrap();
        let (channel, log) = recorder();
        session.run("SHOW SESSION STATUS LIKE 'Ssl_version'", &channel).await.unwrap();
        let tls = {
            let log = log.lock().unwrap();
            batches(&log)[0].column(1).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned()
        };
        assert!(tls.starts_with("TLSv1."), "connection should be encrypted, got {tls:?}");

        // verify-full refuses a certificate no trusted CA signed.
        let verify = config("onyx", SslMode::VerifyFull).unwrap();
        assert!(MySession::connect(&verify, password(), None).await.is_err());

        // Password auth also works without TLS (caching_sha2_password over RSA).
        let plain = config("onyx", SslMode::Disable).unwrap();
        MySession::connect(&plain, password(), None).await.unwrap();
    }
}
