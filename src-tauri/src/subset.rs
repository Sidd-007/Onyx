//! Related-data copy: pick rows on one connection (say 50 users), and copy them with every row
//! they reference through foreign keys (and, if asked, the rows that reference them: their
//! orders, payments…) into another connection. Reads only from the source; on the target,
//! rows are inserted parents first, and rows that already exist are skipped.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::model::ForeignKeyRef;
use crate::db::Session;
use crate::dialect::{ident, literal, qualified};
use crate::error::{AppError, Result};
use crate::journal::{collect, Row};

/// Rows taken from one table at most (each step of the walk is capped too).
const TABLE_CAP: usize = 20_000;
const IN_CHUNK: usize = 400;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetRequest {
    pub schema: String,
    pub table: String,
    /// A WHERE clause picking the starting rows ("" for any).
    pub filter: String,
    pub limit: u64,
    /// Also the rows that reference the picked ones (one level), and what those reference.
    pub children: bool,
    pub target_schema: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubsetResult {
    /// table → rows written (existing ones skipped).
    pub tables: BTreeMap<String, u64>,
    pub read: u64,
}

struct Table {
    columns: Vec<String>,
    rows: Vec<Row>,
    /// Keys already taken (the whole row as text, or its primary key).
    seen: HashSet<String>,
    key_idx: Vec<usize>,
}

fn log(events: &Channel<InvokeResponseBody>, line: String) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "log", "line": line }).to_string()));
}

fn value(engine: Engine, v: &Option<String>) -> String {
    v.as_ref().map_or("NULL".into(), |v| literal(engine, v))
}

