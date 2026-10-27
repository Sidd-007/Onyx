//! MongoDB. Query tabs take mongosh-style statements (see `shell`); each one runs as the
//! server command it stands for (`find`, `aggregate`, `update`, …). Results become tables:
//! one column per top-level field of the first documents, then `$doc`, the whole document as
//! relaxed Extended JSON, which the document view shows.

pub mod shell;

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use bson::{doc, Bson, Document};
use futures_util::future::join_all;
use mongodb::options::{ClientOptions, Credential, Tls, TlsOptions};
use mongodb::{Client, Cursor};
use tokio::sync::Notify;
use zeroize::Zeroizing;

use super::model::{ColumnInfo, CompletionTable, DbObject, ForeignKeyRef, IndexInfo, StructureColumn, TableSnapshot, TableStructure};
use super::stream::{Events, Run, RunSummary};
use crate::connections::{ConnectionConfig, SslMode};
use crate::error::{AppError, ErrorPayload, Result};
use crate::ssh::Tunnel;
use shell::Statement;

/// The column holding each whole document.
pub const DOCUMENT_COLUMN: &str = "$doc";
/// Documents read before the columns are fixed.
const COLUMN_SAMPLE: usize = 1000;
/// Documents sampled to describe a collection's fields.
const FIELD_SAMPLE: i32 = 200;
const HIDDEN_DATABASES: [&str; 3] = ["admin", "local", "config"];

/// Methods that change data or the schema: refused on read-only connections.
pub const WRITE_METHODS: &[&str] = &[
    "insertOne", "insertMany", "insert", "updateOne", "updateMany", "update", "replaceOne", "deleteOne", "deleteMany",
    "remove", "drop", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "renameCollection", "createCollection",
    "dropDatabase", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite",
];
/// Commands `runCommand` may send on a read-only connection.
const READ_COMMANDS: &[&str] = &[
    "ping", "hello", "isMaster", "ismaster", "buildInfo", "buildinfo", "serverStatus", "dbStats", "collStats", "find", "count",
    "distinct", "listCollections", "listIndexes", "listDatabases", "explain", "currentOp", "hostInfo", "connectionStatus",
    "getParameter", "validate", "top", "replSetGetStatus", "aggregate",
];

