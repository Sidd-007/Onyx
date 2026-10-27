//! A whole database (one schema) as a single .sql file: CREATE statements for every table
//! and view, optionally followed by each table's rows as INSERTs. Built from Onyx's own
//! introspection, so it needs no pg_dump or mysqldump.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::model::TableStructure;
use crate::db::Session;
use crate::dialect::{ident, qualified};
use crate::error::{AppError, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExport {
    pub path: String,
    pub tables: usize,
    pub views: usize,
    pub rows: u64,
}

const TABLE_KINDS: [&str; 3] = ["table", "partitioned-table", "foreign-table"];

fn log(events: &Channel<InvokeResponseBody>, line: String) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "log", "line": line }).to_string()));
}

fn progress(events: &Channel<InvokeResponseBody>, rows: u64) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "progress", "rows": rows }).to_string()));
}

/// One statement, ending in exactly one `;`.
fn statement(ddl: &str) -> String {
    let ddl = ddl.trim();
    if ddl.ends_with(';') { ddl.to_owned() } else { format!("{ddl};") }
}

/// Tables ordered so each comes after the tables its foreign keys point at (cycles keep name order).
pub fn creation_order(tables: &[(String, Vec<String>)]) -> Vec<String> {
    let names: HashSet<&str> = tables.iter().map(|(n, _)| n.as_str()).collect();
    let deps: HashMap<&str, Vec<&str>> = tables
        .iter()
        .map(|(n, refs)| (n.as_str(), refs.iter().map(String::as_str).filter(|r| names.contains(r) && r != n).collect()))
        .collect();
    let mut done: Vec<String> = Vec::new();
    let mut placed: HashSet<&str> = HashSet::new();
    let mut remaining: Vec<&str> = tables.iter().map(|(n, _)| n.as_str()).collect();
    while !remaining.is_empty() {
        let ready: Vec<&str> = remaining.iter().copied().filter(|n| deps[n].iter().all(|d| placed.contains(d))).collect();
        // A cycle: take the first one anyway (its constraint may need to be added after).
        let next = if ready.is_empty() { vec![remaining[0]] } else { ready };
        for n in next {
            placed.insert(n);
            done.push(n.to_owned());
            remaining.retain(|r| *r != n);
        }
    }
    done
}

/// Sequences behind Postgres `nextval('…')` defaults, so serial columns restore.
fn sequences(structure: &TableStructure) -> Vec<String> {
    structure
        .columns
        .iter()
        .filter_map(|c| c.default.as_deref())
        .filter_map(|d| d.strip_prefix("nextval('"))
        .filter_map(|d| d.split('\'').next())
        .map(str::to_owned)
        .collect()
}

/// A Write over the shared file, so each table's INSERT writer can append to it.
#[derive(Clone)]
pub struct SharedFile(pub Arc<Mutex<BufWriter<File>>>);

impl Write for SharedFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

pub async fn export_database(
    session: &Session,
    schema: &str,
    include_data: bool,
    path: &Path,
    events: &Channel<InvokeResponseBody>,
) -> Result<DatabaseExport> {
    let engine = session.engine();
    if matches!(engine, Engine::Redis | Engine::Mongodb) {
        return Err(AppError::Invalid("A .sql export is for SQL databases".into()));
    }
    let result = write_all(session, engine, schema, include_data, path, events).await;
    if result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}

