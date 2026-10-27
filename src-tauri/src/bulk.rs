//! Moving rows in bulk: CSV import, copying a query's rows to another connection, and
//! inserting generated rows. Everything runs in one transaction on the target, in batches,
//! reporting progress as JSON events.

use std::io::Read;
use std::sync::{Arc, Mutex};

use arrow_array::{Array, StringArray};
use arrow_ipc::reader::StreamReader;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::db::Session;
use crate::error::{AppError, Result};

const BATCH_ROWS: usize = 1000;

pub type Progress = Channel<InvokeResponseBody>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub path: String,
    pub delimiter: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub path: String,
    pub delimiter: String,
    pub has_header: bool,
    /// For each CSV column, the table column it goes into (or `None` to skip it).
    pub mapping: Vec<Option<String>>,
    /// Empty fields become NULL instead of empty strings.
    pub empty_as_null: bool,
}

fn progress(events: &Progress, rows: u64, done_bytes: Option<u64>) {
    let event = serde_json::json!({ "type": "progress", "rows": rows, "bytes": done_bytes });
    let _ = events.send(InvokeResponseBody::Json(event.to_string()));
}

/// Picks the delimiter that splits the first line into the most fields.
fn detect_delimiter(first_line: &str) -> u8 {
    b",;\t|"
        .iter()
        .copied()
        .max_by_key(|&d| first_line.bytes().filter(|&b| b == d).count())
        .unwrap_or(b',')
}

fn delimiter_byte(delimiter: &str) -> Result<u8> {
    match delimiter {
        "\\t" | "\t" => Ok(b'\t'),
        d if d.len() == 1 => Ok(d.as_bytes()[0]),
        _ => Err(AppError::Invalid("The delimiter must be one character".into())),
    }
}

/// The first rows of a CSV file, to map its columns before importing.
pub fn preview(path: &str) -> Result<CsvPreview> {
    let size_bytes = std::fs::metadata(path)?.len();
    let mut head = String::new();
    std::fs::File::open(path)?.take(64 * 1024).read_to_string(&mut head).ok();
    let delimiter = detect_delimiter(head.lines().next().unwrap_or(""));
    let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).has_headers(false).flexible(true).from_path(path).map_err(csv_err)?;
    let mut records = reader.records();
    let headers: Vec<String> = match records.next() {
        Some(r) => r.map_err(csv_err)?.iter().map(|s| s.trim_start_matches('\u{feff}').to_owned()).collect(),
        None => return Err(AppError::Invalid("The file is empty".into())),
    };
    let rows = records.take(20).filter_map(|r| r.ok()).map(|r| r.iter().map(str::to_owned).collect()).collect();
    Ok(CsvPreview {
        path: path.to_owned(),
        delimiter: if delimiter == b'\t' { "\\t".into() } else { (delimiter as char).to_string() },
        headers,
        rows,
        size_bytes,
    })
}

/// Imports a CSV file into a table. All rows or none: a failure rolls everything back.
pub async fn import_csv(session: &Session, schema: &str, table: &str, plan: ImportPlan, events: &Progress) -> Result<u64> {
    let targets: Vec<(usize, String)> =
        plan.mapping.iter().enumerate().filter_map(|(i, c)| c.clone().map(|c| (i, c))).collect();
    if targets.is_empty() {
        return Err(AppError::Invalid("Map at least one CSV column to a table column".into()));
    }
    let columns: Vec<String> = targets.iter().map(|(_, c)| c.clone()).collect();
    let delimiter = delimiter_byte(&plan.delimiter)?;

    // Read on a blocking thread, a batch at a time; insert as batches arrive.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<(Vec<Vec<Option<String>>>, u64)>>(4);
    let reader_plan = plan.clone();
    let reader = tokio::task::spawn_blocking(move || {
        let read = || -> Result<()> {
            let mut reader = csv::ReaderBuilder::new()
                .delimiter(delimiter)
                .has_headers(reader_plan.has_header)
                .flexible(true)
                .from_path(&reader_plan.path)
                .map_err(csv_err)?;
            let mut batch = Vec::with_capacity(BATCH_ROWS);
            let mut record = csv::StringRecord::new();
            while reader.read_record(&mut record).map_err(csv_err)? {
                let row = targets
                    .iter()
                    .map(|(i, _)| {
                        let value = record.get(*i).unwrap_or("");
                        (!(reader_plan.empty_as_null && value.is_empty())).then(|| value.to_owned())
                    })
                    .collect();
                batch.push(row);
                if batch.len() == BATCH_ROWS {
                    let position = record.position().map_or(0, |p| p.byte());
                    if tx.blocking_send(Ok((std::mem::take(&mut batch), position))).is_err() {
                        return Ok(());
                    }
                }
            }
            let _ = tx.blocking_send(Ok((batch, u64::MAX)));
            Ok(())
        };
        if let Err(e) = read() {
            let _ = tx.blocking_send(Err(e));
        }
    });

    session.bulk_control("BEGIN").await?;
    let inserted: Result<u64> = async {
        let mut total = 0;
        while let Some(batch) = rx.recv().await {
            let (rows, position) = batch?;
            total += session.insert_rows(schema, table, &columns, rows).await?;
            progress(events, total, (position != u64::MAX).then_some(position));
        }
        Ok(total)
    }
    .await;
    drop(rx);
    let _ = reader.await;
    finish(session, inserted).await
}