fn error(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

impl From<mongodb::error::Error> for AppError {
    fn from(e: mongodb::error::Error) -> Self {
        AppError::Invalid(match e.kind.as_ref() {
            mongodb::error::ErrorKind::Command(c) => format!("{} ({})", c.message, c.code_name),
            _ => e.to_string(),
        })
    }
}

pub struct MongoSession {
    pub server_version: String,
    client: Client,
    default_db: String,
    read_only: bool,
    /// Databases chosen with `use` in each query tab.
    tabs: tokio::sync::Mutex<HashMap<String, String>>,
    /// Cancels the statement a tab (or "" for the shared session) is running.
    running: std::sync::Mutex<HashMap<String, Arc<Notify>>>,
    tunnel: Option<Tunnel>,
}

impl MongoSession {
    /// `host` may also be a whole `mongodb://` or `mongodb+srv://` address (Atlas), without the password.
    pub async fn connect(config: &ConnectionConfig, password: Option<Zeroizing<String>>, tunnel: Option<Tunnel>) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let host = config.host.trim();
        let uri = if host.starts_with("mongodb://") || host.starts_with("mongodb+srv://") {
            if tunnel.is_some() {
                return Err(error("An SSH tunnel needs a plain host and port, not a mongodb:// address"));
            }
            host.to_owned()
        } else {
            let (h, p) = match &tunnel {
                Some(t) => ("127.0.0.1".to_owned(), t.local_port),
                None => (host.to_owned(), config.port),
            };
            let h = if h.contains(':') { format!("[{h}]") } else { h };
            // One server, as given (a replica set member through a tunnel can't reach the others).
            format!("mongodb://{h}:{p}/?directConnection=true")
        };
        let mut options = ClientOptions::parse(&uri).await?;
        options.app_name = Some("Onyx".into());
        options.server_selection_timeout = Some(Duration::from_secs(10));
        options.connect_timeout = Some(Duration::from_secs(10));
        if !uri.starts_with("mongodb+srv://") || config.ssl_mode != SslMode::Disable {
            // MongoDB takes the client certificate and key in one PEM file (tlsCertificateKeyFile).
            let files = crate::db::tls::TlsFiles::of(config);
            let ca = files.ca.map(crate::db::tls::expand);
            let cert = files.cert.map(crate::db::tls::expand);
            options.tls = Some(match config.ssl_mode {
                SslMode::Disable => Tls::Disabled,
                mode => Tls::Enabled(
                    TlsOptions::builder()
                        .allow_invalid_certificates(mode != SslMode::VerifyFull)
                        .ca_file_path(ca)
                        .cert_key_file_path(cert)
                        .build(),
                ),
            });
        }
        let user = config.user.trim();
        if !user.is_empty() {
            let source = options.credential.as_ref().and_then(|c| c.source.clone()).unwrap_or_else(|| "admin".into());
            options.credential = Some(
                Credential::builder()
                    .username(user.to_owned())
                    .password(password.as_deref().map(|p| p.to_string()))
                    .source(source)
                    .build(),
            );
        }
        let default_db = Some(config.database.trim())
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .or_else(|| options.default_database.clone())
            .unwrap_or_else(|| "test".into());
        let client = Client::with_options(options)?;
        let info = client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
        Ok(Self {
            server_version: info.get_str("version").unwrap_or_default().to_owned(),
            client,
            default_db,
            read_only: config.read_only,
            tabs: Default::default(),
            running: Default::default(),
            tunnel,
        })
    }

    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    async fn db_for(&self, tab: Option<&str>) -> String {
        match tab {
            Some(t) => self.tabs.lock().await.get(t).cloned().unwrap_or_else(|| self.default_db.clone()),
            None => self.default_db.clone(),
        }
    }

    pub async fn close_tab(&self, tab: &str) {
        self.tabs.lock().await.remove(tab);
    }

    /// Stops the statement: its cursor is dropped, which kills it on the server.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        if let Some(stop) = self.running.lock().unwrap().get(tab.unwrap_or("")) {
            stop.notify_one();
        }
        Ok(())
    }

    pub async fn run(&self, text: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let mut run = Run::with_limit(events, limit);
        let key = tab.unwrap_or("").to_owned();
        let stop = Arc::new(Notify::new());
        self.running.lock().unwrap().insert(key.clone(), stop.clone());
        let mut cancelled = false;
        let outcome: Result<()> = async {
            for statement in shell::parse(text)? {
                tokio::select! {
                    result = self.statement(statement, tab, limit, &mut run) => result?,
                    _ = stop.notified() => {
                        cancelled = true;
                        return Err(error("Query cancelled"));
                    }
                }
            }
            Ok(())
        }
        .await;
        self.running.lock().unwrap().remove(&key);
        let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), cancelled));
        run.finish(outcome, error)
    }

    async fn statement(&self, statement: Statement, tab: Option<&str>, limit: Option<u64>, run: &mut Run<'_>) -> Result<()> {
        if self.read_only && writes(&statement) {
            return Err(error("This connection is read-only"));
        }
        let db = self.client.database(&self.db_for(tab).await);
        match statement {
            Statement::ShowDatabases => {
                let reply = self.client.database("admin").run_command(doc! { "listDatabases": 1 }).await?;
                let mut rows: Vec<Document> = reply.get_array("databases").map(|a| a.iter().filter_map(|d| d.as_document().cloned()).collect()).unwrap_or_default();
                rows.sort_by(|a, b| a.get_str("name").unwrap_or("").cmp(b.get_str("name").unwrap_or("")));
                emit(run, rows).await
            }
            Statement::ShowCollections => {
                let mut cursor = db.run_cursor_command(doc! { "listCollections": 1, "authorizedCollections": true, "nameOnly": true }).await?;
                let mut rows = Vec::new();
                while cursor.advance().await? {
                    let d: Document = cursor.deserialize_current()?;
                    rows.push(doc! { "name": d.get_str("name").unwrap_or_default(), "type": d.get_str("type").unwrap_or("collection") });
                }
                rows.sort_by(|a, b| a.get_str("name").unwrap_or("").cmp(b.get_str("name").unwrap_or("")));
                emit(run, rows).await
            }
            Statement::Use(name) => {
                if let Some(t) = tab {
                    self.tabs.lock().await.insert(t.to_owned(), name.clone());
                }
                emit(run, vec![doc! { "database": name }]).await
            }
            Statement::Db { method, args } => self.db_method(&db, &method, args, run).await,
            Statement::Collection { name, method, args, chain } => self.collection_method(&db, &name, &method, args, chain, limit, run).await,
        }
    }

    async fn db_method(&self, db: &mongodb::Database, method: &str, args: Vec<Bson>, run: &mut Run<'_>) -> Result<()> {
        let reply = match method {
            "runCommand" | "adminCommand" => {
                let command = match args.into_iter().next() {
                    Some(Bson::Document(d)) => d,
                    Some(Bson::String(name)) => doc! { name: 1 },
                    _ => return Err(error(format!("{method}() takes a command document"))),
                };
                let name = command.keys().next().cloned().unwrap_or_default();
                // An aggregate with $out or $merge writes, as a command too.
                let writes_out = command.get_array("pipeline").is_ok_and(|stages| {
                    stages.iter().any(|s| s.as_document().is_some_and(|d| d.contains_key("$out") || d.contains_key("$merge")))
                });
                if self.read_only && (!READ_COMMANDS.contains(&name.as_str()) || writes_out) {
                    return Err(error(format!("This connection is read-only ({name} isn't a read command)")));
                }
                let target = if method == "adminCommand" { self.client.database("admin") } else { db.clone() };
                target.run_command(command).await?
            }
            "getCollectionNames" => {
                let mut names = db.list_collection_names().await?;
                names.sort();
                return emit(run, names.into_iter().map(|n| doc! { "name": n }).collect()).await;
            }
            "getName" => return emit(run, vec![doc! { "name": db.name() }]).await,
            "version" => return emit(run, vec![doc! { "version": &self.server_version }]).await,
            "stats" => db.run_command(doc! { "dbStats": 1 }).await?,
            "serverStatus" => db.run_command(doc! { "serverStatus": 1 }).await?,
            "currentOp" => self.client.database("admin").run_command(doc! { "currentOp": 1 }).await?,
            "createCollection" => {
                let Some(Bson::String(name)) = args.first() else { return Err(error("createCollection() takes a name")) };
                let mut command = doc! { "create": name };
                if let Some(Bson::Document(options)) = args.get(1) {
                    command.extend(options.clone());
                }
                db.run_command(command).await?;
                return run.command(0);
            }
            "dropDatabase" => {
                db.run_command(doc! { "dropDatabase": 1 }).await?;
                return run.command(0);
            }
            other => return Err(error(format!("db.{other}() isn't supported; try db.runCommand({{ … }})"))),
        };
        emit(run, vec![reply]).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn collection_method(
        &self,
        db: &mongodb::Database,
        name: &str,
        method: &str,
        args: Vec<Bson>,
        chain: Vec<(String, Vec<Bson>)>,
        limit: Option<u64>,
        run: &mut Run<'_>,
    ) -> Result<()> {
        let mut args = args.into_iter();
        match method {
            "find" | "findOne" => {
                let filter = doc_arg(args.next(), method, "the filter")?;
                let projection = doc_arg(args.next(), method, "the projection")?;
                let mut command = doc! { "find": name, "filter": filter.clone() };
                if !projection.is_empty() {
                    command.insert("projection", projection);
                }
                let mut user_limit: Option<i64> = (method == "findOne").then_some(1);
                let mut explain: Option<String> = None;
                for (m, a) in chain {
                    let first = a.into_iter().next();
                    match m.as_str() {
                        "sort" | "projection" | "project" | "hint" | "collation" | "min" | "max" => {
                            let key = if m == "project" { "projection" } else { m.as_str() };
                            command.insert(key, first.unwrap_or(Bson::Document(Document::new())));
                        }
                        "limit" => user_limit = Some(as_int(first.as_ref())?.abs()),
                        "skip" => {
                            command.insert("skip", as_int(first.as_ref())?);
                        }
                        "maxTimeMS" => {
                            command.insert("maxTimeMS", as_int(first.as_ref())?);
                        }
                        "explain" => explain = Some(first.and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "queryPlanner".into())),
                        "count" | "itcount" | "size" => {
                            return self.count(db, name, filter, run).await;
                        }
                        "toArray" | "pretty" | "batchSize" | "allowDiskUse" | "noCursorTimeout" | "readPref" => {}
                        other => return Err(error(format!(".{other}() isn't supported after find()"))),
                    }
                }
                if let Some(verbosity) = explain {
                    let reply = db.run_command(doc! { "explain": command, "verbosity": verbosity }).await?;
                    return emit(run, vec![reply]).await;
                }
                // Without a .limit(), read one past the row limit, then count the rest on the server.
                let capped = user_limit.is_none() && limit.is_some();
                if let Some(n) = user_limit.or(limit.map(|l| l as i64 + 1)).filter(|n| *n > 0) {
                    command.insert("limit", n);
                }
                if method == "findOne" {
                    command.insert("singleBatch", true);
                }
                let mut cursor = db.run_cursor_command(command).await?;
                let read = stream(run, &mut cursor).await?;
                let total = if capped && limit.is_some_and(|l| read > l) {
                    let reply = db.run_command(doc! { "count": name, "query": filter, "maxTimeMS": 10_000 }).await;
                    reply.ok().and_then(|r| number(r.get("n")))
                } else {
                    None
                };
                run.end_result(total)
            }
            "aggregate" => {
                let pipeline = match args.next() {
                    Some(Bson::Array(stages)) => stages,
                    Some(Bson::Document(stage)) => vec![Bson::Document(stage)],
                    None => vec![],
                    Some(other) => return Err(error(format!("aggregate() takes a [ … ] pipeline, not {other}"))),
                };
                let writes = pipeline.iter().any(|s| s.as_document().is_some_and(|d| d.contains_key("$out") || d.contains_key("$merge")));
                if self.read_only && writes {
                    return Err(error("This connection is read-only ($out and $merge write)"));
                }
                let mut command = doc! { "aggregate": name, "pipeline": pipeline, "cursor": {} };
                if let Some(Bson::Document(options)) = args.next() {
                    command.extend(options);
                }
                let mut cursor = db.run_cursor_command(command).await?;
                stream(run, &mut cursor).await?;
                run.end_result(None)
            }
            "countDocuments" | "count" => {
                let filter = doc_arg(args.next(), method, "the filter")?;
                self.count(db, name, filter, run).await
            }
            "estimatedDocumentCount" => {
                let reply = db.run_command(doc! { "count": name }).await?;
                emit(run, vec![doc! { "count": reply.get("n").cloned().unwrap_or(Bson::Int32(0)) }]).await
            }
            "distinct" => {
                let Some(Bson::String(key)) = args.next() else { return Err(error("distinct() takes a field name in quotes")) };
                let filter = doc_arg(args.next(), method, "the filter")?;
                let reply = db.run_command(doc! { "distinct": name, "key": &key, "query": filter }).await?;
                let values = reply.get_array("values").cloned().unwrap_or_default();
                emit(run, values.into_iter().map(|v| doc! { key.clone(): v }).collect()).await
            }
            "getIndexes" | "indexes" => {
                let mut cursor = db.run_cursor_command(doc! { "listIndexes": name }).await?;
                stream(run, &mut cursor).await?;
                run.end_result(None)
            }
            "stats" => {
                let reply = db.run_command(doc! { "collStats": name }).await?;
                emit(run, vec![reply]).await
            }
            "insertOne" | "insertMany" | "insert" => {
                let mut documents = match args.next() {
                    Some(Bson::Document(d)) if method != "insertMany" => vec![d],
                    Some(Bson::Array(list)) if method != "insertOne" => {
                        list.into_iter().map(|v| v.as_document().cloned().ok_or_else(|| error("insertMany() takes documents"))).collect::<Result<_>>()?
                    }
                    _ => return Err(error(format!("{method}() takes {}", if method == "insertMany" { "an array of documents" } else { "a document" }))),
                };
                // Like the shell, give each document an _id here.
                for d in &mut documents {
                    if !d.contains_key("_id") {
                        let mut with_id = doc! { "_id": bson::oid::ObjectId::new() };
                        with_id.extend(std::mem::take(d));
                        *d = with_id;
                    }
                }
                let reply = write(db, doc! { "insert": name, "documents": documents }).await?;
                run.command(number(reply.get("n")).unwrap_or(0))
            }
            "updateOne" | "updateMany" | "replaceOne" | "update" => {
                let filter = doc_arg(args.next(), method, "the filter")?;
                let update = match args.next() {
                    Some(u @ (Bson::Document(_) | Bson::Array(_))) => u,
                    _ => return Err(error(format!("{method}() takes a filter and an update"))),
                };
                let options = doc_arg(args.next(), method, "the options")?;
                if method == "replaceOne" && update.as_document().is_some_and(|d| d.keys().any(|k| k.starts_with('$'))) {
                    return Err(error("replaceOne() takes a whole document; use updateOne() for $set and other operators"));
                }
                if method != "replaceOne" && update.as_document().is_some_and(|d| !d.is_empty() && !d.keys().all(|k| k.starts_with('$'))) {
                    return Err(error(format!("{method}() takes operators like {{ $set: {{ … }} }}; use replaceOne() to replace a document")));
                }
                let multi = method == "updateMany" || options.get_bool("multi").unwrap_or(false);
                let mut statement = doc! { "q": filter, "u": update, "multi": multi, "upsert": options.get_bool("upsert").unwrap_or(false) };
                for key in ["arrayFilters", "hint", "collation"] {
                    if let Some(v) = options.get(key) {
                        statement.insert(key, v.clone());
                    }
                }
                let reply = write(db, doc! { "update": name, "updates": [statement] }).await?;
                let upserted = reply.get_array("upserted").map(|a| a.len() as u64).unwrap_or(0);
                run.command(number(reply.get("nModified")).unwrap_or(0) + upserted)
            }
            "deleteOne" | "deleteMany" | "remove" => {
                let filter = doc_arg(args.next(), method, "the filter")?;
                let limit = if method == "deleteOne" { 1 } else { 0 };
                let reply = write(db, doc! { "delete": name, "deletes": [{ "q": filter, "limit": limit }] }).await?;
                run.command(number(reply.get("n")).unwrap_or(0))
            }
            "createIndex" => {
                let keys = doc_arg(args.next(), method, "the keys")?;
                let mut index = doc_arg(args.next(), method, "the options")?;
                if !index.contains_key("name") {
                    let generated: Vec<String> = keys.iter().map(|(k, v)| format!("{k}_{}", v.to_string().trim_matches('"'))).collect();
                    index.insert("name", generated.join("_"));
                }
                let index_name = index.get_str("name").unwrap_or_default().to_owned();
                index.insert("key", keys);
                db.run_command(doc! { "createIndexes": name, "indexes": [index] }).await?;
                emit(run, vec![doc! { "index": index_name }]).await
            }
            "dropIndex" => {
                let index = args.next().ok_or_else(|| error("dropIndex() takes an index name or keys"))?;
                db.run_command(doc! { "dropIndexes": name, "index": index }).await?;
                run.command(0)
            }
            "drop" => {
                db.run_command(doc! { "drop": name }).await?;
                run.command(0)
            }
            "renameCollection" => {
                let Some(Bson::String(to)) = args.next() else { return Err(error("renameCollection() takes the new name")) };
                let from = format!("{}.{name}", db.name());
                self.client.database("admin").run_command(doc! { "renameCollection": from, "to": format!("{}.{to}", db.name()) }).await?;
                run.command(0)
            }
            other => Err(error(format!("db.{name}.{other}() isn't supported"))),
        }
    }

    async fn count(&self, db: &mongodb::Database, name: &str, filter: Document, run: &mut Run<'_>) -> Result<()> {
        let pipeline = vec![doc! { "$match": filter }, doc! { "$group": { "_id": Bson::Null, "n": { "$sum": 1 } } }];
        let mut cursor = db.run_cursor_command(doc! { "aggregate": name, "pipeline": pipeline, "cursor": {} }).await?;
        let n = if cursor.advance().await? { number(cursor.deserialize_current()?.get("n")).unwrap_or(0) } else { 0 };
        emit(run, vec![doc! { "count": n as i64 }]).await
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        let mut names = self.client.list_database_names().await?;
        names.retain(|n| !HIDDEN_DATABASES.contains(&n.as_str()));
        if !names.contains(&self.default_db) {
            names.push(self.default_db.clone());
        }
        names.sort();
        Ok(names)
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let db = self.client.database(schema);
        let mut cursor = db.run_cursor_command(doc! { "listCollections": 1, "authorizedCollections": true }).await?;
        let mut collections = Vec::new();
        while cursor.advance().await? {
            let d: Document = cursor.deserialize_current()?;
            let name = d.get_str("name").unwrap_or_default().to_owned();
            if name.starts_with("system.") {
                continue;
            }
            let kind = if d.get_str("type").ok() == Some("view") { "view" } else { "collection" };
            collections.push((name, kind));
        }
        collections.sort();
        // Estimated counts come from metadata: cheap, but skip them for huge databases.
        let counts: Vec<Option<i64>> = if collections.len() <= 300 {
            join_all(collections.iter().map(|(name, kind)| {
                let db = db.clone();
                async move {
                    if *kind == "view" {
                        return None;
                    }
                    let reply = tokio::time::timeout(Duration::from_secs(5), db.run_command(doc! { "count": name.as_str() })).await.ok()?.ok()?;
                    number(reply.get("n")).map(|n| n as i64)
                }
            }))
            .await
        } else {
            vec![None; collections.len()]
        };
        Ok(collections
            .into_iter()
            .zip(counts)
            .map(|((name, kind), estimated_rows)| DbObject { name, kind, detail: None, estimated_rows, size_bytes: None })
            .collect())
    }

    /// Fields seen in a sample of the collection, `_id` first.
    async fn sample_fields(&self, schema: &str, collection: &str, size: i32) -> Result<Vec<StructureColumn>> {
        let db = self.client.database(schema);
        let pipeline = vec![doc! { "$sample": { "size": size } }];
        let mut cursor = db.run_cursor_command(doc! { "aggregate": collection, "pipeline": pipeline, "cursor": {} }).await?;
        let mut order: Vec<String> = Vec::new();
        let mut types: HashMap<String, BTreeSet<&'static str>> = HashMap::new();
        let mut present: HashMap<String, usize> = HashMap::new();
        let mut seen = 0usize;
        while cursor.advance().await? {
            let d: Document = cursor.deserialize_current()?;
            seen += 1;
            for (k, v) in &d {
                if !types.contains_key(k) {
                    order.push(k.clone());
                }
                types.entry(k.clone()).or_default().insert(type_name(v));
                *present.entry(k.clone()).or_default() += usize::from(!matches!(v, Bson::Null));
            }
        }
        order.sort_by_key(|k| k != "_id");
        Ok(order
            .into_iter()
            .map(|name| StructureColumn {
                data_type: types[&name].iter().copied().collect::<Vec<_>>().join(" | "),
                nullable: present.get(&name).copied().unwrap_or(0) < seen,
                default: None,
                primary_key: name == "_id",
                extra: None,
                comment: None,
                name,
            })
            .collect())
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        Ok(self
            .sample_fields(schema, table, FIELD_SAMPLE)
            .await?
            .into_iter()
            .map(|c| ColumnInfo { name: c.name, data_type: c.data_type, nullable: c.nullable, primary_key: c.primary_key, default: None })
            .collect())
    }

    async fn indexes(&self, schema: &str, collection: &str) -> Result<Vec<(IndexInfo, Document)>> {
        let db = self.client.database(schema);
        let Ok(mut cursor) = db.run_cursor_command(doc! { "listIndexes": collection }).await else { return Ok(vec![]) };
        let mut out = Vec::new();
        while cursor.advance().await? {
            let d: Document = cursor.deserialize_current()?;
            let keys = d.get_document("key").cloned().unwrap_or_default();
            let name = d.get_str("name").unwrap_or_default().to_owned();
            let columns = keys
                .iter()
                .map(|(k, v)| match v {
                    Bson::Int32(-1) | Bson::Int64(-1) => format!("{k} desc"),
                    Bson::String(kind) => format!("{k} ({kind})"),
                    _ => k.clone(),
                })
                .collect();
            let info = IndexInfo { primary: name == "_id_", unique: name == "_id_" || d.get_bool("unique").unwrap_or(false), name, columns, size_bytes: None, scans: None };
            out.push((info, d));
        }
        Ok(out)
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure> {
        let columns = self.sample_fields(schema, table, FIELD_SAMPLE).await?;
        let indexes = self.indexes(schema, table).await?;
        // A script that recreates the collection and its indexes.
        let db = self.client.database(schema);
        let mut info = db.run_cursor_command(doc! { "listCollections": 1, "filter": { "name": table } }).await?;
        let options = if info.advance().await? { info.deserialize_current()?.get_document("options").cloned().unwrap_or_default() } else { Document::new() };
        let json = |d: &Document| Bson::Document(d.clone()).into_relaxed_extjson().to_string();
        let mut ddl = if options.is_empty() {
            format!("db.createCollection({})", serde_json::Value::String(table.to_owned()))
        } else {
            format!("db.createCollection({}, {})", serde_json::Value::String(table.to_owned()), json(&options))
        };
        for (index, d) in &indexes {
            if index.primary {
                continue;
            }
            let mut opts = d.clone();
            let keys = opts.remove("key").and_then(|k| k.as_document().cloned()).unwrap_or_default();
            opts.remove("v");
            ddl += &format!("\ndb.getCollection({}).createIndex({}, {})", serde_json::Value::String(table.to_owned()), json(&keys), json(&opts));
        }
        Ok(TableStructure {
            columns,
            indexes: indexes.into_iter().map(|(i, _)| i).collect(),
            foreign_keys: vec![],
            referenced_by: vec![],
            checks: vec![],
            triggers: vec![],
            ddl,
        })
    }

    /// Collections of the default database with their sampled fields (completion and AI).
    pub async fn completion_tables(&self) -> Result<Vec<CompletionTable>> {
        let objects = self.objects(&self.default_db).await?;
        let mut tables = Vec::new();
        for o in objects.into_iter().take(50) {
            let fields = self.sample_fields(&self.default_db, &o.name, 20).await.unwrap_or_default();
            tables.push(CompletionTable {
                schema: self.default_db.clone(),
                name: o.name,
                columns: fields.iter().map(|f| f.name.clone()).collect(),
                types: fields.into_iter().map(|f| f.data_type).collect(),
            });
        }
        Ok(tables)
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<ForeignKeyRef>> {
        Ok(vec![])
    }

    pub async fn snapshot(&self, schema: &str) -> Result<Vec<TableSnapshot>> {
        let mut out = Vec::new();
        for o in self.objects(schema).await?.into_iter().take(200) {
            out.push(TableSnapshot {
                kind: if o.kind == "view" { "view" } else { "table" }.into(),
                columns: self.sample_fields(schema, &o.name, 50).await.unwrap_or_default(),
                indexes: self.indexes(schema, &o.name).await?.into_iter().map(|(i, _)| i).collect(),
                foreign_keys: vec![],
                name: o.name,
            });
        }
        Ok(out)
    }

    pub async fn apply(&self, _statements: &[super::edit::EditStatement]) -> Result<u64> {
        Err(error("Change MongoDB documents with updateOne() in a query tab"))
    }

    /// CSV import: one document per row; numbers, true/false and empty cells get their types.
    pub async fn insert_rows(&self, schema: &str, collection: &str, columns: &[String], rows: Vec<Vec<Option<String>>>) -> Result<u64> {
        if self.read_only {
            return Err(error("This connection is read-only"));
        }
        let db = self.client.database(schema);
        let mut total = 0;
        for chunk in rows.chunks(1000) {
            let documents: Vec<Document> = chunk
                .iter()
                .map(|row| {
                    let mut d = Document::new();
                    for (c, v) in columns.iter().zip(row) {
                        d.insert(c.clone(), typed(v.as_deref()));
                    }
                    d
                })
                .collect();
            let reply = write(&db, doc! { "insert": collection, "documents": documents }).await?;
            total += number(reply.get("n")).unwrap_or(0);
        }
        Ok(total)
    }
}

/// Statements that change data or the schema.
pub fn writes(statement: &Statement) -> bool {
    match statement {
        Statement::Collection { method, args, .. } => {
            WRITE_METHODS.contains(&method.as_str())
                || (method == "aggregate"
                    && args.first().and_then(Bson::as_array).is_some_and(|stages| {
                        stages.iter().any(|s| s.as_document().is_some_and(|d| d.contains_key("$out") || d.contains_key("$merge")))
                    }))
        }
        Statement::Db { method, .. } => WRITE_METHODS.contains(&method.as_str()),
        _ => false,
    }
}

/// insert / update / delete, failing on write errors (the command itself reports ok).
async fn write(db: &mongodb::Database, command: Document) -> Result<Document> {
    let reply = db.run_command(command).await?;
    if let Ok(errors) = reply.get_array("writeErrors") {
        let first = errors.first().and_then(Bson::as_document);
        let message = first.and_then(|e| e.get_str("errmsg").ok()).unwrap_or("write failed");
        let n = number(reply.get("n")).unwrap_or(0);
        return Err(error(format!("{message}{}", if n > 0 { format!(" ({n} written before the error)") } else { String::new() })));
    }
    Ok(reply)
}

/// A {…} argument; missing or null is an empty document.
fn doc_arg(value: Option<Bson>, method: &str, what: &str) -> Result<Document> {
    match value {
        None | Some(Bson::Null) => Ok(Document::new()),
        Some(Bson::Document(d)) => Ok(d),
        Some(other) => Err(error(format!("{method}(): {what} should be a {{…}} document, not {other}"))),
    }
}

fn as_int(value: Option<&Bson>) -> Result<i64> {
    number(value).map(|n| n as i64).ok_or_else(|| error("Expected a number"))
}

fn number(value: Option<&Bson>) -> Option<u64> {
    match value? {
        Bson::Int32(n) => u64::try_from(*n).ok(),
        Bson::Int64(n) => u64::try_from(*n).ok(),
        Bson::Double(n) if *n >= 0.0 => Some(*n as u64),
        _ => None,
    }
}

fn typed(value: Option<&str>) -> Bson {
    match value {
        None | Some("") => Bson::Null,
        Some("true") => Bson::Boolean(true),
        Some("false") => Bson::Boolean(false),
        Some(v) => {
            // Leading zeros (codes, phone numbers) stay text.
            let leading_zero = v.len() > 1 && v.starts_with('0') && !v.starts_with("0.");
            let numeric = !leading_zero && v.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'.');
            match (numeric, v.parse::<i64>(), v.parse::<f64>()) {
                (true, Ok(n), _) => i32::try_from(n).map(Bson::Int32).unwrap_or(Bson::Int64(n)),
                (true, _, Ok(f)) => Bson::Double(f),
                _ => Bson::String(v.to_owned()),
            }
        }
    }
}

