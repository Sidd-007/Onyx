//! Safety nets around writes:
//! - the change journal: before an UPDATE or DELETE runs, the rows it will touch are read, so
//!   the vault can keep the SQL that puts them back ("Undo", even after a commit);
//! - previews: on prod, a write first runs inside a transaction that's rolled back, to show
//!   the rows before and after;
//! - the cost guard: before a prod query runs, its plan is checked for full scans of big tables.

use std::sync::{Arc, Mutex};

use arrow_array::{Array, StringArray};
use arrow_ipc::reader::StreamReader;
use serde::{Deserialize, Serialize};
use sqlparser::ast::{AssignmentTarget, FromTable, ObjectName, Statement, TableFactor, TableWithJoins};
use sqlparser::parser::Parser;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::Session;
use crate::dialect::{ident, literal, qualified};
use crate::error::{AppError, Result};
use crate::guard::Risk;

pub type Row = Vec<Option<String>>;

/// Rows read before a write; more than this and the change can't be undone.
const CAPTURE_LIMIT: u64 = 5000;
/// Rows a preview shows.
const PREVIEW_LIMIT: u64 = 1000;
/// Full scans of tables bigger than this get a warning on prod.
const BIG_TABLE: f64 = 200_000.0;

/// Every row of a query's first result, on `tab`'s session (`limit`: rows kept).
pub async fn collect(session: &Session, sql: &str, tab: Option<&str>, limit: Option<u64>) -> Result<(Vec<String>, Vec<Row>)> {
    #[derive(Default)]
    struct Out {
        columns: Vec<String>,
        rows: Vec<Row>,
        error: Option<String>,
        results: usize,
    }
    let out = Arc::new(Mutex::new(Out::default()));
    let sink = out.clone();
    let channel = Channel::new(move |body| {
        let mut o = sink.lock().unwrap();
        match body {
            InvokeResponseBody::Json(json) => {
                let e: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
                match e["type"].as_str() {
                    Some("resultStart") => {
                        o.results += 1;
                        if o.results == 1 {
                            o.columns = e["columns"].as_array().into_iter().flatten().map(|c| c.as_str().unwrap_or("").to_owned()).collect();
                        }
                    }
                    Some("error") => o.error = e["error"]["message"].as_str().map(str::to_owned),
                    _ => {}
                }
            }
            InvokeResponseBody::Raw(bytes) if o.results == 1 => {
                if let Ok(reader) = StreamReader::try_new(bytes.as_slice(), None) {
                    for batch in reader.flatten() {
                        let cols: Vec<&StringArray> = batch.columns().iter().filter_map(|c| c.as_any().downcast_ref::<StringArray>()).collect();
                        for r in 0..batch.num_rows() {
                            let row = cols.iter().map(|c| (!c.is_null(r)).then(|| c.value(r).to_owned())).collect();
                            o.rows.push(row);
                        }
                    }
                }
            }
            InvokeResponseBody::Raw(_) => {}
        }
        Ok(())
    });
    session.run_limited(sql, &channel, limit, tab).await?;
    let mut o = out.lock().unwrap();
    match o.error.take() {
        Some(e) => Err(AppError::Invalid(e)),
        None => Ok((std::mem::take(&mut o.columns), std::mem::take(&mut o.rows))),
    }
}

/// A single-table UPDATE or DELETE.
#[derive(Debug, PartialEq)]
pub struct Write {
    pub update: bool,
    /// The table as written (`schema.table` or `table`), its parts unquoted.
    pub parts: Vec<String>,
    /// `FROM` text for reading the same rows (keeps an alias the WHERE uses).
    pub from: String,
    pub selection: Option<String>,
    /// UPDATE: the columns it sets.
    pub assigned: Vec<String>,
    pub text: String,
}

fn parts(name: &ObjectName) -> Vec<String> {
    name.0.iter().filter_map(|p| p.as_ident()).map(|i| i.value.clone()).collect()
}

fn single_table(t: &TableWithJoins) -> Option<(Vec<String>, String)> {
    if !t.joins.is_empty() {
        return None;
    }
    match &t.relation {
        TableFactor::Table { name, .. } => Some((parts(name), t.to_string())),
        _ => None,
    }
}

/// The writes in `sql` that can be captured, and how many statements write at all.
pub fn writes(sql: &str, engine: Engine) -> (Vec<Write>, usize) {
    let dialect = crate::dialect::parser(engine);
    let Ok(statements) = Parser::parse_sql(dialect.as_ref(), sql) else { return (vec![], 0) };
    let mut out = Vec::new();
    let mut writing = 0;
    for s in &statements {
        match s {
            Statement::Update(u) => {
                writing += 1;
                if u.from.is_some() {
                    continue;
                }
                let Some((parts, from)) = single_table(&u.table) else { continue };
                let assigned = u
                    .assignments
                    .iter()
                    .flat_map(|a| match &a.target {
                        AssignmentTarget::ColumnName(n) => vec![parts_last(n)],
                        AssignmentTarget::Tuple(ns) => ns.iter().map(parts_last).collect(),
                    })
                    .collect();
                out.push(Write { update: true, parts, from, selection: u.selection.as_ref().map(|e| e.to_string()), assigned, text: s.to_string() });
            }
            Statement::Delete(d) => {
                writing += 1;
                let tables = match &d.from {
                    FromTable::WithFromKeyword(t) | FromTable::WithoutKeyword(t) => t,
                };
                if tables.len() != 1 || !d.tables.is_empty() || d.using.is_some() {
                    continue;
                }
                let Some((parts, from)) = single_table(&tables[0]) else { continue };
                out.push(Write { update: false, parts, from, selection: d.selection.as_ref().map(|e| e.to_string()), assigned: vec![], text: s.to_string() });
            }
            Statement::Insert(_) | Statement::Merge { .. } => writing += 1,
            _ => {}
        }
    }
    (out, writing)
}