/// Inserts rows the UI made (generated test data), in one transaction.
pub async fn insert(session: &Session, schema: &str, table: &str, columns: &[String], rows: Vec<Vec<Option<String>>>) -> Result<u64> {
    session.bulk_control("BEGIN").await?;
    let inserted = async {
        let mut total = 0;
        let mut rows = rows;
        while !rows.is_empty() {
            let rest = rows.split_off(rows.len().min(BATCH_ROWS));
            total += session.insert_rows(schema, table, columns, rows).await?;
            rows = rest;
        }
        Ok(total)
    }
    .await;
    finish(session, inserted).await
}

enum Piece {
    Columns(Vec<String>),
    Rows(Vec<Vec<Option<String>>>),
}

/// Runs `sql` on `source` and inserts its rows into `schema.table` on `target`, streaming:
/// rows go in while the source is still sending. `columns` renames the result's columns
/// for the target (in order); `None` keeps the result's names.
pub async fn copy(
    source: &Session,
    sql: &str,
    target: &Session,
    schema: &str,
    table: &str,
    columns: Option<Vec<String>>,
    events: &Progress,
) -> Result<u64> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Piece>();
    let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let started = Arc::new(Mutex::new(false));
    let channel = {
        let failure = failure.clone();
        let started = started.clone();
        Channel::new(move |body| {
            match body {
                InvokeResponseBody::Json(json) => {
                    let event: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
                    match event["type"].as_str() {
                        Some("resultStart") => {
                            let mut started = started.lock().unwrap();
                            if !*started {
                                *started = true;
                                let names = event["columns"]
                                    .as_array()
                                    .map(|c| c.iter().map(|v| v.as_str().unwrap_or("").to_owned()).collect())
                                    .unwrap_or_default();
                                let _ = tx.send(Piece::Columns(names));
                            }
                        }
                        Some("error") => {
                            *failure.lock().unwrap() = event["error"]["message"].as_str().map(str::to_owned);
                        }
                        _ => {}
                    }
                }
                InvokeResponseBody::Raw(bytes) => {
                    if let Ok(reader) = StreamReader::try_new(bytes.as_slice(), None) {
                        for batch in reader.flatten() {
                            let columns: Vec<&StringArray> =
                                batch.columns().iter().filter_map(|c| c.as_any().downcast_ref::<StringArray>()).collect();
                            let rows = (0..batch.num_rows())
                                .map(|r| columns.iter().map(|c| (!c.is_null(r)).then(|| c.value(r).to_owned())).collect())
                                .collect();
                            let _ = tx.send(Piece::Rows(rows));
                        }
                    }
                }
            }
            Ok(())
        })
    };

    target.bulk_control("BEGIN").await?;
    let consume = async {
        let mut names: Vec<String> = Vec::new();
        let mut total = 0;
        while let Some(piece) = rx.recv().await {
            match piece {
                Piece::Columns(result_names) => {
                    names = match &columns {
                        Some(c) if c.len() == result_names.len() => c.clone(),
                        Some(_) => return Err(AppError::Invalid("The column list doesn't match the query's columns".into())),
                        None => result_names,
                    };
                }
                Piece::Rows(rows) => {
                    for chunk in rows.chunks(BATCH_ROWS) {
                        total += target.insert_rows(schema, table, &names, chunk.to_vec()).await?;
                        progress(events, total, None);
                    }
                }
            }
        }
        Ok(total)
    };
    let produce = async {
        let summary = source.run_read_only(sql, &channel, None).await;
        drop(channel); // closes the stream of rows
        summary
    };
    let (summary, copied) = tokio::join!(produce, consume);
    let copied = summary.and_then(|_| match failure.lock().unwrap().take() {
        Some(e) => Err(AppError::Invalid(format!("Source query failed: {e}"))),
        None => Ok(()),
    })
    .and(copied);
    finish(target, copied).await
}