fn type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null | Bson::Undefined => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        _ => "other",
    }
}

/// A field as grid text: scalars as themselves, documents and arrays as JSON.
pub fn cell(v: &Bson) -> Option<String> {
    Some(match v {
        Bson::Null | Bson::Undefined => return None,
        Bson::String(s) => s.clone(),
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        Bson::Double(n) => n.to_string(),
        Bson::Boolean(b) => b.to_string(),
        Bson::ObjectId(id) => id.to_hex(),
        Bson::DateTime(d) => d.try_to_rfc3339_string().unwrap_or_else(|_| d.timestamp_millis().to_string()),
        Bson::Decimal128(d) => d.to_string(),
        Bson::RegularExpression(r) => r.to_string(),
        Bson::Timestamp(t) => format!("Timestamp({}, {})", t.time, t.increment),
        other => other.clone().into_relaxed_extjson().to_string(),
    })
}

/// The fields of these documents, in order of first appearance (`_id` first).
pub fn columns_of<'a>(documents: impl IntoIterator<Item = &'a Document>) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for d in documents {
        for k in d.keys() {
            if seen.insert(k.clone()) {
                order.push(k.clone());
            }
        }
    }
    order.sort_by_key(|k| k != "_id");
    order
}

fn push(run: &mut Run<'_>, columns: &[String], d: &Document) -> Result<()> {
    let whole = Bson::Document(d.clone()).into_relaxed_extjson().to_string();
    run.push_row(columns.iter().map(|c| d.get(c).and_then(cell)).chain(std::iter::once(Some(whole))))
}

