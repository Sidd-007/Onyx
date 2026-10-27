//! Runs a .sql file (a dump, a migration) of any size: read in chunks, split into statements
//! as it goes, executed one by one on a session of its own, with progress. Understands
//! strings, comments, Postgres dollar quoting and `COPY … FROM stdin` data, and MySQL's
//! `DELIMITER` (dumps with triggers and routines).

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::connections::Engine;
use crate::db::Session;
use crate::error::{AppError, Result};

/// A piece of the file: a statement to run, or COPY data for the statement before it.
#[derive(Debug, PartialEq)]
pub enum Piece {
    Statement(String),
    /// `COPY … FROM stdin;` and the lines after it, up to `\.`.
    Copy { statement: String, data: Vec<u8> },
    /// psql meta-commands (`\connect`, `\restrict`…): skipped, but reported.
    Meta(String),
}

/// Splits statements from lines fed one at a time. State carries across lines (and chunks).
pub struct Splitter {
    mysql: bool,
    postgres: bool,
    delimiter: String,
    current: String,
    /// Inside a quote ('"` or a dollar tag), or a block comment.
    quote: Option<String>,
    block_comment: bool,
    copy: Option<(String, Vec<u8>)>,
}

impl Splitter {
    pub fn new(engine: Engine) -> Self {
        Self {
            mysql: matches!(engine, Engine::Mysql | Engine::Clickhouse),
            postgres: matches!(engine, Engine::Postgres | Engine::Duckdb),
            delimiter: ";".into(),
            current: String::new(),
            quote: None,
            block_comment: false,
            copy: None,
        }
    }

    /// One line (with its newline). Returns the pieces it completes.
    pub fn line(&mut self, line: &str) -> Vec<Piece> {
        let mut out = Vec::new();
        if let Some((_, data)) = &mut self.copy {
            if line.trim_end_matches(['\r', '\n']) == "\\." {
                let (statement, data) = self.copy.take().unwrap();
                out.push(Piece::Copy { statement, data });
            } else {
                data.extend_from_slice(line.as_bytes());
            }
            return out;
        }
        // Only comments so far (dumps put them before DELIMITER and meta-commands).
        let at_start = is_only_comments(&self.current) && self.quote.is_none() && !self.block_comment;
        if at_start {
            let trimmed = line.trim();
            if self.mysql && trimmed.len() > 10 && trimmed[..10].eq_ignore_ascii_case("delimiter ") {
                self.delimiter = trimmed[10..].trim().to_owned();
                self.current.clear();
                return out;
            }
            if self.postgres && trimmed.starts_with('\\') {
                out.push(Piece::Meta(trimmed.to_owned()));
                return out;
            }
        }

        let chars: Vec<char> = line.chars().collect();
        let delim: Vec<char> = self.delimiter.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if self.block_comment {
                self.current.push(c);
                if c == '*' && chars.get(i + 1) == Some(&'/') {
                    self.current.push('/');
                    i += 1;
                    self.block_comment = false;
                }
                i += 1;
                continue;
            }
            if let Some(q) = &self.quote {
                if q.len() > 1 {
                    // A dollar tag: ends at the same tag.
                    let tag: Vec<char> = q.chars().collect();
                    if chars[i..].starts_with(&tag) {
                        self.current.extend(&tag);
                        i += tag.len();
                        self.quote = None;
                        continue;
                    }
                    self.current.push(c);
                    i += 1;
                    continue;
                }
                let qc = q.chars().next().unwrap();
                self.current.push(c);
                if c == '\\' && self.mysql && qc != '`' {
                    if let Some(&n) = chars.get(i + 1) {
                        self.current.push(n);
                        i += 1;
                    }
                } else if c == qc {
                    if chars.get(i + 1) == Some(&qc) {
                        self.current.push(qc);
                        i += 1;
                    } else {
                        self.quote = None;
                    }
                }
                i += 1;
                continue;
            }
            // A line comment: keep it in the statement (conditional comments matter in MySQL), skip ahead.
            if (c == '-' && chars.get(i + 1) == Some(&'-')) || (self.mysql && c == '#') {
                self.current.extend(&chars[i..]);
                break;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                self.block_comment = true;
                self.current.push_str("/*");
                i += 2;
                continue;
            }
            if c == '\'' || c == '"' || (c == '`' && self.mysql) {
                self.quote = Some(c.to_string());
                self.current.push(c);
                i += 1;
                continue;
            }
            if c == '$' && self.postgres && !self.current.ends_with(|p: char| p.is_alphanumeric() || p == '_') {
                let rest: String = chars[i + 1..].iter().take_while(|ch| ch.is_alphanumeric() || **ch == '_').collect();
                if chars.get(i + 1 + rest.chars().count()) == Some(&'$') {
                    let tag = format!("${rest}$");
                    self.current.push_str(&tag);
                    i += tag.chars().count();
                    self.quote = Some(tag);
                    continue;
                }
            }
            if chars[i..].starts_with(&delim) {
                let statement = std::mem::take(&mut self.current);
                i += delim.len();
                if let Some(piece) = self.finish(statement) {
                    out.push(piece);
                    if self.copy.is_some() {
                        // COPY data starts on the next line.
                        return out;
                    }
                }
                continue;
            }
            self.current.push(c);
            i += 1;
        }
        out
    }

    fn finish(&mut self, statement: String) -> Option<Piece> {
        let text = statement.trim();
        if is_only_comments(text) {
            return None;
        }
        if self.postgres && is_copy_from_stdin(text) {
            self.copy = Some((text.to_owned(), Vec::new()));
            return None;
        }
        Some(Piece::Statement(text.to_owned()))
    }

    /// Whatever is left at the end of the file (a last statement without `;`).
    pub fn end(&mut self) -> Option<Piece> {
        let statement = std::mem::take(&mut self.current);
        self.finish(statement)
    }
}

