//! Database engines behind one `Session` type. Each open connection holds two
//! server connections: one for the editor's queries and one for schema
//! introspection, so browsing the tree never waits behind a long query.

pub mod clickhouse;
pub mod duckdb;
pub mod edit;
pub mod mongo;
pub mod model;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;
pub mod sqlserver;
pub mod stream;
pub(crate) mod tls;

use zeroize::Zeroizing;

use crate::connections::{ConnectionConfig, Engine};
use crate::dialect;
use crate::ssh;
use crate::error::{AppError, Result};
use clickhouse::ClickSession;
use duckdb::DuckSession;
use edit::{EditStatement, RowEdit};
use mongo::MongoSession;
use model::{ColumnInfo, CompletionTable, ConnectInfo, DbObject, ForeignKeyRef, TableSnapshot, TableStructure};
use mysql::MySession;
use postgres::PgSession;
use redis::RedisSession;
use sqlite::SqliteSession;
use sqlserver::SqlServerSession;
use stream::{Events, RunSummary};

/// The CA certificates `verify-full` trusts beyond the system's (Amazon RDS), as PEM.
pub fn tls_bundle() -> &'static [u8] {
    tls::RDS_CA_BUNDLE
}

/// A tab's own server connection dropped. Rather than silently opening a new one (statements
/// would then run outside the transaction the user believes is open), the run stops here once.
pub const LOST_TAB: &str = "This tab's connection to the server was lost, so the server rolled back anything it hadn't committed. Run again to continue on a new connection.";

// One per open connection, behind an Arc: variant sizes don't matter.

#[allow(clippy::large_enum_variant)]
pub enum Session {
    Postgres(Box<PgSession>),
    Mysql(Box<MySession>),
    Sqlite(SqliteSession),
    Duckdb(DuckSession),
    Redis(RedisSession),
    Clickhouse(Box<ClickSession>),
    Mongodb(Box<MongoSession>),
    Sqlserver(Box<SqlServerSession>),
}

/// Dispatches to the engine's session.
macro_rules! each {
    ($self:expr, $s:ident => $body:expr) => {
        match $self {
            Session::Postgres($s) => $body,
            Session::Mysql($s) => $body,
            Session::Sqlite($s) => $body,
            Session::Duckdb($s) => $body,
            Session::Redis($s) => $body,
            Session::Clickhouse($s) => $body,
            Session::Mongodb($s) => $body,
            Session::Sqlserver($s) => $body,
        }
    };
}

impl Session {
    /// `ssh_secret`: the SSH password or key passphrase, when the connection uses a tunnel.
    pub async fn connect(
        config: &ConnectionConfig,
        password: Option<Zeroizing<String>>,
        ssh_secret: Option<Zeroizing<String>>,
    ) -> Result<Self> {
        match config.engine {
            Engine::Sqlite => return Ok(Session::Sqlite(SqliteSession::connect(config).await?)),
            Engine::Duckdb => return Ok(Session::Duckdb(DuckSession::connect(config).await?)),
            _ => {}
        }
        let tunnel = match &config.ssh {
            Some(ssh) => Some(ssh::open(ssh, ssh_secret, (&config.host, config.port)).await?),
            None => None,
        };
        Ok(match config.engine {
            Engine::Mysql => Session::Mysql(Box::new(MySession::connect(config, password, tunnel).await?)),
            Engine::Redis => Session::Redis(RedisSession::connect(config, password, tunnel).await?),
            Engine::Clickhouse => Session::Clickhouse(Box::new(ClickSession::connect(config, password, tunnel).await?)),
            Engine::Mongodb => Session::Mongodb(Box::new(MongoSession::connect(config, password, tunnel).await?)),
            Engine::Sqlserver => Session::Sqlserver(Box::new(SqlServerSession::connect(config, password, tunnel).await?)),
            Engine::Postgres => Session::Postgres(Box::new(PgSession::connect(config, password, tunnel).await?)),
            Engine::Sqlite | Engine::Duckdb => unreachable!("file engines connect above"),
        })
    }

