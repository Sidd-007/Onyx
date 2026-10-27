//! F18: shrink a failing database example into a smaller one that still fails. The chosen
//! tables are copied (with their constraints and the foreign keys between them) into a scratch
//! schema; rows are removed in chunks inside savepoints, keeping a removal only when the
//! failure still reproduces. The source is never touched, and the result is checked again
//! from a clean copy. Data reduction only: the SQL itself isn't simplified.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::Session;
use crate::dialect::ident;
use crate::error::{AppError, Result};
use crate::journal::collect;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkSpec {
    pub schema: String,
    pub tables: Vec<String>,
    /// The failing query (unqualified table names: it runs against the copy).
    pub query: String,
    /// Fails when the query's rows differ from this one's (empty: use `expect`).
    pub other: String,
    /// Fails when the query's first value isn't this.
    pub expect: String,
    pub row_cap: i64,
    pub max_trials: usize,
    pub max_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkResult {
    pub scratch: String,
    /// (table, rows before, rows after)
    pub tables: Vec<(String, i64, i64)>,
    pub trials: usize,
    pub seconds: f64,
    pub stopped: bool,
    /// The last kept state was checked again in a fresh copy.
    pub verified_clean: bool,
    pub notes: Vec<String>,
}

fn stops() -> &'static Mutex<HashSet<String>> {
    static S: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn stop(id: &str) {
    stops().lock().unwrap().insert(id.to_owned());
}

fn q(s: &str) -> String {
    ident(Engine::Postgres, s)
}

/// The failure predicate: true when the example still fails.
async fn fails(session: &Session, tab: &str, spec: &ShrinkSpec) -> Result<bool> {
    let mut a = collect(session, &spec.query, Some(tab), Some(200_000)).await?.1;
    if spec.other.trim().is_empty() {
        let first = a.first().and_then(|r| r.first().cloned().flatten());
        return Ok(first.as_deref() != Some(spec.expect.trim()));
    }
    let mut b = collect(session, &spec.other, Some(tab), Some(200_000)).await?.1;
    a.sort();
    b.sort();
    Ok(a != b)
}

async fn count(session: &Session, tab: &str, table: &str) -> Result<i64> {
    Ok(collect(session, &format!("SELECT count(*) FROM {}", q(table)), Some(tab), Some(1)).await?.1[0][0].as_deref().and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// Copies the tables (constraints, then foreign keys among them) into `scratch`.
#[allow(clippy::too_many_arguments)]
async fn copy(session: &Session, tab: &str, from: &str, scratch: &str, tables: &[String], cap: Option<i64>, fks: &[crate::db::model::ForeignKeyRef], notes: &mut Vec<String>) -> Result<()> {
    session.execute_script(&format!("CREATE SCHEMA {}", q(scratch)), tab).await?;
    for t in tables {
        session.execute_script(&format!("CREATE TABLE {s}.{t} (LIKE {f}.{t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING GENERATED)", s = q(scratch), f = q(from), t = q(t)), tab).await?;
        let limit = cap.map(|c| format!(" LIMIT {c}")).unwrap_or_default();
        session.execute_script(&format!("INSERT INTO {s}.{t} SELECT * FROM {f}.{t}{limit}", s = q(scratch), f = q(from), t = q(t)), tab).await?;
    }
    for fk in fks.iter().filter(|k| k.schema == from && k.key.ref_schema == from && tables.contains(&k.table) && tables.contains(&k.key.ref_table)) {
        let cols = fk.key.columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
        let refs = fk.key.ref_columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
        let sql = format!("ALTER TABLE {s}.{} ADD FOREIGN KEY ({cols}) REFERENCES {s}.{} ({refs})", q(&fk.table), q(&fk.key.ref_table), s = q(scratch));
        session.execute_script("SAVEPOINT onyx_fk", tab).await?;
        if let Err(e) = session.execute_script(&sql, tab).await {
            session.execute_script("ROLLBACK TO SAVEPOINT onyx_fk", tab).await?;
            notes.push(format!("Foreign key {} → {} not kept: the copied rows don't satisfy it ({e}). Raise the row cap to copy all parents.", fk.table, fk.key.ref_table));
        } else {
            session.execute_script("RELEASE SAVEPOINT onyx_fk", tab).await?;
        }
    }
    Ok(())
}

fn send(events: &Channel<InvokeResponseBody>, line: String) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "log", "line": line }).to_string()));
}

