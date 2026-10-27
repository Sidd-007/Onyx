//! DuckDB through its command-line tool, so Onyx doesn't ship the whole engine. Each
//! statement runs as one `duckdb -csv` process and its rows stream back as CSV. Install it
//! with `brew install duckdb`. With no database file, the session gets a private scratch
//! database that's deleted on disconnect, so tables and settings last as long as the session
//! (handy for querying CSV, Parquet and JSON files directly).

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use super::edit::EditStatement;
use super::model::{
    ColumnInfo, CompletionTable, DbObject, ForeignKeyInfo, ForeignKeyRef, IncomingReference, IndexInfo, StructureColumn,
    TableSnapshot, TableStructure,
};
use super::stream::{Events, Run, RunSummary};
use crate::connections::{ConnectionConfig, Engine};
use crate::dialect::literal;
use crate::error::{AppError, ErrorPayload, Result};

/// Printed for NULL, so it can't be confused with an empty string.
const NULL_MARK: &str = "\u{1}NULL\u{1}";

pub struct DuckSession {
    pub server_version: String,
    binary: PathBuf,
    /// The database file (the session's scratch file when the connection names none).
    database: Option<String>,
    /// Scratch database to delete when the session closes.
    scratch: Option<PathBuf>,
    read_only: bool,
    /// The process running right now, so cancel can stop it.
    running: Arc<Mutex<Option<Child>>>,
    /// One process at a time: a DuckDB file has a single writer.
    serial: tokio::sync::Mutex<()>,
}

impl Drop for DuckSession {
    fn drop(&mut self) {
        if let Some(path) = &self.scratch {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(path.with_extension("duckdb.wal"));
        }
    }
}

/// The `duckdb` binary on PATH or in Homebrew's usual places.
pub fn find_binary() -> Option<PathBuf> {
    crate::tools::find("duckdb")
}

type Rows = Vec<Vec<Option<String>>>;