    pub fn info(&self) -> ConnectInfo {
        ConnectInfo { server_version: each!(self, s => s.server_version.clone()) }
    }

    /// Runs `sql` (one or more statements) and streams every result to `events`.
    /// Query errors are reported as events; only a broken channel is returned as `Err`.
    pub async fn run(&self, sql: &str, events: &Events) -> Result<RunSummary> {
        self.run_limited(sql, events, None, None).await
    }

    /// Runs a query that must only read (exports, copies): inside a READ ONLY transaction on a
    /// session of its own, rolled back afterwards, so even a function that writes can't
    /// (Postgres, MySQL). Other engines run it as `run` does, after the caller's checks.
    pub async fn run_read_only(&self, sql: &str, events: &Events, limit: Option<u64>) -> Result<RunSummary> {
        let begin = match self {
            Session::Postgres(_) => "BEGIN READ ONLY",
            Session::Mysql(_) => "START TRANSACTION READ ONLY",
            _ => return self.run_limited(sql, events, limit, None).await,
        };
        let tab = format!("__readonly_{}", uuid::Uuid::new_v4().simple());
        let result = async {
            self.execute_script(begin, &tab).await?;
            self.run_limited(sql, events, limit, Some(&tab)).await
        }
        .await;
        let _ = self.execute_script("ROLLBACK", &tab).await;
        self.close_tab(&tab).await;
        result
    }

    /// Like `run`, keeping at most `limit` rows of each result (the rest are counted).
    /// `tab`: a query tab's own connection (opened on first use) instead of the shared one.
    pub async fn run_limited(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        match self {
            Session::Postgres(s) => s.run_limited(sql, events, limit, tab).await,
            Session::Mysql(s) => s.run_limited(sql, events, limit, tab).await,
            Session::Sqlite(s) => s.run(sql, events, limit, tab).await,
            Session::Duckdb(s) => s.run(sql, events, limit).await,
            Session::Redis(s) => s.run(sql, events, limit, tab).await,
            Session::Clickhouse(s) => s.run(sql, events, limit, tab).await,
            Session::Mongodb(s) => s.run(sql, events, limit, tab).await,
            Session::Sqlserver(s) => s.run_limited(sql, events, limit, tab).await,
        }
    }

