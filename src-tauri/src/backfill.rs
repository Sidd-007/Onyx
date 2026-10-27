//! F07: resumable backfills and bulk repairs (PostgreSQL, one table, a stable unique key).
//!
//! The candidate rows are materialized once into `onyx_job_keys`. Each batch, in ONE
//! transaction: updates its rows (only those still eligible), marks its keys done or skipped,
//! and bumps the job's counters. So a crash leaves either the whole batch and its checkpoint,
//! or neither: resuming continues with exactly the keys still pending. Triggers or functions
//! with effects outside the database are not covered by that guarantee.

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::connections::Engine;
use crate::db::Session;
use crate::dialect::{ident, literal};
use crate::error::{AppError, Result};
use crate::journal::collect;

fn setup_sql(jt: &str, kt: &str) -> String {
    format!("CREATE TABLE IF NOT EXISTS {jt} (
    id text PRIMARY KEY, spec jsonb NOT NULL, status text NOT NULL,
    candidates bigint NOT NULL DEFAULT 0, committed bigint NOT NULL DEFAULT 0, skipped bigint NOT NULL DEFAULT 0, failed bigint NOT NULL DEFAULT 0,
    batches bigint NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS {kt} (
    job_id text NOT NULL REFERENCES {jt} (id) ON DELETE CASCADE, ord bigint NOT NULL, k text NOT NULL,
    state text NOT NULL DEFAULT 'pending', error text, PRIMARY KEY (job_id, ord));")
}

/// Onyx's job tables, in the schema of the table being changed.
fn tables(schema: &str) -> (String, String) {
    (format!("{}.onyx_jobs", q(schema)), format!("{}.onyx_job_keys", q(schema)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub schema: String,
    pub table: String,
    /// A unique, stable key column.
    pub key: String,
    /// Which rows need the change (a WHERE condition), checked again in every batch.
    pub eligible: String,
    /// The change: `SET` assignments, e.g. `status = 'archived', archived_at = now()`.
    pub set: String,
    /// After the job, no done row should match this (e.g. `status <> 'archived'`).
    pub postcondition: String,
    pub batch_size: i64,
    pub pause_ms: u64,
    pub lock_timeout_ms: u64,
    /// Stop (pause) after this many failed batches.
    pub max_failed_batches: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub spec: JobSpec,
    pub status: String,
    pub candidates: i64,
    pub committed: i64,
    pub skipped: i64,
    pub failed: i64,
    pub pending: i64,
    pub batches: i64,
    pub last_error: Option<String>,
    pub updated_at: String,
}

fn stops() -> &'static Mutex<HashSet<String>> {
    static STOPS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    STOPS.get_or_init(Default::default)
}

/// Asks a running job to stop after its current batch (a committed batch stays committed).
pub fn pause(job: &str) {
    stops().lock().unwrap().insert(job.to_owned());
}

fn pg(session: &Session) -> Result<()> {
    if session.engine() != Engine::Postgres {
        return Err(AppError::Invalid("Resumable backfills work on PostgreSQL".into()));
    }
    Ok(())
}

fn q(s: &str) -> String {
    ident(Engine::Postgres, s)
}

/// Creates Onyx's two job tables in the current schema (asked for explicitly by the user).
pub async fn setup(session: &Session, schema: &str) -> Result<()> {
    pg(session)?;
    let (jt, kt) = tables(schema);
    session.execute_meta(&setup_sql(&jt, &kt)).await
}

async fn scalar(session: &Session, sql: &str, tab: &str) -> Result<Option<String>> {
    Ok(collect(session, sql, Some(tab), Some(1)).await?.1.into_iter().next().and_then(|r| r.into_iter().next().flatten()))
}

/// Validates the spec, materializes the candidate keys (in key order) and records the job.
pub async fn create(session: &Session, spec: &JobSpec) -> Result<Job> {
    pg(session)?;
    if spec.batch_size < 1 || spec.batch_size > 50_000 {
        return Err(AppError::Invalid("Batch size must be between 1 and 50,000".into()));
    }
    if spec.set.trim().is_empty() || spec.eligible.trim().is_empty() {
        return Err(AppError::Invalid("Say which rows (eligible) and what to change (SET)".into()));
    }
    let columns = session.columns(&spec.schema, &spec.table).await?;
    let key = columns.iter().find(|c| c.name == spec.key).ok_or_else(|| AppError::Invalid(format!("{} has no column {}", spec.table, spec.key)))?;
    let target = format!("{}.{}", q(&spec.schema), q(&spec.table));
    let tab = format!("backfill:{}", uuid::Uuid::new_v4().simple());
    let unique = scalar(
        session,
        &format!(
            "SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ALL (i.indkey) WHERE i.indrelid = {}::regclass AND i.indisunique AND i.indnkeyatts = 1 AND a.attname = {}",
            literal(Engine::Postgres, &target),
            literal(Engine::Postgres, &spec.key)
        ),
        &tab,
    )
    .await?;
    if unique.as_deref().unwrap_or("0") == "0" && !key.primary_key {
        session.close_tab(&tab).await;
        return Err(AppError::Invalid(format!("{} must be unique (a primary key or unique index) to track progress", spec.key)));
    }
    let (jt, kt) = tables(&spec.schema);
    let id = format!("job_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let spec_json = serde_json::to_string(spec).map_err(|e| AppError::Invalid(e.to_string()))?;
    let work = async {
        session.execute_script("BEGIN", &tab).await?;
        session.execute_script(&format!("INSERT INTO {jt} (id, spec, status) VALUES ({}, {}::jsonb, 'ready')", literal(Engine::Postgres, &id), literal(Engine::Postgres, &spec_json)), &tab).await?;
        session
            .execute_script(
                &format!("INSERT INTO {kt} (job_id, ord, k) SELECT {}, row_number() OVER (ORDER BY {k}), {k}::text FROM {target} WHERE {}", literal(Engine::Postgres, &id), spec.eligible, k = q(&spec.key)),
                &tab,
            )
            .await?;
        session.execute_script(&format!("UPDATE {jt} SET candidates = (SELECT count(*) FROM {kt} WHERE job_id = {0}) WHERE id = {0}", literal(Engine::Postgres, &id)), &tab).await?;
        session.execute_script("COMMIT", &tab).await
    }
    .await;
    if work.is_err() {
        let _ = session.execute_script("ROLLBACK", &tab).await;
    }
    session.close_tab(&tab).await;
    work?;
    get(session, &spec.schema, &id).await
}

pub async fn list(session: &Session, schema: &str) -> Result<Vec<Job>> {
    pg(session)?;
    let (jt, _) = tables(schema);
    let exists = collect(session, &format!("SELECT to_regclass({}) IS NOT NULL", literal(Engine::Postgres, &jt)), None, Some(1)).await?.1;
    if exists.first().and_then(|r| r[0].as_deref()) != Some("t") {
        return Ok(vec![]);
    }
    let (_, rows) = collect(session, &format!("SELECT id FROM {jt} ORDER BY created_at DESC LIMIT 100"), None, None).await?;
    let mut out = Vec::new();
    for r in rows {
        if let Some(id) = r[0].as_deref() {
            out.push(get(session, schema, id).await?);
        }
    }
    Ok(out)
}

pub async fn get(session: &Session, schema: &str, id: &str) -> Result<Job> {
    let (jt, kt) = tables(schema);
    let lid = literal(Engine::Postgres, id);
    let (_, rows) = collect(
        session,
        &format!("SELECT spec::text, status, candidates, committed, skipped, failed, batches, last_error, updated_at::text, (SELECT count(*) FROM {kt} WHERE job_id = {lid} AND state = 'pending') FROM {jt} WHERE id = {lid}"),
        None,
        Some(1),
    )
    .await?;
    let r = rows.into_iter().next().ok_or_else(|| AppError::Invalid(format!("No job {id}")))?;
    let n = |i: usize| r[i].as_deref().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(Job {
        id: id.to_owned(),
        spec: serde_json::from_str(r[0].as_deref().unwrap_or("{}")).map_err(|e| AppError::Invalid(format!("Job spec: {e}")))?,
        status: r[1].clone().unwrap_or_default(),
        candidates: n(2),
        committed: n(3),
        skipped: n(4),
        failed: n(5),
        batches: n(6),
        last_error: r[7].clone(),
        updated_at: r[8].clone().unwrap_or_default(),
        pending: n(9),
    })
}

fn progress(events: &Channel<InvokeResponseBody>, job: &Job) {
    let _ = events.send(InvokeResponseBody::Json(serde_json::json!({ "type": "progress", "committed": job.committed, "skipped": job.skipped, "failed": job.failed, "pending": job.pending, "batches": job.batches }).to_string()));
}

/// Runs (or resumes) a job until it's done, paused, or stopped by failures. The spec is the
/// one stored with the job: it can't change between runs.
pub async fn run(session: &Session, schema: &str, id: &str, events: &Channel<InvokeResponseBody>) -> Result<Job> {
    pg(session)?;
    stops().lock().unwrap().remove(id);
    let (jt, kt) = tables(schema);
    let job = get(session, schema, id).await?;
    if job.status == "done" {
        return Ok(job);
    }
    let spec = job.spec.clone();
    let lid = literal(Engine::Postgres, id);
    let target = format!("{}.{}", q(&spec.schema), q(&spec.table));
    let key_type = session.columns(&spec.schema, &spec.table).await?.into_iter().find(|c| c.name == spec.key).map(|c| c.data_type).ok_or_else(|| AppError::Invalid("The key column is gone".into()))?;
    let tab = format!("backfill:{id}");
    session.execute_meta(&format!("UPDATE {jt} SET status = 'running', updated_at = now() WHERE id = {lid}")).await?;
    let mut failed_batches = 0;
    let outcome: Result<&str> = async {
        loop {
            if stops().lock().unwrap().remove(id) {
                return Ok("paused");
            }
            // One batch: the change and its checkpoint commit together.
            session.execute_script("BEGIN", &tab).await?;
            let batch = async {
                session.execute_script(&format!("SET LOCAL lock_timeout = '{}ms'", spec.lock_timeout_ms.max(100)), &tab).await?;
                let (_, keys) = collect(session, &format!("SELECT ord FROM {kt} WHERE job_id = {lid} AND state = 'pending' ORDER BY ord LIMIT {} FOR UPDATE SKIP LOCKED", spec.batch_size), Some(&tab), None).await?;
                let ords: Vec<String> = keys.into_iter().filter_map(|r| r[0].clone()).collect();
                if ords.is_empty() {
                    return Ok::<_, AppError>(None);
                }
                let batch_keys = format!("SELECT CAST(k AS {key_type}) FROM {kt} WHERE job_id = {lid} AND ord IN ({})", ords.join(", "));
                let (_, updated) = collect(session, &format!("UPDATE {target} SET {} WHERE {k} IN ({batch_keys}) AND ({}) RETURNING {k}::text", spec.set, spec.eligible, k = q(&spec.key)), Some(&tab), None).await?;
                let done: Vec<String> = updated.into_iter().filter_map(|r| r[0].clone()).map(|k| literal(Engine::Postgres, &k)).collect();
                let in_batch = format!("job_id = {lid} AND ord IN ({})", ords.join(", "));
                if !done.is_empty() {
                    session.execute_script(&format!("UPDATE {kt} SET state = 'done' WHERE {in_batch} AND k IN ({})", done.join(", ")), &tab).await?;
                }
                // Not updated: deleted, or no longer eligible (changed by someone else meanwhile).
                session.execute_script(&format!("UPDATE {kt} SET state = 'skipped' WHERE {in_batch} AND state = 'pending'"), &tab).await?;
                let skipped = ords.len() - done.len();
                session
                    .execute_script(&format!("UPDATE {jt} SET committed = committed + {}, skipped = skipped + {skipped}, batches = batches + 1, updated_at = now() WHERE id = {lid}", done.len()), &tab)
                    .await?;
                Ok(Some(ords))
            }
            .await;
            match batch {
                Ok(None) => {
                    session.execute_script("ROLLBACK", &tab).await?;
                    return Ok("done");
                }
                Ok(Some(_)) => session.execute_script("COMMIT", &tab).await?,
                Err(e) => {
                    // Nothing of the batch committed. Its keys are marked failed (outside it), so the
                    // job can go on; they can be retried by resetting them to pending.
                    let _ = session.execute_script("ROLLBACK", &tab).await;
                    failed_batches += 1;
                    let msg = e.to_string();
                    session
                        .execute_script(
                            &format!(
                                "WITH b AS (SELECT ord FROM {kt} WHERE job_id = {lid} AND state = 'pending' ORDER BY ord LIMIT {}) UPDATE {kt} k SET state = 'failed', error = {} FROM b WHERE k.job_id = {lid} AND k.ord = b.ord",
                                spec.batch_size,
                                literal(Engine::Postgres, &msg)
                            ),
                            &tab,
                        )
                        .await?;
                    session.execute_script(&format!("UPDATE {jt} SET failed = (SELECT count(*) FROM {kt} WHERE job_id = {lid} AND state = 'failed'), last_error = {}, updated_at = now() WHERE id = {lid}", literal(Engine::Postgres, &msg)), &tab).await?;
                    if failed_batches >= spec.max_failed_batches.max(1) {
                        return Ok("paused-failures");
                    }
                }
            }
            progress(events, &get(session, schema, id).await?);
            if spec.pause_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(spec.pause_ms)).await;
            }
        }
    }
    .await;
    let status = match &outcome {
        Ok(s) => (*s).to_owned(),
        Err(_) => "interrupted".to_owned(),
    };
    let _ = session.execute_script("ROLLBACK", &tab).await;
    session.close_tab(&tab).await;
    session.execute_meta(&format!("UPDATE {jt} SET status = {}, updated_at = now() WHERE id = {lid}", literal(Engine::Postgres, &status))).await?;
    outcome?;
    get(session, schema, id).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub checked: i64,
    /// Done rows that still match the postcondition (they shouldn't).
    pub violations: i64,
    pub examples: Vec<String>,
    pub skipped: i64,
    pub failed: i64,
}

/// Checks the job's postcondition on every row it changed.
pub async fn verify(session: &Session, schema: &str, id: &str) -> Result<Verification> {
    let (_, kt) = tables(schema);
    let job = get(session, schema, id).await?;
    let spec = &job.spec;
    let lid = literal(Engine::Postgres, id);
    let key_type = session.columns(&spec.schema, &spec.table).await?.into_iter().find(|c| c.name == spec.key).map(|c| c.data_type).unwrap_or_else(|| "text".into());
    let done = format!("{} IN (SELECT CAST(k AS {key_type}) FROM {kt} WHERE job_id = {lid} AND state = 'done')", q(&spec.key));
    let target = format!("{}.{}", q(&spec.schema), q(&spec.table));
    let checked = collect(session, &format!("SELECT count(*) FROM {target} WHERE {done}"), None, Some(1)).await?.1[0][0].as_deref().and_then(|v| v.parse().ok()).unwrap_or(0);
    let post = if spec.postcondition.trim().is_empty() { "FALSE".to_owned() } else { format!("({})", spec.postcondition) };
    let (_, bad) = collect(session, &format!("SELECT {}::text FROM {target} WHERE {done} AND {post} LIMIT 20", q(&spec.key)), None, None).await?;
    let violations = collect(session, &format!("SELECT count(*) FROM {target} WHERE {done} AND {post}"), None, Some(1)).await?.1[0][0].as_deref().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(Verification { checked, violations, examples: bad.into_iter().filter_map(|r| r[0].clone()).collect(), skipped: job.skipped, failed: job.failed })
}

/// Puts failed keys back to pending, for another run.
pub async fn retry_failed(session: &Session, schema: &str, id: &str) -> Result<()> {
    let (jt, kt) = tables(schema);
    let lid = literal(Engine::Postgres, id);
    session.execute_meta(&format!("UPDATE {kt} SET state = 'pending', error = NULL WHERE job_id = {lid} AND state = 'failed'; UPDATE {jt} SET failed = 0, status = 'ready' WHERE id = {lid}")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ONYX_TEST_PG=1 cargo test backfill`: batches commit with their checkpoint; pausing and
    /// resuming finishes exactly the rest; rows changed meanwhile are skipped; a failing batch
    /// commits nothing; the postcondition is verified.
    #[tokio::test]
    async fn runs_pauses_resumes_and_verifies() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = std::sync::Arc::new(Session::connect(&config, None, None).await.unwrap());
        let s = format!("onyx_bf_{}", uuid::Uuid::new_v4().simple());
        session.execute_meta(&format!("CREATE SCHEMA {s}; CREATE TABLE {s}.events (id int PRIMARY KEY, status text, n int); INSERT INTO {s}.events SELECT g, 'old', g FROM generate_series(1, 1000) g")).await.unwrap();
        setup(&session, &s).await.unwrap();
        // Row 500 divides by zero: its batch (401–500) must fail and commit nothing.
        let spec = JobSpec { schema: s.clone(), table: "events".into(), key: "id".into(), eligible: "status = 'old'".into(), set: "status = 'archived', n = 100 / (n - 500)".into(), postcondition: "status <> 'archived'".into(), batch_size: 100, pause_ms: 60, lock_timeout_ms: 2000, max_failed_batches: 3 };
        let job = create(&session, &spec).await.unwrap();
        assert_eq!(job.candidates, 1000);
        // Someone else changes row 950 so it's no longer eligible.
        session.execute_meta(&format!("UPDATE {s}.events SET status = 'kept' WHERE id = 950")).await.unwrap();
        let (events, _) = crate::db::stream::testing::recorder();
        let (sess, sch, id, ev) = (session.clone(), s.clone(), job.id.clone(), events.clone());
        let running = tokio::spawn(async move { run(&sess, &sch, &id, &ev).await });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        pause(&job.id);
        let paused = running.await.unwrap().unwrap();
        assert_eq!(paused.status, "paused");
        assert!(paused.committed > 0 && paused.pending > 0, "{paused:?}");
        let (_, rows) = collect(&session, &format!("SELECT count(*) FROM {s}.events WHERE status = 'archived'"), None, None).await.unwrap();
        assert_eq!(rows[0][0].as_deref().unwrap().parse::<i64>().unwrap(), paused.committed, "the checkpoint matches the committed data exactly");
        let done = run(&session, &s, &job.id, &events).await.unwrap();
        assert_eq!(done.status, "done", "{done:?}");
        assert_eq!((done.committed, done.skipped, done.failed), (899, 1, 100), "{done:?}");
        let (_, rows) = collect(&session, &format!("SELECT count(*) FROM {s}.events WHERE id BETWEEN 401 AND 500 AND status = 'old'"), None, None).await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("100"), "the failed batch left its rows untouched");
        let v = verify(&session, &s, &job.id).await.unwrap();
        assert_eq!((v.checked, v.violations), (899, 0));
        assert_eq!(list(&session, &s).await.unwrap().len(), 1);
        session.execute_meta(&format!("DROP SCHEMA {s} CASCADE")).await.unwrap();
    }
}
