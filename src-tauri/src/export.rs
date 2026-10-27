//! Export a query's rows to CSV, JSON or SQL INSERT statements. Rows stream from the
//! same pipeline as the grid (Arrow batches) straight into the file, so size doesn't matter.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use arrow_array::{Array, StringArray};
use arrow_ipc::reader::StreamReader;
use serde::{Deserialize, Serialize};
use sqlparser::ast::Statement;
use sqlparser::parser::Parser;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::Session;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
    Xlsx,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::Json => "json",
            ExportFormat::Sql => "sql",
            ExportFormat::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
}

/// Export re-runs the SQL, so it must only read.
pub fn ensure_read_only(sql: &str, engine: Engine) -> Result<()> {
    match engine {
        Engine::Redis => {
            let read = sql.lines().map(str::trim).filter(|l| !l.is_empty()).all(|l| {
                let command = l.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
                !crate::db::redis::WRITES.contains(&command.as_str())
            });
            return if read { Ok(()) } else { Err(AppError::Invalid("Export only runs commands that read".into())) };
        }
        Engine::Mongodb => {
            let lower = sql.to_ascii_lowercase();
            let read = [".find(", ".aggregate(", ".countdocuments(", ".distinct("].iter().any(|op| lower.contains(op))
                && !lower.contains("$out")
                && !lower.contains("$merge");
            return if read { Ok(()) } else { Err(AppError::Invalid("Export only runs find, aggregate, countDocuments or distinct".into())) };
        }
        _ => {}
    }
    let dialect = crate::dialect::parser(engine);
    let refuse = || AppError::Invalid("Export only runs SELECT queries".into());
    let statements = Parser::parse_sql(dialect.as_ref(), sql).map_err(|_| refuse())?;
    if statements.is_empty() || !statements.iter().all(|s| matches!(s, Statement::Query(_))) {
        return Err(refuse());
    }
    Ok(())
}

/// Runs `sql` and writes its first result set to `path`. A failed run removes the file.
pub async fn export(
    session: &Session,
    sql: &str,
    format: ExportFormat,
    table: &str,
    path: &Path,
) -> Result<ExportResult> {
    // Excel builds its file from a workbook; the text formats stream into the file.
    let out: Box<dyn Write + Send> =
        if format == ExportFormat::Xlsx { Box::new(std::io::sink()) } else { Box::new(BufWriter::new(File::create(path)?)) };
    let mut writer = Writer::new(out, format, session.engine(), table);
    if format == ExportFormat::Xlsx {
        writer.xlsx = Some((rust_xlsxwriter::Workbook::new(), path.to_owned()));
    }
    let writer = Arc::new(Mutex::new(writer));
    let sink = writer.clone();
    let channel = Channel::new(move |body| {
        sink.lock().unwrap().handle(body);
        Ok(())
    });
    let summary = session.run(sql, &channel).await;
    let mut writer = writer.lock().unwrap();
    let outcome = summary.and_then(|s| match s.error.or(writer.error.take()) {
        Some(e) => Err(AppError::Invalid(e)),
        None => writer.finish(),
    });
    match outcome {
        Ok(rows) => Ok(ExportResult { path: path.display().to_string(), rows }),
        Err(e) => {
            let _ = std::fs::remove_file(path);
            Err(e)
        }
    }
}

/// A query's rows as INSERTs into `table`, appended to `out` (the whole-database export).
pub async fn write_inserts(session: &Session, sql: &str, table: &str, out: crate::export_db::SharedFile) -> Result<u64> {
    let writer = Arc::new(Mutex::new(Writer::new(out, ExportFormat::Sql, session.engine(), table)));
    let sink = writer.clone();
    let channel = Channel::new(move |body| {
        sink.lock().unwrap().handle(body);
        Ok(())
    });
    let summary = session.run(sql, &channel).await?;
    let mut writer = writer.lock().unwrap();
    match summary.error.or(writer.error.take()) {
        Some(e) => Err(AppError::Invalid(format!("{table}: {e}"))),
        None => writer.finish(),
    }
}