    /// Ask the server to cancel whatever the tab's (or the shared) editor connection is running.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        each!(self, s => s.cancel(tab).await)
    }

    /// Closes a query tab's own connection (rolling back anything it left open).
    pub async fn close_tab(&self, tab: &str) {
        match self {
            Session::Postgres(s) => s.close_tab(tab).await,
            Session::Mysql(s) => s.close_tab(tab).await,
            Session::Sqlite(s) => s.close_tab(tab).await,
            Session::Redis(s) => s.close_tab(tab).await,
            Session::Clickhouse(s) => s.close_tab(tab).await,
            Session::Mongodb(s) => s.close_tab(tab).await,
            Session::Sqlserver(s) => s.close_tab(tab).await,
            Session::Duckdb(_) => {}
        }
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        each!(self, s => s.schemas().await)
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        each!(self, s => s.objects(schema).await)
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        each!(self, s => s.columns(schema, table).await)
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        each!(self, s => s.structure(schema, table).await)
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        each!(self, s => s.completion_tables().await)
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        each!(self, s => s.all_foreign_keys().await)
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        each!(self, s => s.snapshot(schema).await)
    }

    pub fn engine(&self) -> Engine {
        match self {
            Session::Postgres(_) => Engine::Postgres,
            Session::Mysql(_) => Engine::Mysql,
            Session::Sqlite(_) => Engine::Sqlite,
            Session::Duckdb(_) => Engine::Duckdb,
            Session::Redis(_) => Engine::Redis,
            Session::Clickhouse(_) => Engine::Clickhouse,
            Session::Mongodb(_) => Engine::Mongodb,
            Session::Sqlserver(_) => Engine::Sqlserver,
        }
    }

    /// The local end of the SSH tunnel, for tools like pg_dump that connect on their own.
    pub fn tunnel_port(&self) -> Option<u16> {
        match self {
            Session::Postgres(s) => s.tunnel_port(),
            Session::Mysql(s) => s.tunnel_port(),
            Session::Redis(s) => s.tunnel_port(),
            Session::Clickhouse(s) => s.tunnel_port(),
            Session::Mongodb(s) => s.tunnel_port(),
            Session::Sqlserver(s) => s.tunnel_port(),
            _ => None,
        }
    }

    /// Turns table-view edits into statements, checking columns against the catalog.
    pub async fn prepare_edits(&self, schema: &str, table: &str, edits: &[RowEdit]) -> Result<Vec<EditStatement>> {
        let types = self.columns(schema, table).await?.into_iter().map(|c| (c.name, c.data_type)).collect();
        edit::build(self.engine(), schema, table, &types, edits)
    }

    /// Runs the statements in one transaction; any failure rolls all of them back.
    pub async fn apply_edits(&self, statements: &[EditStatement]) -> Result<u64> {
        each!(self, s => s.apply(statements).await)
    }

    /// Plain SQL (DDL) on the introspection connection, outside the editor's session.
    pub async fn execute_meta(&self, sql: &str) -> Result<()> {
        match self {
            Session::Postgres(s) => s.execute_meta(sql).await,
            Session::Mysql(s) => s.execute_meta(sql).await,
            Session::Sqlite(s) => s.execute_meta(sql).await,
            Session::Duckdb(s) => s.execute(sql).await,
            Session::Clickhouse(s) => s.execute(sql).await,
            Session::Sqlserver(s) => s.execute_meta(sql).await,
            _ => Err(AppError::Invalid("Not available for this engine".into())),
        }
    }

    /// A script statement for the .sql file runner: on the tab's own session where the engine
    /// has them (so `USE` and `SET` stay there), else the introspection connection.
    pub async fn execute_script(&self, sql: &str, tab: &str) -> Result<()> {
        match self {
            Session::Postgres(s) => s.execute_on_tab(sql, tab).await,
            Session::Mysql(s) => s.execute_on_tab(sql, tab).await,
            _ => self.execute_meta(sql).await,
        }
    }

    /// `COPY … FROM stdin` data (Postgres dumps).
    pub async fn copy_in(&self, statement: &str, data: Vec<u8>, tab: &str) -> Result<()> {
        match self {
            Session::Postgres(s) => s.copy_in(statement, data, tab).await.map(drop),
            _ => Err(AppError::Invalid("COPY … FROM stdin is a Postgres dump feature".into())),
        }
    }

    /// Server-administration SQL (activity, cancelling sessions) on the introspection
    /// connection, so it answers while the editor's connection is busy.
    pub async fn admin_rows(&self, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>)> {
        match self {
            Session::Postgres(s) => s.admin_rows(sql).await,
            Session::Mysql(s) => s.admin_rows(sql).await,
            Session::Clickhouse(s) => s.admin_rows(sql).await,
            Session::Sqlserver(s) => s.admin_rows(sql).await,
            _ => Err(AppError::Invalid("Server activity isn't available for this engine".into())),
        }
    }

    /// BEGIN / COMMIT / ROLLBACK on the connection bulk inserts use.
    pub async fn bulk_control(&self, sql: &str) -> Result<()> {
        match self {
            Session::Postgres(s) => s.execute_meta(sql).await,
            Session::Mysql(s) => s.execute_meta(sql).await,
            Session::Sqlite(s) => s.execute_meta(sql).await,
            Session::Sqlserver(s) => s.execute_meta(sql).await,
            // Each DuckDB batch is its own transaction; the others have none to control.
            _ => Ok(()),
        }
    }

    /// Inserts rows into `columns` of a table. Values are text; each engine converts them
    /// to the column types. Call inside `bulk_control("BEGIN")` … `("COMMIT")`.
    pub async fn insert_rows(&self, schema: &str, table: &str, columns: &[String], rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        if columns.is_empty() || rows.is_empty() {
            return Ok(0);
        }
        let engine = self.engine();
        let target = dialect::qualified(engine, schema, table);
        let names = columns.iter().map(|c| dialect::ident(engine, c)).collect::<Vec<_>>().join(", ");
        let single = || format!("INSERT INTO {target} ({names}) VALUES ({})", vec!["?"; columns.len()].join(", "));
        match self {
            Session::Sqlite(s) => s.insert_rows(single(), rows).await,
            Session::Duckdb(s) => s.insert_rows(single(), rows).await,
            Session::Redis(_) => Err(AppError::Invalid("Redis has no tables to insert rows into".into())),
            Session::Clickhouse(s) => s.insert_rows(schema, table, columns, rows).await,
            Session::Mongodb(s) => s.insert_rows(schema, table, columns, rows).await,
            Session::Sqlserver(s) => s.insert_rows(schema, table, columns, rows).await,
            Session::Postgres(s) => {
                let catalog = self.columns(schema, table).await?;
                let types: Vec<String> = columns
                    .iter()
                    .map(|c| {
                        catalog
                            .iter()
                            .find(|k| &k.name == c)
                            .map(|k| k.data_type.clone())
                            .ok_or_else(|| AppError::Invalid(format!("Unknown column {c}")))
                    })
                    .collect::<Result<_>>()?;
                let mut total = 0;
                for chunk in rows.chunks((60_000 / columns.len()).clamp(1, 1000)) {
                    let mut n = 0;
                    let tuples: Vec<String> = chunk
                        .iter()
                        .map(|_| {
                            let values: Vec<String> = types
                                .iter()
                                .map(|ty| {
                                    n += 1;
                                    format!("CAST(${n}::text AS {})", crate::dialect::pg_cast_type(ty))
                                })
                                .collect();
                            format!("({})", values.join(", "))
                        })
                        .collect();
                    let sql = format!("INSERT INTO {target} ({names}) VALUES {}", tuples.join(", "));
                    total += s.execute_params(&sql, chunk.iter().flatten().cloned().collect()).await?;
                }
                Ok(total)
            }
            Session::Mysql(s) => {
                let mut total = 0;
                for chunk in rows.chunks((60_000 / columns.len()).clamp(1, 1000)) {
                    let tuple = format!("({})", vec!["?"; columns.len()].join(", "));
                    let sql = format!("INSERT INTO {target} ({names}) VALUES {}", vec![tuple; chunk.len()].join(", "));
                    total += s.execute_params(&sql, chunk.iter().flatten().cloned().collect()).await?;
                }
                Ok(total)
            }
        }
    }
}