async fn write_all(
    session: &Session,
    engine: Engine,
    schema: &str,
    include_data: bool,
    path: &Path,
    events: &Channel<InvokeResponseBody>,
) -> Result<DatabaseExport> {
    let objects = session.objects(schema).await?;
    let tables: Vec<&str> = objects.iter().filter(|o| TABLE_KINDS.contains(&o.kind)).map(|o| o.name.as_str()).collect();
    let views: Vec<&str> = objects.iter().filter(|o| o.kind == "view" || o.kind == "materialized-view").map(|o| o.name.as_str()).collect();

    let mut structures: HashMap<String, TableStructure> = HashMap::new();
    for (i, t) in tables.iter().chain(&views).enumerate() {
        log(events, format!("Reading {t} ({}/{})", i + 1, tables.len() + views.len()));
        structures.insert((*t).to_owned(), session.structure(schema, t).await?);
    }
    let order = creation_order(
        &tables
            .iter()
            .map(|t| ((*t).to_owned(), structures[*t].foreign_keys.iter().filter(|k| k.ref_schema == schema || k.ref_schema.is_empty()).map(|k| k.ref_table.clone()).collect()))
            .collect::<Vec<_>>(),
    );

    let file = SharedFile(Arc::new(Mutex::new(BufWriter::new(File::create(path)?))));
    let mut out = file.clone();
    writeln!(out, "-- Onyx export of {schema} ({engine:?}), {}", chrono_free_now())?;
    writeln!(out, "-- {} tables, {} views{}\n", tables.len(), views.len(), if include_data { ", with data" } else { "" })?;
    match engine {
        Engine::Postgres => {
            writeln!(out, "CREATE SCHEMA IF NOT EXISTS {};", ident(engine, schema))?;
            writeln!(out, "SET search_path TO {};\n", ident(engine, schema))?;
            let mut seen = HashSet::new();
            for t in &order {
                for s in sequences(&structures[t]) {
                    if seen.insert(s.clone()) {
                        writeln!(out, "CREATE SEQUENCE IF NOT EXISTS {s};")?;
                    }
                }
            }
            if !seen.is_empty() {
                writeln!(out)?;
            }
        }
        Engine::Mysql => writeln!(out, "SET FOREIGN_KEY_CHECKS = 0;\n")?,
        Engine::Sqlite => writeln!(out, "PRAGMA foreign_keys = OFF;\nBEGIN;\n")?,
        _ => {}
    }

    for t in &order {
        writeln!(out, "-- Table {t}\n{}\n", statement(&structures[t].ddl))?;
    }
    for v in &views {
        writeln!(out, "-- View {v}\n{}\n", statement(&structures[*v].ddl))?;
    }

    let mut rows = 0u64;
    if include_data {
        for (i, t) in order.iter().enumerate() {
            log(events, format!("Writing rows of {t} ({}/{})", i + 1, order.len()));
            writeln!(out, "-- Data of {t}")?;
            let sql = format!("SELECT * FROM {}", qualified(engine, schema, t));
            rows += crate::export::write_inserts(session, &sql, t, file.clone()).await?;
            progress(events, rows);
            writeln!(out)?;
        }
    }

    match engine {
        Engine::Mysql => writeln!(out, "SET FOREIGN_KEY_CHECKS = 1;")?,
        Engine::Sqlite => writeln!(out, "COMMIT;\nPRAGMA foreign_keys = ON;")?,
        _ => {}
    }
    out.flush()?;
    Ok(DatabaseExport { path: path.display().to_string(), tables: tables.len(), views: views.len(), rows })
}

