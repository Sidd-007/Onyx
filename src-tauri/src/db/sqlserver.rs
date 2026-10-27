//! SQL Server (and Azure SQL) over TDS with tiberius. Like the other engines: an editor
//! connection per query tab and one for introspection. Query text is split into batches on
//! `GO` lines; a batch's last row count is read back with `@@ROWCOUNT`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use futures_util::TryStreamExt;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, FromSql, Query, QueryItem, Row};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use zeroize::Zeroizing;

use super::model::{
    CheckInfo, ColumnInfo, CompletionTable, DbObject, ForeignKeyInfo, ForeignKeyRef, IncomingReference, IndexInfo, StructureColumn,
    TableSnapshot, TableStructure, TriggerInfo,
};
use super::stream::{Events, Run, RunSummary};
use crate::connections::{ConnectionConfig, Engine, SslMode};
use crate::dialect::qualified;
use crate::error::{AppError, ErrorPayload, Result};
use crate::ssh::Tunnel;

type Conn = Client<Compat<TcpStream>>;
type Rows = Vec<Vec<Option<String>>>;

/// Marks the row count a batch reports at its end.
const ROWCOUNT_COLUMN: &str = "__onyx_rowcount";

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        AppError::Invalid(match &e {
            tiberius::error::Error::Server(t) => format!("{} (error {}, line {})", t.message(), t.code(), t.line()),
            other => other.to_string(),
        })
    }
}

/// A connection and its server session id, for KILL.
pub struct Editor {
    conn: Mutex<Conn>,
    spid: i16,
}

pub struct SqlServerSession {
    pub server_version: String,
    config: Config,
    read_only: bool,
    meta: Mutex<Conn>,
    shared: Mutex<Option<Arc<Editor>>>,
    tabs: Mutex<HashMap<String, Arc<Editor>>>,
    tunnel: Option<Tunnel>,
}

async fn open(config: &Config) -> Result<Conn> {
    let tcp = TcpStream::connect(config.get_addr()).await?;
    tcp.set_nodelay(true)?;
    Ok(Client::connect(config.clone(), tcp.compat_write()).await?)
}

async fn editor(config: &Config) -> Result<Editor> {
    let mut conn = open(config).await?;
    let spid = conn.simple_query("SELECT @@SPID").await?.into_row().await?.and_then(|r| r.get::<i16, _>(0)).unwrap_or(0);
    Ok(Editor { conn: Mutex::new(conn), spid })
}