fn parts_last(n: &ObjectName) -> String {
    parts(n).pop().unwrap_or_default()
}

/// The schema unqualified names resolve to on this session.
async fn current_schema(session: &Session, tab: Option<&str>) -> Result<String> {
    let sql = match session.engine() {
        Engine::Postgres | Engine::Duckdb => "SELECT current_schema()",
        Engine::Mysql | Engine::Clickhouse => "SELECT DATABASE()",
        Engine::Sqlserver => "SELECT SCHEMA_NAME()",
        _ => return Ok("main".into()),
    };
    let (_, rows) = collect(session, sql, tab, Some(1)).await?;
    Ok(rows.first().and_then(|r| r.first().cloned().flatten()).unwrap_or_default())
}

/// What the journal keeps for one write: the rows before it, and the SQL that restores them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub statement: String,
    pub target: String,
    pub rows: usize,
    pub reverse: Option<String>,
    pub note: Option<String>,
    /// The touched rows, filled with what the write left once it has run (`capture_after`).
    #[serde(skip)]
    pub after: Option<AfterState>,
}

/// The rows a change left behind. Undo first checks they still look like this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AfterState {
    pub schema: String,
    pub table: String,
    pub key_columns: Vec<String>,
    /// UPDATE: the columns it set. Empty for DELETE (the rows must simply be gone).
    pub columns: Vec<String>,
    pub delete: bool,
    /// Each row's key, and (UPDATE) the values it was left with; `None` if it wasn't found.
    pub rows: Vec<(Row, Option<Row>)>,
}

const CHUNK: usize = 200;