/// Consumes the run's events: the first result set's rows go to the file.
struct Writer<W: Write> {
    out: W,
    format: ExportFormat,
    engine: Engine,
    table: String,
    columns: Vec<String>,
    state: State,
    rows: u64,
    error: Option<String>,
    /// XLSX: the workbook and where it's saved at the end.
    xlsx: Option<(rust_xlsxwriter::Workbook, std::path::PathBuf)>,
}

#[derive(PartialEq)]
enum State {
    Waiting,
    Writing,
    Done,
}

impl<W: Write> Writer<W> {
    fn new(out: W, format: ExportFormat, engine: Engine, table: &str) -> Self {
        Self {
            out,
            format,
            engine,
            table: table.to_owned(),
            columns: vec![],
            state: State::Waiting,
            rows: 0,
            error: None,
            xlsx: None,
        }
    }

    fn sheet(&mut self) -> Result<&mut rust_xlsxwriter::Worksheet> {
        let (book, _) = self.xlsx.as_mut().ok_or_else(|| AppError::Invalid("no workbook".into()))?;
        if book.worksheets().is_empty() {
            book.add_worksheet_with_constant_memory().map_err(xlsx_err)?.set_name("Export").map_err(xlsx_err)?;
        }
        book.worksheet_from_index(0).map_err(xlsx_err)
    }

    fn handle(&mut self, body: InvokeResponseBody) {
        let result = match body {
            InvokeResponseBody::Json(json) => self.on_event(&json),
            InvokeResponseBody::Raw(bytes) => self.on_batch(&bytes),
        };
        if let Err(e) = result {
            self.error.get_or_insert(e.to_string());
        }
    }

    fn on_event(&mut self, json: &str) -> Result<()> {
        let event: serde_json::Value = serde_json::from_str(json).map_err(|e| AppError::Invalid(e.to_string()))?;
        match event["type"].as_str() {
            Some("resultStart") if self.state == State::Waiting => {
                self.columns = event["columns"]
                    .as_array()
                    .map(|c| c.iter().map(|v| v.as_str().unwrap_or("").to_owned()).collect())
                    .unwrap_or_default();
                self.state = State::Writing;
                self.write_header()?;
            }
            Some("resultEnd") if self.state == State::Writing => self.state = State::Done,
            Some("error") => {
                self.error = event["error"]["message"].as_str().map(str::to_owned);
            }
            _ => {}
        }
        Ok(())
    }

    fn on_batch(&mut self, bytes: &[u8]) -> Result<()> {
        if self.state != State::Writing {
            return Ok(());
        }
        let reader = StreamReader::try_new(bytes, None).map_err(|e| AppError::Invalid(e.to_string()))?;
        for batch in reader {
            let batch = batch.map_err(|e| AppError::Invalid(e.to_string()))?;
            let columns: Vec<&StringArray> =
                batch.columns().iter().filter_map(|c| c.as_any().downcast_ref::<StringArray>()).collect();
            for row in 0..batch.num_rows() {
                let values: Vec<Option<&str>> =
                    columns.iter().map(|c| (!c.is_null(row)).then(|| c.value(row))).collect();
                self.write_row(&values)?;
            }
        }
        Ok(())
    }

    fn write_header(&mut self) -> Result<()> {
        match self.format {
            ExportFormat::Csv => {
                let line = self.columns.iter().map(|c| csv_field(Some(c))).collect::<Vec<_>>().join(",");
                writeln!(self.out, "{line}")?;
            }
            ExportFormat::Json => write!(self.out, "[")?,
            ExportFormat::Sql => {}
            ExportFormat::Xlsx => {
                let columns = self.columns.clone();
                let bold = rust_xlsxwriter::Format::new().set_bold();
                let sheet = self.sheet()?;
                for (i, c) in columns.iter().enumerate() {
                    sheet.write_string_with_format(0, i as u16, c, &bold).map_err(xlsx_err)?;
                }
                sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
            }
        }
        Ok(())
    }

