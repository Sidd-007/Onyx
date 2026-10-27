//! ClickHouse over its HTTP interface (port 8123, or 8443 with TLS). Each statement is one
//! request; rows stream back as TabSeparatedWithNamesAndTypes. Query tabs get their own
//! ClickHouse session (session_id), so SETs and temporary tables stay in that tab.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use zeroize::Zeroizing;

use super::model::{
    ColumnInfo, CompletionTable, DbObject, ForeignKeyRef, IndexInfo, StructureColumn, TableSnapshot, TableStructure,
};
use super::stream::{Events, Run, RunSummary};
use crate::connections::{ConnectionConfig, Engine, SslMode};
use crate::dialect::literal;
use crate::error::{AppError, ErrorPayload, Result};
use crate::http::{self, Endpoint, Streamed};
use crate::ssh::Tunnel;

/// How long a query may take to start answering.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

const SYSTEM_DATABASES: &str = "('system', 'INFORMATION_SCHEMA', 'information_schema')";

pub struct ClickSession {
    pub server_version: String,
    endpoint: Endpoint,
    user: String,
    password: Option<Zeroizing<String>>,
    database: String,
    read_only: bool,
    /// The shared session's id; query tabs get their own.
    shared: String,
    tabs: tokio::sync::Mutex<HashMap<String, String>>,
    /// The query each session is running, for cancel.
    running: std::sync::Mutex<HashMap<String, String>>,
    tunnel: Option<Tunnel>,
}

type Rows = Vec<Vec<Option<String>>>;