impl DuckSession {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let binary = find_binary().ok_or_else(|| {
            AppError::Invalid("DuckDB isn't installed. Install it with `brew install duckdb`, then connect again.".into())
        })?;
        let named = Some(super::sqlite::expand_path(config.database.trim())).filter(|d| !d.is_empty());
        let scratch = named
            .is_none()
            .then(|| std::env::temp_dir().join(format!("onyx-duckdb-{}.duckdb", uuid::Uuid::new_v4().simple())));
        let database = named.or_else(|| scratch.as_ref().map(|p| p.display().to_string()));
        let session = Self {
            server_version: String::new(),
            binary,
            database,
            scratch,
            read_only: config.read_only,
            running: Arc::new(Mutex::new(None)),
            serial: tokio::sync::Mutex::new(()),
        };
        let version = session.query_rows("SELECT version()").await?;
        let server_version = version.first().and_then(|r| r.first().cloned().flatten()).unwrap_or_default();
        // A struct update would drop `session` (and its scratch file): move it instead.
        let mut session = session;
        session.server_version = server_version;
        Ok(session)
    }

    fn command(&self, sql: &str) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.arg(self.database.as_deref().unwrap_or(":memory:"));
        if self.read_only && self.scratch.is_none() {
            cmd.arg("-readonly");
        }
        // -bail: a script stops at its first error (so a failed edit never reaches COMMIT).
        cmd.args(["-bail", "-csv", "-header", "-nullvalue", NULL_MARK, "-c", sql])
            // DuckDB 2 changes its output for AI agents; Onyx always wants plain CSV.
            .env_remove("AI_AGENT")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// All tabs share the session's database (each statement is its own process anyway).
    pub async fn cancel(&self, _tab: Option<&str>) -> Result<()> {
        if let Some(child) = self.running.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
        Ok(())
    }

    pub async fn run(&self, sql: &str, events: &Events, limit: Option<u64>) -> Result<RunSummary> {
        let _serial = self.serial.lock().await;
        let statements: Vec<String> = split(sql);
        // INSERT / UPDATE / DELETE print nothing in CSV mode: count their RETURNING rows instead.
        let commands: Vec<(Command, bool)> = statements
            .iter()
            .map(|s| match counted(s) {
                Some(rewritten) => (self.command(&rewritten), true),
                None => (self.command(s), false),
            })
            .collect();
        let running = self.running.clone();
        let events = events.clone();
        tokio::task::spawn_blocking(move || {
            let mut run = Run::with_limit(&events, limit);
            let mut cancelled = false;
            let outcome = (|| -> Result<()> {
                for (statement, (command, count_rows)) in statements.iter().zip(commands) {
                    stream_statement(command, statement, count_rows, &running, &mut run, &mut cancelled)?;
                }
                Ok(())
            })();
            let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), cancelled));
            run.finish(outcome, error)
        })
        .await
        .map_err(join_error)?
    }

    /// All rows of one statement, for introspection.
    async fn query_rows(&self, sql: &str) -> Result<Rows> {
        let _serial = self.serial.lock().await;
        let command = self.command(sql);
        tokio::task::spawn_blocking(move || collect(command)).await.map_err(join_error)?
    }

    pub async fn execute(&self, sql: &str) -> Result<()> {
        self.query_rows(sql).await.map(|_| ())
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        let rows = self
            .query_rows(
                "SELECT schema_name FROM information_schema.schemata
                 WHERE catalog_name = current_database() AND schema_name NOT IN ('information_schema', 'pg_catalog')
                 ORDER BY 1",
            )
            .await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let s = lit(schema);
        let rows = self
            .query_rows(&format!(
                "SELECT t.table_name, t.table_type, d.estimated_size
                 FROM information_schema.tables t
                 LEFT JOIN duckdb_tables() d
                   ON d.database_name = t.table_catalog AND d.schema_name = t.table_schema AND d.table_name = t.table_name
                 WHERE t.table_catalog = current_database() AND t.table_schema = {s}
                 ORDER BY 1"
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let view = r.get(1).cloned().flatten().is_some_and(|k| k == "VIEW");
                DbObject {
                    name: cell(&r, 0),
                    kind: if view { "view" } else { "table" },
                    detail: None,
                    estimated_rows: r.get(2).cloned().flatten().and_then(|n| n.parse().ok()),
                    size_bytes: None,
                }
            })
            .collect())
    }

    async fn structure_columns(&self, schema: &str, table: &str) -> Result<Vec<StructureColumn>> {
        let (s, t) = (lit(schema), lit(table));
        let rows = self
            .query_rows(&format!(
                "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                        list_contains(coalesce((SELECT first(k.constraint_column_names) FROM duckdb_constraints() k
                                                WHERE k.schema_name = c.table_schema AND k.table_name = c.table_name
                                                  AND k.constraint_type = 'PRIMARY KEY'), []), c.column_name)
                 FROM information_schema.columns c
                 WHERE c.table_catalog = current_database() AND c.table_schema = {s} AND c.table_name = {t}
                 ORDER BY c.ordinal_position"
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| StructureColumn {
                name: cell(&r, 0),
                data_type: cell(&r, 1),
                nullable: cell(&r, 2) == "YES",
                default: r.get(3).cloned().flatten(),
                primary_key: cell(&r, 4) == "true",
                extra: None,
                comment: None,
            })
            .collect())
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        Ok(self
            .structure_columns(schema, table)
            .await?
            .into_iter()
            .map(|c| ColumnInfo { name: c.name, data_type: c.data_type, nullable: c.nullable, primary_key: c.primary_key, default: c.default })
            .collect())
    }

    async fn foreign_keys(&self, filter: &str) -> Result<Vec<ForeignKeyRef>> {
        let rows = self
            .query_rows(&format!(
                "SELECT schema_name, table_name, constraint_name, constraint_column_names, referenced_table, referenced_column_names
                 FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND database_name = current_database() AND {filter}
                 ORDER BY 1, 2, 3"
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ForeignKeyRef {
                schema: cell(&r, 0),
                table: cell(&r, 1),
                key: ForeignKeyInfo {
                    name: cell(&r, 2),
                    columns: list(&cell(&r, 3)),
                    ref_schema: cell(&r, 0),
                    ref_table: cell(&r, 4),
                    ref_columns: list(&cell(&r, 5)),
                    on_update: "NO ACTION".into(),
                    on_delete: "NO ACTION".into(),
                },
            })
            .collect())
    }

    async fn indexes(&self, schema: &str, table: &str, columns: &[StructureColumn]) -> Result<Vec<IndexInfo>> {
        let mut out = Vec::new();
        let pk: Vec<String> = columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect();
        if !pk.is_empty() {
            out.push(IndexInfo { name: "PRIMARY".into(), columns: pk, unique: true, primary: true, size_bytes: None, scans: None });
        }
        let rows = self
            .query_rows(&format!(
                "SELECT index_name, is_unique, expressions FROM duckdb_indexes()
                 WHERE database_name = current_database() AND schema_name = {} AND table_name = {} ORDER BY 1",
                lit(schema),
                lit(table)
            ))
            .await?;
        for r in rows {
            out.push(IndexInfo {
                name: cell(&r, 0),
                unique: cell(&r, 1) == "true",
                primary: false,
                columns: list(&cell(&r, 2)).into_iter().map(|c| c.trim_matches('"').to_owned()).collect(),
                size_bytes: None,
                scans: None,
            });
        }
        Ok(out)
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let columns = self.structure_columns(schema, table).await?;
        let indexes = self.indexes(schema, table, &columns).await?;
        let (s, t) = (lit(schema), lit(table));
        let foreign_keys = self
            .foreign_keys(&format!("schema_name = {s} AND table_name = {t}"))
            .await?
            .into_iter()
            .map(|f| f.key)
            .collect();
        let referenced_by = self
            .foreign_keys(&format!("referenced_table = {t}"))
            .await?
            .into_iter()
            .map(|f| IncomingReference { name: f.key.name, schema: f.schema, table: f.table, columns: f.key.columns, ref_columns: f.key.ref_columns })
            .collect();
        let ddl = self
            .query_rows(&format!(
                "SELECT sql FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = {s} AND table_name = {t}
                 UNION ALL
                 SELECT sql FROM duckdb_views() WHERE database_name = current_database() AND schema_name = {s} AND view_name = {t}"
            ))
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect::<Vec<_>>()
            .join("\n");
        Ok(TableStructure { columns, indexes, foreign_keys, referenced_by, checks: vec![], triggers: vec![], ddl })
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let rows = self
            .query_rows(
                "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
                 WHERE table_catalog = current_database() ORDER BY table_schema, table_name, ordinal_position",
            )
            .await?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        for r in rows {
            let (schema, name, column, ty) = (cell(&r, 0), cell(&r, 1), cell(&r, 2), cell(&r, 3));
            match tables.last_mut() {
                Some(t) if t.schema == schema && t.name == name => {
                    t.columns.push(column);
                    t.types.push(ty);
                }
                _ => tables.push(CompletionTable { schema, name, columns: vec![column], types: vec![ty] }),
            }
        }
        Ok(tables)
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        self.foreign_keys("true").await
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let mut out = Vec::new();
        for object in self.objects(schema).await? {
            let columns = self.structure_columns(schema, &object.name).await?;
            let indexes = self.indexes(schema, &object.name, &columns).await?;
            let foreign_keys = self
                .foreign_keys(&format!("schema_name = {} AND table_name = {}", lit(schema), lit(&object.name)))
                .await?
                .into_iter()
                .map(|f| f.key)
                .collect();
            out.push(TableSnapshot { name: object.name, kind: object.kind.into(), columns, indexes, foreign_keys });
        }
        Ok(out)
    }

    /// The CLI has no bound parameters: the statements run with their values written in
    /// (already quoted by the edit builder), inside one transaction. Each update and delete is
    /// first checked to match exactly one row; any failure stops the script before COMMIT.
    pub async fn apply(&self, statements: &[EditStatement]) -> Result<u64> {
        let mut script = String::from("BEGIN TRANSACTION;\n");
        for s in statements {
            if let Some(count) = &s.count_sql {
                let message = lit(&format!(
                    "Nothing was saved: expected to change 1 row (was the row changed or deleted?): {}",
                    s.display
                ));
                script += &format!("SELECT CASE WHEN ({count}) <> 1 THEN error({message}) END;\n");
            }
            script += &format!("{};\n", s.display);
        }
        script += "COMMIT;";
        self.query_rows(&script).await?;
        Ok(statements.len() as u64)
    }

    /// `sql` is an INSERT with `?` placeholders; values are written in as literals.
    pub async fn insert_rows(&self, sql: String, rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        let mut script = String::from("BEGIN TRANSACTION;\n");
        for row in &rows {
            let mut values = row.iter();
            let statement: String = sql
                .split('?')
                .enumerate()
                .map(|(i, piece)| {
                    if i == 0 {
                        piece.to_owned()
                    } else {
                        let value = values.next().cloned().flatten();
                        format!("{}{piece}", value.map_or("NULL".into(), |v| literal(Engine::Duckdb, &v)))
                    }
                })
                .collect();
            script.push_str(&statement);
            script.push_str(";\n");
        }
        script.push_str("COMMIT;");
        self.query_rows(&script).await?;
        Ok(rows.len() as u64)
    }
}

