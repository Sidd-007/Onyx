//! Cross-database queries: `SELECT … FROM pg.users u JOIN my.orders o ON …`, where `pg` and
//! `my` are connections given an alias. Each table the query names is read from its
//! connection (up to a cap), loaded into an in-memory SQLite database, and the query runs
//! there. Nothing is written to the source databases.

use std::collections::BTreeMap;

use rusqlite::types::Value;
use serde::Deserialize;

use crate::db::stream::{Events, Run, RunSummary};
use crate::db::Session;
use crate::dialect::qualified;
use crate::error::{AppError, ErrorPayload, Result};

/// A source table read into memory: its columns and rows.
type Loaded = (Vec<String>, Vec<Vec<Option<String>>>);

/// Rows read from each source table.
pub const ROW_CAP: u64 = 200_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub alias: String,
    pub connection_id: uuid::Uuid,
}

/// A table the query names: `alias.table` or `alias.schema.table`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TableRef {
    pub alias: String,
    pub schema: Option<String>,
    pub table: String,
    /// As written, to be replaced.
    pub written: String,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Finds `alias.x` / `alias.x.y` outside strings and comments (names may be "quoted" or `quoted`).
pub fn table_refs(sql: &str, aliases: &[String]) -> Vec<TableRef> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let name_at = |i: usize| -> Option<(String, usize)> {
        let q = *chars.get(i)?;
        if q == '"' || q == '`' {
            let end = chars[i + 1..].iter().position(|&c| c == q)? + i + 1;
            Some((chars[i + 1..end].iter().collect(), end + 1))
        } else if is_word(q) {
            let end = chars[i..].iter().position(|&c| !is_word(c)).map_or(chars.len(), |p| p + i);
            Some((chars[i..end].iter().collect(), end))
        } else {
            None
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            i += 1;
            while i < chars.len() && !(chars[i] == '\'' && chars.get(i + 1) != Some(&'\'')) {
                i += if chars[i] == '\'' { 2 } else { 1 };
            }
            i += 1;
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        let starts_word = (is_word(c) || c == '"' || c == '`') && (i == 0 || !is_word(chars[i - 1]) && chars[i - 1] != '.');
        if starts_word && let Some((first, after)) = name_at(i) {
            if aliases.iter().any(|a| a.eq_ignore_ascii_case(&first))
                && chars.get(after) == Some(&'.')
                && let Some((second, after2)) = name_at(after + 1)
            {
                let (schema, table, end) = match (chars.get(after2) == Some(&'.')).then(|| name_at(after2 + 1)).flatten() {
                    Some((third, end)) => (Some(second), third, end),
                    None => (None, second, after2),
                };
                let alias = aliases.iter().find(|a| a.eq_ignore_ascii_case(&first)).unwrap().clone();
                out.push(TableRef { alias, schema, table, written: chars[i..end].iter().collect() });
                i = end;
                continue;
            }
            i = after;
            continue;
        }
        i += 1;
    }
    out
}

/// The SQLite name a source table gets: `pg__public__users`.
fn local_name(r: &TableRef) -> String {
    format!("\"{}__{}__{}\"", r.alias, r.schema.clone().unwrap_or_default(), r.table).replace("\"\"", "\"")
}

/// Text values become numbers when every value in the column is one, so joins and sorts behave.
fn typed(columns: usize, rows: &[Vec<Option<String>>]) -> Vec<Vec<Value>> {
    let numeric: Vec<bool> = (0..columns)
        .map(|c| rows.iter().filter_map(|r| r[c].as_deref()).all(|v| !v.is_empty() && v.parse::<f64>().is_ok() && !v.starts_with('+') && !(v.len() > 1 && v.starts_with('0') && !v.starts_with("0."))))
        .collect();
    rows.iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(c, v)| match v {
                    None => Value::Null,
                    Some(v) if numeric[c] => v.parse::<i64>().map(Value::Integer).unwrap_or_else(|_| Value::Real(v.parse().unwrap_or(0.0))),
                    Some(v) => Value::Text(v.clone()),
                })
                .collect()
        })
        .collect()
}

pub async fn run(sessions: &[(Source, std::sync::Arc<Session>)], sql: &str, events: &Events, limit: Option<u64>) -> Result<RunSummary> {
    let mut run = Run::with_limit(events, limit);
    let outcome = load_and_query(sessions, sql, &mut run).await;
    let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), false));
    run.finish(outcome, error)
}