/// `(a, b) IN …` as ORs of ANDs, so it works on every engine.
fn match_any(engine: Engine, columns: &[String], tuples: &[Vec<Option<String>>]) -> String {
    tuples
        .iter()
        .map(|t| {
            let parts: Vec<String> = columns.iter().zip(t).map(|(c, v)| format!("{} = {}", ident(engine, c), value(engine, v))).collect();
            if parts.len() == 1 { parts[0].clone() } else { format!("({})", parts.join(" AND ")) }
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

pub async fn copy(source: &Session, target: &Session, req: &SubsetRequest, events: &Channel<InvokeResponseBody>) -> Result<SubsetResult> {
    let engine = source.engine();
    let keys: Vec<ForeignKeyRef> = source.all_foreign_keys().await?.into_iter().filter(|k| k.schema == req.schema && k.key.ref_schema == req.schema).collect();
    let mut tables: HashMap<String, Table> = HashMap::new();
    let mut read = 0u64;

    // Adds rows to a table, returning the ones not taken before.
    async fn take(source: &Session, schema: &str, table: &str, sql: String, tables: &mut HashMap<String, Table>, read: &mut u64) -> Result<Vec<Row>> {
        let (columns, rows) = collect(source, &sql, None, Some(TABLE_CAP as u64)).await?;
        *read += rows.len() as u64;
        if !tables.contains_key(table) {
            let pk: Vec<String> = source.columns(schema, table).await?.into_iter().filter(|c| c.primary_key).map(|c| c.name).collect();
            let key_idx = pk.iter().filter_map(|k| columns.iter().position(|c| c == k)).collect();
            tables.insert(table.to_owned(), Table { columns: columns.clone(), rows: vec![], seen: HashSet::new(), key_idx });
        }
        let t = tables.get_mut(table).unwrap();
        let mut fresh = Vec::new();
        for r in rows {
            let key = if t.key_idx.is_empty() { serde_json::to_string(&r).unwrap_or_default() } else { serde_json::to_string(&t.key_idx.iter().map(|&i| &r[i]).collect::<Vec<_>>()).unwrap_or_default() };
            if t.rows.len() < TABLE_CAP && t.seen.insert(key) {
                t.rows.push(r.clone());
                fresh.push(r);
            }
        }
        Ok(fresh)
    }

    // The starting rows.
    let from = qualified(engine, &req.schema, &req.table);
    let filter = req.filter.trim();
    let start_sql = match engine {
        Engine::Sqlserver => format!("SELECT TOP {} * FROM {from}{}", req.limit, if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") }),
        _ => format!("SELECT * FROM {from}{} LIMIT {}", if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") }, req.limit),
    };
    let start = take(source, &req.schema, &req.table, start_sql, &mut tables, &mut read).await?;
    log(events, format!("{}: {} starting rows", req.table, start.len()));
    // Rows whose parents still need fetching.
    let mut queue: VecDeque<(String, Vec<Row>)> = VecDeque::from([(req.table.clone(), start.clone())]);

    // Children of the starting rows (one level).
    if req.children {
        for fk in keys.iter().filter(|k| k.key.ref_table == req.table) {
            let t = &tables[&req.table];
            let idx: Vec<usize> = fk.key.ref_columns.iter().filter_map(|c| t.columns.iter().position(|x| x == c)).collect();
            if idx.len() != fk.key.ref_columns.len() {
                continue;
            }
            let tuples: Vec<Vec<Option<String>>> = start.iter().map(|r| idx.iter().map(|&i| r[i].clone()).collect()).filter(|t: &Vec<Option<String>>| t.iter().all(Option::is_some)).collect();
            for chunk in tuples.chunks(IN_CHUNK) {
                let sql = format!("SELECT * FROM {} WHERE {}", qualified(engine, &fk.schema, &fk.table), match_any(engine, &fk.key.columns, chunk));
                let fresh = take(source, &fk.schema, &fk.table, sql, &mut tables, &mut read).await?;
                if !fresh.is_empty() {
                    log(events, format!("{}: {} rows that reference {}", fk.table, fresh.len(), req.table));
                    queue.push_back((fk.table.clone(), fresh));
                }
            }
        }
    }

    // Parents, all the way up.
    while let Some((table, rows)) = queue.pop_front() {
        let columns = tables[&table].columns.clone();
        for fk in keys.iter().filter(|k| k.table == table) {
            let idx: Vec<usize> = fk.key.columns.iter().filter_map(|c| columns.iter().position(|x| x == c)).collect();
            if idx.len() != fk.key.columns.len() {
                continue;
            }
            let mut tuples: Vec<Vec<Option<String>>> = rows.iter().map(|r| idx.iter().map(|&i| r[i].clone()).collect()).filter(|t: &Vec<Option<String>>| t.iter().all(Option::is_some)).collect();
            tuples.sort();
            tuples.dedup();
            for chunk in tuples.chunks(IN_CHUNK) {
                let sql = format!("SELECT * FROM {} WHERE {}", qualified(engine, &fk.key.ref_schema, &fk.key.ref_table), match_any(engine, &fk.key.ref_columns, chunk));
                let fresh = take(source, &fk.key.ref_schema, &fk.key.ref_table, sql, &mut tables, &mut read).await?;
                if !fresh.is_empty() {
                    log(events, format!("{}: {} rows referenced by {}", fk.key.ref_table, fresh.len(), table));
                    queue.push_back((fk.key.ref_table.clone(), fresh));
                }
            }
        }
    }

    // Parents first on the target.
    let order = crate::export_db::creation_order(
        &tables.keys().map(|t| (t.clone(), keys.iter().filter(|k| &k.table == t).map(|k| k.key.ref_table.clone()).collect())).collect::<Vec<_>>(),
    );
    let mut written = BTreeMap::new();
    let tengine = target.engine();
    for name in order {
        let t = &tables[&name];
        if t.rows.is_empty() {
            continue;
        }
        let target_columns: Vec<String> = target.columns(&req.target_schema, &name).await.map_err(|e| AppError::Invalid(format!("{name} on the target: {e}")))?.into_iter().map(|c| c.name).collect();
        if target_columns.is_empty() {
            return Err(AppError::Invalid(format!("The target has no table {}.{name}: create it first (Copy structure, or Export structure as SQL)", req.target_schema)));
        }
        let shared: Vec<usize> = (0..t.columns.len()).filter(|&i| target_columns.contains(&t.columns[i])).collect();
        let names = shared.iter().map(|&i| ident(tengine, &t.columns[i])).collect::<Vec<_>>().join(", ");
        let into = qualified(tengine, &req.target_schema, &name);
        let mut count = 0u64;
        for chunk in t.rows.chunks(200) {
            let values = chunk.iter().map(|r| format!("({})", shared.iter().map(|&i| value(tengine, &r[i])).collect::<Vec<_>>().join(", "))).collect::<Vec<_>>().join(", ");
            let sql = match tengine {
                Engine::Postgres | Engine::Duckdb => format!("INSERT INTO {into} ({names}) VALUES {values} ON CONFLICT DO NOTHING"),
                Engine::Mysql => format!("INSERT IGNORE INTO {into} ({names}) VALUES {values}"),
                Engine::Sqlite => format!("INSERT OR IGNORE INTO {into} ({names}) VALUES {values}"),
                _ => format!("INSERT INTO {into} ({names}) VALUES {values}"),
            };
            target.execute_meta(&sql).await.map_err(|e| AppError::Invalid(format!("{name}: {e}")))?;
            count += chunk.len() as u64;
        }
        log(events, format!("{name}: {count} rows written"));
        written.insert(name, count);
    }
    Ok(SubsetResult { tables: written, read })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ONYX_TEST_PG=1 cargo test subset`: copies 1 user with their orders and items between two scratch schemas.
    #[tokio::test]
    async fn copies_rows_with_their_relations() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (src, dst) = (format!("onyx_sub_src_{id}"), format!("onyx_sub_dst_{id}"));
        let ddl = |s: &str| {
            format!(
                "CREATE SCHEMA {s};
                 CREATE TABLE {s}.plans (id int PRIMARY KEY, name text);
                 CREATE TABLE {s}.users (id int PRIMARY KEY, name text, plan_id int REFERENCES {s}.plans(id));
                 CREATE TABLE {s}.orders (id int PRIMARY KEY, user_id int REFERENCES {s}.users(id), total int);"
            )
        };
        session.execute_meta(&ddl(&src)).await.unwrap();
        session.execute_meta(&ddl(&dst)).await.unwrap();
        session
            .execute_meta(&format!(
                "INSERT INTO {src}.plans VALUES (1, 'pro'), (2, 'free');
                 INSERT INTO {src}.users VALUES (10, 'Ann', 1), (11, 'Bo', 2);
                 INSERT INTO {src}.orders VALUES (100, 10, 5), (101, 10, 7), (102, 11, 9);"
            ))
            .await
            .unwrap();
        let req = SubsetRequest { schema: src.clone(), table: "users".into(), filter: "id = 10".into(), limit: 50, children: true, target_schema: dst.clone() };
        let (events, _) = crate::db::stream::testing::recorder();
        let done = copy(&session, &session, &req, &events).await.unwrap();
        assert_eq!(done.tables.get("plans"), Some(&1));
        assert_eq!(done.tables.get("users"), Some(&1));
        assert_eq!(done.tables.get("orders"), Some(&2));
        // Again: existing rows are skipped, nothing fails.
        copy(&session, &session, &req, &events).await.unwrap();
        let (_, rows) = session.admin_rows(&format!("SELECT count(*) FROM {dst}.orders")).await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("2"));
        session.execute_meta(&format!("DROP SCHEMA {src} CASCADE; DROP SCHEMA {dst} CASCADE")).await.unwrap();
    }
}