fn lit(value: &str) -> String {
    literal(Engine::Duckdb, value)
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// DuckDB prints lists as `[a, b]`.
fn list(text: &str) -> Vec<String> {
    text.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::Invalid(format!("DuckDB task failed: {e}"))
}

/// Runs one statement and streams its CSV output into `run`.
fn stream_statement(
    mut command: Command,
    statement: &str,
    count_rows: bool,
    running: &Mutex<Option<Child>>,
    run: &mut Run,
    cancelled: &mut bool,
) -> Result<()> {
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    *running.lock().unwrap() = Some(child);

    let mut reader = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(stdout);
    let mut records = reader.records();
    let header = records.next().transpose().map_err(csv_error)?;
    let dml = {
        let first = statement.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        ["INSERT", "UPDATE", "DELETE", "COPY"].contains(&first.as_str())
    };
    let mut outcome = Ok(());
    let mut silent = false;
    match header {
        None => silent = true,
        // A data change rewritten with RETURNING: its rows are the count.
        Some(_) if count_rows => {
            let mut n = 0;
            for record in records {
                record.map_err(csv_error)?;
                n += 1;
            }
            run.command(n)?;
        }
        // Older versions print a Count result for INSERT / UPDATE / DELETE.
        Some(h) if dml && h.len() == 1 && &h[0] == "Count" => {
            let count = records.next().transpose().map_err(csv_error)?.and_then(|r| r[0].parse().ok()).unwrap_or(0);
            run.command(count)?;
        }
        Some(h) => {
            run.start_result(h.iter().map(str::to_owned).collect())?;
            for record in records {
                let record = match record {
                    Ok(r) => r,
                    Err(e) => {
                        outcome = Err(csv_error(e));
                        break;
                    }
                };
                run.push_row(record.iter().map(|v| (v != NULL_MARK).then_some(v)))?;
            }
            run.end_result(None)?;
        }
    }

    let mut errors = String::new();
    let _ = stderr.read_to_string(&mut errors);
    let mut child = running.lock().unwrap().take().expect("child");
    let status = child.wait()?;
    if !status.success() {
        if status.code().is_none() {
            *cancelled = true;
            return Err(AppError::Invalid("Query cancelled".into()));
        }
        let message = errors.trim().trim_start_matches("Error:").trim();
        return Err(AppError::Invalid(if message.is_empty() { format!("duckdb exited with {status}") } else { message.to_owned() }));
    }
    // Statements with no output (CREATE, SET …) still get a "succeeded" entry.
    if silent {
        run.command(0)?;
    }
    outcome
}

/// Every row of one statement.
fn collect(mut command: Command) -> Result<Rows> {
    let output = command.output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Invalid(message.trim().trim_start_matches("Error:").trim().to_owned()));
    }
    let mut reader = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(output.stdout.as_slice());
    let mut rows = Vec::new();
    for record in reader.records() {
        rows.push(record.map_err(csv_error)?.iter().map(|v| (v != NULL_MARK).then(|| v.to_owned())).collect());
    }
    Ok(rows)
}