fn is_only_comments(text: &str) -> bool {
    let mut rest = text.trim();
    loop {
        if rest.is_empty() {
            return true;
        }
        if rest.starts_with("--") || rest.starts_with('#') {
            match rest.find('\n') {
                Some(n) => rest = rest[n + 1..].trim_start(),
                None => return true,
            }
        } else if rest.starts_with("/*") && !rest.starts_with("/*!") {
            match rest.find("*/") {
                Some(n) => rest = rest[n + 2..].trim_start(),
                None => return true,
            }
        } else {
            return false;
        }
    }
}

fn is_copy_from_stdin(text: &str) -> bool {
    let upper = text.to_ascii_uppercase();
    upper.starts_with("COPY ") && upper.contains(" FROM STDIN")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRun {
    pub statements: u64,
    pub failed: u64,
    /// The first errors, when continuing past them.
    pub errors: Vec<String>,
    pub skipped: Vec<String>,
}

fn progress(events: &Channel<InvokeResponseBody>, statements: u64, bytes: u64) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "progress", "rows": statements, "bytes": bytes }).to_string()));
}

fn log(events: &Channel<InvokeResponseBody>, line: String) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "log", "line": line }).to_string()));
}

fn snippet(statement: &str) -> String {
    let one_line: String = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 { format!("{}…", one_line.chars().take(120).collect::<String>()) } else { one_line }
}

/// Restores a plain SQL dump on a session of its own, statement by statement. psql and mysql
/// client commands in the file (`\\! cmd`, `\\copy … program`, `system …`) are never run: they're
/// skipped and reported, so a crafted dump can't execute anything on this Mac. `setup` runs
/// first (e.g. `USE db`); with `atomic` (Postgres) everything is one transaction, rolled back
/// on the first error.
pub async fn restore_file(session: &Session, path: &Path, setup: Option<String>, atomic: bool, events: &Channel<InvokeResponseBody>) -> Result<FileRun> {
    let tab = format!("__restore_{}", uuid::Uuid::new_v4().simple());
    let result = async {
        if let Some(sql) = &setup {
            session.execute_script(sql, &tab).await?;
        }
        if atomic {
            session.execute_script("BEGIN", &tab).await?;
        }
        let done = run(session, path, true, events, &tab).await;
        if atomic {
            let end = if done.is_ok() { "COMMIT" } else { "ROLLBACK" };
            let ended = session.execute_script(end, &tab).await;
            if done.is_ok() {
                ended?;
            }
        }
        done
    }
    .await;
    session.close_tab(&tab).await;
    result
}

/// Runs the file on a session of its own (`tab`), closed at the end.
pub async fn run_file(session: &Session, path: &Path, stop_on_error: bool, events: &Channel<InvokeResponseBody>) -> Result<FileRun> {
    let tab = format!("__sqlfile_{}", uuid::Uuid::new_v4().simple());
    let result = run(session, path, stop_on_error, events, &tab).await;
    session.close_tab(&tab).await;
    result
}

