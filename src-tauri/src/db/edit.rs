//! Row edits from the table view, turned into parameterized SQL. Values are always bound
//! as parameters; identifiers come from the table's own catalog and are quoted.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::connections::Engine;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Cell {
    pub column: String,
    /// Text as the grid shows it; `None` is NULL.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowEdit {
    /// `key`: the row's primary key as loaded. `original`: the changed columns as loaded, so a
    /// value someone else changed in the meantime is never silently overwritten.
    Update {
        key: Vec<Cell>,
        set: Vec<Cell>,
        #[serde(default)]
        original: Vec<Cell>,
    },
    Insert { values: Vec<Cell> },
    /// `original`: the row as loaded (every column), to refuse deleting a row that changed since.
    Delete {
        key: Vec<Cell>,
        #[serde(default)]
        original: Vec<Cell>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct EditStatement {
    #[serde(skip)]
    pub sql: String,
    #[serde(skip)]
    pub params: Vec<Option<String>>,
    /// Updates and deletes must hit exactly one row, or the whole batch rolls back.
    #[serde(skip)]
    pub expect_one_row: bool,
    /// The statement with its values written in, for the review dialog.
    pub display: String,
    /// For updates and deletes: a query counting the rows the statement will touch, values
    /// written in (DuckDB checks it, having no bound parameters or affected-row counts).
    #[serde(skip)]
    pub count_sql: Option<String>,
}

/// `column_types`: column name → type as the catalog spells it (Postgres casts to it).
pub fn build(
    engine: Engine,
    schema: &str,
    table: &str,
    column_types: &HashMap<String, String>,
    edits: &[RowEdit],
) -> Result<Vec<EditStatement>> {
    if !matches!(engine, Engine::Postgres | Engine::Mysql | Engine::Sqlite | Engine::Duckdb | Engine::Sqlserver) {
        return Err(AppError::Invalid("Editing rows in the grid isn't available for this engine".into()));
    }
    let b = Builder { engine, column_types };
    let target = format!("{}.{}", b.ident(schema), b.ident(table));
    let mut statements = Vec::new();
    for edit in edits {
        let mut s = Statement::default();
        match edit {
            RowEdit::Update { key, set, original } => {
                if set.is_empty() {
                    continue;
                }
                let assignments: Vec<String> =
                    set.iter().map(|c| Ok(format!("{} = {}", b.column(c)?, s.value(&b, c)?))).collect::<Result<_>>()?;
                let mut filter = b.key_filter(key, &mut s)?;
                // Postgres and MySQL: the loaded values must still be there when the UPDATE runs,
                // compared as the text the grid loaded (exact, byte for byte on MySQL), closing
                // the gap after the check.
                if matches!(engine, Engine::Postgres | Engine::Mysql) {
                    for c in original.iter().filter(|c| !key.iter().any(|k| k.column == c.column)) {
                        let column = b.column(c)?;
                        filter.push_str(&match (&c.value, engine) {
                            (None, _) => format!(" AND {column} IS NULL"),
                            (Some(_), Engine::Postgres) => format!(" AND CAST({column} AS text) = {}", s.text_value(c)),
                            (Some(_), _) => format!(" AND CAST({column} AS BINARY) = CAST({} AS BINARY)", s.value(&b, c)?),
                        });
                    }
                }
                s.count_sql = Some(format!("SELECT count(*) FROM {target} WHERE {}", b.key_display(key)?));
                s.finish(format!("UPDATE {target} SET {} WHERE {filter}", assignments.join(", ")), true);
            }
            RowEdit::Insert { values } => {
                let sql = if values.is_empty() {
                    match engine {
                        Engine::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                        _ => format!("INSERT INTO {target} DEFAULT VALUES"),
                    }
                } else {
                    let columns: Vec<String> = values.iter().map(|c| b.column(c)).collect::<Result<_>>()?;
                    let placeholders: Vec<String> = values.iter().map(|c| s.value(&b, c)).collect::<Result<_>>()?;
                    format!("INSERT INTO {target} ({}) VALUES ({})", columns.join(", "), placeholders.join(", "))
                };
                s.finish(sql, false);
            }
            RowEdit::Delete { key, .. } => {
                let filter = b.key_filter(key, &mut s)?;
                s.count_sql = Some(format!("SELECT count(*) FROM {target} WHERE {}", b.key_display(key)?));
                s.finish(format!("DELETE FROM {target} WHERE {filter}"), true);
            }
        }
        statements.push(s.into_statement());
    }
    Ok(statements)
}

struct Builder<'a> {
    engine: Engine,
    column_types: &'a HashMap<String, String>,
}