impl SqlServerSession {
    pub async fn connect(config: &ConnectionConfig, password: Option<Zeroizing<String>>, tunnel: Option<Tunnel>) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let mut tds = Config::new();
        match &tunnel {
            Some(t) => {
                tds.host("127.0.0.1");
                tds.port(t.local_port);
                tds.hostname_in_certificate(config.host.trim());
            }
            None => {
                tds.host(config.host.trim());
                tds.port(config.port);
            }
        }
        if !config.database.trim().is_empty() {
            tds.database(config.database.trim());
        }
        tds.application_name("Onyx");
        tds.authentication(AuthMethod::sql_server(config.user.trim(), password.as_deref().map(String::as_str).unwrap_or("")));
        match config.ssl_mode {
            // Login is still encrypted, as SQL Server always does.
            SslMode::Disable => tds.encryption(EncryptionLevel::Off),
            SslMode::Prefer => {
                tds.encryption(EncryptionLevel::On);
                tds.trust_cert();
            }
            SslMode::Require => {
                tds.encryption(EncryptionLevel::Required);
                tds.trust_cert();
            }
            SslMode::VerifyFull => tds.encryption(EncryptionLevel::Required),
        }
        let mut meta = tokio::time::timeout(std::time::Duration::from_secs(15), open(&tds))
            .await
            .map_err(|_| AppError::Invalid(format!("Timed out connecting to {}:{}", config.host, config.port)))??;
        let version = meta
            .simple_query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) + ' ' + CAST(SERVERPROPERTY('Edition') AS nvarchar(128))")
            .await?
            .into_row()
            .await?
            .and_then(|r| r.get::<&str, _>(0).map(str::to_owned))
            .unwrap_or_default();
        Ok(Self {
            server_version: version,
            config: tds,
            read_only: config.read_only,
            meta: Mutex::new(meta),
            shared: Mutex::new(None),
            tabs: Mutex::new(HashMap::new()),
            tunnel,
        })
    }

    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    /// The tab's editor connection (or the shared one), opened on first use.
    async fn editor(&self, tab: Option<&str>) -> Result<Arc<Editor>> {
        match tab {
            Some(t) => {
                let mut tabs = self.tabs.lock().await;
                if let Some(e) = tabs.get(t) {
                    return Ok(e.clone());
                }
                let e = Arc::new(editor(&self.config).await?);
                tabs.insert(t.to_owned(), e.clone());
                Ok(e)
            }
            None => {
                let mut shared = self.shared.lock().await;
                if let Some(e) = shared.as_ref() {
                    return Ok(e.clone());
                }
                let e = Arc::new(editor(&self.config).await?);
                *shared = Some(e.clone());
                Ok(e)
            }
        }
    }

    /// Forgets an editor whose connection broke (or was killed), so the next run opens a new one.
    async fn forget(&self, tab: Option<&str>, spid: i16) {
        match tab {
            Some(t) => {
                let mut tabs = self.tabs.lock().await;
                if tabs.get(t).is_some_and(|e| e.spid == spid) {
                    tabs.remove(t);
                }
            }
            None => {
                let mut shared = self.shared.lock().await;
                if shared.as_ref().is_some_and(|e| e.spid == spid) {
                    *shared = None;
                }
            }
        }
    }

    pub async fn close_tab(&self, tab: &str) {
        // Dropping the connection ends the session, rolling back anything left open.
        self.tabs.lock().await.remove(tab);
    }

    /// Ends the tab's server session (KILL), which stops its query and rolls back its
    /// transaction; the tab reconnects on its next run.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        let editor = match tab {
            Some(t) => self.tabs.lock().await.get(t).cloned(),
            None => self.shared.lock().await.clone(),
        };
        if let Some(e) = editor {
            if e.spid > 0 {
                self.meta.lock().await.simple_query(format!("KILL {}", e.spid)).await?.into_results().await?;
            }
            self.forget(tab, e.spid).await;
        }
        Ok(())
    }

    pub async fn run_limited(&self, sql: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let mut run = Run::with_limit(events, limit);
        let mut broken: Option<i16> = None;
        let outcome: Result<()> = async {
            if self.read_only {
                crate::readonly::check(sql, Engine::Sqlserver)?;
            }
            let editor = self.editor(tab).await?;
            let mut conn = editor.conn.lock().await;
            for batch in batches(sql) {
                let result = self.batch(&mut conn, &batch, &mut run).await;
                if let Err(e) = result {
                    if !matches!(e, AppError::Invalid(_)) || conn.simple_query("SELECT 1").await.is_err() {
                        broken = Some(editor.spid);
                    }
                    return Err(e);
                }
            }
            Ok(())
        }
        .await;
        if let Some(spid) = broken {
            self.forget(tab, spid).await;
        }
        let cancelled = broken.is_some() && outcome.as_ref().err().is_some_and(|e| e.to_string().contains("closed") || e.to_string().contains("reset"));
        let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), cancelled));
        run.finish(outcome, error)
    }

    /// Streams every result of one batch; a batch with no results reports its row count.
    async fn batch(&self, conn: &mut Conn, batch: &Batch, run: &mut Run<'_>) -> Result<()> {
        let text = if batch.count_rows { format!("{}\nSELECT @@ROWCOUNT AS [{ROWCOUNT_COLUMN}]", batch.sql) } else { batch.sql.clone() };
        let mut stream = conn.simple_query(text).await?;
        let mut results = 0;
        let mut counting = false;
        let mut rowcount = 0u64;
        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::Metadata(meta) => {
                    run.end_result(None)?;
                    counting = meta.columns().len() == 1 && meta.columns()[0].name() == ROWCOUNT_COLUMN;
                    if !counting {
                        results += 1;
                        run.start_result(meta.columns().iter().map(|c| c.name().to_owned()).collect())?;
                    }
                }
                QueryItem::Row(row) if counting => rowcount = row.get::<i32, _>(0).unwrap_or(0).max(0) as u64,
                QueryItem::Row(row) => run.push_row(row_text(&row))?,
            }
        }
        run.end_result(None)?;
        if results == 0 {
            run.command(rowcount)?;
        }
        Ok(())
    }

    /// Every row of a query on the introspection connection.
    async fn rows(&self, sql: &str, params: &[&str]) -> Result<Rows> {
        let mut conn = self.meta.lock().await;
        let mut query = Query::new(sql);
        for p in params {
            query.bind(*p);
        }
        let rows = query.query(&mut conn).await?.into_first_result().await?;
        Ok(rows.iter().map(row_text).collect())
    }

    pub async fn execute_meta(&self, sql: &str) -> Result<()> {
        // Bulk inserts send the Postgres spelling.
        let sql = match sql.trim().to_ascii_uppercase().as_str() {
            "BEGIN" => "BEGIN TRANSACTION",
            _ => sql,
        };
        self.meta.lock().await.simple_query(sql).await?.into_results().await?;
        Ok(())
    }

    pub async fn admin_rows(&self, sql: &str) -> Result<(Vec<String>, Rows)> {
        let mut conn = self.meta.lock().await;
        let mut stream = conn.simple_query(sql).await?;
        let columns = stream.columns().await?.map(|c| c.iter().map(|c| c.name().to_owned()).collect()).unwrap_or_default();
        let rows = stream.into_first_result().await?;
        Ok((columns, rows.iter().map(row_text).collect()))
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        let rows = self
            .rows("SELECT name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') ORDER BY name", &[])
            .await?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let rows = self
            .rows(
                "SELECT o.name, RTRIM(o.type),
                   (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)),
                   (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id
                     WHERE p.object_id = o.object_id)
                 FROM sys.objects o
                 WHERE o.schema_id = SCHEMA_ID(@P1) AND o.is_ms_shipped = 0 AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
                 ORDER BY o.name",
                &[schema],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let kind = match r[1].as_deref() {
                    Some("U") => "table",
                    Some("V") => "view",
                    Some("P") => "procedure",
                    _ => "function",
                };
                DbObject {
                    name: r[0].clone().unwrap_or_default(),
                    kind,
                    detail: None,
                    estimated_rows: r[2].as_deref().and_then(|n| n.parse().ok()),
                    size_bytes: r[3].as_deref().and_then(|n| n.parse().ok()),
                }
            })
            .collect())
    }

    async fn structure_columns(&self, schema: &str, table: &str) -> Result<Vec<StructureColumn>> {
        let rows = self
            .rows(
                "SELECT c.name,
                   t.name + CASE
                     WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length AS varchar(10))) + ')'
                     WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS varchar(10))) + ')'
                     WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
                     WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN '(' + CAST(c.scale AS varchar(10)) + ')'
                     ELSE '' END,
                   CAST(c.is_nullable AS int),
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                     WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS int),
                   OBJECT_DEFINITION(c.default_object_id),
                   CASE WHEN c.is_identity = 1 THEN 'IDENTITY' WHEN c.is_computed = 1 THEN 'AS ' + cc.definition END,
                   CAST(ep.value AS nvarchar(4000))
                 FROM sys.columns c
                 JOIN sys.types t ON t.user_type_id = c.user_type_id
                 LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
                 LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
                 WHERE c.object_id = OBJECT_ID(@P1)
                 ORDER BY c.column_id",
                &[&qualified(Engine::Sqlserver, schema, table)],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| StructureColumn {
                name: r[0].clone().unwrap_or_default(),
                data_type: r[1].clone().unwrap_or_default(),
                nullable: r[2].as_deref() == Some("1"),
                primary_key: r[3].as_deref() == Some("1"),
                default: r[4].clone(),
                extra: r[5].clone(),
                comment: r[6].clone(),
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

    async fn indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let rows = self
            .rows(
                "SELECT i.name, CAST(i.is_unique AS int), CAST(i.is_primary_key AS int),
                   STUFF((SELECT ',' + c.name + IIF(ic.is_descending_key = 1, ' desc', '') FROM sys.index_columns ic
                     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                     WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                     ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, ''),
                   (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id
                     WHERE p.object_id = i.object_id AND p.index_id = i.index_id)
                 FROM sys.indexes i
                 WHERE i.object_id = OBJECT_ID(@P1) AND i.type > 0
                 ORDER BY i.is_primary_key DESC, i.name",
                &[&qualified(Engine::Sqlserver, schema, table)],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| IndexInfo {
                name: r[0].clone().unwrap_or_default(),
                unique: r[1].as_deref() == Some("1"),
                primary: r[2].as_deref() == Some("1"),
                columns: r[3].clone().unwrap_or_default().split(',').filter(|c| !c.is_empty()).map(str::to_owned).collect(),
                size_bytes: r[4].as_deref().and_then(|n| n.parse().ok()),
                scans: None,
            })
            .collect())
    }

    /// Foreign keys, as (schema, table, key): `filter` picks them by the referencing or referenced table.
    async fn foreign_keys(&self, filter: &str, params: &[&str]) -> Result<Vec<ForeignKeyRef>> {
        let sql = format!(
            "SELECT SCHEMA_NAME(fk.schema_id), OBJECT_NAME(fk.parent_object_id), fk.name,
               STUFF((SELECT ',' + COL_NAME(fc.parent_object_id, fc.parent_column_id) FROM sys.foreign_key_columns fc
                 WHERE fc.constraint_object_id = fk.object_id ORDER BY fc.constraint_column_id FOR XML PATH('')), 1, 1, ''),
               OBJECT_SCHEMA_NAME(fk.referenced_object_id), OBJECT_NAME(fk.referenced_object_id),
               STUFF((SELECT ',' + COL_NAME(fc.referenced_object_id, fc.referenced_column_id) FROM sys.foreign_key_columns fc
                 WHERE fc.constraint_object_id = fk.object_id ORDER BY fc.constraint_column_id FOR XML PATH('')), 1, 1, ''),
               REPLACE(fk.update_referential_action_desc, '_', ' '), REPLACE(fk.delete_referential_action_desc, '_', ' ')
             FROM sys.foreign_keys fk {filter} ORDER BY 1, 2, fk.name"
        );
        let split = |s: &Option<String>| s.clone().unwrap_or_default().split(',').filter(|c| !c.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        Ok(self
            .rows(&sql, params)
            .await?
            .into_iter()
            .map(|r| ForeignKeyRef {
                schema: r[0].clone().unwrap_or_default(),
                table: r[1].clone().unwrap_or_default(),
                key: ForeignKeyInfo {
                    name: r[2].clone().unwrap_or_default(),
                    columns: split(&r[3]),
                    ref_schema: r[4].clone().unwrap_or_default(),
                    ref_table: r[5].clone().unwrap_or_default(),
                    ref_columns: split(&r[6]),
                    on_update: r[7].clone().unwrap_or_default(),
                    on_delete: r[8].clone().unwrap_or_default(),
                },
            })
            .collect())
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let name = qualified(Engine::Sqlserver, schema, table);
        let columns = self.structure_columns(schema, table).await?;
        let indexes = self.indexes(schema, table).await?;
        let foreign_keys: Vec<ForeignKeyInfo> =
            self.foreign_keys("WHERE fk.parent_object_id = OBJECT_ID(@P1)", &[&name]).await?.into_iter().map(|f| f.key).collect();
        let referenced_by = self
            .foreign_keys("WHERE fk.referenced_object_id = OBJECT_ID(@P1)", &[&name])
            .await?
            .into_iter()
            .map(|f| IncomingReference { name: f.key.name, schema: f.schema, table: f.table, columns: f.key.columns, ref_columns: f.key.ref_columns })
            .collect();
        let checks = self
            .rows("SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(@P1) ORDER BY name", &[&name])
            .await?
            .into_iter()
            .map(|r| CheckInfo { name: r[0].clone().unwrap_or_default(), kind: "check".into(), definition: format!("CHECK {}", r[1].clone().unwrap_or_default()) })
            .collect();
        let triggers = self
            .rows(
                "SELECT t.name, IIF(t.is_instead_of_trigger = 1, 'INSTEAD OF', 'AFTER') + ' ' +
                   STUFF((SELECT ', ' + e.type_desc FROM sys.trigger_events e WHERE e.object_id = t.object_id FOR XML PATH('')), 1, 2, ''),
                   OBJECT_DEFINITION(t.object_id)
                 FROM sys.triggers t WHERE t.parent_id = OBJECT_ID(@P1) ORDER BY t.name",
                &[&name],
            )
            .await?
            .into_iter()
            .map(|r| TriggerInfo { name: r[0].clone().unwrap_or_default(), timing: r[1].clone().unwrap_or_default(), definition: r[2].clone().unwrap_or_default() })
            .collect();
        // Views and routines have their source; tables get a CREATE TABLE built from the catalog.
        let definition = self.rows("SELECT OBJECT_DEFINITION(OBJECT_ID(@P1))", &[&name]).await?.into_iter().next().and_then(|r| r[0].clone());
        let ddl = definition.unwrap_or_else(|| create_table(&name, &columns, &indexes, &foreign_keys));
        Ok(TableStructure { columns, indexes, foreign_keys, referenced_by, checks, triggers, ddl })
    }

    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let rows = self
            .rows(
                "SELECT s.name, o.name, c.name, TYPE_NAME(c.user_type_id)
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.columns c ON c.object_id = o.object_id
                 WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
                 ORDER BY s.name, o.name, c.column_id",
                &[],
            )
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
        self.foreign_keys("", &[]).await
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let mut keys: HashMap<String, Vec<ForeignKeyInfo>> = HashMap::new();
        for f in self.foreign_keys("WHERE fk.schema_id = SCHEMA_ID(@P1)", &[schema]).await? {
            keys.entry(f.table).or_default().push(f.key);
        }
        let mut out = Vec::new();
        for o in self.objects(schema).await?.into_iter().filter(|o| o.kind == "table" || o.kind == "view").take(500) {
            out.push(TableSnapshot {
                kind: o.kind.into(),
                columns: self.structure_columns(schema, &o.name).await?,
                indexes: self.indexes(schema, &o.name).await?,
                foreign_keys: keys.remove(&o.name).unwrap_or_default(),
                name: o.name,
            });
        }
        Ok(out)
    }

    /// Table edits in one transaction; updates and deletes must each hit exactly one row.
    pub async fn apply(&self, statements: &[super::edit::EditStatement]) -> Result<u64> {
        let mut conn = self.meta.lock().await;
        conn.simple_query("BEGIN TRANSACTION").await?.into_results().await?;
        let applied: Result<u64> = async {
            let mut total = 0;
            for s in statements {
                let mut query = Query::new(s.sql.as_str());
                for p in &s.params {
                    query.bind(p.as_deref().map(Cow::Borrowed));
                }
                let changed: u64 = query.execute(&mut conn).await?.rows_affected().iter().sum();
                super::postgres::check_one_row(s, changed)?;
                total += changed;
            }
            Ok(total)
        }
        .await;
        match applied {
            Ok(total) => {
                conn.simple_query("COMMIT").await?.into_results().await?;
                Ok(total)
            }
            Err(e) => {
                let _ = async { conn.simple_query("IF @@TRANCOUNT > 0 ROLLBACK").await?.into_results().await }.await;
                Err(e)
            }
        }
    }

    /// Multi-row INSERTs with text parameters; SQL Server converts them to the column types.
    pub async fn insert_rows(&self, schema: &str, table: &str, columns: &[String], rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        if self.read_only {
            return Err(AppError::Invalid("This connection is read-only".into()));
        }
        let target = qualified(Engine::Sqlserver, schema, table);
        let names = columns.iter().map(|c| crate::dialect::ident(Engine::Sqlserver, c)).collect::<Vec<_>>().join(", ");
        // At most 2100 parameters and 1000 rows per statement.
        let per_chunk = (2000 / columns.len()).clamp(1, 1000);
        let mut conn = self.meta.lock().await;
        let mut total = 0;
        for chunk in rows.chunks(per_chunk) {
            let mut n = 0;
            let tuples: Vec<String> = chunk
                .iter()
                .map(|_| {
                    let values: Vec<String> = columns
                        .iter()
                        .map(|_| {
                            n += 1;
                            format!("@P{n}")
                        })
                        .collect();
                    format!("({})", values.join(", "))
                })
                .collect();
            let sql = format!("INSERT INTO {target} ({names}) VALUES {}", tuples.join(", "));
            let mut query = Query::new(sql);
            for v in chunk.iter().flatten() {
                query.bind(v.as_deref().map(Cow::Borrowed));
            }
            total += query.execute(&mut conn).await?.rows_affected().iter().sum::<u64>();
        }
        Ok(total)
    }
}

