//! SQLite files through rusqlite. Two connections like the server engines: one for the
//! editor, one for introspection and edits. SQLite calls block, so they run on tokio's
//! blocking pool.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, InterruptHandle, OpenFlags};

use super::edit::EditStatement;
use super::model::{
    ColumnInfo, CompletionTable, DbObject, ForeignKeyInfo, ForeignKeyRef, IncomingReference, IndexInfo, StructureColumn,
    TableSnapshot, TableStructure, TriggerInfo,
};
use super::stream::{Events, Run, RunSummary};
use crate::connections::ConnectionConfig;
use crate::error::{AppError, ErrorPayload, Result};

/// One editor connection: the shared one, or a query tab's own.
struct Editor {
    conn: Arc<Mutex<Connection>>,
    interrupt: InterruptHandle,
}

pub struct SqliteSession {
    pub server_version: String,
    /// The shared editor connection (table browsing, menus, tabs without their own).
    query: Arc<Editor>,
    meta: Arc<Mutex<Connection>>,
    path: String,
    read_only: bool,
    /// Query tabs' own connections, so a transaction in one tab stays in that tab.
    tabs: std::sync::Mutex<std::collections::HashMap<String, Arc<Editor>>>,
}

fn open_file(path: &str, read_only: bool) -> Result<Connection> {
    let flags = if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE }
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    // Fails here (not on first query) when the file isn't a database.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    Ok(conn)
}

impl Editor {
    fn new(conn: Connection) -> Arc<Self> {
        Arc::new(Self { interrupt: conn.get_interrupt_handle(), conn: Arc::new(Mutex::new(conn)) })
    }
}

/// `~/x.db` → `/Users/me/x.db`.
pub fn expand_path(path: &str) -> String {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => path.to_owned(),
    }
}