impl Builder<'_> {
    fn ident(&self, name: &str) -> String {
        crate::dialect::ident(self.engine, name)
    }

    /// The quoted column, after checking it exists.
    fn column(&self, cell: &Cell) -> Result<String> {
        if !self.column_types.contains_key(&cell.column) {
            return Err(AppError::Invalid(format!("Unknown column {}", cell.column)));
        }
        Ok(self.ident(&cell.column))
    }

    fn key_filter(&self, key: &[Cell], s: &mut Statement) -> Result<String> {
        if key.is_empty() {
            return Err(AppError::Invalid("Rows can only be changed in tables with a primary key".into()));
        }
        let parts: Vec<String> = key
            .iter()
            .map(|c| {
                let column = self.column(c)?;
                Ok(match &c.value {
                    None => format!("{column} IS NULL"),
                    Some(_) => format!("{column} = {}", s.value(self, c)?),
                })
            })
            .collect::<Result<_>>()?;
        Ok(parts.join(" AND "))
    }

    /// The key filter with values written in.
    fn key_display(&self, key: &[Cell]) -> Result<String> {
        let parts: Vec<String> = key
            .iter()
            .map(|c| {
                let column = self.column(c)?;
                Ok(match &c.value {
                    None => format!("{column} IS NULL"),
                    Some(_) => format!("{column} = {}", self.literal(&c.value)),
                })
            })
            .collect::<Result<_>>()?;
        Ok(parts.join(" AND "))
    }

    fn literal(&self, value: &Option<String>) -> String {
        match value {
            None => "NULL".into(),
            Some(v) => crate::dialect::literal(self.engine, v),
        }
    }
}

/// Collects one statement's parameters, and its display form alongside.
#[derive(Default)]
struct Statement {
    params: Vec<Option<String>>,
    literals: Vec<String>,
    sql: String,
    expect_one_row: bool,
    count_sql: Option<String>,
}

/// Marks where a value goes in the display form.
const SLOT: &str = "\u{0}";

impl Statement {
    /// A placeholder for the cell's value (text, cast to the column type on Postgres).
    fn value(&mut self, b: &Builder, cell: &Cell) -> Result<String> {
        self.params.push(cell.value.clone());
        self.literals.push(b.literal(&cell.value));
        Ok(match b.engine {
            Engine::Postgres => {
                let ty = &b.column_types[&cell.column];
                format!("CAST(${}::text AS {}){SLOT}", self.params.len(), crate::dialect::pg_cast_type(ty))
            }
            Engine::Sqlserver => format!("@P{}{SLOT}", self.params.len()),
            _ => format!("?{SLOT}"),
        })
    }

    /// A placeholder compared as text (Postgres), for the loaded-value guard.
    fn text_value(&mut self, cell: &Cell) -> String {
        self.params.push(cell.value.clone());
        self.literals.push(cell.value.as_deref().map_or("NULL".into(), |v| crate::dialect::literal(Engine::Postgres, v)));
        format!("CAST(${}::text AS text){SLOT}", self.params.len())
    }

    fn finish(&mut self, sql: String, expect_one_row: bool) {
        self.sql = sql;
        self.expect_one_row = expect_one_row;
    }

    fn into_statement(self) -> EditStatement {
        // Each placeholder is immediately followed by SLOT: swap it for its literal.
        let mut display = String::new();
        let mut literals = self.literals.iter();
        let pieces: Vec<&str> = self.sql.split(SLOT).collect();
        for (i, piece) in pieces.iter().enumerate() {
            if i + 1 < pieces.len() {
                display.push_str(&piece[..placeholder_start(piece)]);
                display.push_str(literals.next().map(String::as_str).unwrap_or("?"));
            } else {
                display.push_str(piece);
            }
        }
        EditStatement {
            sql: self.sql.replace(SLOT, ""),
            params: self.params,
            expect_one_row: self.expect_one_row,
            display,
            count_sql: self.count_sql,
        }
    }
}