pub struct Batch {
    pub sql: String,
    /// Report `@@ROWCOUNT` after it (not for CREATE VIEW / PROCEDURE…, which must be alone in a batch).
    pub count_rows: bool,
}

/// Splits on `GO` lines (optionally `GO n`, run n times), as sqlcmd and SSMS do.
pub fn batches(sql: &str) -> Vec<Batch> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut push = |text: &str, times: usize| {
        if text.trim().is_empty() {
            return;
        }
        let sql = text.trim().to_owned();
        let head: Vec<String> = strip_comments(&sql).split_whitespace().take(4).map(|w| w.to_ascii_uppercase()).collect();
        let alone = matches!(head.first().map(String::as_str), Some("CREATE" | "ALTER"))
            && head.iter().skip(1).any(|w| matches!(w.as_str(), "VIEW" | "PROCEDURE" | "PROC" | "FUNCTION" | "TRIGGER" | "SCHEMA"));
        for _ in 0..times.max(1) {
            out.push(Batch { sql: sql.clone(), count_rows: !alone });
        }
    };
    for line in sql.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.first().is_some_and(|w| w.eq_ignore_ascii_case("go")) && words.len() <= 2 {
            let times = words.get(1).and_then(|n| n.parse().ok()).unwrap_or(1);
            push(&current, times);
            current.clear();
        } else {
            current.push_str(line);
            current.push('\n');
        }
    }
    push(&current, 1);
    out
}