fn csv_error(e: csv::Error) -> AppError {
    AppError::Invalid(format!("Couldn't read DuckDB's output: {e}"))
}

/// `statement` with `RETURNING 1` added, when it changes rows and returns none of its own.
/// On a new line, so a trailing `--` comment can't swallow it.
fn counted(statement: &str) -> Option<String> {
    let code = statement.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("--"))?;
    let first = code.split_whitespace().next()?.to_ascii_uppercase();
    let returns = statement.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w.eq_ignore_ascii_case("returning"));
    (["INSERT", "UPDATE", "DELETE"].contains(&first.as_str()) && !returns).then(|| format!("{statement}\nRETURNING 1"))
}

/// Splits on top-level semicolons, outside strings, quoted names and comments.
pub fn split(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        current.push(c);
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '\'' | '"' | '`' => quote = Some(c),
                '-' if chars.peek() == Some(&'-') => {
                    for c in chars.by_ref() {
                        current.push(c);
                        if c == '\n' {
                            break;
                        }
                    }
                }
                '/' if chars.peek() == Some(&'*') => {
                    let mut last = ' ';
                    for c in chars.by_ref() {
                        current.push(c);
                        if last == '*' && c == '/' {
                            break;
                        }
                        last = c;
                    }
                }
                ';' => {
                    current.pop();
                    out.push(std::mem::take(&mut current));
                }
                _ => {}
            },
        }
    }
    out.push(current);
    out.into_iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty() && !is_only_comments(s)).collect()
}