/// Percent-encoding for a URL query value.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// One TSV field, ClickHouse-escaped: `\N` is NULL, backslash escapes for the rest.
pub fn unescape(field: &[u8]) -> Option<String> {
    if field == b"\\N" {
        return None;
    }
    let mut out = Vec::with_capacity(field.len());
    let mut bytes = field.iter();
    while let Some(&b) = bytes.next() {
        if b != b'\\' {
            out.push(b);
            continue;
        }
        match bytes.next() {
            Some(b't') => out.push(b'\t'),
            Some(b'n') => out.push(b'\n'),
            Some(b'r') => out.push(b'\r'),
            Some(b'0') => out.push(0),
            Some(b'b') => out.push(8),
            Some(b'f') => out.push(12),
            Some(b'a') => out.push(7),
            Some(b'v') => out.push(11),
            Some(&other) => out.push(other),
            None => out.push(b'\\'),
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// A value for a TabSeparated body.
fn escape(value: &Option<String>) -> String {
    match value {
        None => "\\N".into(),
        Some(v) => v.replace('\\', "\\\\").replace('\t', "\\t").replace('\n', "\\n").replace('\r', "\\r"),
    }
}

/// A line ClickHouse writes into the body when a query fails after the response started.
fn exception(line: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(line);
    (text.starts_with("Code: ") && text.contains("DB::Exception")).then(|| text.trim().to_owned())
}

impl ClickSession {
    pub async fn connect(config: &ConnectionConfig, password: Option<Zeroizing<String>>, tunnel: Option<Tunnel>) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_owned(), t.local_port),
            None => (config.host.trim().to_owned(), config.port),
        };
        let tls = match config.ssl_mode {
            SslMode::Disable => None,
            // Through a tunnel the certificate can't match 127.0.0.1: encrypt without checking.
            mode => Some(Arc::new(super::tls::client_config(if tunnel.is_some() { SslMode::Require } else { mode })?)),
        };
        let endpoint = Endpoint { host, port, tls, server_name: config.host.trim().to_owned() };
        let user = if config.user.trim().is_empty() { "default".to_owned() } else { config.user.trim().to_owned() };
        let database = if config.database.trim().is_empty() { "default".to_owned() } else { config.database.trim().to_owned() };
        let mut session = Self {
            server_version: String::new(),
            endpoint,
            user,
            password,
            database,
            read_only: config.read_only,
            shared: uuid::Uuid::new_v4().to_string(),
            tabs: Default::default(),
            running: Default::default(),
            tunnel,
        };
        let version = tokio::time::timeout(Duration::from_secs(10), session.rows("SELECT version()"))
            .await
            .map_err(|_| AppError::Invalid(format!("Timed out connecting to {}:{}", config.host, config.port)))??;
        session.server_version = version.first().and_then(|r| r.first().cloned().flatten()).unwrap_or_default();
        Ok(session)
    }

    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    /// One request. `session`: a ClickHouse session id (the editor's); `query`: SQL in the URL
    /// when `body` carries data (INSERT … FORMAT TabSeparated).
    async fn post(&self, body: &[u8], query: Option<&str>, session: Option<&str>, query_id: &str, format: &str) -> Result<Streamed> {
        let mut path = format!(
            "/?database={}&query_id={}&default_format={format}&output_format_tsv_crlf_end_of_line=0",
            encode(&self.database),
            encode(query_id)
        );
        if let Some(s) = session {
            path += &format!("&session_id={}&session_timeout=3600", encode(s));
        }
        if let Some(q) = query {
            path += &format!("&query={}", encode(q));
        }
        if self.read_only {
            // 2: reads only, but settings may still change.
            path += "&readonly=2";
        }
        let password = self.password.as_deref().map(String::as_str).unwrap_or("");
        let response = http::request(
            &self.endpoint,
            "POST",
            &path,
            &[("X-ClickHouse-User", &self.user), ("X-ClickHouse-Key", password), ("Content-Type", "text/plain; charset=utf-8")],
            body,
            ANSWER_TIMEOUT,
        )
        .await?;
        if response.status != 200 {
            let text = response.text().await?;
            return Err(AppError::Invalid(text.trim().to_owned()));
        }
        Ok(response)
    }

    /// Every row of a query (introspection), outside any session.
    async fn rows(&self, sql: &str) -> Result<Rows> {
        let mut response = self.post(sql.as_bytes(), None, None, &uuid::Uuid::new_v4().to_string(), "TabSeparatedWithNames").await?;
        let mut all = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            all.extend(chunk);
        }
        let mut lines = all.split(|&b| b == b'\n').filter(|l| !l.is_empty());
        lines.next(); // names
        lines
            .map(|line| match exception(line) {
                Some(e) => Err(AppError::Invalid(e)),
                None => Ok(line.split(|&b| b == b'\t').map(unescape).collect()),
            })
            .collect()
    }

    async fn session_for(&self, tab: Option<&str>) -> String {
        match tab {
            None => self.shared.clone(),
            Some(t) => self.tabs.lock().await.entry(t.to_owned()).or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone(),
        }
    }

    pub async fn close_tab(&self, tab: &str) {
        // The server drops the session after its timeout.
        self.tabs.lock().await.remove(tab);
    }

    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        let session = match tab {
            Some(t) => match self.tabs.lock().await.get(t) {
                Some(s) => s.clone(),
                None => return Ok(()),
            },
            None => self.shared.clone(),
        };
        let query_id = self.running.lock().unwrap().get(&session).cloned();
        if let Some(id) = query_id {
            self.rows(&format!("KILL QUERY WHERE query_id = {} ASYNC", literal(Engine::Clickhouse, &id))).await?;
        }
        Ok(())
    }

    pub async fn run(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let mut run = Run::with_limit(events, limit);
        let session = self.session_for(tab).await;
        let mut cancelled = false;
        let outcome: Result<()> = async {
            for statement in super::duckdb::split(sql) {
                let query_id = uuid::Uuid::new_v4().to_string();
                self.running.lock().unwrap().insert(session.clone(), query_id.clone());
                let result = self.stream(&statement, &session, &query_id, &mut run).await;
                self.running.lock().unwrap().remove(&session);
                if let Err(e) = result {
                    cancelled = e.to_string().contains("QUERY_WAS_CANCELLED") || e.to_string().contains("Code: 394");
                    return Err(e);
                }
            }
            Ok(())
        }
        .await;
        let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), cancelled));
        run.finish(outcome, error)
    }

    async fn stream(&self, statement: &str, session: &str, query_id: &str, run: &mut Run<'_>) -> Result<()> {
        let mut response = self.post(statement.as_bytes(), None, Some(session), query_id, "TabSeparatedWithNamesAndTypes").await?;
        let written = response
            .header("X-ClickHouse-Summary")
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v["written_rows"].as_str().and_then(|n| n.parse::<u64>().ok()));
        let mut pending: Vec<u8> = Vec::new();
        let mut line_no = 0usize;
        let mut started = false;
        loop {
            let chunk = response.chunk().await?;
            let end = chunk.is_none();
            if let Some(c) = chunk {
                pending.extend(c);
            }
            // Complete lines (the last one at the end of the body, even without a newline).
            let mut consumed = 0;
            while let Some(nl) = pending[consumed..].iter().position(|&b| b == b'\n') {
                let line = pending[consumed..consumed + nl].to_vec();
                consumed += nl + 1;
                self.line(&line, &mut line_no, &mut started, run)?;
            }
            pending.drain(..consumed);
            if end {
                if !pending.is_empty() {
                    let line = std::mem::take(&mut pending);
                    self.line(&line, &mut line_no, &mut started, run)?;
                }
                break;
            }
        }
        if started {
            run.end_result(None)
        } else {
            // INSERT, CREATE, SET …: no rows, maybe a count of rows written.
            run.command(written.unwrap_or(0))
        }
    }

    fn line(&self, line: &[u8], line_no: &mut usize, started: &mut bool, run: &mut Run<'_>) -> Result<()> {
        if let Some(e) = exception(line) {
            return Err(AppError::Invalid(e));
        }
        *line_no += 1;
        let fields = line.split(|&b| b == b'\t');
        match *line_no {
            1 => {
                run.start_result(fields.map(|f| unescape(f).unwrap_or_default()).collect())?;
                *started = true;
            }
            2 => {} // types
            _ => run.push_row(fields.map(unescape))?,
        }
        Ok(())
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        let rows = self.rows(&format!("SELECT name FROM system.databases WHERE name NOT IN {SYSTEM_DATABASES} ORDER BY name")).await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let rows = self
            .rows(&format!(
                "SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {} AND NOT is_temporary ORDER BY name",
                literal(Engine::Clickhouse, schema)
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let engine = r[1].clone().unwrap_or_default();
                DbObject {
                    name: r[0].clone().unwrap_or_default(),
                    kind: match engine.as_str() {
                        "View" | "LiveView" | "WindowView" => "view",
                        "MaterializedView" => "materialized-view",
                        _ => "table",
                    },
                    detail: None,
                    estimated_rows: r[2].as_deref().and_then(|n| n.parse().ok()),
                    size_bytes: r[3].as_deref().and_then(|n| n.parse().ok()),
                }
            })
            .collect())
    }

    async fn structure_columns(&self, filter: &str) -> Result<Vec<(String, StructureColumn)>> {
        let rows = self
            .rows(&format!(
                "SELECT table, name, type, default_kind, default_expression, is_in_primary_key, comment
                 FROM system.columns WHERE {filter} ORDER BY table, position"
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let get = |i: usize| r[i].clone().unwrap_or_default();
                let kind = get(3);
                let data_type = get(2);
                (
                    get(0),
                    StructureColumn {
                        name: get(1),
                        nullable: data_type.starts_with("Nullable("),
                        data_type,
                        default: Some(get(4)).filter(|d| !d.is_empty() && kind == "DEFAULT"),
                        primary_key: get(5) == "1",
                        extra: Some(kind.clone()).filter(|k| !k.is_empty() && k != "DEFAULT").map(|k| format!("{k} {}", get(4))),
                        comment: Some(get(6)).filter(|c| !c.is_empty()),
                    },
                )
            })
            .collect())
    }

    fn table_filter(schema: &str, table: &str) -> String {
        format!("database = {} AND table = {}", literal(Engine::Clickhouse, schema), literal(Engine::Clickhouse, table))
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        Ok(self
            .structure_columns(&Self::table_filter(schema, table))
            .await?
            .into_iter()
            .map(|(_, c)| ColumnInfo { name: c.name, data_type: c.data_type, nullable: c.nullable, primary_key: c.primary_key, default: c.default })
            .collect())
    }

    /// The primary and sorting keys as indexes, then data-skipping indexes.
    async fn indexes(&self, schema: &str, table: Option<&str>) -> Result<HashMap<String, Vec<IndexInfo>>> {
        let s = literal(Engine::Clickhouse, schema);
        let t = table.map(|t| format!(" AND name = {}", literal(Engine::Clickhouse, t))).unwrap_or_default();
        let keys = self.rows(&format!("SELECT name, primary_key, sorting_key FROM system.tables WHERE database = {s}{t}")).await?;
        let t = table.map(|t| format!(" AND table = {}", literal(Engine::Clickhouse, t))).unwrap_or_default();
        let skipping = self
            .rows(&format!("SELECT table, name, type, expr, data_compressed_bytes FROM system.data_skipping_indices WHERE database = {s}{t}"))
            .await
            .unwrap_or_default();
        let split = |cols: &str| cols.split(',').map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        let mut out: HashMap<String, Vec<IndexInfo>> = HashMap::new();
        for r in keys {
            let name = r[0].clone().unwrap_or_default();
            let entry = out.entry(name).or_default();
            let primary = r[1].clone().unwrap_or_default();
            let sorting = r[2].clone().unwrap_or_default();
            if !primary.is_empty() {
                entry.push(IndexInfo { name: "PRIMARY KEY".into(), columns: split(&primary), unique: false, primary: true, size_bytes: None, scans: None });
            }
            if !sorting.is_empty() && sorting != primary {
                entry.push(IndexInfo { name: "ORDER BY".into(), columns: split(&sorting), unique: false, primary: false, size_bytes: None, scans: None });
            }
        }
        for r in skipping {
            let table = r[0].clone().unwrap_or_default();
            out.entry(table).or_default().push(IndexInfo {
                name: format!("{} ({})", r[1].clone().unwrap_or_default(), r[2].clone().unwrap_or_default()),
                columns: split(&r[3].clone().unwrap_or_default()),
                unique: false,
                primary: false,
                size_bytes: r[4].as_deref().and_then(|n| n.parse().ok()),
                scans: None,
            });
        }
        Ok(out)
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let columns = self.structure_columns(&Self::table_filter(schema, table)).await?.into_iter().map(|(_, c)| c).collect();
        let indexes = self.indexes(schema, Some(table)).await?.remove(table).unwrap_or_default();
        let ddl = self
            .rows(&format!("SHOW CREATE TABLE {}", crate::dialect::qualified(Engine::Clickhouse, schema, table)))
            .await?
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .unwrap_or_default();
        Ok(TableStructure { columns, indexes, foreign_keys: vec![], referenced_by: vec![], checks: vec![], triggers: vec![], ddl })
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let rows = self
            .rows(&format!(
                "SELECT database, table, name, type FROM system.columns WHERE database NOT IN {SYSTEM_DATABASES} ORDER BY database, table, position"
            ))
            .await?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        for r in rows {
            let get = |i: usize| r[i].clone().unwrap_or_default();
            let (schema, name) = (get(0), get(1));
            match tables.last_mut() {
                Some(t) if t.schema == schema && t.name == name => {
                    t.columns.push(get(2));
                    t.types.push(get(3));
                }
                _ => tables.push(CompletionTable { schema, name, columns: vec![get(2)], types: vec![get(3)] }),
            }
        }
        Ok(tables)
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        Ok(vec![])
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let objects = self.objects(schema).await?;
        let mut columns: HashMap<String, Vec<StructureColumn>> = HashMap::new();
        for (table, c) in self.structure_columns(&format!("database = {}", literal(Engine::Clickhouse, schema))).await? {
            columns.entry(table).or_default().push(c);
        }
        let mut indexes = self.indexes(schema, None).await?;
        Ok(objects
            .into_iter()
            .map(|o| TableSnapshot {
                kind: if o.kind == "table" { "table" } else { "view" }.into(),
                columns: columns.remove(&o.name).unwrap_or_default(),
                indexes: indexes.remove(&o.name).unwrap_or_default(),
                foreign_keys: vec![],
                name: o.name,
            })
            .collect())
    }

    /// DDL from the UI, outside any session.
    pub async fn execute(&self, sql: &str) -> Result<()> {
        self.rows(sql).await.map(drop)
    }

    pub async fn apply(&self, _statements: &[super::edit::EditStatement]) -> Result<u64> {
        Err(AppError::Invalid("ClickHouse rows are changed with ALTER TABLE … UPDATE in a query tab".into()))
    }

    /// Inserts rows as TabSeparated, so ClickHouse parses each column's type itself.
    pub async fn insert_rows(&self, schema: &str, table: &str, columns: &[String], rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        let names = columns.iter().map(|c| crate::dialect::ident(Engine::Clickhouse, c)).collect::<Vec<_>>().join(", ");
        let query = format!("INSERT INTO {} ({names}) FORMAT TabSeparated", crate::dialect::qualified(Engine::Clickhouse, schema, table));
        let mut body = String::new();
        for row in &rows {
            body += &row.iter().map(escape).collect::<Vec<_>>().join("\t");
            body.push('\n');
        }
        let response = self.post(body.as_bytes(), Some(&query), None, &uuid::Uuid::new_v4().to_string(), "TabSeparated").await?;
        let text = response.text().await?;
        if let Some(e) = exception(text.as_bytes()) {
            return Err(AppError::Invalid(e));
        }
        Ok(rows.len() as u64)
    }

    /// Server activity (system.processes) and KILL QUERY.
    pub async fn admin_rows(&self, sql: &str) -> Result<(Vec<String>, Rows)> {
        let mut response = self.post(sql.as_bytes(), None, None, &uuid::Uuid::new_v4().to_string(), "TabSeparatedWithNames").await?;
        let mut all = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            all.extend(chunk);
        }
        let mut lines = all.split(|&b| b == b'\n').filter(|l| !l.is_empty());
        let columns = lines.next().map(|l| l.split(|&b| b == b'\t').map(|f| unescape(f).unwrap_or_default()).collect()).unwrap_or_default();
        let rows = lines.map(|l| l.split(|&b| b == b'\t').map(unescape).collect()).collect();
        Ok((columns, rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::stream::testing::{batches, event_types, events, recorder};
    use arrow_array::{Array, StringArray};

    #[test]
    fn escapes_tsv_fields() {
        assert_eq!(unescape(b"a\\tb\\\\c\\n"), Some("a\tb\\c\n".into()));
        assert_eq!(unescape(b"\\N"), None);
        assert_eq!(escape(&Some("x\ty\\".into())), "x\\ty\\\\");
        assert_eq!(encode("SELECT 1"), "SELECT%201");
    }

    fn config() -> Option<ConnectionConfig> {
        let port: u16 = std::env::var("ONYX_TEST_CLICKHOUSE").ok()?.parse().ok()?;
        let mut config = crate::bulk_test_config(std::path::Path::new("default"));
        config.engine = Engine::Clickhouse;
        config.host = "127.0.0.1".into();
        config.port = port;
        config.user = "default".into();
        Some(config)
    }

    /// `ONYX_TEST_CLICKHOUSE=8124 cargo test clickhouse` with scripts/dev-db.sh running.
    #[tokio::test]
    async fn queries_introspects_and_inserts() {
        let Some(config) = config() else { return };
        let session = ClickSession::connect(&config, None, None).await.unwrap();
        assert!(!session.server_version.is_empty());
        let db = format!("onyx_test_{}", uuid::Uuid::new_v4().simple());
        let (channel, log) = recorder();
        let setup = format!(
            "CREATE DATABASE {db};
             CREATE TABLE {db}.events (id UInt64, kind LowCardinality(String), note Nullable(String), at DateTime, INDEX kind_idx kind TYPE set(10) GRANULARITY 1)
               ENGINE = MergeTree ORDER BY (id, at);
             INSERT INTO {db}.events VALUES (1, 'a', 'tab\there', '2026-10-01 10:00:00'), (2, 'b', NULL, '2026-10-02 10:00:00');
             SELECT id, kind, note FROM {db}.events ORDER BY id;
             SELECT nope FROM {db}.events"
        );
        session.run(&setup, &channel, None, Some("t1")).await.unwrap();
        {
            let log = log.lock().unwrap();
            assert_eq!(event_types(&log), ["command", "command", "command", "resultStart", "resultEnd", "error", "done"]);
            assert_eq!(events(&log)[2]["rowsAffected"], 2);
            let batch = batches(&log)[0];
            let note = batch.column(2).as_any().downcast_ref::<StringArray>().unwrap();
            assert_eq!((note.value(0), note.is_null(1)), ("tab\there", true));
        }

        // A SET in tab t1 stays in t1.
        let (channel, _) = recorder();
        session.run("SET max_threads = 3", &channel, None, Some("t1")).await.unwrap();
        for (tab, expected) in [(Some("t1"), "3"), (Some("t2"), "")] {
            let (channel, log) = recorder();
            session.run("SELECT value FROM system.settings WHERE name = 'max_threads' AND changed", &channel, None, tab).await.unwrap();
            let log = log.lock().unwrap();
            let b = batches(&log);
            let got = b.first().map(|b| b.column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned()).unwrap_or_default();
            assert_eq!(got, expected, "{tab:?}");
        }

        assert!(session.schemas().await.unwrap().contains(&db));
        let objects = session.objects(&db).await.unwrap();
        assert_eq!((objects[0].name.as_str(), objects[0].estimated_rows), ("events", Some(2)));
        let s = session.structure(&db, "events").await.unwrap();
        assert!(s.columns[2].nullable && s.columns[0].primary_key);
        assert_eq!(s.indexes[0].columns, ["id", "at"]);
        assert!(s.indexes.iter().any(|i| i.name.starts_with("kind_idx")));
        assert!(s.ddl.contains("CREATE TABLE"), "{}", s.ddl);
        assert_eq!(session.snapshot(&db).await.unwrap()[0].columns.len(), 4);
        assert!(session.completion_tables().await.unwrap().iter().any(|t| t.schema == db));

        let rows = vec![vec![Some("3".into()), Some("c".into()), Some("multi\nline".into()), Some("2026-10-03 10:00:00".into())]];
        let columns = ["id", "kind", "note", "at"].map(String::from);
        assert_eq!(session.insert_rows(&db, "events", &columns, rows).await.unwrap(), 1);
        let count = session.rows(&format!("SELECT note FROM {db}.events WHERE id = 3")).await.unwrap();
        assert_eq!(count[0][0].as_deref(), Some("multi\nline"));
        session.rows(&format!("DROP DATABASE {db}")).await.unwrap();
    }
}