fn strip_comments(sql: &str) -> String {
    sql.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join(" ")
}

fn create_table(name: &str, columns: &[StructureColumn], indexes: &[IndexInfo], keys: &[ForeignKeyInfo]) -> String {
    let ident = |c: &str| crate::dialect::ident(Engine::Sqlserver, c);
    let mut lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  {} {}", ident(&c.name), c.data_type);
            if let Some(extra) = &c.extra {
                line = if extra.starts_with("AS ") { format!("  {} {extra}", ident(&c.name)) } else { format!("{line} {extra}") };
            }
            if !c.extra.as_deref().is_some_and(|e| e.starts_with("AS ")) {
                line += if c.nullable { " NULL" } else { " NOT NULL" };
            }
            if let Some(d) = &c.default {
                line += &format!(" DEFAULT {d}");
            }
            line
        })
        .collect();
    if let Some(pk) = indexes.iter().find(|i| i.primary) {
        let cols: Vec<String> = pk.columns.iter().map(|c| c.strip_suffix(" desc").map(|c| format!("{} DESC", ident(c))).unwrap_or_else(|| ident(c))).collect();
        lines.push(format!("  CONSTRAINT {} PRIMARY KEY ({})", ident(&pk.name), cols.join(", ")));
    }
    for k in keys {
        lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            ident(&k.name),
            k.columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", "),
            qualified(Engine::Sqlserver, &k.ref_schema, &k.ref_table),
            k.ref_columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ")
        ));
    }
    let mut ddl = format!("CREATE TABLE {name} (\n{}\n);", lines.join(",\n"));
    for i in indexes.iter().filter(|i| !i.primary) {
        ddl += &format!(
            "\nCREATE {}INDEX {} ON {name} ({});",
            if i.unique { "UNIQUE " } else { "" },
            ident(&i.name),
            i.columns.iter().map(|c| c.strip_suffix(" desc").map(|c| format!("{} DESC", ident(c))).unwrap_or_else(|| ident(c))).collect::<Vec<_>>().join(", ")
        );
    }
    ddl
}