    fn write_row(&mut self, values: &[Option<&str>]) -> Result<()> {
        match self.format {
            ExportFormat::Csv => {
                let line = values.iter().map(|v| csv_field(*v)).collect::<Vec<_>>().join(",");
                writeln!(self.out, "{line}")?;
            }
            ExportFormat::Json => {
                let fields: Vec<String> = self
                    .columns
                    .iter()
                    .zip(values)
                    .map(|(c, v)| format!("{}: {}", json_string(c), v.map_or("null".to_owned(), json_string)))
                    .collect();
                let comma = if self.rows == 0 { "" } else { "," };
                write!(self.out, "{comma}\n  {{{}}}", fields.join(", "))?;
            }
            ExportFormat::Sql => {
                let columns: Vec<String> = self.columns.iter().map(|c| ident(c, self.engine)).collect();
                let literals: Vec<String> = values.iter().map(|v| sql_literal(*v, self.engine)).collect();
                writeln!(
                    self.out,
                    "INSERT INTO {} ({}) VALUES ({});",
                    ident(&self.table, self.engine),
                    columns.join(", "),
                    literals.join(", ")
                )?;
            }
            ExportFormat::Xlsx => {
                // Excel's limit, header row included.
                if self.rows + 1 >= 1_048_576 {
                    return Err(AppError::Invalid("Excel sheets hold at most 1,048,575 rows: export as CSV instead".into()));
                }
                let row = self.rows as u32 + 1;
                let sheet = self.sheet()?;
                for (i, value) in values.iter().enumerate() {
                    let Some(v) = value else { continue };
                    match excel_number(v) {
                        Some(n) => sheet.write_number(row, i as u16, n),
                        None => sheet.write_string(row, i as u16, *v),
                    }
                    .map_err(xlsx_err)?;
                }
            }
        }
        self.rows += 1;
        Ok(())
    }

    fn finish(&mut self) -> Result<u64> {
        if self.format == ExportFormat::Json {
            if self.state == State::Waiting {
                write!(self.out, "[")?;
            }
            writeln!(self.out, "{}]", if self.rows > 0 { "\n" } else { "" })?;
        }
        self.out.flush()?;
        if let Some((mut book, path)) = self.xlsx.take() {
            if book.worksheets().is_empty() {
                book.add_worksheet();
            }
            book.save(&path).map_err(xlsx_err)?;
        }
        Ok(self.rows)
    }
}

/// Numbers become Excel numbers, unless that would lose digits (ids, phone numbers, zip codes).
fn excel_number(value: &str) -> Option<f64> {
    let plain = value.len() <= 15 && !value.starts_with('+') && !(value.starts_with('0') && value.len() > 1 && !value.starts_with("0."));
    if !plain {
        return None;
    }
    value.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Invalid(format!("Excel: {e}"))
}