pub async fn run(session: &Session, id: &str, spec: &ShrinkSpec, events: &Channel<InvokeResponseBody>) -> Result<ShrinkResult> {
    if session.engine() != Engine::Postgres {
        return Err(AppError::Invalid("Shrinking works on PostgreSQL".into()));
    }
    if spec.tables.is_empty() {
        return Err(AppError::Invalid("Pick the tables the failing query uses".into()));
    }
    let read = |sql: &str| {
        let t = sql.trim().trim_end_matches(';').to_lowercase();
        (t.starts_with("select") || t.starts_with("with")) && !t.contains(';')
    };
    if !read(&spec.query) || (!spec.other.trim().is_empty() && !read(&spec.other)) {
        return Err(AppError::Invalid("The queries must only read".into()));
    }
    stops().lock().unwrap().remove(id);
    let started = Instant::now();
    let scratch = format!("onyx_shrink_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let tab = format!("shrink:{id}");
    let fks = session.all_foreign_keys().await?;
    let mut notes = Vec::new();
    let mut trials = 0usize;
    let mut stopped = false;
    let result: Result<Vec<(String, i64, i64)>> = async {
        session.execute_script("BEGIN", &tab).await?;
        copy(session, &tab, &spec.schema, &scratch, &spec.tables, Some(spec.row_cap.max(1)), &fks, &mut notes).await?;
        session.execute_script(&format!("SET LOCAL search_path TO {}", q(&scratch)), &tab).await?;
        // The failure has to reproduce, and the same way every time.
        let first = fails(session, &tab, spec).await?;
        let second = fails(session, &tab, spec).await?;
        if first != second {
            return Err(AppError::Invalid("The check gives different answers on the same data (nondeterministic): shrinking would chase noise. Add an ORDER BY or remove volatile functions.".into()));
        }
        if !first {
            return Err(AppError::Invalid(format!("The failure doesn't reproduce on the copy (first {} rows of each table). Raise the row cap, or check the queries name tables without a schema.", spec.row_cap)));
        }
        let before: Vec<i64> = {
            let mut v = Vec::new();
            for t in &spec.tables {
                v.push(count(session, &tab, t).await?);
            }
            v
        };
        // Children before parents: a parent row still referenced can't go anyway.
        let mut order = spec.tables.clone();
        order.sort_by_key(|t| fks.iter().filter(|k| &k.key.ref_table == t && spec.tables.contains(&k.table)).count());
        let budget_left = |trials: usize| trials < spec.max_trials && started.elapsed().as_secs() < spec.max_seconds;
        'tables: for t in &order {
            let mut chunks = 2usize;
            loop {
                let (_, rows) = collect(session, &format!("SELECT ctid::text FROM {}", q(t)), Some(&tab), None).await?;
                let ctids: Vec<String> = rows.into_iter().filter_map(|r| r[0].clone()).collect();
                if ctids.is_empty() {
                    break;
                }
                let size = ctids.len().div_ceil(chunks).max(1);
                let mut removed_any = false;
                for chunk in ctids.chunks(size) {
                    if stops().lock().unwrap().remove(id) {
                        stopped = true;
                        break 'tables;
                    }
                    if !budget_left(trials) {
                        notes.push("Stopped at the trial or time budget: the result is smaller, not necessarily minimal.".into());
                        break 'tables;
                    }
                    trials += 1;
                    session.execute_script("SAVEPOINT onyx_try", &tab).await?;
                    let list = chunk.iter().map(|c| format!("'{c}'::tid")).collect::<Vec<_>>().join(", ");
                    let deleted = session.execute_script(&format!("DELETE FROM {} WHERE ctid IN ({list})", q(t)), &tab).await;
                    // A foreign key refused it, or the failure is gone without these rows: put them back.
                    let keep = match deleted {
                        Ok(()) => fails(session, &tab, spec).await.unwrap_or(false),
                        Err(_) => false,
                    };
                    if keep {
                        session.execute_script("RELEASE SAVEPOINT onyx_try", &tab).await?;
                        removed_any = true;
                    } else {
                        session.execute_script("ROLLBACK TO SAVEPOINT onyx_try", &tab).await?;
                    }
                }
                let remaining = count(session, &tab, t).await?;
                send(events, format!("{t}: {remaining} rows left after {trials} trials"));
                if !removed_any {
                    if chunks >= remaining as usize {
                        break;
                    }
                    chunks = (chunks * 2).min(remaining.max(1) as usize);
                } else {
                    chunks = 2.max(chunks / 2);
                }
            }
        }
        let mut out = Vec::new();
        for (t, b) in spec.tables.iter().zip(before) {
            out.push((t.clone(), b, count(session, &tab, t).await?));
        }
        session.execute_script("COMMIT", &tab).await?;
        Ok(out)
    }
    .await;
    let tables = match result {
        Ok(t) => t,
        Err(e) => {
            let _ = session.execute_script("ROLLBACK", &tab).await;
            session.close_tab(&tab).await;
            return Err(e);
        }
    };
    // Again from a clean copy of what's left: it must still fail.
    let clean = format!("{scratch}_check");
    let verified_clean = async {
        session.execute_script("BEGIN", &tab).await?;
        copy(session, &tab, &scratch, &clean, &spec.tables, None, &[], &mut Vec::new()).await?;
        session.execute_script(&format!("SET LOCAL search_path TO {}", q(&clean)), &tab).await?;
        let f = fails(session, &tab, spec).await?;
        session.execute_script("ROLLBACK", &tab).await?;
        Ok::<_, AppError>(f)
    }
    .await
    .unwrap_or(false);
    session.close_tab(&tab).await;
    Ok(ShrinkResult { scratch, tables, trials, seconds: started.elapsed().as_secs_f64(), stopped, verified_clean, notes })
}