/// "2026-10-23 13:40 UTC", without a date library.
fn chrono_free_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let (h, m) = (secs.rem_euclid(86_400) / 3600, secs.rem_euclid(3600) / 60);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02} UTC")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_tables_by_foreign_keys() {
        let t = |n: &str, refs: &[&str]| (n.to_owned(), refs.iter().map(|r| (*r).to_owned()).collect());
        let order = creation_order(&[t("items", &["orders", "products"]), t("orders", &["users"]), t("products", &[]), t("users", &["users"])]);
        assert_eq!(order, ["products", "users", "orders", "items"]);
        // A cycle still lists every table once.
        let cycle = creation_order(&[t("a", &["b"]), t("b", &["a"])]);
        assert_eq!(cycle.len(), 2);
        assert_eq!(statement("CREATE VIEW v AS SELECT 1\n"), "CREATE VIEW v AS SELECT 1;");
    }

    /// `ONYX_TEST_PG=1 cargo test export_db`: exports a scratch schema and checks the file.
    #[tokio::test]
    async fn exports_a_postgres_schema() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let schema = format!("onyx_export_{}", uuid::Uuid::new_v4().simple());
        let (channel, _) = crate::db::stream::testing::recorder();
        session
            .run(
                &format!(
                    "CREATE SCHEMA {schema};
                     CREATE TABLE {schema}.users (id serial PRIMARY KEY, name text NOT NULL);
                     CREATE TABLE {schema}.orders (id serial PRIMARY KEY, user_id int REFERENCES {schema}.users(id), note text);
                     CREATE VIEW {schema}.named AS SELECT name FROM {schema}.users;
                     INSERT INTO {schema}.users (name) VALUES ('Ann'), ('O''Brien');
                     INSERT INTO {schema}.orders (user_id, note) VALUES (1, NULL);"
                ),
                &channel,
            )
            .await
            .unwrap();
        let path = std::env::temp_dir().join(format!("{schema}.sql"));
        let (events, _) = crate::db::stream::testing::recorder();
        let done = export_database(&session, &schema, true, &path, &events).await.unwrap();
        assert_eq!((done.tables, done.views, done.rows), (2, 1, 3));
        let text = std::fs::read_to_string(&path).unwrap();
        let users = text.find("CREATE TABLE \"").unwrap();
        assert!(text[users..].starts_with(&format!("CREATE TABLE \"{schema}\".\"users\"")), "users first: {text}");
        assert!(text.contains("CREATE SEQUENCE IF NOT EXISTS"), "{text}");
        assert!(text.contains("O''Brien"));

        // The file recreates the schema.
        let (channel, _) = crate::db::stream::testing::recorder();
        session.run(&format!("DROP SCHEMA {schema} CASCADE"), &channel).await.unwrap();
        let (channel, log) = crate::db::stream::testing::recorder();
        session.run(&text, &channel).await.unwrap();
        assert!(!crate::db::stream::testing::event_types(&log.lock().unwrap()).contains(&"error".to_owned()));
        let (channel, _) = crate::db::stream::testing::recorder();
        session.run(&format!("DROP SCHEMA {schema} CASCADE"), &channel).await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    /// `ONYX_TEST_MYSQL=1 cargo test export_db`: the same round trip on a scratch MySQL database.
    #[tokio::test]
    async fn exports_a_mysql_database() {
        let Some(config) = crate::db::edit_integration::config(Engine::Mysql) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let db = format!("onyx_export_{}", uuid::Uuid::new_v4().simple());
        let run = |sql: String| {
            let session = &session;
            async move {
                let (channel, log) = crate::db::stream::testing::recorder();
                session.run(&sql, &channel).await.unwrap();
                let failed = crate::db::stream::testing::event_types(&log.lock().unwrap()).contains(&"error".to_owned());
                assert!(!failed, "{sql}");
            }
        };
        run(format!(
            "CREATE DATABASE {db};
             CREATE TABLE {db}.users (id int PRIMARY KEY, name varchar(50) NOT NULL);
             CREATE TABLE {db}.orders (id int PRIMARY KEY, user_id int, note text, FOREIGN KEY (user_id) REFERENCES {db}.users(id));
             CREATE VIEW {db}.named AS SELECT name FROM {db}.users;
             INSERT INTO {db}.users VALUES (1, 'Ann'), (2, 'it''s \\ fine');
             INSERT INTO {db}.orders VALUES (1, 1, NULL)"
        ))
        .await;
        let path = std::env::temp_dir().join(format!("{db}.sql"));
        let (events, _) = crate::db::stream::testing::recorder();
        let done = export_database(&session, &db, true, &path, &events).await.unwrap();
        assert_eq!((done.tables, done.views, done.rows), (2, 1, 3));
        let text = std::fs::read_to_string(&path).unwrap();
        run(format!("DROP DATABASE {db}")).await;
        run(format!("CREATE DATABASE {db}; USE {db};\n{text}")).await;
        let (channel, log) = crate::db::stream::testing::recorder();
        session.run(&format!("SELECT name FROM {db}.users ORDER BY id"), &channel).await.unwrap();
        assert_eq!(crate::db::stream::testing::events(&log.lock().unwrap()).iter().find(|e| e["type"] == "resultEnd").unwrap()["rowCount"], 2);
        run(format!("DROP DATABASE {db}")).await;
        std::fs::remove_file(path).unwrap();
    }
}