async fn run(session: &Session, path: &Path, stop_on_error: bool, events: &Channel<InvokeResponseBody>, tab: &str) -> Result<FileRun> {
    let file = tokio::fs::File::open(path).await?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut splitter = Splitter::new(session.engine());
    let mut done = FileRun { statements: 0, failed: 0, errors: vec![], skipped: vec![] };
    let mut bytes = 0u64;
    let mut line = String::new();
    let mut last = Instant::now();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        let pieces = if n == 0 { splitter.end().into_iter().collect() } else { splitter.line(&line) };
        bytes += n as u64;
        for piece in pieces {
            let (label, outcome) = match piece {
                Piece::Meta(m) => {
                    log(events, format!("Skipped {m}"));
                    done.skipped.push(m);
                    continue;
                }
                Piece::Statement(s) => {
                    let outcome = session.execute_script(&s, tab).await;
                    (s, outcome)
                }
                Piece::Copy { statement, data } => {
                    let outcome = session.copy_in(&statement, data, tab).await;
                    (statement, outcome)
                }
            };
            done.statements += 1;
            if let Err(e) = outcome {
                done.failed += 1;
                let message = format!("Statement {}: {e} — {}", done.statements, snippet(&label));
                if stop_on_error {
                    return Err(AppError::Invalid(format!("{message}\n(stopped; {} statements before it ran)", done.statements - 1)));
                }
                log(events, message.clone());
                if done.errors.len() < 20 {
                    done.errors.push(message);
                }
            }
            if last.elapsed() > Duration::from_millis(150) {
                progress(events, done.statements, bytes);
                last = Instant::now();
            }
        }
        if n == 0 {
            break;
        }
    }
    progress(events, done.statements, bytes);
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(engine: Engine, text: &str) -> Vec<Piece> {
        let mut s = Splitter::new(engine);
        let mut out = Vec::new();
        for line in text.split_inclusive('\n') {
            out.extend(s.line(line));
        }
        out.extend(s.end());
        out
    }

    fn statements(pieces: &[Piece]) -> Vec<&str> {
        pieces.iter().filter_map(|p| if let Piece::Statement(s) = p { Some(s.as_str()) } else { None }).collect()
    }

    #[test]
    fn splits_postgres_dumps() {
        let dump = "-- a comment\nSET client_encoding = 'UTF8';\n\\connect shop\nCREATE FUNCTION f() RETURNS int AS $body$\nBEGIN; RETURN 1; END;\n$body$ LANGUAGE plpgsql;\nCOPY users (id, name) FROM stdin;\n1\tAnn\n2\tit's; fine\n\\.\nSELECT 'a;b', \"we;ird\" FROM t;\nSELECT 1";
        let pieces = split(Engine::Postgres, dump);
        assert_eq!(pieces[0], Piece::Statement("-- a comment\nSET client_encoding = 'UTF8'".into()));
        assert_eq!(pieces[1], Piece::Meta("\\connect shop".into()));
        assert!(matches!(&pieces[2], Piece::Statement(s) if s.contains("RETURN 1; END;") && s.ends_with("plpgsql")));
        assert_eq!(pieces[3], Piece::Copy { statement: "COPY users (id, name) FROM stdin".into(), data: b"1\tAnn\n2\tit's; fine\n".to_vec() });
        assert_eq!(statements(&pieces[4..]), ["SELECT 'a;b', \"we;ird\" FROM t", "SELECT 1"]);
    }

    #[test]
    fn splits_mysql_dumps() {
        let dump = "/*!40101 SET NAMES utf8mb4 */;\n-- comment only\n;\nINSERT INTO t VALUES ('it\\'s; ok', `a;b`);\nDELIMITER ;;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END ;;\nDELIMITER ;\nSELECT 1;";
        let s = split(Engine::Mysql, dump);
        assert_eq!(
            statements(&s),
            [
                "/*!40101 SET NAMES utf8mb4 */",
                "INSERT INTO t VALUES ('it\\'s; ok', `a;b`)",
                "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END",
                "SELECT 1",
            ]
        );
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test sqlfile`: runs dump-style files on the dev databases.
    #[tokio::test]
    async fn runs_files_on_dev_databases() {
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let name = format!("onyx_file_{}", uuid::Uuid::new_v4().simple());
            let text = if engine == Engine::Postgres {
                format!(
                    "CREATE SCHEMA {name};\nSET search_path TO {name};\nCREATE TABLE t (id int PRIMARY KEY, note text);\nCOPY t (id, note) FROM stdin;\n1\thello\n2\tit's; ok\n\\.\nCREATE FUNCTION {name}.f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nINSERT INTO t VALUES (3, 'x');\n"
                )
            } else {
                format!(
                    "CREATE DATABASE {name};\nUSE {name};\nCREATE TABLE t (id int PRIMARY KEY, note text);\nINSERT INTO t VALUES (1, 'it\\'s; ok'), (2, 'b');\nDELIMITER ;;\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.note = UPPER(NEW.note); END ;;\nDELIMITER ;\nINSERT INTO t VALUES (3, 'x');\n"
                )
            };
            let path = std::env::temp_dir().join(format!("{name}.sql"));
            std::fs::write(&path, text).unwrap();
            let (events, _) = crate::db::stream::testing::recorder();
            let done = run_file(&session, &path, true, &events).await.unwrap();
            assert_eq!(done.failed, 0);
            let q = format!("SELECT count(*) FROM {name}.t");
            let (_, rows) = session.admin_rows(&q).await.unwrap();
            assert_eq!(rows[0][0].as_deref(), Some("3"), "{engine:?}");
            // An error stops the run and says which statement.
            std::fs::write(&path, "SELECT 1;\nSELECT nope_nope;\nSELECT 2;\n").unwrap();
            let err = run_file(&session, &path, true, &events).await.unwrap_err().to_string();
            assert!(err.contains("Statement 2"), "{err}");
            let drop = if engine == Engine::Postgres { format!("DROP SCHEMA {name} CASCADE") } else { format!("DROP DATABASE {name}") };
            session.execute_meta(&drop).await.unwrap();
            std::fs::remove_file(path).unwrap();
        }
    }
}