/// The reduced fixture as a script that reproduces the failure on its own: a new schema of
/// its own (nothing existing is touched), the tables with their keys, checks, enums and
/// indexes, the rows, the foreign keys, and the check itself, which prints REPRODUCED or not.
pub async fn export(session: &Session, scratch: &str, spec: &ShrinkSpec) -> Result<String> {
    let tab = format!("shrink-export:{scratch}");
    let out = script(session, &tab, scratch, spec).await;
    session.close_tab(&tab).await;
    out
}

async fn script(session: &Session, tab: &str, scratch: &str, spec: &ShrinkSpec) -> Result<String> {
    let lit = |v: &str| crate::dialect::literal(Engine::Postgres, v);
    let rows = |sql: String| async move { collect(session, &sql, Some(tab), None).await.map(|r| r.1) };
    let text = |r: &[Option<String>], i: usize| r.get(i).cloned().flatten().unwrap_or_default();
    // Constraint and index definitions come out unqualified for tables in the search path.
    collect(session, &format!("SET search_path TO {}", q(scratch)), Some(tab), None).await?;
    let env = rows("SELECT current_setting('server_version'), current_setting('TimeZone'), current_setting('DateStyle'), (SELECT datcollate FROM pg_database WHERE datname = current_database())".into()).await?;
    let env = env.first().cloned().unwrap_or_default();
    let target = format!("onyx_repro_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let fails_when = if spec.other.trim().is_empty() { format!("its first value isn't {}", spec.expect.trim()) } else { format!("its rows differ from: {}", one_line(&spec.other)) };
    let mut out = vec![
        format!("-- Onyx: a smaller reproducer, made from schema {} on PostgreSQL {}.", spec.schema, text(&env, 0)),
        format!("-- The query: {}", one_line(&spec.query)),
        format!("-- Fails when: {fails_when}"),
        format!("-- Made with TimeZone {}, DateStyle {}, collation {}.", text(&env, 1), text(&env, 2), text(&env, 3)),
        format!("-- Everything goes into a new schema, {target}; nothing else is touched. Run it with psql -f, read the"),
        "-- outcome at the end, and DROP SCHEMA it CASCADE when done.".into(),
        String::new(),
        "BEGIN;".into(),
        format!("CREATE SCHEMA {};", q(&target)),
        format!("SET LOCAL search_path TO {};", q(&target)),
        format!("SET LOCAL TimeZone TO {};", lit(&text(&env, 1))),
        format!("SET LOCAL DateStyle TO {};", lit(&text(&env, 2))),
    ];
    let mut notes: Vec<String> = Vec::new();
    let mut enums: Vec<String> = Vec::new();
    let mut tables: Vec<String> = Vec::new();
    let mut inserts: Vec<String> = Vec::new();
    let mut fks: Vec<String> = Vec::new();
    for t in &spec.tables {
        let rel = lit(&format!("{}.{}", q(scratch), q(t)));
        for e in rows(format!(
            "SELECT DISTINCT t.typname::text, (SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid)
             FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
             WHERE a.attrelid = {rel}::regclass AND a.attnum > 0 AND NOT a.attisdropped AND t.typtype = 'e'"
        ))
        .await?
        {
            let def = format!("CREATE TYPE {} AS ENUM ({});", q(&text(&e, 0)), text(&e, 1));
            if !enums.contains(&def) {
                enums.push(def);
            }
        }
        let columns = rows(format!(
            "SELECT a.attname::text, CASE WHEN t.typtype = 'e' THEN quote_ident(t.typname) ELSE format_type(a.atttypid, a.atttypmod) END,
                    a.attnotnull::text, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text
             FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = {rel}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
        ))
        .await?;
        let mut lines = Vec::new();
        let mut stored = Vec::new();
        for c in &columns {
            let name = text(c, 0);
            let mut line = format!("  {} {}", q(&name), text(c, 1));
            let default = text(c, 3);
            if text(c, 5) == "s" {
                line += &format!(" GENERATED ALWAYS AS ({default}) STORED");
            } else {
                stored.push(name.clone());
                if !text(c, 4).is_empty() {
                    line += " GENERATED BY DEFAULT AS IDENTITY";
                } else if default.contains("nextval(") {
                    notes.push(format!("{t}.{name}: its sequence default is left out (the rows carry their values)"));
                } else if !default.is_empty() {
                    line += &format!(" DEFAULT {default}");
                }
            }
            if text(c, 2) == "true" {
                line += " NOT NULL";
            }
            lines.push(line);
        }
        for k in rows(format!("SELECT conname::text, contype::text, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = {rel}::regclass ORDER BY contype, conname")).await? {
            let def = format!("CONSTRAINT {} {}", q(&text(&k, 0)), text(&k, 2));
            // Foreign keys go in after the rows, so the insert order doesn't matter.
            if text(&k, 1) == "f" {
                fks.push(format!("ALTER TABLE {} ADD {def};", q(t)));
            } else {
                lines.push(format!("  {def}"));
            }
        }
        tables.push(format!("CREATE TABLE {} (\n{}\n);", q(t), lines.join(",\n")));
        for i in rows(format!("SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix WHERE ix.indrelid = {rel}::regclass AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid) ORDER BY 1")).await? {
            tables.push(format!("{};", text(&i, 0)));
        }
        let cols = stored.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
        for r in rows(format!("SELECT {cols} FROM {}.{}", q(scratch), q(t))).await? {
            let values = r.iter().map(|v| v.as_ref().map_or("NULL".into(), |v| lit(v))).collect::<Vec<_>>().join(", ");
            inserts.push(format!("INSERT INTO {} ({cols}) VALUES ({values});", q(t)));
        }
    }
    out.extend(enums);
    out.push(String::new());
    out.extend(tables);
    out.push(String::new());
    out.extend(inserts);
    if !fks.is_empty() {
        out.push(String::new());
        out.extend(fks);
    }
    let query = spec.query.trim().trim_end_matches(';');
    if [&spec.query, &spec.other].iter().any(|t| t.contains(&format!("{}.", spec.schema)) || t.contains(&format!("{}.", q(&spec.schema)))) {
        notes.push(format!("the check names schema {} directly: change it to {target} (or leave the schema out) so it reads these rows", spec.schema));
    }
    out.push(String::new());
    out.push(format!("-- The check: REPRODUCED when {fails_when}."));
    if spec.other.trim().is_empty() {
        let got = format!("(SELECT (SELECT value FROM json_each_text(row_to_json(q)) LIMIT 1) FROM ({query}) q LIMIT 1)");
        let expect = lit(spec.expect.trim());
        out.push(format!("SELECT CASE WHEN {got} IS DISTINCT FROM {expect} THEN 'REPRODUCED' ELSE 'not reproduced' END AS outcome, {got} AS got, {expect} AS expected;"));
    } else {
        let other = spec.other.trim().trim_end_matches(';');
        out.push(format!("SELECT CASE WHEN EXISTS (({query}) EXCEPT ALL ({other})) OR EXISTS (({other}) EXCEPT ALL ({query})) THEN 'REPRODUCED' ELSE 'not reproduced' END AS outcome;"));
    }
    out.push("COMMIT;".into());
    if !notes.is_empty() {
        out.push(String::new());
        out.extend(notes.iter().map(|n| format!("-- Note: {n}")));
    }
    Ok(out.join("\n") + "\n")
}

pub async fn drop(session: &Session, scratch: &str) -> Result<()> {
    if !scratch.starts_with("onyx_shrink_") {
        return Err(AppError::Invalid("Only Onyx's own scratch schemas can be dropped here".into()));
    }
    session.execute_meta(&format!("DROP SCHEMA IF EXISTS {} CASCADE", q(scratch))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ONYX_TEST_PG=1 cargo test shrink`: 500 orders, one of them has a negative total that
    /// makes "every order total is positive" fail; shrinking keeps that order (and the customer
    /// its foreign key needs) and little else, verified from a clean copy. The source is untouched.
    #[tokio::test]
    async fn shrinks_while_the_failure_reproduces() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let s = format!("onyx_src_{}", uuid::Uuid::new_v4().simple());
        session
            .execute_meta(&format!(
                "CREATE SCHEMA {s};
                 CREATE TABLE {s}.customers (id int PRIMARY KEY, name text);
                 CREATE TABLE {s}.orders (id int PRIMARY KEY, customer_id int REFERENCES {s}.customers(id), total int);
                 INSERT INTO {s}.customers SELECT g, 'c' || g FROM generate_series(1, 50) g;
                 INSERT INTO {s}.orders SELECT g, 1 + g % 50, CASE WHEN g = 333 THEN -5 ELSE g END FROM generate_series(1, 500) g;"
            ))
            .await
            .unwrap();
        let spec = ShrinkSpec { schema: s.clone(), tables: vec!["customers".into(), "orders".into()], query: "SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total < 0".into(), other: String::new(), expect: "0".into(), row_cap: 10_000, max_trials: 500, max_seconds: 60 };
        let (events, _) = crate::db::stream::testing::recorder();
        let r = run(&session, "t1", &spec, &events).await.unwrap();
        let after = |t: &str| r.tables.iter().find(|x| x.0 == t).unwrap().2;
        assert_eq!((after("orders"), after("customers")), (1, 1), "{r:?}");
        assert!(r.verified_clean);
        let sql = export(&session, &r.scratch, &spec).await.unwrap();
        assert!(sql.contains("-5"), "{sql}");
        assert!(sql.contains("CREATE TABLE \"orders\"") && sql.contains("PRIMARY KEY") && sql.contains("FOREIGN KEY"), "{sql}");
        // On its own (a fresh schema of its own), the script reproduces the failure.
        let target = sql.split("CREATE SCHEMA \"").nth(1).unwrap().split('"').next().unwrap().to_owned();
        let (channel, log) = crate::db::stream::testing::recorder();
        session.run(&sql, &channel).await.unwrap();
        assert!(!format!("{:?}", log.lock().unwrap()).contains("\"error\""));
        let (_, outcome) = collect(&session, &format!("SELECT count(*) FROM {target}.orders WHERE total < 0"), None, None).await.unwrap();
        assert_eq!(outcome[0][0].as_deref(), Some("1"));
        let check = sql.lines().find(|l| l.starts_with("SELECT CASE")).unwrap().replace("FROM (SELECT count(*) FROM orders", &format!("FROM (SELECT count(*) FROM {target}.orders")).replace("JOIN customers", &format!("JOIN {target}.customers"));
        let (_, got) = collect(&session, &check, None, None).await.unwrap();
        assert_eq!(got[0][0].as_deref(), Some("REPRODUCED"), "{check}");
        session.execute_meta(&format!("DROP SCHEMA {target} CASCADE")).await.unwrap();
        let (_, src) = collect(&session, &format!("SELECT count(*) FROM {s}.orders"), None, None).await.unwrap();
        assert_eq!(src[0][0].as_deref(), Some("500"), "the source is untouched");
        drop(&session, &r.scratch).await.unwrap();
        session.execute_meta(&format!("DROP SCHEMA {s} CASCADE")).await.unwrap();
    }
}
