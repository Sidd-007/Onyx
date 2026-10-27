//! Runs editor SQL with the simple query protocol, so every value arrives as text.

use futures_util::{pin_mut, StreamExt};
use tokio_postgres::error::SqlState;
use tokio_postgres::SimpleQueryMessage;

use super::PgSession;
use crate::db::stream::{Events, Run, RunSummary};
use crate::error::{AppError, ErrorPayload, Result};

impl PgSession {
    #[cfg(test)]
    pub async fn run(&self, sql: &str, events: &Events) -> Result<RunSummary> {
        self.run_limited(sql, events, None, None).await
    }

    /// `tab`: run on that query tab's own connection.
    pub async fn run_limited(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let mut run = Run::with_limit(events, limit);
        let outcome: Result<()> = async {
            let editor = self.editor(tab).await?;
            if self.read_only {
                // Back to read-only before every run, whatever an earlier run did to the session's
                // defaults (best effort: inside a failed transaction, ROLLBACK must still get through).
                let _ = editor.client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await;
            }
            let stream = editor.client.simple_query_raw(sql).await?;
            pin_mut!(stream);
            while let Some(message) = stream.next().await {
                match message? {
                    SimpleQueryMessage::RowDescription(columns) => {
                        run.start_result(columns.iter().map(|c| c.name().to_owned()).collect())?;
                    }
                    SimpleQueryMessage::Row(row) => run.push_row((0..row.len()).map(|i| row.get(i)))?,
                    SimpleQueryMessage::CommandComplete(count) => {
                        if run.in_result() {
                            run.end_result(Some(count))?;
                        } else {
                            run.command(count)?;
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        .await;

        let error = outcome.as_ref().err().map(|err| (ErrorPayload::from(err), is_cancel(err)));
        run.finish(outcome, error)
    }
}

impl PgSession {
    /// A small query on the introspection client (server activity), all rows as text, so
    /// it works while the editor's query is still running.
    pub async fn admin_rows(&self, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>)> {
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        for message in self.meta.simple_query(sql).await? {
            match message {
                SimpleQueryMessage::RowDescription(c) if columns.is_empty() => {
                    columns = c.iter().map(|c| c.name().to_owned()).collect();
                }
                SimpleQueryMessage::Row(row) => {
                    if columns.is_empty() {
                        columns = row.columns().iter().map(|c| c.name().to_owned()).collect();
                    }
                    rows.push((0..row.len()).map(|i| row.get(i).map(str::to_owned)).collect());
                }
                _ => {}
            }
        }
        Ok((columns, rows))
    }
}

fn is_cancel(err: &AppError) -> bool {
    matches!(err, AppError::Db(e) if e.code() == Some(&SqlState::QUERY_CANCELED))
}

/// Integration tests against a real server. Run with the dev database up:
/// `ONYX_TEST_PG=1 cargo test` (expects scripts/seed-dev-db.sql loaded on localhost:54329).
#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use arrow_array::{Array, StringArray};
    use uuid::Uuid;

    use super::*;
    use crate::connections::{ConnectionConfig, Engine, Environment, SslMode};
    use crate::db::stream::testing::{batches, event_types, events, recorder};
    use crate::db::stream::FIRST_BATCH_ROWS;

    fn dev_config() -> Option<ConnectionConfig> {
        std::env::var("ONYX_TEST_PG").ok()?;
        Some(ConnectionConfig {
            id: Uuid::new_v4(),
            engine: Engine::Postgres,
            name: "test".into(),
            host: "localhost".into(),
            port: 54329,
            user: "postgres".into(),
            database: "onyx_dev".into(),
            ssl_mode: SslMode::Disable,
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

    #[tokio::test]
    async fn streams_rows_in_batches_with_nulls() {
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&config, None, None).await.unwrap();
        let (channel, log) = recorder();

        session
            .run("SELECT id, kind FROM public.events ORDER BY id LIMIT 25000", &channel)
            .await
            .unwrap();

        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["resultStart", "resultEnd", "done"]);
        assert_eq!(events(&log)[0]["columns"], serde_json::json!(["id", "kind"]));

        let batches = batches(&log);
        assert_eq!(batches[0].num_rows(), FIRST_BATCH_ROWS);
        assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 25_000);

        let ids = batches[0].column(0).as_any().downcast_ref::<StringArray>().unwrap();
        let kinds = batches[0].column(1).as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(ids.value(0), "1");
        assert!(kinds.is_null(9), "id 10 has a NULL kind in the seed data");
    }

    #[tokio::test]
    async fn reports_multiple_statements_commands_and_errors() {
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&config, None, None).await.unwrap();
        let (channel, log) = recorder();

        session
            .run("CREATE TEMP TABLE t (x int); INSERT INTO t VALUES (1), (2); SELECT * FROM t; SELECT nope;", &channel)
            .await
            .unwrap();

        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["command", "command", "resultStart", "resultEnd", "error", "done"]);
        let events = events(&log);
        assert_eq!(events[1]["rowsAffected"], 2);
        assert_eq!(events[3]["rowCount"], 2);
        assert_eq!(events[4]["cancelled"], false);
        let error = &events[4]["error"];
        assert_eq!(error["code"], "42703");
        // "nope" starts at character 85 of the SQL above (1-based).
        assert_eq!(error["position"], 85);
    }

    #[tokio::test]
    async fn cancel_stops_a_running_query() {
        let Some(config) = dev_config() else { return };
        let session = Arc::new(PgSession::connect(&config, None, None).await.unwrap());
        let (channel, log) = recorder();

        let runner = {
            let session = session.clone();
            tokio::spawn(async move { session.run("SELECT pg_sleep(30)", &channel).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        session.cancel(None).await.unwrap();
        runner.await.unwrap().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));

        let log = log.lock().unwrap();
        let error = events(&log).into_iter().find(|e| e["type"] == "error").unwrap().clone();
        assert_eq!(error["cancelled"], true);
        assert_eq!(error["error"]["code"], "57014");
    }

    /// Streaming speed: `ONYX_BENCH=1 ONYX_TEST_PG=1 cargo test --release stream_speed -- --nocapture`.
    #[tokio::test]
    async fn stream_speed() {
        if std::env::var("ONYX_BENCH").is_err() {
            return;
        }
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&config, None, None).await.unwrap();
        let first = Arc::new(std::sync::Mutex::new(None::<Duration>));
        let rows = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let started = Instant::now();
        let channel = {
            let (first, rows) = (first.clone(), rows.clone());
            tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                    first.lock().unwrap().get_or_insert(started.elapsed());
                    let reader = arrow_ipc::reader::StreamReader::try_new(bytes.as_slice(), None).unwrap();
                    for batch in reader {
                        rows.fetch_add(batch.unwrap().num_rows(), std::sync::atomic::Ordering::Relaxed);
                    }
                }
                Ok(())
            })
        };
        let columns: Vec<String> = (0..20).map(|i| format!("md5((g + {i})::text) AS c{i}")).collect();
        let sql = format!("SELECT g, {} FROM generate_series(1, 1000000) g", columns.join(", "));
        session.run(&sql, &channel).await.unwrap();
        let total = started.elapsed();
        let rows = rows.load(std::sync::atomic::Ordering::Relaxed);
        println!(
            "1M rows × 21 columns: first rows after {:?}, all in {total:?} ({:.0} rows/s)",
            first.lock().unwrap().unwrap(),
            rows as f64 / total.as_secs_f64()
        );
        assert_eq!(rows, 1_000_000);
    }

    #[tokio::test]
    async fn each_tab_has_its_own_session() {
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&config, None, None).await.unwrap();
        let (channel, _) = recorder();
        // A transaction and a temp table in tab A…
        session.run_limited("BEGIN; CREATE TEMP TABLE only_a (x int); INSERT INTO only_a VALUES (1);", &channel, None, Some("a")).await.unwrap();
        // …are invisible to tab B and to the shared connection.
        for tab in [Some("b"), None] {
            let (channel, log) = recorder();
            session.run_limited("SELECT * FROM only_a", &channel, None, tab).await.unwrap();
            assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()), "{tab:?} sees tab A's temp table");
        }
        let (channel, log) = recorder();
        session.run_limited("SELECT count(*) FROM only_a", &channel, None, Some("a")).await.unwrap();
        assert_eq!(event_types(&log.lock().unwrap()), ["resultStart", "resultEnd", "done"]);

        // Cancelling tab B leaves tab A alone; closing tab A drops its transaction.
        session.cancel(Some("b")).await.unwrap();
        session.close_tab("a").await;
        let (channel, log) = recorder();
        session.run_limited("SELECT * FROM only_a", &channel, None, Some("a")).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()), "a reopened tab starts fresh");
    }

    #[tokio::test]
    async fn read_only_connections_refuse_writes() {
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&ConnectionConfig { read_only: true, ..config }, None, None).await.unwrap();
        let (channel, log) = recorder();
        session.run("CREATE TABLE should_not_exist (x int)", &channel).await.unwrap();
        let log = log.lock().unwrap();
        let error = events(&log).into_iter().find(|e| e["type"] == "error").unwrap().clone();
        assert_eq!(error["error"]["code"], "25006", "read_only_sql_transaction");
    }

    /// `ONYX_TEST_PG=1 cargo test read_only`: a run that switches the session's default back to
    /// read-write (here through set_config, as a function could) doesn't carry over: the next
    /// run is read-only again, so a function that writes still can't. Exports run read-only too.
    #[tokio::test]
    async fn read_only_survives_a_flipped_default_and_exports_never_write() {
        let Some(config) = dev_config() else { return };
        let rw = crate::db::Session::connect(&config, None, None).await.unwrap();
        let schema = format!("onyx_ro_{}", uuid::Uuid::new_v4().simple());
        rw.execute_meta(&format!(
            "CREATE SCHEMA {schema}; CREATE TABLE {schema}.t (i int);
             CREATE FUNCTION {schema}.w() RETURNS int LANGUAGE sql AS $$ INSERT INTO {schema}.t VALUES (1) RETURNING i $$;"
        ))
        .await
        .unwrap();
        let count = || {
            let (rw, schema) = (&rw, schema.clone());
            async move { crate::journal::collect(rw, &format!("SELECT count(*) FROM {schema}.t"), None, None).await.unwrap().1[0][0].clone() }
        };

        let ro = PgSession::connect(&ConnectionConfig { read_only: true, ..config }, None, None).await.unwrap();
        let (channel, _) = recorder();
        ro.run_limited("SELECT set_config('default_transaction_read_only', 'off', false)", &channel, None, Some("t")).await.unwrap();
        let (channel, log) = recorder();
        ro.run_limited(&format!("SELECT {schema}.w()"), &channel, None, Some("t")).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()), "the write went through");
        assert_eq!(count().await.as_deref(), Some("0"));

        // An export (or copy) of a SELECT that calls a writing function writes nothing.
        let (channel, log) = recorder();
        rw.run_read_only(&format!("SELECT {schema}.w()"), &channel, None).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()));
        assert_eq!(count().await.as_deref(), Some("0"));

        // Alerts collect the same way: a read returns its rows, a writing call fails, nothing written.
        let (_, rows) = crate::journal::collect_read_only(&rw, "SELECT 41 + 1", Some(10)).await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("42"));
        assert!(crate::journal::collect_read_only(&rw, &format!("SELECT {schema}.w()"), Some(10)).await.is_err());
        assert_eq!(count().await.as_deref(), Some("0"));
        rw.execute_meta(&format!("DROP SCHEMA {schema} CASCADE")).await.unwrap();
    }

    #[tokio::test]
    async fn introspects_schema() {
        let Some(config) = dev_config() else { return };
        let session = PgSession::connect(&config, None, None).await.unwrap();

        // Other tests create onyx_* scratch schemas while this runs.
        let schemas: Vec<String> = session.schemas().await.unwrap().into_iter().filter(|s| !s.starts_with("onyx_")).collect();
        assert_eq!(schemas, ["public", "shop"]);

        let objects = session.objects("shop").await.unwrap();
        let kinds: Vec<(&str, &str)> = objects.iter().map(|o| (o.name.as_str(), o.kind)).collect();
        assert!(kinds.contains(&("users", "table")));
        assert!(kinds.contains(&("paid_orders", "view")));
        assert!(kinds.contains(&("revenue_by_user", "materialized-view")));
        assert!(kinds.contains(&("invoice_number_seq", "sequence")));
        assert!(kinds.contains(&("user_revenue", "function")));
        let users = objects.iter().find(|o| o.name == "users").unwrap();
        assert_eq!(users.estimated_rows, Some(5000));

        let columns = session.columns("shop", "orders").await.unwrap();
        assert_eq!(columns[0].name, "id");
        assert!(columns[0].primary_key);
        assert_eq!(columns[1].data_type, "bigint");
        assert!(!columns[1].nullable);

        let tables = session.completion_tables().await.unwrap();
        let events = tables.iter().find(|t| t.schema == "public" && t.name == "events").unwrap();
        assert_eq!(events.columns, ["id", "hash", "bucket", "at", "kind"]);
    }
}
