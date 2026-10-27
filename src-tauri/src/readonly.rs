//! What may run where only reading is allowed: read-only connections, and exports and copies
//! from any connection. The server's own read-only mode stays on underneath (Postgres, MySQL);
//! this check refuses up front what would switch it off (`BEGIN READ WRITE`, `SET
//! transaction_read_only`, `RESET ALL`…) or write anyway (`SELECT … INTO`, data-modifying CTEs,
//! `EXPLAIN ANALYZE` of a write). SQL that can't be parsed is refused: unknown isn't a read.

use sqlparser::ast::{Query, SetExpr, Statement};
use sqlparser::parser::Parser;

use crate::connections::Engine;
use crate::error::{AppError, Result};

fn refuse(why: impl Into<String>) -> AppError {
    AppError::Invalid(why.into())
}

/// A query that only reads: no `INTO`, no INSERT / UPDATE / DELETE in a CTE, no row locks.
fn check_query(q: &Query) -> Result<()> {
    if let Some(with) = &q.with {
        for cte in &with.cte_tables {
            check_query(&cte.query)?;
        }
    }
    if !q.locks.is_empty() {
        return Err(refuse("SELECT … FOR UPDATE / FOR SHARE locks rows for writing"));
    }
    check_set_expr(&q.body)
}

fn check_set_expr(body: &SetExpr) -> Result<()> {
    match body {
        SetExpr::Select(select) if select.into.is_some() => Err(refuse("SELECT … INTO creates a table")),
        SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Table(_) => Ok(()),
        SetExpr::Query(q) => check_query(q),
        SetExpr::SetOperation { left, right, .. } => {
            check_set_expr(left)?;
            check_set_expr(right)
        }
        _ => Err(refuse("this query changes data (INSERT, UPDATE, DELETE or MERGE inside it)")),
    }
}

/// One statement that only reads. `alone`: it's the whole run (COMMIT / ROLLBACK may then end
/// a read-only transaction; mid-batch they'd start a new one before later statements).
fn check_statement(s: &Statement, alone: bool) -> Result<()> {
    let text = s.to_string();
    let upper = text.to_ascii_uppercase();
    match s {
        Statement::Query(q) => check_query(q),
        Statement::Explain { analyze, statement, .. } => {
            if *analyze {
                check_statement(statement, false)
            } else {
                Ok(())
            }
        }
        Statement::ExplainTable { .. } => Ok(()),
        Statement::StartTransaction { .. } if upper.contains("READ ONLY") && !upper.contains("READ WRITE") => Ok(()),
        Statement::StartTransaction { .. } => Err(refuse("only BEGIN READ ONLY / START TRANSACTION READ ONLY runs here")),
        Statement::Commit { .. } | Statement::Rollback { .. } if alone => Ok(()),
        Statement::Commit { .. } | Statement::Rollback { .. } => Err(refuse("run COMMIT or ROLLBACK on its own here")),
        _ if upper.starts_with("SHOW ") || upper.starts_with("DESCRIBE ") || upper.starts_with("DESC ") || upper.starts_with("USE ") => Ok(()),
        _ if upper.starts_with("SET ") => {
            let flips = ["READ WRITE", "READ_ONLY", "SESSION CHARACTERISTICS", "AUTOCOMMIT"].iter().any(|w| upper.contains(w));
            if flips { Err(refuse("this SET would switch off read-only mode")) } else { Ok(()) }
        }
        _ => Err(refuse(format!("{} isn't a read", text.split_whitespace().next().unwrap_or("This statement").to_ascii_uppercase()))),
    }
}

/// Every statement in `sql` only reads. Used on read-only connections.
pub fn check(sql: &str, engine: Engine) -> Result<()> {
    if sql.to_ascii_lowercase().contains("set_config") {
        return Err(refuse("This connection is read-only: set_config() could switch off read-only mode"));
    }
    let dialect = crate::dialect::parser(engine);
    let statements = Parser::parse_sql(dialect.as_ref(), sql)
        .map_err(|_| refuse("This connection is read-only, and Onyx couldn't confirm this SQL only reads, so it didn't run"))?;
    let alone = statements.len() == 1;
    for s in &statements {
        check_statement(s, alone).map_err(|e| refuse(format!("This connection is read-only: {}", e.to_string().trim_start_matches("Invalid: "))))?;
    }
    Ok(())
}

/// Exports and copies: exactly one statement, a query (or SHOW / EXPLAIN) that only reads.
pub fn check_export(sql: &str, engine: Engine) -> Result<()> {
    let dialect = crate::dialect::parser(engine);
    let refuse_export = |why: &str| refuse(format!("Export only runs one query that reads{why}"));
    let statements = Parser::parse_sql(dialect.as_ref(), sql).map_err(|_| refuse_export(""))?;
    let [statement] = statements.as_slice() else { return Err(refuse_export("")) };
    match statement {
        Statement::Query(_) | Statement::Explain { .. } => {}
        s if s.to_string().to_ascii_uppercase().starts_with("SHOW ") => {}
        _ => return Err(refuse_export("")),
    }
    check_statement(statement, false).map_err(|e| refuse_export(&format!(": {}", e.to_string().trim_start_matches("Invalid: "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_connections_refuse_writes_and_ways_out() {
        let pg = Engine::Postgres;
        for ok in [
            "SELECT * FROM users WHERE id = 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT 1; SELECT 2",
            "EXPLAIN SELECT * FROM users",
            "EXPLAIN ANALYZE SELECT * FROM users",
            "SHOW search_path",
            "SET search_path TO shop",
            "BEGIN READ ONLY",
            "COMMIT",
        ] {
            assert!(check(ok, pg).is_ok(), "{ok}");
        }
        for bad in [
            "DELETE FROM users",
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
            "SELECT * INTO copy FROM users",
            "SELECT * FROM users FOR UPDATE",
            "EXPLAIN ANALYZE DELETE FROM users",
            "SET default_transaction_read_only = off",
            "SET transaction_read_only = off; UPDATE users SET name = 'x'",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "BEGIN READ WRITE",
            "BEGIN",
            "SELECT 1; COMMIT; SELECT 2",
            "SELECT set_config('default_transaction_read_only', 'off', false)",
            "RESET ALL",
            "DISCARD ALL",
            "CALL do_things()",
            "not sql at all",
        ] {
            assert!(check(bad, pg).is_err(), "{bad}");
        }
        assert!(check("SET SESSION TRANSACTION READ WRITE", Engine::Mysql).is_err());
        assert!(check("SET @@session.transaction_read_only = 0", Engine::Mysql).is_err());
        assert!(check("SELECT * FROM t INTO OUTFILE '/tmp/x'", Engine::Mysql).is_err());
        assert!(check("SELECT * INTO new_t FROM t", Engine::Sqlserver).is_err());
    }

    #[test]
    fn exports_run_one_reading_query() {
        assert!(check_export("SELECT * FROM users WHERE id = 1", Engine::Postgres).is_ok());
        assert!(check_export("WITH x AS (SELECT 1) SELECT * FROM x", Engine::Mysql).is_ok());
        for bad in [
            "DELETE FROM users",
            "SELECT 1; DROP TABLE users",
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
            "SELECT * INTO copy FROM users",
            "not sql at all",
        ] {
            assert!(check_export(bad, Engine::Postgres).is_err(), "{bad}");
        }
    }
}
