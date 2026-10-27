//! Migrations: `migrations/<version>_<name>.up.sql` (and `.down.sql`) files in the IDE folder,
//! applied to a connection one at a time and recorded in its `onyx_migrations` table.
//! On Postgres a migration and its record commit together (DDL is transactional there).

use crate::connections::Engine;
use crate::db::Session;
use crate::dialect::literal;
use crate::error::{AppError, Result};
use crate::sqlfile::{Piece, Splitter};

pub const TABLE: &str = "onyx_migrations";
/// The session migrations run on (Postgres and MySQL keep one per tab).
const TAB: &str = "onyx:migrations";

fn supported(engine: Engine) -> Result<()> {
    match engine {
        Engine::Postgres | Engine::Mysql | Engine::Sqlite | Engine::Duckdb | Engine::Sqlserver => Ok(()),
        _ => Err(AppError::Invalid("Migrations work on Postgres, MySQL, SQLite, DuckDB and SQL Server".into())),
    }
}

/// Versions already applied, oldest first. None yet (or no table) is an empty list.
pub async fn applied(session: &Session) -> Result<Vec<String>> {
    supported(session.engine())?;
    match crate::journal::collect(session, &format!("SELECT id FROM {TABLE} ORDER BY id"), Some(TAB), None).await {
        Ok((_, rows)) => Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect()),
        Err(_) => Ok(vec![]),
    }
}

fn statements(engine: Engine, sql: &str) -> Result<Vec<String>> {
    let mut splitter = Splitter::new(engine);
    let mut out = Vec::new();
    let mut push = |p: Piece| match p {
        Piece::Statement(s) => {
            out.push(s);
            Ok(())
        }
        Piece::Copy { .. } => Err(AppError::Invalid("COPY … FROM stdin isn't supported in migrations".into())),
        Piece::Meta(_) => Ok(()),
    };
    for line in sql.split_inclusive('\n') {
        for p in splitter.line(line) {
            push(p)?;
        }
    }
    if let Some(p) = splitter.end() {
        push(p)?;
    }
    Ok(out)
}

fn create_table(engine: Engine) -> String {
    let columns = "id VARCHAR(255) NOT NULL PRIMARY KEY, applied_at VARCHAR(40) NOT NULL";
    match engine {
        Engine::Sqlserver => format!("IF OBJECT_ID('{TABLE}') IS NULL CREATE TABLE {TABLE} ({columns})"),
        _ => format!("CREATE TABLE IF NOT EXISTS {TABLE} ({columns})"),
    }
}

fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

/// Runs `sql` (the up or down file) and records it. Stops at the first failing statement.
pub async fn apply(session: &Session, version: &str, sql: &str, up: bool) -> Result<usize> {
    let engine = session.engine();
    supported(engine)?;
    if version.is_empty() || version.len() > 255 {
        return Err(AppError::Invalid("A migration needs a name".into()));
    }
    let list = statements(engine, sql)?;
    let done = applied(session).await?;
    if up && done.iter().any(|v| v == version) {
        return Err(AppError::Invalid(format!("{version} is already applied")));
    }
    if !up && !done.iter().any(|v| v == version) {
        return Err(AppError::Invalid(format!("{version} isn't applied")));
    }
    session.execute_script(&create_table(engine), TAB).await?;
    let record = if up {
        format!("INSERT INTO {TABLE} (id, applied_at) VALUES ({}, {})", literal(engine, version), literal(engine, &now()))
    } else {
        format!("DELETE FROM {TABLE} WHERE id = {}", literal(engine, version))
    };
    let transactional = engine == Engine::Postgres;
    if transactional {
        session.execute_script("BEGIN", TAB).await?;
    }
    let result = async {
        for (i, s) in list.iter().enumerate() {
            session.execute_script(s, TAB).await.map_err(|e| AppError::Invalid(format!("Statement {} of {}: {e}", i + 1, list.len())))?;
        }
        session.execute_script(&record, TAB).await
    }
    .await;
    if transactional {
        let end = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
        session.execute_script(end, TAB).await?;
    }
    result.map(|_| list.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_migration_files() {
        let s = statements(Engine::Postgres, "-- add\nCREATE TABLE a (id int);\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nALTER TABLE a ADD b int").unwrap();
        assert_eq!(s.len(), 3);
        assert!(s[1].contains("SELECT 1;"));
    }

    /// `ONYX_TEST_PG=1 cargo test migrations`: applies, refuses twice, rolls back, and a failing one leaves nothing.
    #[tokio::test]
    async fn applies_and_rolls_back() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let schema = format!("onyx_mig_{}", uuid::Uuid::new_v4().simple());
        session.execute_meta(&format!("CREATE SCHEMA {schema}")).await.unwrap();
        // Everything (the record table too) goes in the scratch schema.
        session.execute_script(&format!("SET search_path TO {schema}"), TAB).await.unwrap();
        assert!(applied(&session).await.unwrap().is_empty());
        apply(&session, "001_items", "CREATE TABLE items (id int);\nINSERT INTO items VALUES (1);", true).await.unwrap();
        assert_eq!(applied(&session).await.unwrap(), ["001_items"]);
        assert!(apply(&session, "001_items", "SELECT 1", true).await.is_err());
        // A failing migration: rolled back with its record.
        assert!(apply(&session, "002_bad", "ALTER TABLE items ADD note text;\nSELECT * FROM missing_table;", true).await.is_err());
        assert_eq!(applied(&session).await.unwrap(), ["001_items"]);
        let (cols, _) = crate::journal::collect(&session, "SELECT * FROM items", Some(TAB), None).await.unwrap();
        assert_eq!(cols, ["id"], "the failed ALTER was rolled back");
        apply(&session, "001_items", "DROP TABLE items;", false).await.unwrap();
        assert!(applied(&session).await.unwrap().is_empty());
        session.execute_meta(&format!("DROP SCHEMA {schema} CASCADE")).await.unwrap();
    }
}
