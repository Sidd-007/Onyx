//! Conflict-aware grid edits. Before saving, each row being changed or deleted is read again
//! and compared with what the user loaded: if someone changed it since, nothing is written
//! and the user sees exactly what changed. After saving, the rows are read back to confirm
//! the database holds the new values.

use serde::Serialize;

use crate::db::edit::{Cell, RowEdit};
use crate::db::Session;
use crate::dialect::{ident, literal, qualified};
use crate::error::Result;
use crate::journal::collect;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Rows the statements changed.
    pub changed: u64,
    /// Rows read back after saving.
    pub checked: usize,
    /// Values the database stores differently from what was typed (normalized dates, numbers…).
    pub notes: Vec<String>,
    /// What didn't look right after saving (a row not found, a deleted row still there).
    pub problems: Vec<String>,
}

fn shown(value: &Option<String>) -> String {
    match value {
        None => "NULL".into(),
        Some(v) if v.chars().count() > 60 => format!("'{}…'", v.chars().take(59).collect::<String>()),
        Some(v) => format!("'{v}'"),
    }
}

fn where_of(session: &Session, key: &[Cell]) -> String {
    let engine = session.engine();
    key.iter()
        .map(|c| match &c.value {
            None => format!("{} IS NULL", ident(engine, &c.column)),
            Some(v) => format!("{} = {}", ident(engine, &c.column), literal(engine, v)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// `id = 7` as the user would say it.
fn row_name(key: &[Cell]) -> String {
    key.iter().map(|c| format!("{} = {}", c.column, c.value.as_deref().unwrap_or("NULL"))).collect::<Vec<_>>().join(", ")
}

/// The columns' current values for one row (None when the row is gone).
async fn current(session: &Session, schema: &str, table: &str, key: &[Cell], columns: &[String]) -> Result<Option<Vec<Option<String>>>> {
    let engine = session.engine();
    let list = columns.iter().map(|c| ident(engine, c)).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT {list} FROM {} WHERE {}", qualified(engine, schema, table), where_of(session, key));
    let (_, rows) = collect(session, &sql, None, Some(2)).await?;
    Ok(rows.into_iter().next())
}

/// One field seen three ways: as loaded (base), as edited (mine), as it is now (theirs).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldState {
    /// Which edit (its position in the list sent).
    pub edit: usize,
    pub key: Vec<Cell>,
    pub column: String,
    pub base: Option<String>,
    /// None for a delete (there is no new value).
    pub mine: Option<Option<String>>,
    pub theirs: Option<String>,
    /// Someone else changed it to exactly what I wanted: nothing to decide.
    pub converged: bool,
    /// The row is gone (deleted, or its key changed).
    pub deleted: bool,
}

/// Fields someone else changed since they were loaded, three ways. Empty: safe to save.
pub async fn changed_since(session: &Session, schema: &str, table: &str, edits: &[RowEdit]) -> Result<Vec<FieldState>> {
    let mut out = Vec::new();
    for (i, edit) in edits.iter().enumerate() {
        let (key, original, set) = match edit {
            RowEdit::Update { key, original, set } if !original.is_empty() => (key, original, Some(set)),
            RowEdit::Delete { key, original } if !original.is_empty() => (key, original, None),
            _ => continue,
        };
        let columns: Vec<String> = original.iter().map(|c| c.column.clone()).collect();
        let mine = |column: &str| set.map(|s| s.iter().find(|c| c.column == column).and_then(|c| c.value.clone()));
        match current(session, schema, table, key, &columns).await? {
            None => out.push(FieldState { edit: i, key: key.clone(), column: String::new(), base: None, mine: None, theirs: None, converged: false, deleted: true }),
            Some(now) => {
                for (c, value) in original.iter().zip(now) {
                    if c.value != value {
                        let mine = mine(&c.column);
                        out.push(FieldState { edit: i, key: key.clone(), column: c.column.clone(), base: c.value.clone(), converged: mine.as_ref() == Some(&value), mine, theirs: value, deleted: false });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// The fields that need a decision, as sentences (converged ones don't).
pub fn describe(fields: &[FieldState]) -> Vec<String> {
    fields
        .iter()
        .filter(|f| !f.converged)
        .map(|f| {
            if f.deleted {
                format!("{}: the row was deleted, or its key changed", row_name(&f.key))
            } else {
                format!("{}: {} is now {} (you loaded {})", row_name(&f.key), f.column, shown(&f.theirs), shown(&f.base))
            }
        })
        .collect()
}

/// Rows changed (or deleted) by someone else since they were loaded. Empty when it's safe to save.
pub async fn conflicts(session: &Session, schema: &str, table: &str, edits: &[RowEdit]) -> Result<Vec<String>> {
    Ok(describe(&changed_since(session, schema, table, edits).await?))
}

/// Reads the saved rows back: updated values present, deleted rows gone.
pub async fn verify(session: &Session, schema: &str, table: &str, edits: &[RowEdit], changed: u64) -> ApplyReport {
    let mut report = ApplyReport { changed, checked: 0, notes: vec![], problems: vec![] };
    for edit in edits {
        match edit {
            RowEdit::Update { key, set, .. } => {
                // A changed key column: look the row up by its new key.
                let key: Vec<Cell> = key.iter().map(|k| set.iter().find(|s| s.column == k.column).cloned().unwrap_or_else(|| k.clone())).collect();
                let columns: Vec<String> = set.iter().map(|c| c.column.clone()).collect();
                match current(session, schema, table, &key, &columns).await {
                    Ok(Some(now)) => {
                        report.checked += 1;
                        for (c, value) in set.iter().zip(now) {
                            if c.value != value {
                                report.notes.push(format!("{}: {} is stored as {} (you entered {})", row_name(&key), c.column, shown(&value), shown(&c.value)));
                            }
                        }
                    }
                    Ok(None) => report.problems.push(format!("{}: not found after saving", row_name(&key))),
                    Err(e) => report.problems.push(format!("{}: couldn't read it back ({e})", row_name(&key))),
                }
            }
            RowEdit::Delete { key, .. } => match current(session, schema, table, key, &[key[0].column.clone()]).await {
                Ok(None) => report.checked += 1,
                Ok(Some(_)) => report.problems.push(format!("{}: still there after deleting", row_name(key))),
                Err(e) => report.problems.push(format!("{}: couldn't check it ({e})", row_name(key))),
            },
            RowEdit::Insert { .. } => {}
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::Engine;

    fn cell(column: &str, value: Option<&str>) -> Cell {
        Cell { column: column.into(), value: value.map(str::to_owned) }
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test safe_edit`: someone else's change is caught
    /// before saving (nothing is written), and a clean save is verified.
    #[tokio::test]
    async fn catches_changes_made_since_loading() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let schema = if engine == Engine::Postgres { "public" } else { "onyx_dev" };
            let t = format!("onyx_conflict_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, status varchar(20), total decimal(10,2))")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'new', 10.50), (2, 'new', 3.00)")).await.unwrap();

            // Loaded: status 'new'. Someone else marks it paid.
            let edit = RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("status", Some("cancelled"))], original: vec![cell("status", Some("new"))] };
            session.execute_meta(&format!("UPDATE {t} SET status = 'paid' WHERE id = 1")).await.unwrap();
            let found = conflicts(&session, schema, &t, std::slice::from_ref(&edit)).await.unwrap();
            assert_eq!(found, ["id = 1: status is now 'paid' (you loaded 'new')"], "{engine:?}");

            // The UPDATE itself also refuses (the guard in its WHERE): no gap after the check.
            {
                let statements = session.prepare_edits(schema, &t, std::slice::from_ref(&edit)).await.unwrap();
                assert!(session.apply_edits(&statements).await.is_err());
                let (_, rows) = collect(&session, &format!("SELECT status FROM {t} WHERE id = 1"), None, None).await.unwrap();
                assert_eq!(rows[0][0].as_deref(), Some("paid"), "nothing overwritten");
            }

            // A deleted row is a conflict too.
            let gone = RowEdit::Delete { key: vec![cell("id", Some("2"))], original: vec![cell("status", Some("new"))] };
            session.execute_meta(&format!("DELETE FROM {t} WHERE id = 2")).await.unwrap();
            assert!(conflicts(&session, schema, &t, std::slice::from_ref(&gone)).await.unwrap()[0].contains("deleted"));

            // A clean edit: no conflicts, saved, verified; the database's own formatting is a note.
            let clean = RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("total", Some("12.5"))], original: vec![cell("total", Some("10.50"))] };
            assert!(conflicts(&session, schema, &t, std::slice::from_ref(&clean)).await.unwrap().is_empty());
            let statements = session.prepare_edits(schema, &t, std::slice::from_ref(&clean)).await.unwrap();
            let changed = session.apply_edits(&statements).await.unwrap();
            let report = verify(&session, schema, &t, std::slice::from_ref(&clean), changed).await;
            assert_eq!((report.changed, report.checked, report.problems.len()), (1, 1, 0), "{engine:?}");
            assert_eq!(report.notes, ["id = 1: total is stored as '12.50' (you entered '12.5')"]);
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }

    /// F11 on Postgres and MySQL: my name change and their status change both survive; both
    /// changing a field to the same value isn't a conflict; different values on one field is.
    #[tokio::test]
    async fn merges_three_ways() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let schema = if engine == Engine::Postgres { "public" } else { "onyx_dev" };
            let t = format!("onyx_merge_{}", uuid::Uuid::new_v4().simple());
            session.execute_meta(&format!("CREATE TABLE {t} (id int PRIMARY KEY, name varchar(20), status varchar(20))")).await.unwrap();
            session.execute_meta(&format!("INSERT INTO {t} VALUES (1, 'Ann', 'new')")).await.unwrap();
            // Someone else: status → paid.
            session.execute_meta(&format!("UPDATE {t} SET status = 'paid' WHERE id = 1")).await.unwrap();
            // Me (loaded before that): name → Anne. Different fields: no conflict, both kept.
            let mine = RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("name", Some("Anne"))], original: vec![cell("name", Some("Ann"))] };
            assert!(changed_since(&session, schema, &t, std::slice::from_ref(&mine)).await.unwrap().is_empty());
            let statements = session.prepare_edits(schema, &t, std::slice::from_ref(&mine)).await.unwrap();
            session.apply_edits(&statements).await.unwrap();
            let (_, rows) = collect(&session, &format!("SELECT name, status FROM {t}"), None, None).await.unwrap();
            assert_eq!(rows[0], [Some("Anne".into()), Some("paid".into())], "{engine:?}");
            // Me: status → paid too (loaded 'new'): converged, nothing to decide.
            let same = RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("status", Some("paid"))], original: vec![cell("status", Some("new"))] };
            let fields = changed_since(&session, schema, &t, std::slice::from_ref(&same)).await.unwrap();
            assert!(fields[0].converged && describe(&fields).is_empty(), "{engine:?}");
            // Me: status → cancelled (loaded 'new', now 'paid'): a real conflict, three ways.
            let clash = RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("status", Some("cancelled"))], original: vec![cell("status", Some("new"))] };
            let fields = changed_since(&session, schema, &t, std::slice::from_ref(&clash)).await.unwrap();
            assert_eq!((fields[0].base.as_deref(), fields[0].mine.clone(), fields[0].theirs.as_deref(), fields[0].converged), (Some("new"), Some(Some("cancelled".into())), Some("paid"), false));
            session.execute_meta(&format!("DROP TABLE {t}")).await.unwrap();
        }
    }
}
