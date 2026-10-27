//! Streams query results to the UI, the same way for every engine.
//!
//! Values arrive as text (what the engine's own CLI would print). Rows are packed into
//! Arrow record batches of UTF-8 columns and sent as raw bytes over a Tauri channel;
//! control messages (result start/end, errors, done) go over the same channel as JSON.

use std::sync::Arc;
use std::time::{Duration, Instant};

use arrow_array::builder::StringBuilder;
use arrow_array::{ArrayRef, RecordBatch};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{AppError, ErrorPayload, Result};

/// Rows in the first batch of each result: small, so something paints fast.
pub const FIRST_BATCH_ROWS: usize = 500;
const BATCH_ROWS: usize = 10_000;
/// Flush a partial batch if rows trickle in slower than this.
const MAX_BATCH_DELAY: Duration = Duration::from_millis(100);

pub type Events = Channel<InvokeResponseBody>;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QueryEvent {
    /// A result set begins; Arrow batches that follow belong to it.
    #[serde(rename_all = "camelCase")]
    ResultStart { index: usize, columns: Vec<String> },
    /// `truncated`: rows past the run's limit were read but not sent; `row_count` counts them all.
    #[serde(rename_all = "camelCase")]
    ResultEnd { index: usize, row_count: u64, truncated: bool },
    /// A statement that returns no rows (INSERT, UPDATE, CREATE, ...).
    #[serde(rename_all = "camelCase")]
    Command { index: usize, rows_affected: u64 },
    /// `cancelled` is true when the user cancelled the query.
    Error { error: ErrorPayload, cancelled: bool },
    #[serde(rename_all = "camelCase")]
    Done { elapsed_ms: f64 },
}

/// How a run ended, for query history.
#[derive(Debug, Clone)]
pub struct RunSummary {
    pub elapsed_ms: f64,
    /// Rows returned plus rows affected.
    pub row_count: u64,
    pub error: Option<String>,
    pub cancelled: bool,
}

/// One query run: numbers result sets and builds the one being streamed.
pub struct Run<'a> {
    events: &'a Events,
    started: Instant,
    index: usize,
    current: Option<ResultBuilder>,
    row_count: u64,
    /// Rows kept per result set; the rest are read and dropped.
    limit: Option<u64>,
}

impl<'a> Run<'a> {
    pub fn new(events: &'a Events) -> Self {
        Self { events, started: Instant::now(), index: 0, current: None, row_count: 0, limit: None }
    }

    pub fn with_limit(events: &'a Events, limit: Option<u64>) -> Self {
        Self { limit, ..Self::new(events) }
    }

    pub fn in_result(&self) -> bool {
        self.current.is_some()
    }

    pub fn start_result(&mut self, columns: Vec<String>) -> Result<()> {
        let width = columns.len();
        send_event(self.events, &QueryEvent::ResultStart { index: self.index, columns })?;
        self.current = Some(ResultBuilder::new(width, self.limit));
        Ok(())
    }

    pub fn push_row<S: AsRef<str>>(&mut self, values: impl IntoIterator<Item = Option<S>>) -> Result<()> {
        let result = self
            .current
            .as_mut()
            .ok_or_else(|| AppError::Invalid("row before row description".into()))?;
        result.push(values);
        if result.should_flush() {
            result.flush(self.events)?;
        }
        Ok(())
    }

    /// Ends the current result set. `row_count`: what the server reported, if anything.
    pub fn end_result(&mut self, row_count: Option<u64>) -> Result<()> {
        if let Some(mut result) = self.current.take() {
            result.flush(self.events)?;
            let row_count = row_count.unwrap_or(result.total);
            self.row_count += row_count;
            let truncated = result.dropped > 0;
            send_event(self.events, &QueryEvent::ResultEnd { index: self.index, row_count, truncated })?;
            self.index += 1;
        }
        Ok(())
    }

    pub fn command(&mut self, rows_affected: u64) -> Result<()> {
        self.row_count += rows_affected;
        send_event(self.events, &QueryEvent::Command { index: self.index, rows_affected })?;
        self.index += 1;
        Ok(())
    }

    /// Reports how the run ended. Rows that arrived before an error (e.g. a cancel) are kept.
    pub fn finish(mut self, outcome: Result<()>, error: Option<(ErrorPayload, bool)>) -> Result<RunSummary> {
        let mut summary_error = None;
        let mut cancelled = false;
        if outcome.is_err() {
            self.end_result(None)?;
            if let Some((error, was_cancelled)) = error {
                summary_error = Some(error.message.clone());
                cancelled = was_cancelled;
                send_event(self.events, &QueryEvent::Error { error, cancelled })?;
            }
        }
        let elapsed_ms = self.started.elapsed().as_secs_f64() * 1000.0;
        send_event(self.events, &QueryEvent::Done { elapsed_ms })?;
        Ok(RunSummary { elapsed_ms, row_count: self.row_count, error: summary_error, cancelled })
    }
}

fn send_event(events: &Events, event: &QueryEvent) -> Result<()> {
    let json = serde_json::to_string(event).map_err(|e| AppError::Invalid(e.to_string()))?;
    events.send(InvokeResponseBody::Json(json)).map_err(|e| AppError::Invalid(e.to_string()))
}