async fn load_and_query(sessions: &[(Source, std::sync::Arc<Session>)], sql: &str, run: &mut Run<'_>) -> Result<()> {
    let aliases: Vec<String> = sessions.iter().map(|(s, _)| s.alias.clone()).collect();
    let mut refs = table_refs(sql, &aliases);
    if refs.is_empty() {
        return Err(AppError::Invalid(format!("Name tables with their connection's alias, like {}.users", aliases.first().map_or("pg", String::as_str))));
    }
    // Read each table once.
    let mut tables: BTreeMap<String, Loaded> = BTreeMap::new();
    refs.sort();
    for r in &refs {
        let name = local_name(r);
        if tables.contains_key(&name) {
            continue;
        }
        let session = &sessions.iter().find(|(s, _)| s.alias == r.alias).unwrap().1;
        let engine = session.engine();
        let from = match &r.schema {
            Some(s) => qualified(engine, s, &r.table),
            None => crate::dialect::ident(engine, &r.table),
        };
        let select = if engine == crate::connections::Engine::Sqlserver { format!("SELECT TOP {ROW_CAP} * FROM {from}") } else { format!("SELECT * FROM {from} LIMIT {ROW_CAP}") };
        let (columns, rows) = crate::journal::collect(session, &select, None, Some(ROW_CAP)).await.map_err(|e| AppError::Invalid(format!("{}: {e}", r.written)))?;
        tables.insert(name, (columns, rows));
    }
    // Longest first, so `pg.public.users` isn't cut to `pg.public` + `.users`.
    let mut rewritten = sql.to_owned();
    let mut by_length = refs.clone();
    by_length.sort_by_key(|r| std::cmp::Reverse(r.written.len()));
    for r in &by_length {
        rewritten = rewritten.replace(&r.written, &local_name(r));
    }

    let result = tokio::task::spawn_blocking(move || -> Result<Loaded> {
        let db = rusqlite::Connection::open_in_memory()?;
        for (name, (columns, rows)) in &tables {
            let cols = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(", ");
            db.execute_batch(&format!("CREATE TABLE {name} ({cols})"))?;
            let marks = vec!["?"; columns.len()].join(", ");
            let tx = db.unchecked_transaction()?;
            {
                let mut insert = tx.prepare(&format!("INSERT INTO {name} VALUES ({marks})"))?;
                for row in typed(columns.len(), rows) {
                    insert.execute(rusqlite::params_from_iter(row))?;
                }
            }
            tx.commit()?;
        }
        let mut stmt = db.prepare(&rewritten)?;
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let n = columns.len();
        let rows = stmt
            .query_map([], |r| {
                (0..n)
                    .map(|i| {
                        Ok(match r.get::<_, Value>(i)? {
                            Value::Null => None,
                            Value::Integer(v) => Some(v.to_string()),
                            Value::Real(v) => Some(v.to_string()),
                            Value::Text(v) => Some(v),
                            Value::Blob(b) => Some(format!("\\x{}", hex::encode(b))),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((columns, rows))
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))??;
    run.start_result(result.0)?;
    for row in result.1 {
        run.push_row(row)?;
    }
    run.end_result(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_aliased_tables() {
        let aliases = vec!["pg".to_owned(), "my".to_owned()];
        let refs = table_refs("SELECT u.name, 'pg.not_this' FROM pg.public.users u -- my.no\nJOIN my.\"order items\" o ON o.user_id = u.id JOIN mypg.x ON 1=1", &aliases);
        assert_eq!(refs.len(), 2);
        assert_eq!((refs[0].schema.as_deref(), refs[0].table.as_str(), refs[0].written.as_str()), (Some("public"), "users", "pg.public.users"));
        assert_eq!((refs[1].alias.as_str(), refs[1].table.as_str()), ("my", "order items"));
        // u.name is an alias column, not a table.
        assert!(table_refs("SELECT u.name FROM pg.users u", &aliases).iter().all(|r| r.table == "users"));
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test federated`: joins a Postgres table with a MySQL table.
    #[tokio::test]
    async fn joins_across_databases() {
        let (Some(pg), Some(my)) = (crate::db::edit_integration::config(crate::connections::Engine::Postgres), crate::db::edit_integration::config(crate::connections::Engine::Mysql)) else { return };
        let (pg, my) = (std::sync::Arc::new(Session::connect(&pg, None, None).await.unwrap()), std::sync::Arc::new(Session::connect(&my, None, None).await.unwrap()));
        let t = format!("onyx_fed_{}", uuid::Uuid::new_v4().simple());
        pg.execute_meta(&format!("CREATE TABLE public.{t} (id int PRIMARY KEY, name text); INSERT INTO public.{t} VALUES (1, 'Ann'), (2, 'Bo'), (10, 'Cy')")).await.unwrap();
        my.execute_meta(&format!("CREATE TABLE {t} (user_id int, total int)")).await.unwrap();
        my.execute_meta(&format!("INSERT INTO {t} VALUES (1, 5), (1, 7), (10, 1)")).await.unwrap();
        let sources = vec![
            (Source { alias: "pg".into(), connection_id: uuid::Uuid::nil() }, pg.clone()),
            (Source { alias: "my".into(), connection_id: uuid::Uuid::nil() }, my.clone()),
        ];
        let (channel, log) = crate::db::stream::testing::recorder();
        run(&sources, &format!("SELECT u.name, SUM(o.total) AS spent FROM pg.public.{t} u JOIN my.{t} o ON o.user_id = u.id GROUP BY u.name ORDER BY u.id"), &channel, None)
            .await
            .unwrap();
        {
            let log = log.lock().unwrap();
            let types = crate::db::stream::testing::event_types(&log);
            assert!(!types.contains(&"error".to_owned()), "{types:?}");
            let b = crate::db::stream::testing::batches(&log);
            let names = b[0].column(0).as_any().downcast_ref::<arrow_array::StringArray>().unwrap();
            let spent = b[0].column(1).as_any().downcast_ref::<arrow_array::StringArray>().unwrap();
            use arrow_array::Array;
            assert_eq!((names.len(), names.value(0), spent.value(0), names.value(1)), (2, "Ann", "12", "Cy"), "10 sorts after 2: numbers stay numbers");
        }
        pg.execute_meta(&format!("DROP TABLE public.{t}")).await.unwrap();
        my.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
    }
}