impl SqliteSession {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let path = expand_path(config.database.trim());
        if !std::path::Path::new(&path).is_file() {
            return Err(AppError::Invalid(format!("No database file at {path}")));
        }
        let read_only = config.read_only;
        tokio::task::spawn_blocking(move || {
            let query = open_file(&path, read_only)?;
            let meta = open_file(&path, read_only)?;
            let server_version: String = meta.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
            Ok(Self {
                server_version,
                query: Editor::new(query),
                meta: Arc::new(Mutex::new(meta)),
                path,
                read_only,
                tabs: Default::default(),
            })
        })
        .await
        .map_err(join_error)?
    }

    /// The tab's own connection (opened on first use), or the shared one.
    async fn editor(&self, tab: Option<&str>) -> Result<Arc<Editor>> {
        let Some(tab) = tab else { return Ok(self.query.clone()) };
        if let Some(e) = self.tabs.lock().unwrap().get(tab) {
            return Ok(e.clone());
        }
        let (path, read_only) = (self.path.clone(), self.read_only);
        let conn = tokio::task::spawn_blocking(move || open_file(&path, read_only)).await.map_err(join_error)??;
        let editor = Editor::new(conn);
        self.tabs.lock().unwrap().insert(tab.to_owned(), editor.clone());
        Ok(editor)
    }

    /// Closes a tab's connection; anything it left open rolls back.
    pub async fn close_tab(&self, tab: &str) {
        self.tabs.lock().unwrap().remove(tab);
    }

    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        let editor = match tab {
            Some(t) => self.tabs.lock().unwrap().get(t).cloned(),
            None => Some(self.query.clone()),
        };
        if let Some(e) = editor {
            e.interrupt.interrupt();
        }
        Ok(())
    }

    pub async fn run(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let conn = match self.editor(tab).await {
            Ok(e) => e.conn.clone(),
            Err(e) => {
                let payload = ErrorPayload::from(&e);
                return Run::with_limit(events, limit).finish(Err(e), Some((payload, false)));
            }
        };
        let sql = sql.to_owned();
        let events = events.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut run = Run::with_limit(&events, limit);
            let outcome = run_batch(&conn, &sql, &mut run);
            let error = outcome.as_ref().err().map(|err| {
                let mut payload = ErrorPayload::from(err);
                payload.position = error_position(&sql, &payload.message);
                (payload, is_cancel(err))
            });
            run.finish(outcome, error)
        })
        .await
        .map_err(join_error)?
    }

    /// Runs `f` on the introspection connection, off the async runtime.
    async fn meta<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> Result<T> + Send + 'static) -> Result<T> {
        let conn = self.meta.clone();
        tokio::task::spawn_blocking(move || f(&conn.lock().unwrap())).await.map_err(join_error)?
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        self.meta(schemas).await
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let schema = schema.to_owned();
        self.meta(move |c| {
            let mut stmt = c.prepare(&format!(
                "SELECT name, type FROM {}.sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
                ident(&schema)
            ))?;
            let rows = stmt.query_map([], |r| {
                let kind: String = r.get(1)?;
                Ok(DbObject {
                    name: r.get(0)?,
                    kind: if kind == "view" { "view" } else { "table" },
                    detail: None,
                    estimated_rows: None,
                    size_bytes: None,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let (schema, table) = (schema.to_owned(), table.to_owned());
        self.meta(move |c| {
            Ok(table_info(c, &schema, &table)?
                .into_iter()
                .map(|col| ColumnInfo {
                    name: col.name,
                    data_type: col.data_type,
                    nullable: col.nullable,
                    primary_key: col.primary_key,
                    default: col.default,
                })
                .collect())
        })
        .await
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let (schema, table) = (schema.to_owned(), table.to_owned());
        self.meta(move |c| {
            let columns = table_info(c, &schema, &table)?;
            let indexes = indexes(c, &schema, &table, &columns)?;
            let outgoing = foreign_keys(c, &schema, &table)?;
            let mut referenced_by = Vec::new();
            for other in table_names(c, &schema)? {
                for fk in foreign_keys(c, &schema, &other)? {
                    if fk.ref_table == table {
                        referenced_by.push(IncomingReference {
                            name: fk.name,
                            schema: schema.clone(),
                            table: other.clone(),
                            columns: fk.columns,
                            ref_columns: fk.ref_columns,
                        });
                    }
                }
            }
            let mut stmt = c.prepare(&format!(
                "SELECT name, sql FROM {}.sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 ORDER BY name",
                ident(&schema)
            ))?;
            let triggers = stmt
                .query_map([&table], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|(name, definition)| TriggerInfo {
                    timing: super::postgres::trigger_timing(&definition, &name),
                    name,
                    definition,
                })
                .collect();
            let mut stmt = c.prepare(&format!(
                "SELECT sql FROM {}.sqlite_master WHERE tbl_name = ?1 AND sql IS NOT NULL
                 ORDER BY type IN ('table', 'view') DESC, name",
                ident(&schema)
            ))?;
            let ddl = stmt
                .query_map([&table], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|s| format!("{s};"))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(TableStructure { columns, indexes, foreign_keys: outgoing, referenced_by, checks: vec![], triggers, ddl })
        })
        .await
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        self.meta(|c| {
            let mut out = Vec::new();
            for schema in schemas(c)? {
                for name in object_names(c, &schema)? {
                    let columns = table_info(c, &schema, &name)?;
                    out.push(CompletionTable {
                        schema: schema.clone(),
                        name,
                        types: columns.iter().map(|c| c.data_type.clone()).collect(),
                        columns: columns.into_iter().map(|c| c.name).collect(),
                    });
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        self.meta(|c| {
            let mut out = Vec::new();
            for schema in schemas(c)? {
                for table in table_names(c, &schema)? {
                    for key in foreign_keys(c, &schema, &table)? {
                        out.push(ForeignKeyRef { schema: schema.clone(), table: table.clone(), key });
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let schema = schema.to_owned();
        self.meta(move |c| {
            let views = view_names(c, &schema)?;
            object_names(c, &schema)?
                .into_iter()
                .map(|name| {
                    let columns = table_info(c, &schema, &name)?;
                    Ok(TableSnapshot {
                        kind: if views.contains(&name) { "view" } else { "table" }.to_owned(),
                        indexes: indexes(c, &schema, &name, &columns)?,
                        foreign_keys: foreign_keys(c, &schema, &name)?,
                        columns,
                        name,
                    })
                })
                .collect()
        })
        .await
    }

    /// One transaction on the introspection connection; any failure rolls back.
    pub async fn apply(&self, statements: &[EditStatement]) -> Result<u64> {
        let statements = statements.to_vec();
        self.meta(move |c| {
            c.execute_batch("BEGIN")?;
            let applied = (|| -> Result<u64> {
                let mut total = 0;
                for s in &statements {
                    let changed = c.execute(&s.sql, rusqlite::params_from_iter(s.params.iter()))? as u64;
                    super::postgres::check_one_row(s, changed)?;
                    total += changed;
                }
                Ok(total)
            })();
            match applied {
                Ok(total) => {
                    c.execute_batch("COMMIT")?;
                    Ok(total)
                }
                Err(e) => {
                    let _ = c.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
        .await
    }

    /// Inserts rows in one transaction (CSV import, copies, generated data). Values are text;
    /// SQLite's column affinity stores numbers as numbers.
    pub async fn insert_rows(&self, sql: String, rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        self.meta(move |c| {
            let mut stmt = c.prepare_cached(&sql)?;
            let mut total = 0;
            for row in &rows {
                total += stmt.execute(rusqlite::params_from_iter(row.iter()))? as u64;
            }
            Ok(total)
        })
        .await
    }

    /// Runs plain SQL on the introspection connection (transaction control around inserts).
    pub async fn execute_meta(&self, sql: &str) -> Result<()> {
        let sql = sql.to_owned();
        self.meta(move |c| Ok(c.execute_batch(&sql)?)).await
    }
}

fn run_batch(conn: &Connection, sql: &str, run: &mut Run) -> Result<()> {
    let mut batch = rusqlite::Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next()? {
        let width = stmt.column_count();
        if width > 0 {
            run.start_result(stmt.column_names().into_iter().map(str::to_owned).collect())?;
            let mut rows = stmt.raw_query();
            while let Some(row) = rows.next()? {
                run.push_row((0..width).map(|i| text(row.get_ref_unwrap(i))))?;
            }
            run.end_result(None)?;
        } else {
            let before = conn.total_changes();
            stmt.raw_execute()?;
            run.command(conn.total_changes() - before)?;
        }
    }
    Ok(())
}

/// A value as the sqlite3 CLI prints it; blobs as hex.
fn text(value: ValueRef<'_>) -> Option<Cow<'_, str>> {
    match value {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(Cow::Owned(i.to_string())),
        ValueRef::Real(f) => Some(Cow::Owned(f.to_string())),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => Some(Cow::Owned(b.iter().fold(String::from("0x"), |mut s, byte| {
            s.push_str(&format!("{byte:02x}"));
            s
        }))),
    }
}

fn is_cancel(err: &AppError) -> bool {
    matches!(err, AppError::Sqlite(rusqlite::Error::SqliteFailure(e, _)) if e.code == ErrorCode::OperationInterrupted)
}

/// "no such column: nope", `near "selec": syntax error` → where that word is in the SQL.
fn error_position(sql: &str, message: &str) -> Option<u32> {
    let word = if let Some(rest) = message.strip_prefix("near \"") {
        rest.split('"').next()?
    } else {
        let rest = ["no such column: ", "no such table: ", "no such function: "]
            .iter()
            .find_map(|p| message.find(p).map(|i| &message[i + p.len()..]))?;
        rest.split([' ', ',']).next()?.rsplit('.').next()?
    };
    super::mysql::find_word(sql, word).map(|byte| sql[..byte].chars().count() as u32 + 1)
}

fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::Invalid(format!("SQLite task failed: {e}"))
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn schemas(c: &Connection) -> Result<Vec<String>> {
    let mut stmt = c.prepare("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")?;
    Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

fn names_of(c: &Connection, schema: &str, types: &str) -> Result<Vec<String>> {
    let mut stmt = c.prepare(&format!(
        "SELECT name FROM {}.sqlite_master WHERE type IN ({types}) AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        ident(schema)
    ))?;
    Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

fn table_names(c: &Connection, schema: &str) -> Result<Vec<String>> {
    names_of(c, schema, "'table'")
}

fn view_names(c: &Connection, schema: &str) -> Result<Vec<String>> {
    names_of(c, schema, "'view'")
}

fn object_names(c: &Connection, schema: &str) -> Result<Vec<String>> {
    names_of(c, schema, "'table', 'view'")
}

fn table_info(c: &Connection, schema: &str, table: &str) -> Result<Vec<StructureColumn>> {
    let autoincrement: bool = c
        .query_row(
            &format!("SELECT sql LIKE '%AUTOINCREMENT%' FROM {}.sqlite_master WHERE name = ?1", ident(schema)),
            [table],
            |r| r.get(0),
        )
        .unwrap_or(false);
    let mut stmt = c.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1, ?2) ORDER BY cid")?;
    let rows = stmt.query_map([table, schema], |r| {
        let pk: i64 = r.get(4)?;
        Ok(StructureColumn {
            name: r.get(0)?,
            data_type: r.get(1)?,
            nullable: r.get::<_, i64>(2)? == 0 && pk == 0,
            default: r.get(3)?,
            primary_key: pk > 0,
            extra: (pk > 0 && autoincrement).then(|| "autoincrement".to_owned()),
            comment: None,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn indexes(c: &Connection, schema: &str, table: &str, columns: &[StructureColumn]) -> Result<Vec<IndexInfo>> {
    let mut stmt = c.prepare("SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2) ORDER BY origin = 'pk' DESC, name")?;
    let list: Vec<(String, bool, String)> = stmt
        .query_map([table, schema], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    if !list.iter().any(|(_, _, origin)| origin == "pk") {
        // INTEGER PRIMARY KEY is the rowid: there's no index for it, but it is the primary key.
        let pk: Vec<String> = columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect();
        if !pk.is_empty() {
            out.push(IndexInfo { name: "PRIMARY".into(), columns: pk, unique: true, primary: true, size_bytes: None, scans: None });
        }
    }
    let mut info = c.prepare("SELECT name FROM pragma_index_info(?1, ?2) ORDER BY seqno")?;
    for (name, unique, origin) in list {
        let columns = info
            .query_map([&name, schema], |r| Ok(r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "(expression)".into())))?
            .collect::<rusqlite::Result<_>>()?;
        out.push(IndexInfo { primary: origin == "pk", name, columns, unique, size_bytes: None, scans: None });
    }
    Ok(out)
}

fn foreign_keys(c: &Connection, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>> {
    let mut stmt = c.prepare(
        "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
    )?;
    type Row = (i64, String, String, Option<String>, String, String);
    let rows: Vec<Row> = stmt
        .query_map([table, schema], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut keys: Vec<(i64, ForeignKeyInfo)> = Vec::new();
    for (id, ref_table, from, to, on_update, on_delete) in rows {
        if keys.last().is_none_or(|(last, _)| *last != id) {
            keys.push((
                id,
                ForeignKeyInfo {
                    name: format!("fk_{table}_{id}"),
                    columns: vec![],
                    ref_schema: schema.to_owned(),
                    ref_table: ref_table.clone(),
                    ref_columns: vec![],
                    on_update,
                    on_delete,
                },
            ));
        }
        let key = &mut keys.last_mut().unwrap().1;
        key.columns.push(from);
        // `REFERENCES t` without columns points at t's primary key.
        let to = match to {
            Some(to) => to,
            None => table_info(c, schema, &ref_table)?
                .into_iter()
                .filter(|c| c.primary_key)
                .nth(key.ref_columns.len())
                .map(|c| c.name)
                .unwrap_or_default(),
        };
        key.ref_columns.push(to);
    }
    Ok(keys.into_iter().map(|(_, k)| k).collect())
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::connections::{Engine, Environment, SslMode};
    use crate::db::stream::testing::{batches, event_types, events, recorder};
    use arrow_array::{Array, StringArray};

    impl SqliteSession {
        async fn run_test(&self, sql: &str, events: &Events, limit: Option<u64>) -> Result<RunSummary> {
            self.run(sql, events, limit, None).await
        }
    }

    #[tokio::test]
    async fn each_tab_has_its_own_transaction() {
        let (path, config) = temp_db();
        let session = SqliteSession::connect(&config).await.unwrap();
        let (channel, _) = recorder();
        session.run("BEGIN; UPDATE users SET email = 'pending@x.io' WHERE id = 1", &channel, None, Some("a")).await.unwrap();
        // The shared connection still sees the committed value.
        let (channel, log) = recorder();
        session.run("SELECT email FROM users WHERE id = 1", &channel, None, None).await.unwrap();
        let email = batches(&log.lock().unwrap())[0].column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned();
        assert_eq!(email, "a@x.io");
        // Closing the tab rolls its transaction back.
        session.close_tab("a").await;
        let (channel, log) = recorder();
        session.run("SELECT email FROM users WHERE id = 1", &channel, None, Some("a")).await.unwrap();
        let email = batches(&log.lock().unwrap())[0].column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned();
        assert_eq!(email, "a@x.io");
        std::fs::remove_file(path).unwrap();
    }

    fn temp_db() -> (String, ConnectionConfig) {
        let path = std::env::temp_dir().join(format!("onyx-sqlite-{}.db", Uuid::new_v4())).display().to_string();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, score REAL);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, total NUMERIC);
             CREATE INDEX orders_user ON orders (user_id);
             CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
             CREATE TRIGGER orders_touch AFTER UPDATE ON orders BEGIN SELECT 1; END;
             INSERT INTO users (email, score) VALUES ('a@x.io', 1.5), ('b@x.io', NULL);
             INSERT INTO orders (user_id, total) VALUES (1, 50), (1, 150), (2, 10);",
        )
        .unwrap();
        let config = ConnectionConfig {
            id: Uuid::new_v4(),
            engine: Engine::Sqlite,
            name: "t".into(),
            host: String::new(),
            port: 0,
            user: String::new(),
            database: path.clone(),
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
        };
        (path, config)
    }

    #[tokio::test]
    async fn runs_queries_and_commands() {
        let (path, config) = temp_db();
        let session = SqliteSession::connect(&config).await.unwrap();
        let (channel, log) = recorder();
        session
            .run_test("UPDATE users SET score = 2 WHERE id = 1; SELECT id, email, score FROM users ORDER BY id; SELECT nope FROM users", &channel, None)
            .await
            .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["command", "resultStart", "resultEnd", "error", "done"]);
        assert_eq!(events(&log)[0]["rowsAffected"], 1);
        let batch = batches(&log)[0];
        let score = batch.column(2).as_any().downcast_ref::<StringArray>().unwrap();
        assert_eq!(score.value(0), "2");
        assert!(score.is_null(1));
        let error = &events(&log)[3]["error"];
        assert!(error["message"].as_str().unwrap().contains("no such column"));
        assert_eq!(error["position"], 97);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn introspects_structure() {
        let (path, config) = temp_db();
        let session = SqliteSession::connect(&config).await.unwrap();
        assert_eq!(session.schemas().await.unwrap(), ["main"]);
        let objects = session.objects("main").await.unwrap();
        let kinds: Vec<(&str, &str)> = objects.iter().map(|o| (o.name.as_str(), o.kind)).collect();
        assert_eq!(kinds, [("big_orders", "view"), ("orders", "table"), ("users", "table")]);

        let users = session.structure("main", "users").await.unwrap();
        assert_eq!(users.columns[0].extra.as_deref(), Some("autoincrement"));
        assert!(users.indexes.iter().any(|i| i.primary && i.columns == ["id"]));
        assert!(users.indexes.iter().any(|i| i.unique && i.columns == ["email"]));
        assert_eq!(users.referenced_by[0].table, "orders");

        let orders = session.structure("main", "orders").await.unwrap();
        let fk = &orders.foreign_keys[0];
        assert_eq!((fk.ref_table.as_str(), fk.columns[0].as_str(), fk.ref_columns[0].as_str()), ("users", "user_id", "id"));
        assert_eq!(fk.on_delete, "CASCADE");
        assert_eq!(orders.triggers[0].timing, "AFTER UPDATE");
        assert!(orders.ddl.contains("CREATE INDEX orders_user"));

        let snapshot = session.snapshot("main").await.unwrap();
        assert_eq!(snapshot.len(), 3);
        assert_eq!(session.all_foreign_keys().await.unwrap().len(), 1);
        let completion = session.completion_tables().await.unwrap();
        assert_eq!(completion.iter().find(|t| t.name == "users").unwrap().types, ["INTEGER", "TEXT", "REAL"]);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn applies_edits_in_a_transaction() {
        use crate::db::edit::{build, Cell, RowEdit};
        let (path, config) = temp_db();
        let session = SqliteSession::connect(&config).await.unwrap();
        let types = [("id", "INTEGER"), ("email", "TEXT"), ("score", "REAL")].into_iter().map(|(a, b)| (a.into(), b.into())).collect();
        let cell = |c: &str, v: Option<&str>| Cell { column: c.into(), value: v.map(str::to_owned) };
        let edits = [
            RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("email", Some("o'neil@x.io"))], original: vec![] },
            RowEdit::Insert { values: vec![cell("email", Some("c@x.io"))] },
        ];
        let statements = build(Engine::Sqlite, "main", "users", &types, &edits).unwrap();
        assert_eq!(session.apply(&statements).await.unwrap(), 2);
        let stale = build(Engine::Sqlite, "main", "users", &types, &[RowEdit::Delete { key: vec![cell("id", Some("99"))], original: vec![] }]).unwrap();
        assert!(session.apply(&stale).await.is_err());

        let (channel, log) = recorder();
        session.run_test("SELECT email FROM users ORDER BY id", &channel, None).await.unwrap();
        let log = log.lock().unwrap();
        let emails = batches(&log)[0].column(0).as_any().downcast_ref::<StringArray>().unwrap().clone();
        assert_eq!((emails.value(0), emails.len()), ("o'neil@x.io", 3));
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn read_only_and_cancel() {
        let (path, config) = temp_db();
        let ro = SqliteSession::connect(&ConnectionConfig { read_only: true, ..config.clone() }).await.unwrap();
        let (channel, log) = recorder();
        ro.run_test("DELETE FROM users", &channel, None).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()));

        let session = Arc::new(SqliteSession::connect(&config).await.unwrap());
        let (channel, log) = recorder();
        let runner = {
            let session = session.clone();
            tokio::spawn(async move {
                session
                    .run_test("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n", &channel, None)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.cancel(None).await.unwrap();
        runner.await.unwrap().unwrap();
        let error = events(&log.lock().unwrap()).into_iter().find(|e| e["type"] == "error").unwrap().clone();
        assert_eq!(error["cancelled"], true);
        std::fs::remove_file(path).unwrap();
    }
}
