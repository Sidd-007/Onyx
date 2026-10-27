//! Natural language → SQL with the Claude API. Sent: the request, the schema (table, column
//! and type names, foreign keys) and, when there is one, SQL to refine: Claude's previous
//! answer, or the editor's SQL when the user includes it (it can contain values). Never rows.
//! The API key lives in Onyx's vault.

use std::time::Duration;

use serde::Serialize;

use crate::connections::Engine;
use crate::db::model::{CompletionTable, ForeignKeyRef};
use crate::error::{AppError, Result};

pub const API_KEY_ACCOUNT: &str = "anthropic-api-key";
const MODEL: &str = "claude-opus-5-5";
/// Keeps very large schemas within a sensible request size.
const MAX_SCHEMA_CHARS: usize = 200_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedSql {
    pub sql: String,
    pub explanation: String,
}

fn engine_name(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "PostgreSQL",
        Engine::Mysql => "MySQL",
        Engine::Sqlite => "SQLite",
        Engine::Duckdb => "DuckDB",
        Engine::Clickhouse => "ClickHouse",
        Engine::Sqlserver => "SQL Server (T-SQL)",
        Engine::Redis => "Redis",
        Engine::Mongodb => "MongoDB",
    }
}

/// `schema.table(column type, …)` per line, then the foreign keys.
pub fn schema_context(tables: &[CompletionTable], keys: &[ForeignKeyRef]) -> String {
    let mut text = String::new();
    for t in tables {
        let columns: Vec<String> = t.columns.iter().zip(&t.types).map(|(c, ty)| format!("{c} {ty}")).collect();
        let line = format!("{}.{}({})\n", t.schema, t.name, columns.join(", "));
        if text.len() + line.len() > MAX_SCHEMA_CHARS {
            text += "… (more tables not shown)\n";
            break;
        }
        text += &line;
    }
    if !keys.is_empty() {
        text += "\nForeign keys:\n";
        for k in keys {
            let line = format!(
                "{}.{}({}) -> {}.{}({})\n",
                k.schema,
                k.table,
                k.key.columns.join(", "),
                k.key.ref_schema,
                k.key.ref_table,
                k.key.ref_columns.join(", ")
            );
            if text.len() + line.len() > MAX_SCHEMA_CHARS {
                break;
            }
            text += &line;
        }
    }
    text
}

pub fn request_body(engine: Engine, schema: &str, default_schema: Option<&str>, prompt: &str, current_sql: Option<&str>) -> serde_json::Value {
    let language = match engine {
        Engine::Redis => "Redis commands, one per line as redis-cli takes them,",
        Engine::Mongodb => "a MongoDB shell query such as db.users.find({ plan: \"pro\" }).limit(100),",
        _ => "SQL",
    };
    let mut system = format!(
        "You write {language} for {engine} in a database client. Write exactly one statement that does what the user asks, \
         using only the tables and columns in the schema below. Qualify table names with their schema when the \
         schema isn't the default. Unless the user explicitly asks to change data or the schema, write a read-only \
         query, and add a LIMIT to exploratory queries that could return many rows. Put the SQL in `sql` (no \
         markdown fences) and one or two plain sentences about what it does, and any assumption you made, in \
         `explanation`. If the schema can't answer the request, return an empty `sql` and say why in `explanation`.",
        engine = engine_name(engine)
    );
    if let Some(d) = default_schema.filter(|d| !d.is_empty()) {
        system += &format!("\n\nThe default schema is {d}.");
    }
    system += &format!("\n\nSchema:\n{schema}");
    let mut user = prompt.trim().to_owned();
    if let Some(sql) = current_sql.map(str::trim).filter(|s| !s.is_empty()) {
        user = format!("The editor currently contains:\n{sql}\n\nRequest: {user}");
    }
    serde_json::json!({
        "model": MODEL,
        "max_tokens": 16000,
        "fallbacks": "default",
        "system": system,
        "output_config": {
            "effort": "medium",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "sql": { "type": "string" },
                        "explanation": { "type": "string" }
                    },
                    "required": ["sql", "explanation"],
                    "additionalProperties": false
                }
            }
        },
        "messages": [{ "role": "user", "content": user }]
    })
}

/// Reads the SQL out of a Messages API response.
pub fn parse_response(status: u16, body: &str) -> Result<GeneratedSql> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|_| AppError::Invalid(format!("Claude API returned HTTP {status}")))?;
    if status != 200 {
        let message = json["error"]["message"].as_str().unwrap_or("request failed");
        return Err(AppError::Invalid(format!("Claude API ({status}): {message}")));
    }
    if json["stop_reason"] == "refusal" {
        return Err(AppError::Invalid("Claude declined this request. Try rephrasing it.".into()));
    }
    if json["stop_reason"] == "max_tokens" {
        return Err(AppError::Invalid("Claude's answer was cut off. Try a narrower request.".into()));
    }
    let text = json["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<String>();
    let answer: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| AppError::Invalid("Claude's answer wasn't in the expected format".into()))?;
    Ok(GeneratedSql {
        sql: answer["sql"].as_str().unwrap_or("").trim().to_owned(),
        explanation: answer["explanation"].as_str().unwrap_or("").trim().to_owned(),
    })
}

pub async fn generate(api_key: &str, body: &serde_json::Value) -> Result<GeneratedSql> {
    let response = crate::http::post_json(
        "api.anthropic.com",
        "/v1/messages",
        &[
            ("x-api-key", api_key),
            ("anthropic-version", "2026-10-21"),
            ("anthropic-beta", "server-side-fallback-2026-07-01"),
        ],
        &body.to_string(),
        Duration::from_secs(180),
    )
    .await?;
    parse_response(response.status, &response.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::ForeignKeyInfo;

    #[test]
    fn builds_a_schema_only_request() {
        let tables = [CompletionTable {
            schema: "shop".into(),
            name: "orders".into(),
            columns: vec!["id".into(), "user_id".into()],
            types: vec!["bigint".into(), "bigint".into()],
        }];
        let keys = [ForeignKeyRef {
            schema: "shop".into(),
            table: "orders".into(),
            key: ForeignKeyInfo {
                name: "fk".into(),
                columns: vec!["user_id".into()],
                ref_schema: "shop".into(),
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_update: "NO ACTION".into(),
                on_delete: "NO ACTION".into(),
            },
        }];
        let context = schema_context(&tables, &keys);
        assert!(context.contains("shop.orders(id bigint, user_id bigint)"));
        assert!(context.contains("shop.orders(user_id) -> shop.users(id)"));
        let body = request_body(Engine::Postgres, &context, Some("public"), "top 5 users by orders", Some("SELECT 1"));
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["fallbacks"], "default");
        assert!(body["system"].as_str().unwrap().contains("PostgreSQL"));
        assert!(body["messages"][0]["content"].as_str().unwrap().contains("SELECT 1"));
    }

    #[test]
    fn reads_answers_refusals_and_errors() {
        let ok = r#"{"stop_reason":"end_turn","content":[{"type":"thinking","thinking":""},{"type":"text","text":"{\"sql\":\" SELECT 1 \",\"explanation\":\"One.\"}"}]}"#;
        let answer = parse_response(200, ok).unwrap();
        assert_eq!((answer.sql.as_str(), answer.explanation.as_str()), ("SELECT 1", "One."));
        assert!(parse_response(200, r#"{"stop_reason":"refusal","content":[]}"#).is_err());
        let err = parse_response(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#).unwrap_err();
        assert!(err.to_string().contains("invalid x-api-key"));
    }
}