/// RFC 4180: quote fields with commas, quotes or line breaks. NULL is an empty field and the
/// empty string is `""`, so the two stay different (as in Postgres' COPY … CSV).
fn csv_field(value: Option<&str>) -> String {
    match value {
        None => String::new(),
        Some("") => "\"\"".to_owned(),
        Some(v) if v.contains([',', '"', '\n', '\r']) => format!("\"{}\"", v.replace('"', "\"\"")),
        Some(v) => v.to_owned(),
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn ident(name: &str, engine: Engine) -> String {
    crate::dialect::ident(engine, name)
}

fn sql_literal(value: Option<&str>, engine: Engine) -> String {
    value.map_or_else(|| "NULL".into(), |v| crate::dialect::literal(engine, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(format: ExportFormat, engine: Engine, rows: &[&[Option<&str>]]) -> String {
        let mut w = Writer::new(Vec::new(), format, engine, "users");
        w.on_event(r#"{"type":"resultStart","index":0,"columns":["id","note"]}"#).unwrap();
        for row in rows {
            w.write_row(row).unwrap();
        }
        w.on_event(r#"{"type":"resultEnd","index":0,"rowCount":2}"#).unwrap();
        w.finish().unwrap();
        String::from_utf8(w.out).unwrap()
    }

    const ROWS: &[&[Option<&str>]] = &[&[Some("1"), Some("plain")], &[Some("2"), Some("a, \"quoted\"\nline")], &[Some("3"), None]];

    #[test]
    fn csv_quotes_only_when_needed() {
        assert_eq!(
            written(ExportFormat::Csv, Engine::Postgres, ROWS),
            "id,note\n1,plain\n2,\"a, \"\"quoted\"\"\nline\"\n3,\n"
        );
    }

    #[test]
    fn json_is_an_array_of_objects_in_column_order() {
        let json = written(ExportFormat::Json, Engine::Postgres, ROWS);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed[1]["note"], "a, \"quoted\"\nline");
        assert!(parsed[2]["note"].is_null());
        assert!(json.find("\"id\"").unwrap() < json.find("\"note\"").unwrap());
        assert_eq!(serde_json::from_str::<serde_json::Value>(&written(ExportFormat::Json, Engine::Mysql, &[])).unwrap(), serde_json::json!([]));
    }

    #[test]
    fn sql_inserts_escape_per_engine() {
        let rows: &[&[Option<&str>]] = &[&[Some("1"), Some("O'Brien \\ x")], &[Some("2"), None]];
        assert_eq!(
            written(ExportFormat::Sql, Engine::Mysql, rows),
            "INSERT INTO `users` (`id`, `note`) VALUES ('1', 'O\\'Brien \\\\ x');\nINSERT INTO `users` (`id`, `note`) VALUES ('2', NULL);\n"
        );
        assert!(written(ExportFormat::Sql, Engine::Postgres, rows).contains("'O''Brien \\ x'"));
    }

    #[test]
    fn xlsx_writes_a_workbook() {
        let path = std::env::temp_dir().join(format!("onyx-export-{}.xlsx", uuid::Uuid::new_v4()));
        let mut w = Writer::new(Vec::new(), ExportFormat::Xlsx, Engine::Postgres, "users");
        w.xlsx = Some((rust_xlsxwriter::Workbook::new(), path.clone()));
        w.on_event(r#"{"type":"resultStart","index":0,"columns":["id","note"]}"#).unwrap();
        for row in ROWS {
            w.write_row(row).unwrap();
        }
        assert_eq!(w.finish().unwrap(), 3);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"PK"), "an xlsx file is a zip");
        std::fs::remove_file(path).unwrap();
        assert_eq!(excel_number("12.5"), Some(12.5));
        assert_eq!(excel_number("007"), None);
        assert_eq!(excel_number("12345678901234567"), None);
    }

    #[test]
    fn only_select_queries_can_be_exported() {
        assert!(ensure_read_only("SELECT * FROM users WHERE id = 1", Engine::Postgres).is_ok());
        assert!(ensure_read_only("WITH x AS (SELECT 1) SELECT * FROM x", Engine::Mysql).is_ok());
        assert!(ensure_read_only("DELETE FROM users", Engine::Postgres).is_err());
        assert!(ensure_read_only("SELECT 1; DROP TABLE users", Engine::Mysql).is_err());
        assert!(ensure_read_only("not sql at all", Engine::Postgres).is_err());
    }

    #[tokio::test]
    async fn exports_a_real_table_to_csv() {
        if std::env::var("ONYX_TEST_PG").is_err() {
            return;
        }
        let config = crate::connections::ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            engine: Engine::Postgres,
            name: "export".into(),
            host: "localhost".into(),
            port: 54329,
            user: "postgres".into(),
            database: "onyx_dev".into(),
            ssl_mode: crate::connections::SslMode::Disable,
            environment: crate::connections::Environment::Local,
            color: "#000".into(),
            read_only: false,
            ssh: None,
            folder: None,
            ai_enabled: false,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            aws_iam: None,
        };
        let session = Session::connect(&config, None, None).await.unwrap();
        let path = std::env::temp_dir().join(format!("onyx-export-{}.csv", uuid::Uuid::new_v4()));
        let result = export(&session, "SELECT id, kind FROM public.events ORDER BY id LIMIT 25000", ExportFormat::Csv, "events", &path)
            .await
            .unwrap();
        assert_eq!(result.rows, 25_000);
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 25_001);
        assert_eq!(lines[0], "id,kind");
        assert_eq!(lines[10], "10,", "id 10 has a NULL kind");

        // A failing query leaves no file behind.
        let bad = std::env::temp_dir().join(format!("onyx-export-{}.csv", uuid::Uuid::new_v4()));
        assert!(export(&session, "SELECT nope FROM public.events", ExportFormat::Csv, "x", &bad).await.is_err());
        assert!(!bad.exists());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn csv_keeps_null_and_empty_apart() {
        assert_eq!(written(ExportFormat::Csv, Engine::Postgres, &[&[None, Some("")]]), "id,note\n,\"\"\n");
    }

    /// `ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 cargo test fidelity`: tricky values survive the result
    /// stream and every export format exactly (no rounding, NULL ≠ '', Unicode intact).
    #[tokio::test]
    async fn values_survive_streaming_and_exports() {
        const TEXT: &str = "naïve café — 你好 👋🏽 עברית";
        for engine in [Engine::Postgres, Engine::Mysql] {
            let Some(config) = crate::db::edit_integration::config(engine) else { continue };
            let session = Session::connect(&config, None, None).await.unwrap();
            let sql = match engine {
                Engine::Postgres => format!(
                    "SELECT 9223372036854775807::bigint AS big, (-9223372036854775808)::bigint AS small, \
                     12345678901234567890.123456789::numeric(38,9) AS money, 0.1::float8 AS tenth, \
                     ''::text AS blank, NULL::text AS nothing, '{TEXT}'::text AS words, E'a\\tb\\nc' AS controls"
                ),
                _ => format!(
                    "SELECT CAST(9223372036854775807 AS SIGNED) AS big, CAST(-9223372036854775808 AS SIGNED) AS small, \
                     CAST(12345678901234567890.123456789 AS DECIMAL(38,9)) AS money, CAST(0.1 AS DOUBLE) AS tenth, \
                     '' AS blank, NULL AS nothing, '{TEXT}' AS words, 'a\\tb\\nc' AS controls"
                ),
            };
            let expected: Vec<Option<&str>> = vec![
                Some("9223372036854775807"),
                Some("-9223372036854775808"),
                Some("12345678901234567890.123456789"),
                Some("0.1"),
                Some(""),
                None,
                Some(TEXT),
                Some("a\tb\nc"),
            ];
            // The stream the grid reads.
            let (_, rows) = crate::journal::collect(&session, &sql, None, None).await.unwrap();
            let got: Vec<Option<&str>> = rows[0].iter().map(|v| v.as_deref()).collect();
            assert_eq!(got, expected, "{engine:?} stream");

            // Each export format.
            let file = |ext: &str| std::env::temp_dir().join(format!("onyx-fidelity-{}.{ext}", uuid::Uuid::new_v4()));
            let (csv, json, ins) = (file("csv"), file("json"), file("sql"));
            export(&session, &sql, ExportFormat::Csv, "t", &csv).await.unwrap();
            export(&session, &sql, ExportFormat::Json, "t", &json).await.unwrap();
            export(&session, &sql, ExportFormat::Sql, "t", &ins).await.unwrap();
            let csv_text = std::fs::read_to_string(&csv).unwrap();
            assert!(
                csv_text.ends_with(&format!("9223372036854775807,-9223372036854775808,12345678901234567890.123456789,0.1,\"\",,{TEXT},\"a\tb\nc\"\n")),
                "{engine:?} csv: {csv_text}"
            );
            let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
            let row = &parsed[0];
            assert_eq!(row["big"], "9223372036854775807", "{engine:?} json");
            assert_eq!(row["money"], "12345678901234567890.123456789");
            assert_eq!(row["blank"], "");
            assert!(row["nothing"].is_null());
            assert_eq!(row["words"], TEXT);
            let sql_text = std::fs::read_to_string(&ins).unwrap();
            assert!(sql_text.contains("12345678901234567890.123456789") && sql_text.contains("NULL") && sql_text.contains(TEXT), "{engine:?} sql: {sql_text}");
            for f in [csv, json, ins] {
                std::fs::remove_file(f).unwrap();
            }
        }
    }
}
