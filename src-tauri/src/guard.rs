//! Prod guard: finds statements that destroy data or change the schema, so the UI can
//! ask before running them on a connection tagged prod.

use serde::Serialize;
use sqlparser::ast::Statement;
use sqlparser::parser::Parser;

use crate::connections::Engine;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub statement: String,
    pub reason: String,
}

pub fn risky_statements(sql: &str, engine: Engine) -> Vec<Risk> {
    match engine {
        Engine::Redis => return redis_risks(sql),
        Engine::Mongodb => return mongo_risks(sql),
        _ => {}
    }
    let dialect = crate::dialect::parser(engine);
    match Parser::parse_sql(dialect.as_ref(), sql) {
        Ok(statements) => statements.iter().filter_map(risk).collect(),
        // Can't parse it: fall back to keywords, erring on the side of asking.
        Err(_) => keyword_risk(sql).into_iter().collect(),
    }
}

fn risk(statement: &Statement) -> Option<Risk> {
    let text = statement.to_string();
    let reason = match statement {
        Statement::Delete(d) if d.selection.is_none() => "DELETE without WHERE removes every row",
        Statement::Update(u) if u.selection.is_none() => "UPDATE without WHERE changes every row",
        _ => match text.split_whitespace().next().unwrap_or("").to_ascii_uppercase().as_str() {
            "DROP" => "drops an object and its data",
            "TRUNCATE" => "removes every row",
            "ALTER" | "RENAME" => "changes the schema",
            "GRANT" | "REVOKE" => "changes permissions",
            _ => return None,
        },
    };
    Some(Risk { statement: shorten(&text), reason: reason.into() })
}

/// Redis commands that delete or rewrite data in bulk, or change the server.
fn redis_risks(text: &str) -> Vec<Risk> {
    text.lines()
        .filter_map(|line| {
            let command = line.split_whitespace().next()?.to_ascii_uppercase();
            let reason = match command.as_str() {
                "FLUSHALL" | "FLUSHDB" => "deletes every key",
                "DEL" | "UNLINK" => "deletes keys",
                "RENAME" | "MOVE" | "SWAPDB" | "RESTORE" => "moves or replaces keys",
                "CONFIG" | "SHUTDOWN" | "DEBUG" | "SCRIPT" | "FUNCTION" | "EVAL" | "EVALSHA" | "FCALL" => "runs server-side code or changes the server",
                _ => return None,
            };
            Some(Risk { statement: shorten(line.trim()), reason: reason.into() })
        })
        .collect()
}

/// MongoDB operations that delete or rewrite many documents.
fn mongo_risks(text: &str) -> Vec<Risk> {
    let lower = text.to_ascii_lowercase();
    [
        (".drop(", "drops a collection"),
        (".dropdatabase(", "drops the database"),
        (".deletemany(", "deletes documents"),
        (".remove(", "deletes documents"),
        (".updatemany(", "changes many documents"),
        (".replaceone(", "replaces a document"),
        ("runcommand(", "runs a server command"),
    ]
    .into_iter()
    .filter(|(needle, _)| lower.contains(needle))
    .map(|(_, reason)| Risk { statement: shorten(text.trim()), reason: reason.into() })
    .collect()
}

fn keyword_risk(sql: &str) -> Option<Risk> {
    let lower = sql.to_ascii_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric() && c != '_').collect();
    let has = |w: &str| words.contains(&w);
    let found = ["drop", "truncate", "alter", "grant", "revoke", "rename"].into_iter().find(|w| has(w));
    let unfiltered = (has("delete") || has("update")) && !has("where");
    if found.is_none() && !unfiltered {
        return None;
    }
    let keyword = found.unwrap_or(if has("delete") { "delete" } else { "update" });
    Some(Risk {
        statement: shorten(sql.trim()),
        reason: format!("couldn't parse this SQL, and it contains {}", keyword.to_ascii_uppercase()),
    })
}

pub fn shorten(text: &str) -> String {
    match text.char_indices().nth(300) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reasons(sql: &str, engine: Engine) -> Vec<String> {
        risky_statements(sql, engine).into_iter().map(|r| r.reason).collect()
    }

    #[test]
    fn flags_destructive_statements() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            assert_eq!(reasons("DELETE FROM users", engine), ["DELETE without WHERE removes every row"]);
            assert_eq!(reasons("UPDATE users SET name = 'x'", engine), ["UPDATE without WHERE changes every row"]);
            assert_eq!(reasons("DROP TABLE users", engine), ["drops an object and its data"]);
            assert_eq!(reasons("TRUNCATE TABLE users", engine), ["removes every row"]);
            assert_eq!(reasons("ALTER TABLE users ADD COLUMN x int", engine), ["changes the schema"]);
        }
        assert_eq!(reasons("drop index idx_a; select 1; delete from t", Engine::Postgres).len(), 2);
    }

    #[test]
    fn leaves_safe_statements_alone() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            assert!(risky_statements("SELECT * FROM users", engine).is_empty());
            assert!(risky_statements("DELETE FROM users WHERE id = 1", engine).is_empty());
            assert!(risky_statements("UPDATE users SET name = 'x' WHERE id = 1", engine).is_empty());
            assert!(risky_statements("INSERT INTO users (id) VALUES (1)", engine).is_empty());
            assert!(risky_statements("SELECT 'drop table users'", engine).is_empty());
        }
    }

    #[test]
    fn flags_redis_and_mongo_bulk_changes() {
        assert_eq!(reasons("GET a\nFLUSHDB", Engine::Redis), ["deletes every key"]);
        assert!(risky_statements("HGETALL user:1", Engine::Redis).is_empty());
        assert_eq!(reasons("db.users.deleteMany({})", Engine::Mongodb), ["deletes documents"]);
        assert!(risky_statements("db.users.find({a: 1})", Engine::Mongodb).is_empty());
    }

    #[test]
    fn falls_back_to_keywords_when_parsing_fails() {
        let risks = risky_statements("DROP TABLE users ???", Engine::Postgres);
        assert_eq!(risks.len(), 1);
        assert!(risks[0].reason.contains("DROP"));
        assert!(risky_statements("SELEC 1 ???", Engine::Postgres).is_empty());
    }
}