/// Accumulates one result set's rows into Arrow string columns.
struct ResultBuilder {
    schema: Arc<Schema>,
    columns: Vec<StringBuilder>,
    rows: usize,
    total: u64,
    /// Rows past the limit, read but not kept.
    dropped: u64,
    limit: Option<u64>,
    batches_sent: usize,
    last_flush: Instant,
}

impl ResultBuilder {
    fn new(width: usize, limit: Option<u64>) -> Self {
        // Positional field names: real names (which may repeat) are sent in `ResultStart`.
        let fields: Vec<Field> =
            (0..width).map(|i| Field::new(format!("c{i}"), DataType::Utf8, true)).collect();
        Self {
            schema: Arc::new(Schema::new(fields)),
            columns: (0..width).map(|_| StringBuilder::new()).collect(),
            rows: 0,
            total: 0,
            dropped: 0,
            limit,
            batches_sent: 0,
            last_flush: Instant::now(),
        }
    }

    fn push<S: AsRef<str>>(&mut self, values: impl IntoIterator<Item = Option<S>>) {
        if self.limit.is_some_and(|limit| self.total - self.dropped >= limit) {
            self.total += 1;
            self.dropped += 1;
            return;
        }
        for (column, value) in self.columns.iter_mut().zip(values) {
            column.append_option(value);
        }
        self.rows += 1;
        self.total += 1;
    }

    fn should_flush(&self) -> bool {
        let target = if self.batches_sent == 0 { FIRST_BATCH_ROWS } else { BATCH_ROWS };
        self.rows >= target || self.last_flush.elapsed() >= MAX_BATCH_DELAY
    }

    fn flush(&mut self, events: &Events) -> Result<()> {
        if self.rows == 0 {
            return Ok(());
        }
        let arrays: Vec<ArrayRef> =
            self.columns.iter_mut().map(|c| Arc::new(c.finish()) as ArrayRef).collect();
        let batch = RecordBatch::try_new(self.schema.clone(), arrays).map_err(arrow_err)?;
        let bytes = encode(&batch)?;
        events.send(InvokeResponseBody::Raw(bytes)).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.rows = 0;
        self.batches_sent += 1;
        self.last_flush = Instant::now();
        Ok(())
    }
}

/// One self-contained Arrow IPC stream (schema + batch) per message.
fn encode(batch: &RecordBatch) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut writer = StreamWriter::try_new(&mut bytes, &batch.schema()).map_err(arrow_err)?;
    writer.write(batch).map_err(arrow_err)?;
    writer.finish().map_err(arrow_err)?;
    drop(writer);
    Ok(bytes)
}

fn arrow_err(e: arrow_schema::ArrowError) -> AppError {
    AppError::Invalid(format!("arrow: {e}"))
}

#[cfg(test)]
mod tests {
    use super::testing::{batches, events, recorder};
    use super::*;

    #[test]
    fn keeps_rows_up_to_the_limit_and_counts_the_rest() {
        let (channel, log) = recorder();
        let mut run = Run::with_limit(&channel, Some(3));
        run.start_result(vec!["n".into()]).unwrap();
        for i in 0..10 {
            run.push_row([Some(i.to_string())]).unwrap();
        }
        run.end_result(None).unwrap();
        run.finish(Ok(()), None).unwrap();
        let log = log.lock().unwrap();
        assert_eq!(batches(&log).iter().map(|b| b.num_rows()).sum::<usize>(), 3);
        let end = events(&log).into_iter().find(|e| e["type"] == "resultEnd").unwrap().clone();
        assert_eq!(end["rowCount"], 10);
        assert_eq!(end["truncated"], true);
    }
}

/// Test helpers: a channel that records what was sent, decoded.
#[cfg(test)]
pub mod testing {
    use std::sync::{Arc, Mutex};

    use arrow_array::RecordBatch;
    use arrow_ipc::reader::StreamReader;
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[derive(Debug)]
    pub enum Received {
        Event(serde_json::Value),
        Batch(RecordBatch),
    }

    pub fn recorder() -> (Channel<InvokeResponseBody>, Arc<Mutex<Vec<Received>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        let channel = Channel::new(move |body| {
            let item = match body {
                InvokeResponseBody::Json(json) => Received::Event(serde_json::from_str(&json).unwrap()),
                InvokeResponseBody::Raw(bytes) => {
                    let mut reader = StreamReader::try_new(bytes.as_slice(), None).unwrap();
                    Received::Batch(reader.next().unwrap().unwrap())
                }
            };
            sink.lock().unwrap().push(item);
            Ok(())
        });
        (channel, log)
    }

    pub fn events(log: &[Received]) -> Vec<&serde_json::Value> {
        log.iter().filter_map(|r| if let Received::Event(e) = r { Some(e) } else { None }).collect()
    }

    pub fn event_types(log: &[Received]) -> Vec<String> {
        events(log).iter().map(|e| e["type"].as_str().unwrap().to_owned()).collect()
    }

    pub fn batches(log: &[Received]) -> Vec<&RecordBatch> {
        log.iter().filter_map(|r| if let Received::Batch(b) = r { Some(b) } else { None }).collect()
    }
}
