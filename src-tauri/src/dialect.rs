//! Per-engine SQL spelling: identifier quoting, string literals, and the parser dialect.

use sqlparser::dialect::{ClickHouseDialect, Dialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};

use crate::connections::Engine;

pub fn parser(engine: Engine) -> Box<dyn Dialect> {
    match engine {
        Engine::Postgres => Box::new(PostgreSqlDialect {}),
        Engine::Mysql => Box::new(MySqlDialect {}),
        Engine::Sqlite => Box::new(SQLiteDialect {}),
        Engine::Duckdb => Box::new(DuckDbDialect {}),
        Engine::Clickhouse => Box::new(ClickHouseDialect {}),
        Engine::Sqlserver => Box::new(MsSqlDialect {}),
        Engine::Redis | Engine::Mongodb => Box::new(GenericDialect {}),
    }
}

pub fn ident(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mysql | Engine::Clickhouse => format!("`{}`", name.replace('`', "``")),
        Engine::Sqlserver => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// `schema.table`, both quoted.
pub fn qualified(engine: Engine, schema: &str, table: &str) -> String {
    format!("{}.{}", ident(engine, schema), ident(engine, table))
}

/// A string literal. MySQL escapes backslashes too; the others double the quote.
pub fn literal(engine: Engine, value: &str) -> String {
    match engine {
        Engine::Mysql | Engine::Clickhouse => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")),
        Engine::Sqlserver => format!("N'{}'", value.replace('\'', "''")),
        _ => format!("'{}'", value.replace('\'', "''")),
    }
}

/// The type a text parameter is cast to before Postgres stores it in a column of type `ty`
/// (as `format_type` spells it). An explicit cast to `varchar(5)`, `char(3)` or `bit(4)`
/// silently cuts the value to fit; storing into the column checks the length instead and
/// fails. So the modifier is left to the column: `character varying(5)` → `character varying`,
/// `character(3)` → `character varying` (`character` alone means one character), `bit(4)` →
/// `bit varying`, `numeric(5,2)` → `numeric` (the column rounds and range-checks as for a literal).
pub fn pg_cast_type(ty: &str) -> String {
    if ty.starts_with('"') {
        return ty.to_owned();
    }
    let mut out = String::new();
    let mut rest = ty;
    while let Some(open) = rest.find('(') {
        let Some(close) = rest[open..].find(')') else { break };
        let inner = &rest[open + 1..open + close];
        out.push_str(&rest[..open]);
        if !inner.chars().all(|c| c.is_ascii_digit() || c == ',' || c == ' ') {
            out.push_str(&rest[open..=open + close]);
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    let array = out.find("[]").map(|i| out[i..].to_owned()).unwrap_or_default();
    let base = out[..out.len() - array.len()].trim();
    let base = match base {
        "character" | "bpchar" => "character varying",
        "bit" => "bit varying",
        b => b,
    };
    format!("{base}{array}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_per_engine() {
        assert_eq!(ident(Engine::Mysql, "a`b"), "`a``b`");
        assert_eq!(ident(Engine::Sqlite, "a\"b"), "\"a\"\"b\"");
        assert_eq!(literal(Engine::Mysql, r"O'B\"), r"'O\'B\\'");
        assert_eq!(literal(Engine::Duckdb, "O'B"), "'O''B'");
        assert_eq!(qualified(Engine::Postgres, "s", "t"), "\"s\".\"t\"");
        assert_eq!(ident(Engine::Sqlserver, "a]b"), "[a]]b]");
        assert_eq!(literal(Engine::Sqlserver, "O'B"), "N'O''B'");
        assert_eq!(literal(Engine::Clickhouse, r"O'B\"), r"'O\'B\\'");
    }

    #[test]
    fn postgres_casts_leave_lengths_to_the_column() {
        assert_eq!(pg_cast_type("character varying(5)"), "character varying");
        assert_eq!(pg_cast_type("character(3)"), "character varying");
        assert_eq!(pg_cast_type("character(3)[]"), "character varying[]");
        assert_eq!(pg_cast_type("bit(4)"), "bit varying");
        assert_eq!(pg_cast_type("numeric(5,2)"), "numeric");
        assert_eq!(pg_cast_type("timestamp(3) without time zone"), "timestamp without time zone");
        assert_eq!(pg_cast_type("integer"), "integer");
        assert_eq!(pg_cast_type("public.mood"), "public.mood");
        assert_eq!(pg_cast_type("\"char\""), "\"char\"");
        assert_eq!(pg_cast_type("vector(3)"), "vector");
    }
}