fn is_only_comments(s: &str) -> bool {
    s.lines().all(|l| l.trim().is_empty() || l.trim().starts_with("--"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::stream::testing::{batches, event_types, events, recorder};
    use arrow_array::{Array, StringArray};

    #[test]
    fn splits_statements_outside_quotes_and_comments() {
        assert_eq!(
            split("select 'a;b'; -- c;d\nselect \"x;y\" /* ; */ ; ;"),
            ["select 'a;b'", "-- c;d\nselect \"x;y\" /* ; */"]
        );
        assert_eq!(split("-- only a comment"), Vec::<String>::new());
    }

    fn config(database: &str) -> Option<ConnectionConfig> {
        find_binary()?;
        let mut config = crate::bulk_test_config(std::path::Path::new(database));
        config.engine = Engine::Duckdb;
        Some(config)
    }

    #[tokio::test]
    async fn queries_csv_files_in_memory() {
        let Some(config) = config("") else { return };
        let dir = std::env::temp_dir().join(format!("onyx-duck-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("people.csv");
        std::fs::write(&csv, "id,name,score\n1,ann,9.5\n2,\"bo, b\",\n3,cy,7\n").unwrap();
        let session = DuckSession::connect(&config).await.unwrap();
        assert!(session.server_version.starts_with('v'), "{}", session.server_version);

        let (channel, log) = recorder();
        let sql = format!("SELECT name, score FROM '{}' ORDER BY id; SELECT nope", csv.display());
        session.run(&sql, &channel, None).await.unwrap();
        {
            let log = log.lock().unwrap();
            assert_eq!(event_types(&log), ["resultStart", "resultEnd", "error", "done"]);
            let batch = batches(&log)[0];
            let names = batch.column(0).as_any().downcast_ref::<StringArray>().unwrap();
            let scores = batch.column(1).as_any().downcast_ref::<StringArray>().unwrap();
            assert_eq!((names.value(1), scores.is_null(1)), ("bo, b", true));
            let error = &events(&log)[2]["error"]["message"];
            assert!(error.as_str().unwrap().contains("nope"), "{error}");
        }

        // Limits keep the first rows and count the rest.
        let (channel, log) = recorder();
        session.run("SELECT * FROM range(5000)", &channel, Some(100)).await.unwrap();
        let log = log.lock().unwrap();
        let end = events(&log).into_iter().find(|e| e["type"] == "resultEnd").unwrap().clone();
        assert_eq!((end["rowCount"].as_u64(), end["truncated"].as_bool()), (Some(5000), Some(true)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn file_database_introspection_edits_and_inserts() {
        let path = std::env::temp_dir().join(format!("onyx-duck-{}.duckdb", uuid::Uuid::new_v4()));
        let Some(config) = config(path.to_str().unwrap()) else { return };
        let session = DuckSession::connect(&config).await.unwrap();
        session
            .execute(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR NOT NULL, score DOUBLE);
                 CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), total DECIMAL(10,2));
                 CREATE INDEX orders_user ON orders (user_id);
                 CREATE VIEW big AS SELECT * FROM orders WHERE total > 100;
                 INSERT INTO users VALUES (1, 'a@x.io', 1.5), (2, 'b@x.io', NULL);
                 INSERT INTO orders VALUES (1, 1, 50), (2, 1, 150);",
            )
            .await
            .unwrap();

        assert_eq!(session.schemas().await.unwrap(), ["main"]);
        let objects = session.objects("main").await.unwrap();
        let kinds: Vec<(&str, &str)> = objects.iter().map(|o| (o.name.as_str(), o.kind)).collect();
        assert_eq!(kinds, [("big", "view"), ("orders", "table"), ("users", "table")]);

        let columns = session.columns("main", "users").await.unwrap();
        assert_eq!(columns.iter().map(|c| (c.name.as_str(), c.primary_key, c.nullable)).collect::<Vec<_>>(), [
            ("id", true, false),
            ("email", false, false),
            ("score", false, true)
        ]);

        let orders = session.structure("main", "orders").await.unwrap();
        assert!(orders.indexes.iter().any(|i| i.primary && i.columns == ["id"]), "{:?}", orders.indexes);
        assert!(orders.indexes.iter().any(|i| i.name == "orders_user" && i.columns == ["user_id"]), "{:?}", orders.indexes);
        let fk = &orders.foreign_keys[0];
        assert_eq!((fk.ref_table.as_str(), fk.columns[0].as_str(), fk.ref_columns[0].as_str()), ("users", "user_id", "id"));
        assert!(orders.ddl.to_uppercase().contains("CREATE TABLE"), "{}", orders.ddl);
        let users = session.structure("main", "users").await.unwrap();
        assert_eq!(users.referenced_by[0].table, "orders");
        assert!(session.structure("main", "big").await.unwrap().ddl.to_uppercase().contains("VIEW"));

        let completion = session.completion_tables().await.unwrap();
        assert_eq!(completion.iter().find(|t| t.name == "users").unwrap().types, ["INTEGER", "VARCHAR", "DOUBLE"]);
        assert_eq!(session.all_foreign_keys().await.unwrap().len(), 1);
        assert_eq!(session.snapshot("main").await.unwrap().len(), 3);

        // Edits from the grid, and bulk inserts, through a Session like the app uses.
        let session = crate::db::Session::Duckdb(session);
        use crate::db::edit::{Cell, RowEdit};
        let cell = |c: &str, v: Option<&str>| Cell { column: c.into(), value: v.map(str::to_owned) };
        let edits = [
            RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("email", Some("o'neil@x.io")), cell("score", None)], original: vec![] },
            RowEdit::Insert { values: vec![cell("id", Some("3")), cell("email", Some("c@x.io"))] },
            RowEdit::Delete { key: vec![cell("id", Some("2"))], original: vec![] },
        ];
        let statements = session.prepare_edits("main", "users", &edits).await.unwrap();
        session.apply_edits(&statements).await.unwrap();
        let rows: Vec<Vec<Option<String>>> = (10..1210).map(|i| vec![Some(i.to_string()), Some(format!("u{i}@x.io")), Some("2.5".into())]).collect();
        let columns = ["id".to_owned(), "email".to_owned(), "score".to_owned()];
        assert_eq!(session.insert_rows("main", "users", &columns, rows).await.unwrap(), 1200);

        let (channel, log) = recorder();
        session.run("SELECT email, score FROM users WHERE id IN (1, 2, 3) ORDER BY id; SELECT count(*) FROM users", &channel).await.unwrap();
        {
            let log = log.lock().unwrap();
            let all = batches(&log);
            let emails = all[0].column(0).as_any().downcast_ref::<StringArray>().unwrap();
            assert_eq!((emails.len(), emails.value(0), emails.value(1)), (2, "o'neil@x.io", "c@x.io"));
            assert!(all[0].column(1).is_null(0));
            let count = all[1].column(0).as_any().downcast_ref::<StringArray>().unwrap();
            assert_eq!(count.value(0), "1202");
        }

        // A failing batch changes nothing.
        let bad = [RowEdit::Insert { values: vec![cell("id", Some("3")), cell("email", Some("dup@x.io"))] }];
        let statements = session.prepare_edits("main", "users", &bad).await.unwrap();
        assert!(session.apply_edits(&statements).await.is_err());

        // An update to a row that's gone fails the whole batch, the insert before it included.
        let stale = [
            RowEdit::Insert { values: vec![cell("id", Some("5000")), cell("email", Some("new@x.io"))] },
            RowEdit::Update { key: vec![cell("id", Some("99999"))], set: vec![cell("email", Some("gone@x.io"))], original: vec![] },
        ];
        let statements = session.prepare_edits("main", "users", &stale).await.unwrap();
        let err = session.apply_edits(&statements).await.unwrap_err();
        assert!(err.to_string().contains("expected to change 1 row"), "{err}");
        let (channel, log) = recorder();
        session.run("SELECT count(*) FROM users WHERE id = 5000", &channel).await.unwrap();
        let none = batches(&log.lock().unwrap())[0].column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned();
        assert_eq!(none, "0", "the insert was rolled back");
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn cancel_stops_a_running_query() {
        let Some(config) = config("") else { return };
        let session = Arc::new(DuckSession::connect(&config).await.unwrap());
        let (channel, log) = recorder();
        let runner = {
            let session = session.clone();
            tokio::spawn(async move {
                session.run("SELECT count(*) FROM range(10000000000) a, range(1000) b", &channel, None).await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let started = std::time::Instant::now();
        session.cancel(None).await.unwrap();
        runner.await.unwrap().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        let error = events(&log.lock().unwrap()).into_iter().find(|e| e["type"] == "error").unwrap().clone();
        assert_eq!(error["cancelled"], true, "{error}");
    }

    #[test]
    fn counts_rows_of_data_changes() {
        assert_eq!(counted("-- note\nUPDATE t SET x = 1 -- all").unwrap(), "-- note\nUPDATE t SET x = 1 -- all\nRETURNING 1");
        assert!(counted("DELETE FROM t RETURNING id").is_none());
        assert!(counted("SELECT 1").is_none());
        assert!(counted("CREATE TABLE t (x int)").is_none());
    }

    #[tokio::test]
    async fn reports_rows_changed() {
        let Some(config) = config("") else { return };
        let session = DuckSession::connect(&config).await.unwrap();
        let (channel, log) = recorder();
        // Without a file, the session's scratch database keeps tables between statements and runs.
        session
            .run("CREATE TABLE t AS SELECT range AS x FROM range(10); SELECT 1; INSERT INTO t SELECT 1 FROM range(3) -- three", &channel, None)
            .await
            .unwrap();
        {
            let log = log.lock().unwrap();
            assert_eq!(event_types(&log), ["command", "resultStart", "resultEnd", "command", "done"]);
            assert_eq!(events(&log)[3]["rowsAffected"], 3);
        }
        let (channel, log) = recorder();
        session.run("SELECT count(*) FROM t", &channel, None).await.unwrap();
        let count = batches(&log.lock().unwrap())[0].column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned();
        assert_eq!(count, "13");
        let scratch = session.scratch.clone().unwrap();
        assert!(scratch.exists());
        drop(session);
        assert!(!scratch.exists(), "the scratch database is deleted with the session");

        let path = std::env::temp_dir().join(format!("onyx-duck-{}.duckdb", uuid::Uuid::new_v4()));
        let config = self::config(path.to_str().unwrap()).unwrap();
        let session = DuckSession::connect(&config).await.unwrap();
        let (channel, log) = recorder();
        session
            .run("CREATE TABLE t AS SELECT range AS x FROM range(10); UPDATE t SET x = x + 1 WHERE x < 4; DELETE FROM t WHERE x > 8 RETURNING x", &channel, None)
            .await
            .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(event_types(&log), ["command", "command", "resultStart", "resultEnd", "done"]);
        assert_eq!(events(&log)[1]["rowsAffected"], 4);
        assert_eq!(events(&log)[3]["rowCount"], 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn parses_lists() {
        assert_eq!(list("[id, user_id]"), ["id", "user_id"]);
        assert!(list("[]").is_empty());
    }
}