/// `(k1, k2) = (…)` for many keys, as ORs, so it works everywhere.
fn any_key(engine: Engine, columns: &[String], keys: &[&Row]) -> String {
    keys.iter()
        .map(|k| {
            let parts: Vec<String> = columns
                .iter()
                .zip(k.iter())
                .map(|(c, v)| match v {
                    None => format!("{} IS NULL", ident(engine, c)),
                    Some(v) => format!("{} = {}", ident(engine, c), literal(engine, v)),
                })
                .collect();
            format!("({})", parts.join(" AND "))
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// The current values of `state`'s columns for its rows, by key (`lock`: FOR UPDATE where it exists).
async fn read_state(session: &Session, state: &AfterState, tab: Option<&str>, lock: bool) -> Result<std::collections::HashMap<Row, Row>> {
    let engine = session.engine();
    let target = qualified(engine, &state.schema, &state.table);
    let wanted: Vec<String> = state.key_columns.iter().chain(state.columns.iter()).map(|c| ident(engine, c)).collect();
    let lock = if lock && matches!(engine, Engine::Postgres | Engine::Mysql) { " FOR UPDATE" } else { "" };
    let mut found = std::collections::HashMap::new();
    let keys: Vec<&Row> = state.rows.iter().map(|(k, _)| k).collect();
    for chunk in keys.chunks(CHUNK) {
        let sql = format!("SELECT {} FROM {target} WHERE {}{lock}", wanted.join(", "), any_key(engine, &state.key_columns, chunk));
        let (_, rows) = collect(session, &sql, tab, None).await?;
        for mut r in rows {
            let values = r.split_off(state.key_columns.len());
            found.insert(r, values);
        }
    }
    Ok(found)
}

/// After a write has run: records what it left in the rows it touched (on the same session,
/// so an open transaction's own changes are seen).
pub async fn capture_after(session: &Session, planned: &mut [Planned], tab: Option<&str>) {
    for p in planned.iter_mut() {
        let Some(state) = p.after.as_mut() else { continue };
        if state.delete {
            continue;
        }
        match read_state(session, state, tab, false).await {
            Ok(found) => {
                for (key, values) in state.rows.iter_mut() {
                    *values = found.get(key).cloned();
                }
            }
            // Without it, undo can't check for newer changes: say so rather than guess.
            Err(e) => {
                p.after = None;
                p.note = Some(format!("Couldn't read the rows after the change ({e}), so undo can't check for newer changes"));
            }
        }
    }
}

fn row_label(columns: &[String], key: &Row) -> String {
    columns.iter().zip(key).map(|(c, v)| format!("{c} = {}", v.as_deref().unwrap_or("NULL"))).collect::<Vec<_>>().join(", ")
}

fn shown(v: &Option<String>) -> String {
    v.as_ref().map_or("NULL".into(), |v| if v.chars().count() > 40 { format!("'{}…'", v.chars().take(39).collect::<String>()) } else { format!("'{v}'") })
}

/// Rows that changed after `state` was recorded: undoing would overwrite those newer changes.
async fn newer_changes(session: &Session, state: &AfterState, tab: &str) -> Result<Vec<String>> {
    let found = read_state(session, state, Some(tab), true).await?;
    let mut out = Vec::new();
    for (key, left) in &state.rows {
        let label = row_label(&state.key_columns, key);
        match (state.delete, found.get(key), left) {
            (true, Some(_), _) => out.push(format!("{label} exists again")),
            (true, None, _) => {}
            (false, None, Some(_)) => out.push(format!("{label} was deleted after this change")),
            (false, Some(now), Some(left)) => {
                for ((c, n), l) in state.columns.iter().zip(now).zip(left) {
                    if n != l {
                        out.push(format!("{label}: {c} is now {} (this change left {})", shown(n), shown(l)));
                    }
                }
            }
            (false, _, None) => {}
        }
    }
    Ok(out)
}

fn value(engine: Engine, v: &Option<String>) -> String {
    v.as_ref().map_or("NULL".into(), |v| literal(engine, v))
}

/// Reads what each UPDATE / DELETE in `sql` will touch, before it runs (on the same session).
///
/// Writes to the same table in one run become one entry. Their rows are all read before the
/// batch starts and checked after it ends, so per-statement images would be wrong: a later
/// statement's "before" misses the earlier one's change, and the earlier one's "after" already
/// holds the later one's. One entry for the batch restores what the table held before it.
pub async fn plan(session: &Session, sql: &str, tab: Option<&str>) -> Vec<Planned> {
    let engine = session.engine();
    let (writes, writing) = writes(sql, engine);
    let failed = |w: &Write, e: AppError| Planned {
        statement: w.text.clone(),
        target: w.parts.join("."),
        rows: 0,
        reverse: None,
        note: Some(format!("Couldn't read the rows first: {e}")),
        after: None,
    };
    let mut current: Option<String> = None;
    let mut groups: Vec<((String, String), Vec<&Write>)> = Vec::new();
    let mut out = Vec::new();
    for w in &writes {
        let target = match w.parts.as_slice() {
            [t] => {
                if current.is_none() {
                    match current_schema(session, tab).await {
                        Ok(s) => current = Some(s),
                        Err(e) => {
                            out.push(failed(w, e));
                            continue;
                        }
                    }
                }
                (current.clone().unwrap_or_default(), t.clone())
            }
            [.., s, t] => (s.clone(), t.clone()),
            [] => continue,
        };
        match groups.iter_mut().find(|(t, _)| *t == target) {
            Some((_, g)) => g.push(w),
            None => groups.push((target, vec![w])),
        }
    }
    for ((schema, table), group) in groups {
        out.push(plan_group(session, engine, &schema, &table, &group, tab).await.unwrap_or_else(|e| failed(group[0], e)));
    }
    if writing > writes.len() {
        out.push(Planned {
            statement: sql.trim().chars().take(2000).collect(),
            target: String::new(),
            rows: 0,
            reverse: None,
            note: Some("Inserts, joins and multi-table writes are listed but can't be undone".into()),
            after: None,
        });
    }
    out
}

/// One table's writes from a run (usually one): the rows any of them will touch, read before
/// the run, and the SQL that puts them back.
async fn plan_group(session: &Session, engine: Engine, schema: &str, table: &str, group: &[&Write], tab: Option<&str>) -> Result<Planned> {
    let target = qualified(engine, schema, table);
    let statement = group.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(";\n");
    let base = Planned { statement, target: format!("{schema}.{table}"), rows: 0, reverse: None, note: None, after: None };
    let update = group[0].update;
    if group.iter().any(|w| w.update != update) {
        return Ok(Planned { note: Some("Updates and deletes rows of the same table in one run: run them one at a time to be able to undo them".into()), ..base });
    }
    let keys: Vec<String> = session.columns(schema, table).await?.into_iter().filter(|c| c.primary_key).map(|c| c.name).collect();
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    let mut assigned: Vec<String> = Vec::new();
    for w in group {
        let where_ = w.selection.as_ref().map(|s| format!(" WHERE {s}")).unwrap_or_default();
        let (c, read) = collect(session, &format!("SELECT * FROM {}{where_}", w.from), tab, Some(CAPTURE_LIMIT + 1)).await?;
        if read.len() as u64 > CAPTURE_LIMIT {
            return Ok(Planned { rows: CAPTURE_LIMIT as usize, note: Some(format!("Touches more than {CAPTURE_LIMIT} rows: too many to keep for undo")), ..base });
        }
        let key_idx: Vec<usize> = keys.iter().filter_map(|k| c.iter().position(|n| n == k)).collect();
        let same = |a: &Row, b: &Row| if key_idx.len() == keys.len() && !keys.is_empty() { key_idx.iter().all(|&i| a[i] == b[i]) } else { a == b };
        for r in read {
            if !rows.iter().any(|x| same(x, &r)) {
                rows.push(r);
            }
        }
        columns = c;
        for a in &w.assigned {
            if !assigned.contains(a) {
                assigned.push(a.clone());
            }
        }
        if rows.len() as u64 > CAPTURE_LIMIT {
            return Ok(Planned { rows: CAPTURE_LIMIT as usize, note: Some(format!("Touches more than {CAPTURE_LIMIT} rows: too many to keep for undo")), ..base });
        }
    }
    let base = Planned { rows: rows.len(), ..base };
    if rows.is_empty() {
        return Ok(Planned { note: Some("Touched no rows".into()), ..base });
    }
    let col = |name: &str| columns.iter().position(|c| c == name);
    let key_idx: Vec<usize> = keys.iter().filter_map(|k| col(k)).collect();
    let reverse = if !update {
        let names = columns.iter().map(|c| ident(engine, c)).collect::<Vec<_>>().join(", ");
        Some(rows.iter().map(|r| format!("INSERT INTO {target} ({names}) VALUES ({})", r.iter().map(|v| value(engine, v)).collect::<Vec<_>>().join(", "))).collect::<Vec<_>>())
    } else if keys.is_empty() || key_idx.len() != keys.len() {
        return Ok(Planned { note: Some("No primary key: the old rows can't be found again".into()), ..base });
    } else if assigned.iter().any(|a| keys.contains(a)) {
        return Ok(Planned { note: Some("Changes the primary key itself".into()), ..base });
    } else {
        let set_idx: Vec<(String, usize)> = assigned.iter().filter_map(|a| col(a).map(|i| (a.clone(), i))).collect();
        Some(
            rows.iter()
                .map(|r| {
                    let set = set_idx.iter().map(|(n, i)| format!("{} = {}", ident(engine, n), value(engine, &r[*i]))).collect::<Vec<_>>().join(", ");
                    let key = key_idx.iter().map(|&i| format!("{} = {}", ident(engine, &columns[i]), value(engine, &r[i]))).collect::<Vec<_>>().join(" AND ");
                    format!("UPDATE {target} SET {set} WHERE {key}")
                })
                .collect(),
        )
    };
    // The rows' keys, for checking later that nobody changed them since (filled after the run).
    let after = (!keys.is_empty() && key_idx.len() == keys.len()).then(|| AfterState {
        schema: schema.to_owned(),
        table: table.to_owned(),
        key_columns: keys.clone(),
        columns: if update { assigned.iter().filter(|a| col(a).is_some()).cloned().collect() } else { vec![] },
        delete: !update,
        rows: rows.iter().map(|r| (key_idx.iter().map(|&i| r[i].clone()).collect(), None)).collect(),
    });
    Ok(Planned { reverse: reverse.map(|r| r.join(";\n")), after, ..base })
}

/// Saves what ran (after it succeeded).
pub fn record(vault: &crate::appdb::AppDb, connection_id: &str, planned: Vec<Planned>) {
    let at = crate::appdb::now_ms();
    for p in planned {
        let entry = crate::appdb::JournalEntry {
            id: 0,
            connection_id: connection_id.to_owned(),
            at,
            statement: p.statement,
            target: p.target,
            rows: p.rows as i64,
            reverse: p.reverse,
            note: p.note,
            undone_at: None,
            after_state: p.after.and_then(|a| serde_json::to_string(&a).ok()),
        };
        if let Err(e) = vault.add_journal(&entry) {
            crate::redact::log(format!("could not record a change: {e}"));
        }
    }
}

fn begin(engine: Engine) -> &'static str {
    match engine {
        Engine::Mysql => "START TRANSACTION",
        Engine::Sqlserver => "BEGIN TRANSACTION",
        _ => "BEGIN",
    }
}

/// Runs a change's reverse SQL in one transaction. With `after` (what the change left), it
/// first checks, with the rows locked, that nothing changed them since: if something did,
/// nothing is undone and the error lists the newer changes.
pub async fn undo(session: &Session, reverse: &str, after: Option<&AfterState>) -> Result<()> {
    let tab = format!("__undo_{}", uuid::Uuid::new_v4().simple());
    let engine = session.engine();
    let result = async {
        session.execute_script(begin(engine), &tab).await?;
        if let Some(state) = after {
            let newer = match newer_changes(session, state, &tab).await {
                Ok(n) => n,
                Err(e) => {
                    let _ = session.execute_script("ROLLBACK", &tab).await;
                    return Err(e);
                }
            };
            if !newer.is_empty() {
                let _ = session.execute_script("ROLLBACK", &tab).await;
                let more = newer.len().saturating_sub(10);
                return Err(AppError::Invalid(format!(
                    "Not undone: the rows changed after this change, and undoing it would overwrite that.\n{}{}\nUndo the newer change first, or fix the rows by hand.",
                    newer.iter().take(10).map(|n| format!("• {n}")).collect::<Vec<_>>().join("\n"),
                    if more > 0 { format!("\n• …and {more} more") } else { String::new() }
                )));
            }
        }
        for statement in reverse.split(";\n").filter(|s| !s.trim().is_empty()) {
            if let Err(e) = session.execute_script(statement, &tab).await {
                let _ = session.execute_script("ROLLBACK", &tab).await;
                return Err(e);
            }
        }
        session.execute_script("COMMIT", &tab).await
    }
    .await;
    session.close_tab(&tab).await;
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub update: bool,
    pub target: String,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    pub before: Vec<Row>,
    /// UPDATE: the same rows afterwards (by key), in the same order.
    pub after: Vec<Row>,
    /// Rows the statement touches (more than are shown, past PREVIEW_LIMIT).
    pub total: u64,
}

/// Runs one UPDATE / DELETE inside a transaction that's always rolled back, and returns the
/// rows before and after. On a session of its own; engines with transactional DML only.
pub async fn preview(session: &Session, sql: &str) -> Result<Option<Preview>> {
    let engine = session.engine();
    if !matches!(engine, Engine::Postgres | Engine::Mysql | Engine::Sqlite | Engine::Sqlserver) {
        return Ok(None);
    }
    let (writes, writing) = writes(sql, engine);
    if writes.len() != 1 || writing != 1 {
        return Ok(None);
    }
    let w = &writes[0];
    let tab = format!("__preview_{}", uuid::Uuid::new_v4().simple());
    let result = async {
        let (schema, table) = match w.parts.as_slice() {
            [t] => (current_schema(session, Some(&tab)).await?, t.clone()),
            [.., s, t] => (s.clone(), t.clone()),
            [] => return Ok(None),
        };
        let keys: Vec<String> = session.columns(&schema, &table).await?.into_iter().filter(|c| c.primary_key).map(|c| c.name).collect();
        let where_ = w.selection.as_ref().map(|s| format!(" WHERE {s}")).unwrap_or_default();
        let (_, count) = collect(session, &format!("SELECT COUNT(*) FROM {}{where_}", w.from), Some(&tab), Some(1)).await?;
        let total = count.first().and_then(|r| r[0].as_deref()).and_then(|n| n.parse().ok()).unwrap_or(0);
        session.execute_script(begin(engine), &tab).await?;
        let inner = async {
            let (columns, before) = collect(session, &format!("SELECT * FROM {}{where_}", w.from), Some(&tab), Some(PREVIEW_LIMIT)).await?;
            session.execute_script(sql, &tab).await?;
            let key_idx: Vec<usize> = keys.iter().filter_map(|k| columns.iter().position(|c| c == k)).collect();
            let mut after = Vec::new();
            if w.update && !before.is_empty() && key_idx.len() == keys.len() && !keys.is_empty() {
                let target = qualified(engine, &schema, &table);
                // The same rows by key, read inside the uncommitted transaction.
                for chunk in before.chunks(200) {
                    let ors = chunk
                        .iter()
                        .map(|r| format!("({})", key_idx.iter().map(|&i| format!("{} = {}", ident(engine, &columns[i]), value(engine, &r[i]))).collect::<Vec<_>>().join(" AND ")))
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    let (_, rows) = collect(session, &format!("SELECT * FROM {target} WHERE {ors}"), Some(&tab), None).await?;
                    after.extend(rows);
                }
                // In `before` order.
                let key_of = |r: &Row| key_idx.iter().map(|&i| r[i].clone()).collect::<Vec<_>>();
                after.sort_by_key(|r| before.iter().position(|b| key_of(b) == key_of(r)).unwrap_or(usize::MAX));
            }
            Ok::<_, AppError>(Preview { update: w.update, target: format!("{schema}.{table}"), columns, key_columns: keys.clone(), before, after, total })
        }
        .await;
        // Never kept, whatever happened.
        let _ = session.execute_script("ROLLBACK", &tab).await;
        inner.map(Some)
    }
    .await;
    session.close_tab(&tab).await;
    result
}

/// Full scans of big tables in a SELECT's plan (Postgres, MySQL), as warnings.
pub async fn cost_risks(session: &Session, sql: &str) -> Vec<Risk> {
    let engine = session.engine();
    if !matches!(engine, Engine::Postgres | Engine::Mysql) {
        return vec![];
    }
    // Parsed up front: the parser isn't Send, so it can't live across the awaits below.
    let queries: Vec<String> = {
        let dialect = crate::dialect::parser(engine);
        let Ok(statements) = Parser::parse_sql(dialect.as_ref(), sql) else { return vec![] };
        statements.iter().filter(|s| matches!(s, Statement::Query(_))).map(|s| s.to_string()).collect()
    };
    let mut risks = Vec::new();
    for text in queries {
        let explain = if engine == Engine::Postgres { format!("EXPLAIN (FORMAT JSON) {text}") } else { format!("EXPLAIN FORMAT=JSON {text}") };
        // Best effort, and quick: a slow or failing EXPLAIN never blocks the query.
        let Ok(Ok((_, rows))) = tokio::time::timeout(std::time::Duration::from_millis(1500), session.admin_rows(&explain)).await else { continue };
        let Some(json) = rows.first().and_then(|r| r.first().cloned().flatten()) else { continue };
        let Ok(plan) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        let mut scans = Vec::new();
        if engine == Engine::Postgres {
            pg_scans(&plan, &mut scans);
        } else {
            mysql_scans(&plan, &mut scans);
        }
        for (table, rows) in scans {
            let estimate = if engine == Engine::Postgres { pg_table_rows(session, &table).await.unwrap_or(rows) } else { rows };
            if estimate >= BIG_TABLE {
                risks.push(Risk {
                    statement: text.chars().take(300).collect(),
                    reason: format!("reads all ~{} rows of {table} (no index used): it can be slow and load the server", compact(estimate)),
                });
            }
        }
    }
    risks
}

fn compact(n: f64) -> String {
    if n >= 1e9 { format!("{:.1}B", n / 1e9) } else if n >= 1e6 { format!("{:.1}M", n / 1e6) } else { format!("{:.0}K", n / 1e3) }
}

/// Seq Scan nodes: (relation, planned rows).
fn pg_scans(v: &serde_json::Value, out: &mut Vec<(String, f64)>) {
    match v {
        serde_json::Value::Array(items) => items.iter().for_each(|i| pg_scans(i, out)),
        serde_json::Value::Object(o) => {
            if o.get("Node Type").and_then(|t| t.as_str()) == Some("Seq Scan")
                && let Some(rel) = o.get("Relation Name").and_then(|r| r.as_str())
            {
                out.push((rel.to_owned(), o.get("Plan Rows").and_then(|r| r.as_f64()).unwrap_or(0.0)));
            }
            o.values().for_each(|i| pg_scans(i, out));
        }
        _ => {}
    }
}

async fn pg_table_rows(session: &Session, table: &str) -> Option<f64> {
    let (_, rows) = session.admin_rows(&format!("SELECT max(reltuples)::float8 FROM pg_class WHERE relname = {} AND relkind = 'r'", literal(Engine::Postgres, table))).await.ok()?;
    rows.first()?.first()?.as_deref()?.parse().ok()
}

/// Tables read with access_type ALL: (table, rows examined).
fn mysql_scans(v: &serde_json::Value, out: &mut Vec<(String, f64)>) {
    match v {
        serde_json::Value::Array(items) => items.iter().for_each(|i| mysql_scans(i, out)),
        serde_json::Value::Object(o) => {
            if o.get("access_type").and_then(|t| t.as_str()) == Some("ALL") {
                let table = o.get("table_name").and_then(|t| t.as_str()).unwrap_or("?").to_owned();
                let rows = o.get("rows_examined_per_scan").and_then(|r| r.as_f64().or_else(|| r.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0);
                out.push((table, rows));
            }
            o.values().for_each(|i| mysql_scans(i, out));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_single_table_writes() {
        let (w, n) = writes("UPDATE shop.orders o SET status = 'x', note = NULL WHERE o.id > 3; DELETE FROM users WHERE id = 1; INSERT INTO t VALUES (1)", Engine::Postgres);
        assert_eq!(n, 3);
        assert_eq!(w[0].parts, ["shop", "orders"]);
        assert_eq!(w[0].from, "shop.orders o");
        assert_eq!(w[0].assigned, ["status", "note"]);
        assert_eq!(w[0].selection.as_deref(), Some("o.id > 3"));
        assert!(!w[1].update && w[1].parts == ["users"]);
        let (w, n) = writes("UPDATE a JOIN b ON a.id = b.id SET a.x = 1", Engine::Mysql);
        assert_eq!((w.len(), n), (0, 1), "joins aren't captured");
    }

    #[test]
    fn reads_plans() {
        let pg: serde_json::Value = serde_json::from_str(r#"[{"Plan":{"Node Type":"Hash Join","Plans":[{"Node Type":"Seq Scan","Relation Name":"orders","Plan Rows":500000},{"Node Type":"Index Scan","Relation Name":"users"}]}}]"#).unwrap();
        let mut scans = vec![];
        pg_scans(&pg, &mut scans);
        assert_eq!(scans, [("orders".to_owned(), 500000.0)]);
        let my: serde_json::Value = serde_json::from_str(r#"{"query_block":{"table":{"table_name":"events","access_type":"ALL","rows_examined_per_scan":995117}}}"#).unwrap();
        let mut scans = vec![];
        mysql_scans(&my, &mut scans);
        assert_eq!(scans, [("events".to_owned(), 995117.0)]);
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test journal`: capture, undo and preview on scratch tables.
    #[tokio::test]
    async fn undoes_and_previews_on_dev_databases() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let t = format!("onyx_journal_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, name varchar(20), plan varchar(10))")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'Ann', 'pro'), (2, 'Bo', 'free'), (3, 'it''s', 'free')")).await.unwrap();

            // Preview: rolled back, so nothing changes.
            let p = preview(&session, &format!("UPDATE {t} SET plan = 'pro' WHERE plan = 'free'")).await.unwrap().unwrap();
            assert_eq!((p.total, p.before.len(), p.after.len()), (2, 2, 2));
            assert!(p.after.iter().all(|r| r[2].as_deref() == Some("pro")));
            let (_, still) = session.admin_rows(&format!("SELECT count(*) FROM {t} WHERE plan = 'free'")).await.unwrap();
            assert_eq!(still[0][0].as_deref(), Some("2"), "{engine:?}: the preview kept nothing");

            // Capture, run, undo.
            let update = format!("UPDATE {t} SET name = 'X', plan = NULL WHERE id >= 2");
            let planned = plan(&session, &update, None).await;
            assert_eq!(planned[0].rows, 2);
            session.execute_meta(&update).await.unwrap();
            undo(&session, planned[0].reverse.as_deref().unwrap(), None).await.unwrap();
            let (_, rows) = session.admin_rows(&format!("SELECT name, plan FROM {t} ORDER BY id")).await.unwrap();
            assert_eq!(rows[2], [Some("it's".into()), Some("free".into())], "{engine:?}");

            let delete = format!("DELETE FROM {t} WHERE id = 1");
            let planned = plan(&session, &delete, None).await;
            session.execute_meta(&delete).await.unwrap();
            undo(&session, planned[0].reverse.as_deref().unwrap(), None).await.unwrap();
            let (_, rows) = session.admin_rows(&format!("SELECT count(*) FROM {t}")).await.unwrap();
            assert_eq!(rows[0][0].as_deref(), Some("3"));
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }
}

#[cfg(test)]
mod regression {
    use super::*;

    /// Runs `sql` the way the app does: plan, run, record what it left.
    async fn journaled(session: &Session, sql: &str) -> Planned {
        let mut planned = plan(session, sql, None).await;
        session.execute_meta(sql).await.unwrap();
        capture_after(session, &mut planned, None).await;
        planned.remove(0)
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test regression`: pending → base → later, then
    /// undoing the older change is refused (it would overwrite "later"); undoing in order works.
    #[tokio::test]
    async fn undo_refuses_to_overwrite_newer_changes() {
        for engine in [crate::connections::Engine::Postgres, crate::connections::Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let t = format!("onyx_undo_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, status varchar(30))")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'pending'), (2, 'gone')")).await.unwrap();
            let status = || {
                let (s, t) = (&session, t.clone());
                async move { collect(s, &format!("SELECT status FROM {t} WHERE id = 1"), None, None).await.unwrap().1[0][0].clone() }
            };
            let first = journaled(&session, &format!("UPDATE {t} SET status = 'e2e_undo_base' WHERE id = 1")).await;
            let second = journaled(&session, &format!("UPDATE {t} SET status = 'e2e_later_value' WHERE id = 1")).await;
            let a = first.after.clone().unwrap();
            let err = undo(&session, first.reverse.as_deref().unwrap(), Some(&a)).await.unwrap_err().to_string();
            assert!(err.contains("status is now 'e2e_later_value' (this change left 'e2e_undo_base')"), "{engine:?}: {err}");
            assert_eq!(status().await.as_deref(), Some("e2e_later_value"), "{engine:?}: nothing overwritten");
            // Newest first, then the older one: both fine.
            undo(&session, second.reverse.as_deref().unwrap(), second.after.as_ref()).await.unwrap();
            undo(&session, first.reverse.as_deref().unwrap(), Some(&a)).await.unwrap();
            assert_eq!(status().await.as_deref(), Some("pending"));

            // A deleted row that's back again isn't silently duplicated or overwritten.
            let delete = journaled(&session, &format!("DELETE FROM {t} WHERE id = 2")).await;
            session.execute_meta(&format!("INSERT INTO {t} VALUES (2, 'recreated')")).await.unwrap();
            let err = undo(&session, delete.reverse.as_deref().unwrap(), delete.after.as_ref()).await.unwrap_err().to_string();
            assert!(err.contains("id = 2 exists again"), "{engine:?}: {err}");
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test batch`: two UPDATEs of the same row in one
    /// run (Run all) are one journal entry; undo restores what the row held before the batch, and
    /// refuses once something changed it after the batch.
    #[tokio::test]
    async fn batch_of_writes_to_one_table_undoes_as_one() {
        for engine in [crate::connections::Engine::Postgres, crate::connections::Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let t = format!("onyx_undo_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, status varchar(30), n int)")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'pending', 0), (2, 'other', 0)")).await.unwrap();
            let row = || {
                let (s, t) = (&session, t.clone());
                async move { collect(s, &format!("SELECT status, n FROM {t} WHERE id = 1"), None, None).await.unwrap().1[0].clone() }
            };
            // The second statement only matches the row after the first has changed it.
            let batch = format!("UPDATE {t} SET status = 'step1' WHERE id = 1; UPDATE {t} SET n = 7 WHERE status = 'step1'");
            let mut planned = plan(&session, &batch, None).await;
            assert_eq!(planned.len(), 1, "{engine:?}: one entry for the table");
            session.execute_meta(&batch).await.unwrap();
            capture_after(&session, &mut planned, None).await;
            let entry = planned.remove(0);
            assert_eq!(row().await, vec![Some("step1".into()), Some("7".into())]);

            session.execute_meta(&format!("UPDATE {t} SET n = 8 WHERE id = 1")).await.unwrap();
            let err = undo(&session, entry.reverse.as_deref().unwrap(), entry.after.as_ref()).await.unwrap_err().to_string();
            assert!(err.contains("n is now '8' (this change left '7')"), "{engine:?}: {err}");
            assert_eq!(row().await, vec![Some("step1".into()), Some("8".into())], "{engine:?}: nothing overwritten");

            session.execute_meta(&format!("UPDATE {t} SET n = 7 WHERE id = 1")).await.unwrap();
            undo(&session, entry.reverse.as_deref().unwrap(), entry.after.as_ref()).await.unwrap();
            assert_eq!(row().await, vec![Some("pending".into()), Some("0".into())], "{engine:?}: back to before the batch");
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }

    /// `ONYX_TEST_PG=1 cargo test explain_regression`: EXPLAIN (FORMAT JSON) of a grouped query
    /// comes back as one complete JSON document.
    #[tokio::test]
    async fn grouped_query_plan_is_complete_json() {
        let Some(config) = crate::db::edit_integration::config(crate::connections::Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let schema = format!("onyx_explain_{}", uuid::Uuid::new_v4().simple());
        session
            .execute_meta(&format!(
                "CREATE SCHEMA {schema}; CREATE TABLE {schema}.events (id int PRIMARY KEY, bucket text); \
                 INSERT INTO {schema}.events SELECT g, 'b' || (g % 37) FROM generate_series(1, 30000) g; ANALYZE {schema}.events;"
            ))
            .await
            .unwrap();
        for analyze in ["", ", ANALYZE, BUFFERS"] {
            let sql = format!(
                "EXPLAIN (FORMAT JSON{analyze}) SELECT bucket, count(*) AS event_count FROM {schema}.events WHERE id <= 20000 GROUP BY bucket ORDER BY bucket LIMIT 20"
            );
            let (cols, rows) = collect(&session, &sql, Some("tab-x"), Some(100_000)).await.unwrap();
            eprintln!("{cols:?} rows={} lens={:?}", rows.len(), rows.iter().map(|r| r[0].as_ref().map(|s| s.len())).collect::<Vec<_>>());
            let text: String = rows.iter().map(|r| r[0].clone().unwrap_or_default()).collect::<Vec<_>>().join("\n");
            serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|e| panic!("{e}: {}", &text[..text.len().min(300)]));
        }
        session.execute_meta(&format!("DROP SCHEMA {schema} CASCADE")).await.unwrap();
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test regression`: a tab's transaction stays its
    /// own until it ends, and ROLLBACK puts the value back.
    #[tokio::test]
    async fn tab_transactions_roll_back() {
        for engine in [crate::connections::Engine::Postgres, crate::connections::Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let t = format!("onyx_tx_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v text)")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'before')")).await.unwrap();
            let value = |tab: Option<&'static str>| {
                let (session, t) = (&session, t.clone());
                async move { collect(session, &format!("SELECT v FROM {t} WHERE id = 1"), tab, None).await.unwrap().1[0][0].clone() }
            };
            let begin = if engine == crate::connections::Engine::Mysql { "START TRANSACTION" } else { "BEGIN" };
            collect(&session, begin, Some("tab-a"), None).await.unwrap();
            collect(&session, &format!("UPDATE {t} SET v = 'during' WHERE id = 1"), Some("tab-a"), None).await.unwrap();
            assert_eq!(value(Some("tab-a")).await.as_deref(), Some("during"), "{engine:?}: the tab sees its change");
            assert_eq!(value(Some("tab-b")).await.as_deref(), Some("before"), "{engine:?}: other tabs don't");
            collect(&session, "ROLLBACK", Some("tab-a"), None).await.unwrap();
            assert_eq!(value(Some("tab-a")).await.as_deref(), Some("before"), "{engine:?}: rolled back");
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }

    /// `ONYX_TEST_PG=1 cargo test regression`: when a tab's connection dies mid-transaction,
    /// the next run says so instead of quietly running outside the transaction.
    #[tokio::test]
    async fn lost_tab_connection_is_reported_once() {
        let Some(config) = crate::db::edit_integration::config(crate::connections::Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        collect(&session, "BEGIN", Some("tab-lost"), None).await.unwrap();
        let (_, rows) = collect(&session, "SELECT pg_backend_pid()", Some("tab-lost"), None).await.unwrap();
        let pid = rows[0][0].clone().unwrap();
        // The server ends that session (as a restart or a network drop would).
        session.execute_meta(&format!("SELECT pg_terminate_backend({pid})")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // The first run after it says the connection was lost, and runs nothing.
        let first = collect(&session, "SELECT 1", Some("tab-lost"), None).await;
        let message = first.expect_err("a run on the dead connection must not succeed").to_string();
        assert!(message.contains("connection to the server was lost") || message.contains("closed"), "{message}");
        if !message.contains("connection to the server was lost") {
            let second = collect(&session, "SELECT 1", Some("tab-lost"), None).await;
            assert!(second.unwrap_err().to_string().contains("connection to the server was lost"));
        }
        // Then the tab carries on, on a new connection (outside any transaction).
        assert!(collect(&session, "SELECT 1", Some("tab-lost"), None).await.is_ok());
    }

    /// `ONYX_TEST_PG=1 cargo test regression`: the race lab's premise. A statement waiting for a
    /// lock on one tab's session doesn't block another tab's COMMIT; the lost update reproduces
    /// under the schedule, and the atomic increment passes the same schedule.
    #[tokio::test]
    async fn race_lab_reproduces_a_lost_update() {
        let Some(config) = crate::db::edit_integration::config(crate::connections::Engine::Postgres) else { return };
        let session = std::sync::Arc::new(Session::connect(&config, None, None).await.unwrap());
        let t = format!("onyx_race_{}", uuid::Uuid::new_v4().simple());
        for (a_update, b_update, expected) in [("balance = 110", "balance = 120", "120"), ("balance = balance + 10", "balance = balance + 20", "130")] {
            session.execute_meta(&format!("DROP TABLE IF EXISTS {t}; CREATE TABLE {t} (id int PRIMARY KEY, balance int); INSERT INTO {t} VALUES (1, 100)")).await.unwrap();
            let run = |tab: &'static str, sql: String| {
                let s = session.clone();
                async move { collect(&s, &sql, Some(tab), None).await.map(|r| r.1) }
            };
            // A1 A2 B1 B2 A3
            run("race-a", "BEGIN".into()).await.unwrap();
            run("race-a", format!("SELECT balance FROM {t} WHERE id = 1")).await.unwrap();
            run("race-b", "BEGIN".into()).await.unwrap();
            run("race-b", format!("SELECT balance FROM {t} WHERE id = 1")).await.unwrap();
            run("race-a", format!("UPDATE {t} SET {a_update} WHERE id = 1")).await.unwrap();
            // B3 waits on A's row lock…
            let b3 = tokio::spawn(run("race-b", format!("UPDATE {t} SET {b_update} WHERE id = 1")));
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(!b3.is_finished(), "B3 should be waiting for A's lock");
            // …A4 still runs on its own session and releases it.
            tokio::time::timeout(std::time::Duration::from_secs(5), run("race-a", "COMMIT".into())).await.expect("A's COMMIT must not wait for B").unwrap();
            b3.await.unwrap().unwrap();
            run("race-b", "COMMIT".into()).await.unwrap();
            let (_, rows) = collect(&session, &format!("SELECT balance FROM {t} WHERE id = 1"), None, None).await.unwrap();
            assert_eq!(rows[0][0].as_deref(), Some(expected), "{a_update} / {b_update}");
            session.close_tab("race-a").await;
            session.close_tab("race-b").await;
        }
        session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
    }
}