/// Where the trailing placeholder (`?`, `@Pn` or `CAST($n::text AS type)`) begins in `piece`.
fn placeholder_start(piece: &str) -> usize {
    if piece.ends_with('?') {
        piece.len() - 1
    } else if let Some(at) = piece.rfind("@P").filter(|&i| piece[i + 2..].chars().all(|c| c.is_ascii_digit())) {
        at
    } else {
        piece.rfind("CAST($").unwrap_or(piece.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(column: &str, value: Option<&str>) -> Cell {
        Cell { column: column.into(), value: value.map(str::to_owned) }
    }

    fn types() -> HashMap<String, String> {
        [("id", "bigint"), ("name", "text"), ("n", "integer")].into_iter().map(|(a, b)| (a.into(), b.into())).collect()
    }

    #[test]
    fn postgres_statements_bind_values_and_cast_to_column_types() {
        let edits = [
            RowEdit::Update { key: vec![cell("id", Some("7"))], set: vec![cell("name", Some("O'Brien")), cell("n", None)], original: vec![] },
            RowEdit::Insert { values: vec![cell("name", Some("new"))] },
            RowEdit::Delete { key: vec![cell("id", Some("9"))], original: vec![] },
        ];
        let s = build(Engine::Postgres, "shop", "users", &types(), &edits).unwrap();
        assert_eq!(
            s[0].sql,
            r#"UPDATE "shop"."users" SET "name" = CAST($1::text AS text), "n" = CAST($2::text AS integer) WHERE "id" = CAST($3::text AS bigint)"#
        );
        assert_eq!(s[0].params, [Some("O'Brien".into()), None, Some("7".into())]);
        assert!(s[0].expect_one_row);
        assert_eq!(s[0].display, r#"UPDATE "shop"."users" SET "name" = 'O''Brien', "n" = NULL WHERE "id" = '7'"#);
        assert_eq!(s[1].sql, r#"INSERT INTO "shop"."users" ("name") VALUES (CAST($1::text AS text))"#);
        assert!(!s[1].expect_one_row);
        assert_eq!(s[2].display, r#"DELETE FROM "shop"."users" WHERE "id" = '9'"#);
    }

    #[test]
    fn mysql_statements_use_question_marks_and_backticks() {
        let edits = [RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("name", Some(r"a\'b"))], original: vec![] }];
        let s = build(Engine::Mysql, "db", "we`ird", &types(), &edits).unwrap();
        assert_eq!(s[0].sql, "UPDATE `db`.`we``ird` SET `name` = ? WHERE `id` = ?");
        assert_eq!(s[0].display, r"UPDATE `db`.`we``ird` SET `name` = 'a\\\'b' WHERE `id` = '1'");
        let empty = build(Engine::Mysql, "db", "t", &types(), &[RowEdit::Insert { values: vec![] }]).unwrap();
        assert_eq!(empty[0].sql, "INSERT INTO `db`.`t` () VALUES ()");
    }

    #[test]
    fn sql_server_uses_numbered_parameters() {
        let edits = [RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("name", Some("x"))], original: vec![] }];
        let s = build(Engine::Sqlserver, "dbo", "users", &types(), &edits).unwrap();
        assert_eq!(s[0].sql, "UPDATE [dbo].[users] SET [name] = @P1 WHERE [id] = @P2");
        assert_eq!(s[0].display, "UPDATE [dbo].[users] SET [name] = N'x' WHERE [id] = N'1'");
        assert!(build(Engine::Redis, "db0", "k", &types(), &edits).is_err());
    }

    #[test]
    fn hostile_values_stay_in_parameters() {
        let evil = "x'); DROP TABLE users; --";
        let s = build(Engine::Postgres, "public", "users", &types(), &[RowEdit::Insert { values: vec![cell("name", Some(evil))] }]).unwrap();
        assert!(!s[0].sql.contains("DROP"));
        assert_eq!(s[0].params, [Some(evil.into())]);
    }

    #[test]
    fn rejects_unknown_columns_and_missing_keys() {
        let unknown = [RowEdit::Update { key: vec![cell("id", Some("1"))], set: vec![cell("nope", Some("1"))], original: vec![] }];
        assert!(build(Engine::Postgres, "s", "t", &types(), &unknown).is_err());
        let keyless = [RowEdit::Delete { key: vec![], original: vec![] }];
        assert!(build(Engine::Postgres, "s", "t", &types(), &keyless).is_err());
    }
}