/// Table edits against both dev databases: `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test`.
#[cfg(test)]
pub(crate) mod edit_integration {
    use uuid::Uuid;

    use super::*;
    use crate::connections::{Environment, SslMode};
    use crate::db::edit::Cell;
    use crate::db::stream::testing::{batches, recorder};
    use arrow_array::{Array, StringArray};

    pub(crate) fn config(engine: Engine) -> Option<ConnectionConfig> {
        let (var, port, user) = match engine {
            Engine::Mysql => ("ONYX_TEST_MYSQL", 33069, "root"),
            _ => ("ONYX_TEST_PG", 54329, "postgres"),
        };
        std::env::var(var).ok()?;
        Some(ConnectionConfig {
            id: Uuid::new_v4(),
            engine,
            name: "edits".into(),
            host: "127.0.0.1".into(),
            port,
            user: user.into(),
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

    fn cell(column: &str, value: Option<&str>) -> Cell {
        Cell { column: column.into(), value: value.map(str::to_owned) }
    }

    async fn rows(session: &Session, sql: &str) -> Vec<Vec<Option<String>>> {
        let (channel, log) = recorder();
        session.run(sql, &channel).await.unwrap();
        let log = log.lock().unwrap();
        let mut out = Vec::new();
        for batch in batches(&log) {
            let columns: Vec<&StringArray> =
                batch.columns().iter().map(|c| c.as_any().downcast_ref::<StringArray>().unwrap()).collect();
            for r in 0..batch.num_rows() {
                out.push(columns.iter().map(|c| (!c.is_null(r)).then(|| c.value(r).to_owned())).collect());
            }
        }
        out
    }

    /// `ONYX_TEST_PG=1 cargo test fits`: a value too long for varchar(n) / char(n) is refused,
    /// by bulk inserts (fixtures, CSV, copies) and by cell edits, never cut to fit; values that
    /// fit are stored exactly.
    #[tokio::test]
    async fn postgres_writes_refuse_values_that_dont_fit() {
        let Some(config) = config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let table = format!("fit_test_{}", Uuid::new_v4().simple());
        rows(&session, &format!("CREATE TABLE public.{table} (id int PRIMARY KEY, short varchar(5), code char(3), amount numeric(5,2))")).await;
        let cols = ["id".to_owned(), "short".to_owned(), "code".to_owned(), "amount".to_owned()];
        let row = |id: &str, short: &str, code: &str| vec![Some(id.to_owned()), Some(short.to_owned()), Some(code.to_owned()), Some("999.99".to_owned())];
        let insert = |r| {
            let (s, t, c) = (&session, table.clone(), cols.clone());
            async move {
                s.bulk_control("BEGIN").await.unwrap();
                let out = s.insert_rows("public", &t, &c, vec![r]).await;
                s.bulk_control(if out.is_ok() { "COMMIT" } else { "ROLLBACK" }).await.unwrap();
                out
            }
        };
        let err = format!("{:?}", insert(row("1", "naïve café", "ab")).await.unwrap_err());
        assert!(err.contains("too long"), "{err}");
        let err = format!("{:?}", insert(row("1", "ok", "abcd")).await.unwrap_err());
        assert!(err.contains("too long"), "{err}");
        assert_eq!(insert(row("1", "你好👋🏽", "ab")).await.unwrap(), 1);
        assert_eq!(
            rows(&session, &format!("SELECT short, code, amount FROM public.{table}")).await,
            [[Some("你好👋🏽".into()), Some("ab ".into()), Some("999.99".into())]]
        );
        let edit = vec![RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("short", Some("O'Brien"))], original: vec![] }];
        let statements = session.prepare_edits("public", &table, &edit).await.unwrap();
        assert!(format!("{:?}", session.apply_edits(&statements).await.unwrap_err()).contains("too long"));
        assert_eq!(rows(&session, &format!("SELECT short FROM public.{table}")).await, [[Some("你好👋🏽".into())]]);
        rows(&session, &format!("DROP TABLE public.{table}")).await;
    }

    async fn round_trip(engine: Engine) {
        let Some(config) = config(engine) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let (schema, table) = match engine {
            Engine::Mysql => ("onyx_dev", format!("edit_test_{}", Uuid::new_v4().simple())),
            _ => ("public", format!("edit_test_{}", Uuid::new_v4().simple())),
        };
        let qualified = format!("{schema}.{table}");
        rows(&session, &format!("CREATE TABLE {qualified} (id INT PRIMARY KEY, name TEXT, n INT, made DATE)")).await;
        rows(&session, &format!("INSERT INTO {qualified} VALUES (1, 'one', 10, '2026-01-01'), (2, 'two', 20, NULL)")).await;

        // Text values from the grid go back into typed columns.
        let edits = vec![
            RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("name", Some("O'Neil")), cell("n", None), cell("made", Some("2026-10-22"))], original: vec![] },
            RowEdit::Insert { values: vec![cell("id", Some("3")), cell("name", Some("three"))] },
            RowEdit::Delete { key: vec![cell("id", Some("2"))], original: vec![] },
        ];
        let statements = session.prepare_edits(schema, &table, &edits).await.unwrap();
        assert_eq!(session.apply_edits(&statements).await.unwrap(), 3);
        assert_eq!(
            rows(&session, &format!("SELECT id, name, n, made FROM {qualified} ORDER BY id")).await,
            [
                vec![Some("1".into()), Some("O'Neil".into()), None, Some("2026-10-22".into())],
                vec![Some("3".into()), Some("three".into()), None, None],
            ]
        );