/// A complete result set from documents in hand.
async fn emit(run: &mut Run<'_>, documents: Vec<Document>) -> Result<()> {
    let columns = columns_of(&documents);
    run.start_result(columns.iter().cloned().chain(std::iter::once(DOCUMENT_COLUMN.to_owned())).collect())?;
    for d in &documents {
        push(run, &columns, d)?;
    }
    run.end_result(None)
}

/// Streams a cursor's documents; the columns come from the first ones. Returns how many were read.
/// The caller ends the result.
async fn stream(run: &mut Run<'_>, cursor: &mut Cursor<Document>) -> Result<u64> {
    let mut first = Vec::new();
    let mut more = true;
    while first.len() < COLUMN_SAMPLE {
        if !cursor.advance().await? {
            more = false;
            break;
        }
        first.push(cursor.deserialize_current()?);
    }
    let columns = columns_of(&first);
    run.start_result(columns.iter().cloned().chain(std::iter::once(DOCUMENT_COLUMN.to_owned())).collect())?;
    let mut read = 0u64;
    for d in &first {
        push(run, &columns, d)?;
        read += 1;
    }
    while more && cursor.advance().await? {
        push(run, &columns, &cursor.deserialize_current()?)?;
        read += 1;
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_documents_into_cells() {
        let id = bson::oid::ObjectId::parse_str("65f1a2b3c4d5e6f708192a3b").unwrap();
        let d = doc! { "name": "Ann", "_id": id, "tags": ["a", 1], "address": { "city": "Pune" }, "n": 3_i64, "gone": Bson::Null };
        let e = doc! { "name": "Bo", "extra": true };
        assert_eq!(columns_of([&d, &e]), ["_id", "name", "tags", "address", "n", "gone", "extra"]);
        assert_eq!(cell(d.get("_id").unwrap()).as_deref(), Some("65f1a2b3c4d5e6f708192a3b"));
        assert_eq!(cell(d.get("tags").unwrap()).as_deref(), Some(r#"["a",1]"#));
        assert_eq!(cell(d.get("address").unwrap()).as_deref(), Some(r#"{"city":"Pune"}"#));
        assert_eq!(cell(d.get("gone").unwrap()), None);
        let at = bson::DateTime::from_millis(1_790_812_800_000);
        assert_eq!(cell(&Bson::DateTime(at)).as_deref(), Some("2026-10-01T00:00:00Z"));
        assert_eq!(typed(Some("42")), Bson::Int32(42));
        assert_eq!(typed(Some("007")), Bson::String("007".into()), "leading zeros stay text");
        assert_eq!(typed(Some("1.5")), Bson::Double(1.5));
        assert_eq!(typed(Some("")), Bson::Null);
    }

    #[test]
    fn knows_which_statements_write() {
        let parsed = shell::parse("db.a.find()\ndb.a.deleteMany({})\ndb.a.aggregate([{ $match: {} }, { $out: 'b' }])\ndb.a.aggregate([])\ndb.dropDatabase()").unwrap();
        assert_eq!(parsed.iter().map(writes).collect::<Vec<_>>(), [false, true, true, false, true]);
    }

    fn config() -> Option<ConnectionConfig> {
        let port: u16 = std::env::var("ONYX_TEST_MONGO").ok()?.parse().ok()?;
        let mut config = crate::bulk_test_config(std::path::Path::new("onyx_test"));
        config.engine = crate::connections::Engine::Mongodb;
        config.host = "127.0.0.1".into();
        config.port = port;
        config.user = String::new();
        Some(config)
    }

    /// `ONYX_TEST_MONGO=27019 cargo test mongo` with scripts/dev-db.sh running.
    #[tokio::test]
    async fn queries_and_introspects() {
        use crate::db::stream::testing::{batches, event_types, events, recorder};
        let Some(mut config) = config() else { return };
        let db = format!("onyx_test_{}", uuid::Uuid::new_v4().simple());
        config.database = db.clone();
        let session = MongoSession::connect(&config, None, None).await.unwrap();
        let (channel, log) = recorder();
        session
            .run(
                "db.users.insertMany([{ name: 'Ann', plan: 'pro', age: 31, at: ISODate('2026-10-01') }, { name: 'Bo', plan: 'free', age: 22, tags: ['x'] }, { name: 'Cy', plan: 'pro', age: 45 }])
                 db.users.updateOne({ name: 'Bo' }, { $set: { plan: 'pro' } })
                 db.users.find({ plan: 'pro' }, { name: 1, age: 1 }).sort({ age: -1 })
                 db.users.countDocuments({ age: { $gt: 30 } })
                 db.users.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }])
                 db.users.createIndex({ name: 1 }, { unique: true })
                 db.users.insertOne({ name: 'Ann' })",
                &channel,
                Some(2),
                Some("t1"),
            )
            .await
            .unwrap();
        {
            let log = log.lock().unwrap();
            let types = event_types(&log);
            assert_eq!(&types[..2], ["command", "command"], "{types:?}");
            assert_eq!(events(&log)[0]["rowsAffected"], 3);
            assert_eq!(events(&log)[1]["rowsAffected"], 1);
            // The find kept 2 of the 3 pro users and counted the third on the server.
            let end = events(&log).into_iter().find(|e| e["type"] == "resultEnd").unwrap().clone();
            assert_eq!((end["rowCount"].as_u64(), end["truncated"].as_bool()), (Some(3), Some(true)));
            assert!(types.contains(&"error".to_owned()), "the duplicate key is an error");
            let b = batches(&log);
            assert_eq!(b[0].schema().fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(), ["_id", "name", "age", DOCUMENT_COLUMN]);
        }
        assert!(session.schemas().await.unwrap().contains(&db));
        let objects = session.objects(&db).await.unwrap();
        assert_eq!((objects[0].name.as_str(), objects[0].estimated_rows), ("users", Some(3)));
        let s = session.structure(&db, "users").await.unwrap();
        assert_eq!(s.columns[0].name, "_id");
        assert!(s.columns.iter().any(|c| c.name == "tags" && c.nullable));
        assert!(s.indexes.iter().any(|i| i.name == "name_1" && i.unique));
        assert!(s.ddl.contains("createIndex({\"name\":1}"), "{}", s.ddl);

        // Read-only connections refuse writes before sending them.
        let ro = MongoSession::connect(&ConnectionConfig { read_only: true, ..config.clone() }, None, None).await.unwrap();
        let (channel, log) = recorder();
        ro.run("db.users.deleteMany({})", &channel, None, None).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()));
        let (channel, _) = recorder();
        session.run("db.dropDatabase()", &channel, None, None).await.unwrap();
    }
}