fn row_text(row: &Row) -> Vec<Option<String>> {
    row.cells().map(|(_, data)| cell(data)).collect()
}

/// A value as SQL Server Management Studio shows it.
pub fn cell(data: &ColumnData<'static>) -> Option<String> {
    use tiberius::time::time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
    let time = |t: Time| {
        let nanos = t.nanosecond();
        let mut s = format!("{:02}:{:02}:{:02}", t.hour(), t.minute(), t.second());
        if nanos > 0 {
            s += format!(".{nanos:09}").trim_end_matches('0');
        }
        s
    };
    let date = |d: Date| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day());
    Some(match data {
        ColumnData::U8(v) => v.as_ref()?.to_string(),
        ColumnData::I16(v) => v.as_ref()?.to_string(),
        ColumnData::I32(v) => v.as_ref()?.to_string(),
        ColumnData::I64(v) => v.as_ref()?.to_string(),
        ColumnData::F32(v) => v.as_ref()?.to_string(),
        ColumnData::F64(v) => v.as_ref()?.to_string(),
        ColumnData::Bit(v) => v.as_ref()?.to_string(),
        ColumnData::String(v) => v.as_ref()?.to_string(),
        ColumnData::Guid(v) => v.as_ref()?.to_string().to_uppercase(),
        ColumnData::Binary(v) => format!("0x{}", hex::encode_upper(v.as_ref()?)),
        ColumnData::Numeric(v) => v.as_ref()?.to_string(),
        ColumnData::Xml(v) => v.as_ref()?.to_string(),
        ColumnData::Date(_) => date(Date::from_sql(data).ok()??),
        ColumnData::Time(_) => time(Time::from_sql(data).ok()??),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            let dt = PrimitiveDateTime::from_sql(data).ok()??;
            format!("{} {}", date(dt.date()), time(dt.time()))
        }
        ColumnData::DateTimeOffset(_) => {
            let dt = OffsetDateTime::from_sql(data).ok()??;
            let offset = dt.offset();
            let (h, m, _) = offset.as_hms();
            format!("{} {} {}{:02}:{:02}", date(dt.date()), time(dt.time()), if offset.is_negative() { '-' } else { '+' }, h.abs(), m.abs())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_batches_on_go() {
        let b = batches("SELECT 1;\nSELECT 2\nGO\nCREATE VIEW v AS SELECT 1\ngo\n-- comment\nUPDATE t SET a = 1\nGO 2\n  \n");
        let shape: Vec<(&str, bool)> = b.iter().map(|b| (b.sql.as_str(), b.count_rows)).collect();
        assert_eq!(
            shape,
            [("SELECT 1;\nSELECT 2", true), ("CREATE VIEW v AS SELECT 1", false), ("-- comment\nUPDATE t SET a = 1", true), ("-- comment\nUPDATE t SET a = 1", true)]
        );
        // "go" inside a statement isn't a separator.
        assert_eq!(batches("SELECT go FROM t\nWHERE x = 'GO'").len(), 1);
    }

    #[test]
    fn writes_create_table() {
        let col = |name: &str, ty: &str, nullable: bool, pk: bool, extra: Option<&str>| StructureColumn {
            name: name.into(),
            data_type: ty.into(),
            nullable,
            default: None,
            primary_key: pk,
            extra: extra.map(str::to_owned),
            comment: None,
        };
        let ddl = create_table(
            "[dbo].[users]",
            &[col("id", "int", false, true, Some("IDENTITY")), col("email", "nvarchar(200)", true, false, None)],
            &[
                IndexInfo { name: "PK_users".into(), columns: vec!["id".into()], unique: true, primary: true, size_bytes: None, scans: None },
                IndexInfo { name: "ix_email".into(), columns: vec!["email desc".into()], unique: true, primary: false, size_bytes: None, scans: None },
            ],
            &[],
        );
        assert_eq!(
            ddl,
            "CREATE TABLE [dbo].[users] (\n  [id] int IDENTITY NOT NULL,\n  [email] nvarchar(200) NULL,\n  CONSTRAINT [PK_users] PRIMARY KEY ([id])\n);\nCREATE UNIQUE INDEX [ix_email] ON [dbo].[users] ([email] DESC);"
        );
    }

    #[test]
    fn formats_values() {
        use tiberius::numeric::Numeric;
        assert_eq!(cell(&ColumnData::I32(Some(7))).as_deref(), Some("7"));
        assert_eq!(cell(&ColumnData::I32(None)), None);
        assert_eq!(cell(&ColumnData::Bit(Some(true))).as_deref(), Some("true"));
        assert_eq!(cell(&ColumnData::Numeric(Some(Numeric::new_with_scale(12345, 2)))).as_deref(), Some("123.45"));
        assert_eq!(cell(&ColumnData::Binary(Some(Cow::Borrowed(&[0xde, 0xad])))).as_deref(), Some("0xDEAD"));
    }
}