        // A row that no longer exists rolls back the whole batch.
        let stale = vec![
            RowEdit::Insert { values: vec![cell("id", Some("4"))] },
            RowEdit::Update { key: vec![cell("id", Some("99"))], set: vec![cell("name", Some("gone"))], original: vec![] },
        ];
        let statements = session.prepare_edits(schema, &table, &stale).await.unwrap();
        let err = session.apply_edits(&statements).await.unwrap_err();
        assert!(err.to_string().contains("expected to change 1 row"), "{err}");
        assert_eq!(rows(&session, &format!("SELECT count(*) FROM {qualified}")).await, [vec![Some("2".into())]]);

        // Bulk inserts bind text and convert it per column type.
        session.bulk_control("BEGIN").await.unwrap();
        let columns = ["id".to_owned(), "name".to_owned(), "made".to_owned()];
        let bulk: Vec<Vec<Option<String>>> =
            (10..1510).map(|i| vec![Some(i.to_string()), Some(format!("row {i}")), Some("2026-01-02".into())]).collect();
        assert_eq!(session.insert_rows(schema, &table, &columns, bulk).await.unwrap(), 1500);
        session.bulk_control("COMMIT").await.unwrap();
        assert_eq!(rows(&session, &format!("SELECT count(*) FROM {qualified}")).await, [vec![Some("1502".into())]]);