async fn finish(session: &Session, outcome: Result<u64>) -> Result<u64> {
    match outcome {
        Ok(total) => {
            session.bulk_control("COMMIT").await?;
            Ok(total)
        }
        Err(e) => {
            let _ = session.bulk_control("ROLLBACK").await;
            Err(e)
        }
    }
}

fn csv_err(e: csv::Error) -> AppError {
    AppError::Invalid(format!("CSV: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::stream::testing::recorder;
    use uuid::Uuid;

    fn sqlite_session_with(sql: &str) -> (String, crate::connections::ConnectionConfig) {
        let path = std::env::temp_dir().join(format!("onyx-bulk-{}.db", Uuid::new_v4())).display().to_string();
        rusqlite::Connection::open(&path).unwrap().execute_batch(sql).unwrap();
        let config = crate::connections::ConnectionConfig {
            id: Uuid::new_v4(),
            engine: crate::connections::Engine::Sqlite,
            name: "bulk".into(),
            host: String::new(),
            port: 0,
            user: String::new(),
            database: path.clone(),
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
        (path, config)
    }

    async fn count(session: &Session, sql: &str) -> String {
        let (channel, log) = recorder();
        session.run(sql, &channel).await.unwrap();
        let log = log.lock().unwrap();
        let batch = crate::db::stream::testing::batches(&log)[0].clone();
        batch.column(0).as_any().downcast_ref::<StringArray>().unwrap().value(0).to_owned()
    }

    #[tokio::test]
    async fn imports_csv_and_rolls_back_on_errors() {
        let (path, config) = sqlite_session_with("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)");
        let session = Session::connect(&config, None, None).await.unwrap();
        let csv_path = std::env::temp_dir().join(format!("onyx-{}.csv", Uuid::new_v4()));
        let mut text = String::from("\u{feff}name;age;ignored\n");
        for i in 0..2500 {
            text += &format!("\"person; {i}\";{};x\n", if i % 10 == 0 { String::new() } else { i.to_string() });
        }
        std::fs::write(&csv_path, &text).unwrap();
        let p = preview(csv_path.to_str().unwrap()).unwrap();
        assert_eq!((p.delimiter.as_str(), p.headers[0].as_str(), p.rows.len()), (";", "name", 20));

        let plan = ImportPlan {
            path: p.path.clone(),
            delimiter: p.delimiter.clone(),
            has_header: true,
            mapping: vec![Some("name".into()), Some("age".into()), None],
            empty_as_null: true,
        };
        let (events, _) = recorder();
        assert_eq!(import_csv(&session, "main", "people", plan.clone(), &events).await.unwrap(), 2500);
        assert_eq!(count(&session, "SELECT count(*) FROM people WHERE age IS NULL").await, "250");

        // A NULL into a NOT NULL column fails the whole import.
        let bad = ImportPlan { mapping: vec![None, Some("name".into()), None], ..plan };
        assert!(import_csv(&session, "main", "people", bad, &events).await.is_err());
        assert_eq!(count(&session, "SELECT count(*) FROM people").await, "2500");
        std::fs::remove_file(csv_path).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn copies_rows_between_connections() {
        let (from_path, from) = sqlite_session_with(
            "CREATE TABLE src (a INTEGER, b TEXT);
             WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3000) INSERT INTO src SELECT x, 'v' || x FROM n;",
        );
        let (to_path, to) = sqlite_session_with("CREATE TABLE dst (x INTEGER, y TEXT)");
        let source = Session::connect(&from, None, None).await.unwrap();
        let target = Session::connect(&to, None, None).await.unwrap();
        let (events, _) = recorder();
        let copied = copy(&source, "SELECT a, b FROM src", &target, "main", "dst", Some(vec!["x".into(), "y".into()]), &events)
            .await
            .unwrap();
        assert_eq!(copied, 3000);
        assert_eq!(count(&target, "SELECT max(x) FROM dst").await, "3000");
        assert!(copy(&source, "SELECT nope FROM src", &target, "main", "dst", None, &events).await.is_err());
        assert_eq!(count(&target, "SELECT count(*) FROM dst").await, "3000");

        let generated = (0..1200).map(|i| vec![Some(i.to_string()), None]).collect();
        assert_eq!(insert(&target, "main", "dst", &["x".into(), "y".into()], generated).await.unwrap(), 1200);
        std::fs::remove_file(from_path).unwrap();
        std::fs::remove_file(to_path).unwrap();
    }
}