        let snapshot = session.snapshot(schema).await.unwrap();
        let mine = snapshot.iter().find(|t| t.name == table).unwrap();
        assert_eq!(mine.columns.len(), 4);
        assert!(mine.indexes.iter().any(|i| i.primary));

        rows(&session, &format!("DROP TABLE {qualified}")).await;
    }

    #[tokio::test]
    async fn structure_lists_columns_indexes_foreign_keys_and_ddl() {
        for (engine, schema, users) in [(Engine::Postgres, "shop", "users"), (Engine::Mysql, "onyx_dev", "users")] {
            let Some(config) = config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let s = session.structure(schema, "orders").await.unwrap();

            let id = &s.columns[0];
            assert_eq!(id.name, "id");
            assert!(id.primary_key && !id.nullable);
            assert!(id.extra.is_some() || id.default.is_some(), "{engine:?}: id is generated: {id:?}");

            let primary = s.indexes.iter().find(|i| i.primary).unwrap();
            assert_eq!(primary.columns, ["id"]);
            let fk = &s.foreign_keys[0];
            assert_eq!((fk.columns.as_slice(), fk.ref_table.as_str(), fk.ref_columns.as_slice()), (&["user_id".to_owned()][..], users, &["id".to_owned()][..]));
            assert!(s.ddl.to_uppercase().starts_with("CREATE TABLE"), "{}", s.ddl);
            assert!(s.ddl.contains("user_id"));

            let users_structure = session.structure(schema, users).await.unwrap();
            let incoming = &users_structure.referenced_by[0];
            assert_eq!((incoming.table.as_str(), incoming.columns.as_slice()), ("orders", &["user_id".to_owned()][..]));

            let view = session.structure(schema, "paid_orders").await.unwrap();
            assert!(view.ddl.to_uppercase().contains("VIEW"), "{}", view.ddl);
        }
    }

    #[tokio::test]
    async fn admin_queries_answer_on_the_introspection_connection() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let (columns, rows) = session.admin_rows("SELECT 1 AS a, NULL AS b").await.unwrap();
            assert_eq!(columns, ["a", "b"]);
            assert_eq!(rows, [vec![Some("1".to_owned()), None]]);
        }
    }

    #[tokio::test]
    async fn postgres_edits_round_trip_and_roll_back() {
        round_trip(Engine::Postgres).await;
    }

    #[tokio::test]
    async fn mysql_edits_round_trip_and_roll_back() {
        round_trip(Engine::Mysql).await;
    }
}
