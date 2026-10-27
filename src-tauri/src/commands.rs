use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use uuid::Uuid;

use crate::appdb::{now_ms, HistoryEntry, SavedQuery};
use crate::connections::{ConnectionConfig, Engine, Environment};
use crate::error::{AppError, Result};
use crate::db::edit::RowEdit;
use crate::db::model::{ColumnInfo, CompletionTable, ConnectInfo, DbObject, ForeignKeyRef, TableSnapshot, TableStructure};
use crate::export::{self, ExportFormat, ExportResult};
use crate::db::Session;
use crate::guard::{self, Risk};
use crate::{secrets, ssh};
use crate::state::AppState;

/// Basic facts about the running app, used by the UI to prove the IPC bridge works.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub tauri_version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Onyx",
        version: env!("CARGO_PKG_VERSION"),
        tauri_version: tauri::VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// The UI has rendered and is ready. Returns true in startup-probe mode
/// (`ONYX_STARTUP_PROBE=1`): the app then prints how long startup took and quits before
/// touching the vault, so release builds can be timed without a Keychain prompt.
#[tauri::command]
pub fn app_ready(app: tauri::AppHandle) -> bool {
    let elapsed = crate::STARTED.get().map(|t| t.elapsed().as_secs_f64() * 1000.0).unwrap_or_default();
    if std::env::var_os("ONYX_STARTUP_PROBE").is_none() {
        return false;
    }
    let epoch_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    println!("onyx-startup ready_ms_since_main={elapsed:.1} ready_epoch_ms={epoch_ms}");
    let hold = std::env::var("ONYX_STARTUP_PROBE").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    std::thread::spawn(move || {
        // Optionally stay up (idle, vault untouched) so memory can be measured.
        std::thread::sleep(std::time::Duration::from_secs(hold.max(1)));
        app.exit(0);
    });
    true
}

/// Frontend errors, printed in the terminal running the app.
#[tauri::command]
pub fn log_frontend_error(message: String) {
    crate::redact::log(format!("[ui error] {message}"));
}

// ---- Saved connections ----

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionConfig> {
    state.store.lock().unwrap().list().to_vec()
}

/// `password` and `ssh_secret`: `None` keeps the stored one, `Some("")` removes it,
/// anything else replaces it.
#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<()> {
    config.validate()?;
    // A password typed into a MongoDB address goes to the vault, never connections.json.
    let from_url = config.take_url_credentials();
    let password = match (password, from_url) {
        (Some(typed), _) if !typed.is_empty() => Some(typed),
        (_, Some(in_url)) => Some(in_url),
        (typed, None) => typed,
    }
    .map(zeroize::Zeroizing::new);
    let ssh_secret = ssh_secret.map(zeroize::Zeroizing::new);
    state.update_secret(&secrets::password_account(&config.id), password.as_deref().map(String::as_str))?;
    state.update_secret(&secrets::ssh_account(&config.id), ssh_secret.as_deref().map(String::as_str))?;
    state.store.lock().unwrap().upsert(config)
}

/// Saves the order of the Connections screen (drag to reorder).
#[tauri::command]
pub fn reorder_connections(state: State<'_, AppState>, ids: Vec<Uuid>) -> Result<()> {
    state.store.lock().unwrap().reorder(&ids)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    state.sessions.write().await.remove(&id);
    state.delete_secret(&secrets::password_account(&id))?;
    state.delete_secret(&secrets::ssh_account(&id))?;
    state.store.lock().unwrap().remove(&id)
}

/// Tries the given settings without saving them. A `None` secret uses the stored one.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<ConnectInfo> {
    config.validate()?;
    let password = match password {
        Some(p) => Some(zeroize::Zeroizing::new(p)),
        None => state.secret(&secrets::password_account(&config.id))?,
    };
    let ssh_secret = match ssh_secret {
        Some(s) => Some(zeroize::Zeroizing::new(s)),
        None => state.secret(&secrets::ssh_account(&config.id))?,
    };
    let session = Session::connect(&config, password, ssh_secret).await?;
    Ok(session.info())
}

/// Trust an SSH host key the user checked (saved to Onyx's known_hosts).
#[tauri::command]
pub fn trust_ssh_host(host: String, port: u16, key: String) -> Result<()> {
    ssh::trust_host_key(&host, port, &key)
}

// ---- Sessions ----

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: Uuid) -> Result<ConnectInfo> {
    if let Some(session) = state.sessions.read().await.get(&id) {
        return Ok(session.info());
    }
    let config = state.config(&id)?;
    let password = state.secret(&secrets::password_account(&id))?;
    let ssh_secret = match config.ssh {
        Some(_) => state.secret(&secrets::ssh_account(&id))?,
        None => None,
    };
    let session = Session::connect(&config, password, ssh_secret).await?;
    let info = session.info();
    state.sessions.write().await.insert(id, Arc::new(session));
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: Uuid) -> Result<()> {
    state.sessions.write().await.remove(&id);
    Ok(())
}

// ---- Schema ----

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, id: Uuid) -> Result<Vec<String>> {
    state.session(&id).await?.schemas().await
}

#[tauri::command]
pub async fn list_objects(state: State<'_, AppState>, id: Uuid, schema: String) -> Result<Vec<DbObject>> {
    state.session(&id).await?.objects(&schema).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    state.session(&id).await?.columns(&schema, &table).await
}

#[tauri::command]
pub async fn table_structure(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
) -> Result<TableStructure> {
    state.session(&id).await?.structure(&schema, &table).await
}

#[tauri::command]
pub async fn completion_tables(state: State<'_, AppState>, id: Uuid) -> Result<Vec<CompletionTable>> {
    state.session(&id).await?.completion_tables().await
}

// ---- Queries ----

/// Statements the prod guard would stop, for any connection.
#[tauri::command]
pub fn check_sql(state: State<'_, AppState>, id: Uuid, sql: String) -> Result<Vec<Risk>> {
    Ok(guard::risky_statements(&sql, state.config(&id)?.engine))
}

/// `record`: add to query history (editor runs; not table browsing).
/// `confirmed`: the user already approved risky statements on a prod connection.
/// `max_rows`: keep at most this many rows per result (the rest are counted, not sent).
/// `timeout_ms`: cancel the query after this long.
/// `tab`: a query tab's own connection, so its transactions and settings stay in that tab.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_query(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
    record: bool,
    confirmed: bool,
    max_rows: Option<u64>,
    timeout_ms: Option<u64>,
    tab: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Result<()> {
    let config = state.config(&id)?;
    if config.read_only && matches!(config.engine, Engine::Postgres | Engine::Mysql | Engine::Sqlserver) {
        crate::readonly::check(&sql, config.engine)?;
    }
    let session = state.session(&id).await?;
    if config.environment == Environment::Prod && !confirmed {
        let mut risks = guard::risky_statements(&sql, config.engine);
        // Every UPDATE / DELETE on prod is shown first (the dialog can preview its rows),
        // and big full scans get a warning.
        for w in crate::journal::writes(&sql, config.engine).0 {
            if !risks.iter().any(|r| r.statement == guard::shorten(&w.text)) {
                risks.push(guard::Risk { statement: guard::shorten(&w.text), reason: "changes rows on prod".into() });
            }
        }
        risks.extend(crate::journal::cost_risks(&session, &sql).await);
        if !risks.is_empty() {
            return Err(AppError::NeedsConfirmation(risks));
        }
    }
    let executed_at = now_ms();
    // The change journal: what UPDATE / DELETE will touch, read before they run.
    let mut planned = if record { crate::journal::plan(&session, &sql, tab.as_deref()).await } else { vec![] };
    let timer = timeout_ms.filter(|&ms| ms > 0).map(|ms| {
        let session = session.clone();
        let tab = tab.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            let _ = session.cancel(tab.as_deref()).await;
        })
    });
    let summary = session.run_limited(&sql, &on_event, max_rows, tab.as_deref()).await;
    if let Some(timer) = timer {
        timer.abort();
    }
    let summary = summary?;
    if !planned.is_empty() && summary.error.is_none() && !summary.cancelled && let Ok(vault) = state.vault() {
        crate::journal::capture_after(&session, &mut planned, tab.as_deref()).await;
        crate::journal::record(&vault, &id.to_string(), planned);
    }
    if record && !summary.cancelled {
        let entry = HistoryEntry {
            id: 0,
            connection_id: id.to_string(),
            sql,
            executed_at,
            duration_ms: summary.elapsed_ms,
            row_count: summary.row_count as i64,
            error: summary.error,
        };
        if let Err(e) = state.vault().and_then(|v| v.add_history(&entry)) {
            crate::redact::log(format!("could not record history: {e}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, id: Uuid, tab: Option<String>) -> Result<()> {
    state.session(&id).await?.cancel(tab.as_deref()).await
}

/// A query tab closed: close its own connection (the server rolls back an open transaction).
#[tauri::command]
pub async fn close_tab_session(state: State<'_, AppState>, id: Uuid, tab: String) -> Result<()> {
    if let Ok(session) = state.session(&id).await {
        session.close_tab(&tab).await;
    }
    Ok(())
}

// ---- Export ----

/// Asks where to save (a native dialog, so the path always comes from the user), then
/// streams the query's rows into the file. `None` when the user cancels the dialog.
#[tauri::command]
pub async fn export_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
    format: ExportFormat,
    name: String,
) -> Result<Option<ExportResult>> {
    use tauri_plugin_dialog::DialogExt;
    let session = state.session(&id).await?;
    export::ensure_read_only(&sql, session.engine())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(format!("{name}.{}", format.extension()))
        .add_filter(format.extension().to_uppercase(), &[format.extension()])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    export::export(&session, &sql, format, &name, &path).await.map(Some)
}

// ---- Table edits ----

/// The SQL the edits will run, for the review dialog.
#[tauri::command]
pub async fn preview_edits(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
    edits: Vec<RowEdit>,
) -> Result<Vec<String>> {
    let statements = state.session(&id).await?.prepare_edits(&schema, &table, &edits).await?;
    Ok(statements.into_iter().map(|s| s.display).collect())
}

/// Three-way check before saving edits: each field someone else changed since it was loaded,
/// with base / mine / theirs, so the review can merge or ask.
#[tauri::command]
pub async fn check_edits(state: State<'_, AppState>, id: Uuid, schema: String, table: String, edits: Vec<RowEdit>) -> Result<Vec<crate::safe_edit::FieldState>> {
    crate::safe_edit::changed_since(&*state.session(&id).await?, &schema, &table, &edits).await
}

/// Applies edits in one transaction. On prod, only after the user confirmed the review.
#[tauri::command]
pub async fn apply_edits(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
    edits: Vec<RowEdit>,
    confirmed: bool,
) -> Result<crate::safe_edit::ApplyReport> {
    if state.config(&id)?.read_only {
        return Err(AppError::Invalid("This connection is read-only".into()));
    }
    let session = state.session(&id).await?;
    let statements = session.prepare_edits(&schema, &table, &edits).await?;
    if state.config(&id)?.environment == Environment::Prod && !confirmed {
        let risks = statements
            .iter()
            .map(|s| Risk { statement: s.display.clone(), reason: "writes to a prod database".into() })
            .collect();
        return Err(AppError::NeedsConfirmation(risks));
    }
    // Never overwrite what someone else changed since the rows were loaded.
    let conflicts = crate::safe_edit::conflicts(&session, &schema, &table, &edits).await?;
    if !conflicts.is_empty() {
        let n = conflicts.len();
        return Err(AppError::Invalid(format!(
            "Nothing was saved: {} changed since you loaded {}.\n{}\nReload to see the current values, then make your change again.",
            if n == 1 { "a value".to_owned() } else { format!("{n} values") },
            if n == 1 { "it" } else { "them" },
            conflicts.iter().map(|c| format!("• {c}")).collect::<Vec<_>>().join("\n")
        )));
    }
    // Grid edits go into the change journal too.
    let mut planned = Vec::new();
    for s in &statements {
        planned.extend(crate::journal::plan(&session, &s.display, None).await);
    }
    let changed = session.apply_edits(&statements).await?;
    if let Ok(vault) = state.vault() {
        crate::journal::capture_after(&session, &mut planned, None).await;
        crate::journal::record(&vault, &id.to_string(), planned);
    }
    Ok(crate::safe_edit::verify(&session, &schema, &table, &edits, changed).await)
}

/// Copies picked rows and everything they're related to (foreign keys) into another
/// connection. Only reads from `id`; writes to `target` (refused if read-only, prod asks).
#[tauri::command]
pub async fn copy_related(
    state: State<'_, AppState>,
    id: Uuid,
    target: Uuid,
    request: crate::subset::SubsetRequest,
    confirmed: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<crate::subset::SubsetResult> {
    check_writable(&state, &target, confirmed, &format!("Copy {} with its related rows", request.table))?;
    let (source, dest) = (state.session(&id).await?, state.session(&target).await?);
    crate::subset::copy(&source, &dest, &request, &on_progress).await
}

/// A query across connections (each named by an alias), run in an in-memory SQLite database.
#[tauri::command]
pub async fn federated_query(
    state: State<'_, AppState>,
    sources: Vec<crate::federated::Source>,
    sql: String,
    max_rows: Option<u64>,
    on_event: Channel<InvokeResponseBody>,
) -> Result<()> {
    let mut sessions = Vec::new();
    for s in sources {
        let session = state.session(&s.connection_id).await?;
        sessions.push((s, session));
    }
    crate::federated::run(&sessions, &sql, &on_event, max_rows).await.map(drop)
}

// ---- Change journal ----

#[tauri::command]
pub async fn list_changes(state: State<'_, AppState>, id: Uuid) -> Result<Vec<crate::appdb::JournalEntry>> {
    state.vault()?.journal(&id.to_string(), 500)
}

/// Runs a change's reverse SQL (one transaction). Prod needs confirmation.
#[tauri::command]
pub async fn undo_change(state: State<'_, AppState>, id: Uuid, change: i64, confirmed: bool) -> Result<()> {
    let vault = state.vault()?;
    let entry = vault.journal_entry(change)?;
    if entry.connection_id != id.to_string() {
        return Err(AppError::Invalid("That change belongs to another connection".into()));
    }
    let Some(reverse) = entry.reverse.as_deref() else { return Err(AppError::Invalid("This change can't be undone".into())) };
    if entry.undone_at.is_some() {
        return Err(AppError::Invalid("Already undone".into()));
    }
    check_writable(&state, &id, confirmed, &format!("Undo: {}", entry.statement))?;
    let session = state.session(&id).await?;
    let after = entry.after_state.as_deref().and_then(|a| serde_json::from_str::<crate::journal::AfterState>(a).ok());
    crate::journal::undo(&session, reverse, after.as_ref()).await?;
    vault.mark_undone(change, now_ms())
}

/// An UPDATE / DELETE run in a transaction that's rolled back: the rows before and after.
#[tauri::command]
pub async fn preview_write(state: State<'_, AppState>, id: Uuid, sql: String) -> Result<Option<crate::journal::Preview>> {
    if state.config(&id)?.read_only {
        return Ok(None);
    }
    let session = state.session(&id).await?;
    crate::journal::preview(&session, &sql).await
}

// ---- History and saved queries ----
// Async so a Keychain prompt (unlocking the vault) never blocks the main thread.

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>, search: Option<String>) -> Result<Vec<HistoryEntry>> {
    state.vault()?.history(search.as_deref().filter(|s| !s.trim().is_empty()), 300)
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> Result<()> {
    state.vault()?.clear_history()
}

#[tauri::command]
pub async fn list_saved_queries(state: State<'_, AppState>) -> Result<Vec<SavedQuery>> {
    state.vault()?.saved_queries()
}

#[tauri::command]
pub async fn save_query(state: State<'_, AppState>, query: SavedQuery) -> Result<SavedQuery> {
    state.vault()?.save_query(&query)
}

#[tauri::command]
pub async fn delete_saved_query(state: State<'_, AppState>, id: String) -> Result<()> {
    state.vault()?.delete_saved_query(&id)
}

// ---- Query logic (F01 / F05 / F19) ----

#[tauri::command]
pub async fn sql_stages(state: State<'_, AppState>, id: Uuid, sql: String) -> Result<crate::sqllogic::StageReport> {
    crate::sqllogic::stages(&*state.session(&id).await?, &sql).await
}

#[tauri::command]
pub async fn sql_missing(state: State<'_, AppState>, id: Uuid, sql: String, alias: String, key: Vec<(String, String)>) -> Result<Vec<crate::sqllogic::MissingStep>> {
    crate::sqllogic::missing(&*state.session(&id).await?, &sql, &alias, &key).await
}

#[tauri::command]
pub async fn sql_drill(state: State<'_, AppState>, id: Uuid, sql: String, row: std::collections::HashMap<String, Option<String>>, column: String) -> Result<crate::sqllogic::Drill> {
    crate::sqllogic::drill(&*state.session(&id).await?, &sql, &row, &column).await
}

// ---- Resumable backfills (F07) ----

#[tauri::command]
pub async fn backfill_setup(state: State<'_, AppState>, id: Uuid, schema: String, confirmed: bool) -> Result<()> {
    check_writable(&state, &id, confirmed, &format!("Create Onyx's job tables in {schema}"))?;
    crate::backfill::setup(&*state.session(&id).await?, &schema).await
}

#[tauri::command]
pub async fn backfill_create(state: State<'_, AppState>, id: Uuid, spec: crate::backfill::JobSpec, confirmed: bool) -> Result<crate::backfill::Job> {
    check_writable(&state, &id, confirmed, &format!("Create a backfill job on {}.{}", spec.schema, spec.table))?;
    crate::backfill::create(&*state.session(&id).await?, &spec).await
}

#[tauri::command]
pub async fn backfill_list(state: State<'_, AppState>, id: Uuid, schema: String) -> Result<Vec<crate::backfill::Job>> {
    crate::backfill::list(&*state.session(&id).await?, &schema).await
}

#[tauri::command]
pub async fn backfill_run(state: State<'_, AppState>, id: Uuid, schema: String, job: String, confirmed: bool, on_progress: Channel<InvokeResponseBody>) -> Result<crate::backfill::Job> {
    check_writable(&state, &id, confirmed, &format!("Run backfill {job}"))?;
    crate::backfill::run(&*state.session(&id).await?, &schema, &job, &on_progress).await
}

#[tauri::command]
pub fn backfill_pause(job: String) {
    crate::backfill::pause(&job);
}

#[tauri::command]
pub async fn backfill_verify(state: State<'_, AppState>, id: Uuid, schema: String, job: String) -> Result<crate::backfill::Verification> {
    crate::backfill::verify(&*state.session(&id).await?, &schema, &job).await
}

#[tauri::command]
pub async fn backfill_retry(state: State<'_, AppState>, id: Uuid, schema: String, job: String, confirmed: bool) -> Result<()> {
    check_writable(&state, &id, confirmed, &format!("Retry failed rows of {job}"))?;
    crate::backfill::retry_failed(&*state.session(&id).await?, &schema, &job).await
}

// ---- Smaller reproducers (F18) ----

/// Copies tables into a scratch schema and shrinks them. Never on prod (it creates schemas).
#[tauri::command]
pub async fn shrink_run(state: State<'_, AppState>, id: Uuid, run: String, spec: crate::shrink::ShrinkSpec, confirmed: bool, on_progress: Channel<InvokeResponseBody>) -> Result<crate::shrink::ShrinkResult> {
    if state.config(&id)?.environment == Environment::Prod {
        return Err(AppError::Invalid("Shrinking copies data into scratch schemas: use a local or disposable database, not prod".into()));
    }
    check_writable(&state, &id, confirmed, "Create a scratch schema for the reproducer")?;
    crate::shrink::run(&*state.session(&id).await?, &run, &spec, &on_progress).await
}

#[tauri::command]
pub fn shrink_stop(run: String) {
    crate::shrink::stop(&run);
}

#[tauri::command]
pub async fn shrink_export(state: State<'_, AppState>, id: Uuid, scratch: String, spec: crate::shrink::ShrinkSpec) -> Result<String> {
    crate::shrink::export(&*state.session(&id).await?, &scratch, &spec).await
}

#[tauri::command]
pub async fn shrink_drop(state: State<'_, AppState>, id: Uuid, scratch: String) -> Result<()> {
    crate::shrink::drop(&*state.session(&id).await?, &scratch).await
}

// ---- Investigations ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationSummary {
    id: String,
    title: String,
    updated_at: i64,
}

#[tauri::command]
pub async fn list_investigations(state: State<'_, AppState>) -> Result<Vec<InvestigationSummary>> {
    Ok(state.vault()?.investigations()?.into_iter().map(|(id, title, updated_at)| InvestigationSummary { id, title, updated_at }).collect())
}

/// The investigation's JSON body.
#[tauri::command]
pub async fn get_investigation(state: State<'_, AppState>, id: String) -> Result<String> {
    state.vault()?.investigation(&id)
}

/// Saves the body (JSON from the UI, at most 64 MB) and returns the saved time.
#[tauri::command]
pub async fn save_investigation(state: State<'_, AppState>, id: String, title: String, body: String) -> Result<i64> {
    if body.len() > 64 * 1024 * 1024 {
        return Err(AppError::Invalid("This investigation is over 64 MB: remove some row snapshots first".into()));
    }
    serde_json::from_str::<serde_json::Value>(&body).map_err(|e| AppError::Invalid(format!("Not a valid investigation: {e}")))?;
    state.vault()?.save_investigation(&id, title.trim(), &body)
}

#[tauri::command]
pub async fn delete_investigation(state: State<'_, AppState>, id: String) -> Result<()> {
    state.vault()?.delete_investigation(&id)
}

// ---- Files ----

/// A native Open dialog. `extensions`: the file types that make sense (empty: any file).
///
/// They're checked after picking rather than given to the panel: macOS filters by its own idea
/// of a file's type, and a `.csv` or `.db` it classifies differently stays greyed out with Open
/// disabled. Any file can be picked; a wrong one gets a clear message.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle, title: String, extensions: Vec<String>) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    check_extension(&path, &extensions)?;
    Ok(Some(path.display().to_string()))
}

/// `path` has one of `extensions` (any case), or there's no list.
fn check_extension(path: &std::path::Path, extensions: &[String]) -> Result<()> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if extensions.is_empty() || extensions.iter().any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(&ext)) {
        return Ok(());
    }
    let list = extensions.iter().map(|e| format!(".{}", e.trim_start_matches('.'))).collect::<Vec<_>>().join(", ");
    Err(AppError::Invalid(format!("{} isn't a supported file here: choose a {list} file", path.file_name().and_then(|n| n.to_str()).unwrap_or("That file"))))
}

async fn save_dialog(app: &tauri::AppHandle, name: &str, extension: &str) -> Result<Option<std::path::PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // No type filter: on macOS a filter the panel can't match (seen with .json) leaves Save
    // disabled. The suggested name carries the extension, and a name without one gets it.
    app.dialog()
        .file()
        .set_file_name(format!("{name}.{extension}"))
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok(Some(if path.extension().is_none() { path.with_extension(extension) } else { path }))
}

/// Saves text (or base64 bytes) to a file the user picks: diagram exports, migration SQL.
#[tauri::command]
pub async fn save_file(app: tauri::AppHandle, name: String, extension: String, contents: String, base64: bool) -> Result<Option<String>> {
    let Some(path) = save_dialog(&app, &name, &extension).await? else { return Ok(None) };
    let bytes = if base64 {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(contents.trim()).map_err(|e| AppError::Invalid(e.to_string()))?
    } else {
        contents.into_bytes()
    };
    std::fs::write(&path, bytes)?;
    Ok(Some(path.display().to_string()))
}

/// Which optional command-line tools are installed.
#[tauri::command]
pub fn tool_status() -> serde_json::Value {
    let has = |name: &str| crate::tools::find(name).is_some();
    serde_json::json!({
        "duckdb": has("duckdb"),
        "pgDump": has("pg_dump"),
        "mysqldump": has("mysqldump"),
        "sqlite3": has("sqlite3"),
    })
}

// ---- Schema-wide ----

#[tauri::command]
pub async fn all_foreign_keys(state: State<'_, AppState>, id: Uuid) -> Result<Vec<ForeignKeyRef>> {
    state.session(&id).await?.all_foreign_keys().await
}

/// Every table of a schema with columns, indexes and keys (ER diagram, schema diff).
#[tauri::command]
pub async fn schema_snapshot(state: State<'_, AppState>, id: Uuid, schema: String) -> Result<Vec<TableSnapshot>> {
    state.session(&id).await?.snapshot(&schema).await
}

/// Server activity: sessions, locks, and cancelling them. On prod, cancelling a session needs
/// the user's confirmation (the UI asks; `confirmed` says it did).
#[tauri::command]
pub async fn admin_query(state: State<'_, AppState>, id: Uuid, sql: String, confirmed: bool) -> Result<serde_json::Value> {
    let config = state.config(&id)?;
    let lower_trim = sql.trim().to_ascii_lowercase();
    let kill = lower_trim.starts_with("kill ") && lower_trim.split_whitespace().skip(1).all(|w| w == "query" || w.chars().all(|c| c.is_ascii_digit()));
    if config.read_only && matches!(config.engine, Engine::Postgres | Engine::Mysql | Engine::Sqlserver) && !kill {
        crate::readonly::check(&sql, config.engine)?;
    }
    let lower = sql.to_ascii_lowercase();
    let kills = lower.contains("pg_cancel_backend") || lower.contains("pg_terminate_backend") || lower.trim_start().starts_with("kill");
    if kills && config.environment == Environment::Prod && !confirmed {
        return Err(AppError::NeedsConfirmation(vec![Risk { statement: sql, reason: "stops another session on a prod database".into() }]));
    }
    let (columns, rows) = state.session(&id).await?.admin_rows(&sql).await?;
    Ok(serde_json::json!({ "columns": columns, "rows": rows }))
}

/// A query alert's check: one query that only reads (checked here, not in the UI), run in a
/// READ ONLY transaction of its own, at most 1,000 rows. Alerts run unattended on a schedule,
/// so they can never write, on any environment.
#[tauri::command]
pub async fn alert_query(state: State<'_, AppState>, id: Uuid, sql: String) -> Result<serde_json::Value> {
    let config = state.config(&id)?;
    let sql = sql.trim().trim_end_matches(';').trim().to_owned();
    export::ensure_read_only(&sql, config.engine).map_err(|e| AppError::Invalid(format!("Alerts only run one query that reads: {}", e.to_string().trim_start_matches("Invalid: "))))?;
    let session = state.session(&id).await?;
    let (columns, rows) = crate::journal::collect_read_only(&session, &sql, Some(1000)).await?;
    Ok(serde_json::json!({ "columns": columns, "rows": rows }))
}

// ---- Bulk data ----

/// Writing many rows: refused on read-only connections; prod needs the user's confirmation.
fn check_writable(state: &AppState, id: &Uuid, confirmed: bool, what: &str) -> Result<()> {
    let config = state.config(id)?;
    if config.read_only {
        return Err(AppError::Invalid(format!("{} is read-only", config.name)));
    }
    if config.environment == Environment::Prod && !confirmed {
        return Err(AppError::NeedsConfirmation(vec![Risk { statement: what.to_owned(), reason: "writes to a prod database".into() }]));
    }
    Ok(())
}

#[tauri::command]
pub async fn csv_preview(path: String) -> Result<crate::bulk::CsvPreview> {
    tokio::task::spawn_blocking(move || crate::bulk::preview(&path)).await.map_err(|e| AppError::Invalid(e.to_string()))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
    plan: crate::bulk::ImportPlan,
    confirmed: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<u64> {
    check_writable(&state, &id, confirmed, &format!("Import {} into {schema}.{table}", plan.path))?;
    let session = state.session(&id).await?;
    crate::bulk::import_csv(&session, &schema, &table, plan, &on_progress).await
}

/// Generated test rows. Never on prod.
#[tauri::command]
pub async fn insert_rows(
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<u64> {
    if state.config(&id)?.environment == Environment::Prod {
        return Err(AppError::Invalid("Generated data is never written to a prod connection".into()));
    }
    check_writable(&state, &id, false, "")?;
    let session = state.session(&id).await?;
    crate::bulk::insert(&session, &schema, &table, &columns, rows).await
}

/// Copies a query's rows into a table on another (or the same) connection. `create_sql`
/// creates the table first, in the same step.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn copy_rows(
    state: State<'_, AppState>,
    source_id: Uuid,
    sql: String,
    target_id: Uuid,
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    create_sql: Option<String>,
    confirmed: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<u64> {
    check_writable(&state, &target_id, confirmed, &format!("Copy rows into {schema}.{table}"))?;
    let source = state.session(&source_id).await?;
    export::ensure_read_only(&sql, source.engine())?;
    let target = state.session(&target_id).await?;
    if let Some(create) = create_sql.filter(|c| !c.trim().is_empty()) {
        target.execute_meta(&create).await?;
    }
    crate::bulk::copy(&source, &sql, &target, &schema, &table, columns, &on_progress).await
}

// ---- Dump and restore ----

/// Where pg_dump & co. connect, the password, and (for SSH connections that aren't open) a
/// tunnel opened just for this job; keep it alive until the tool finishes.
async fn tool_endpoint(
    state: &AppState,
    id: &Uuid,
) -> Result<(ConnectionConfig, crate::dump::Endpoint, Option<zeroize::Zeroizing<String>>, Option<ssh::Tunnel>)> {
    let config = state.config(id)?;
    let open_tunnel = match state.sessions.read().await.get(id) {
        Some(session) => session.tunnel_port(),
        None => None,
    };
    let mut own_tunnel = None;
    let port = match (&config.ssh, open_tunnel) {
        (Some(_), Some(port)) => Some(port),
        (Some(ssh_config), None) => {
            let secret = state.secret(&secrets::ssh_account(id))?;
            let tunnel = ssh::open(ssh_config, secret, (&config.host, config.port)).await?;
            let port = tunnel.local_port;
            own_tunnel = Some(tunnel);
            Some(port)
        }
        (None, _) => None,
    };
    let at = match port {
        Some(port) => crate::dump::Endpoint { host: "127.0.0.1".into(), port, tunnelled: true },
        None => crate::dump::Endpoint { host: config.host.clone(), port: config.port, tunnelled: false },
    };
    let password = state.secret(&secrets::password_account(id))?;
    Ok((config, at, password, own_tunnel))
}

#[tauri::command]
pub async fn dump_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    schema: Option<String>,
    format: String,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<Option<crate::dump::DumpResult>> {
    let (config, at, password, _tunnel) = tool_endpoint(&state, &id).await?;
    let name = schema.clone().unwrap_or_else(|| if config.database.is_empty() { config.name.clone() } else { config.database.clone() });
    let name = std::path::Path::new(&name).file_stem().map_or(name.clone(), |s| s.to_string_lossy().into_owned());
    let extension = if format == "custom" && config.engine == crate::connections::Engine::Postgres { "dump" } else { "sql" };
    let Some(path) = save_dialog(&app, &name, extension).await? else { return Ok(None) };
    crate::dump::dump(&config, at, password, schema, &path, &on_progress).await.map(Some)
}

/// One schema as a single .sql file: every CREATE TABLE and CREATE VIEW, optionally its rows as
/// INSERTs. Read-only on the database; `None` if the user cancels the save dialog.
#[tauri::command]
pub async fn export_database_sql(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    schema: String,
    include_data: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<Option<crate::export_db::DatabaseExport>> {
    let session = state.session(&id).await?;
    let stem = std::path::Path::new(&schema).file_stem().map_or(schema.clone(), |s| s.to_string_lossy().into_owned());
    let name = if include_data { stem } else { format!("{stem}-schema") };
    let Some(path) = save_dialog(&app, &name, "sql").await? else { return Ok(None) };
    crate::export_db::export_database(&session, &schema, include_data, &path, &on_progress).await.map(Some)
}

/// Runs a .sql file the user picks (native dialog), statement by statement on a session of
/// its own. Writes, so: refused on read-only connections, prod needs confirmation. `None` if cancelled.
#[tauri::command]
pub async fn run_sql_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: Uuid,
    stop_on_error: bool,
    confirmed: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<Option<crate::sqlfile::FileRun>> {
    check_writable(&state, &id, confirmed, "Run a .sql file")?;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Run a .sql file").pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    check_extension(&path, &["sql".into(), "txt".into(), "dump".into()])?;
    let session = state.session(&id).await?;
    crate::sqlfile::run_file(&session, &path, stop_on_error, &on_progress).await.map(Some)
}

/// Migrations already applied to this connection (from its onyx_migrations table).
#[tauri::command]
pub async fn migration_status(state: State<'_, AppState>, id: Uuid) -> Result<Vec<String>> {
    crate::migrations::applied(&*state.session(&id).await?).await
}

/// Applies (or with `up: false` rolls back) one migration file's SQL and records it.
#[tauri::command]
pub async fn apply_migration(state: State<'_, AppState>, id: Uuid, version: String, sql: String, up: bool, confirmed: bool) -> Result<usize> {
    check_writable(&state, &id, confirmed, &format!("{} migration {version}", if up { "Apply" } else { "Roll back" }))?;
    crate::migrations::apply(&*state.session(&id).await?, &version, &sql, up).await
}

/// Hosts from ~/.ssh/config, for the SSH tunnel fields.
#[tauri::command]
pub fn ssh_config_hosts() -> Vec<crate::ssh::ConfigHost> {
    crate::ssh::config_hosts()
}

/// Restores a dump file; on prod only after confirmation. `None` if the user cancels.
#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    id: Uuid,
    path: String,
    schema: Option<String>,
    confirmed: bool,
    on_progress: Channel<InvokeResponseBody>,
) -> Result<()> {
    check_writable(&state, &id, confirmed, &format!("Restore {path}"))?;
    let (config, at, password, _tunnel) = tool_endpoint(&state, &id).await?;
    let session = state.session(&id).await?;
    crate::dump::restore(&config, &session, at, password, schema, std::path::Path::new(&path), &on_progress).await
}

// ---- Natural language to SQL ----

#[tauri::command]
pub async fn set_api_key(state: State<'_, AppState>, key: String) -> Result<()> {
    let key = zeroize::Zeroizing::new(key);
    let trimmed = key.trim();
    if !trimmed.is_empty() && !trimmed.starts_with("sk-ant-") {
        return Err(AppError::Invalid("That doesn't look like an Anthropic API key (sk-ant-…)".into()));
    }
    state.update_secret(crate::ai::API_KEY_ACCOUNT, Some(trimmed))
}

/// The UI's saved state that holds SQL or results (tabs, alerts, tool setups), in the vault.
#[tauri::command]
pub fn ui_state_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    state.vault()?.ui_state(&key)
}

#[tauri::command]
pub fn ui_state_set(state: State<'_, AppState>, key: String, value: Option<String>) -> Result<()> {
    state.vault()?.set_ui_state(&key, value.as_deref())
}

#[tauri::command]
pub async fn has_api_key(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.secret(crate::ai::API_KEY_ACCOUNT)?.is_some())
}

/// Writes SQL for a request in plain words. Sends the request, the schema and any SQL the UI
/// passes to refine (never rows); needs the
/// connection's opt-in and is refused on prod.
#[tauri::command]
pub async fn ai_sql(
    state: State<'_, AppState>,
    id: Uuid,
    prompt: String,
    current_sql: Option<String>,
    default_schema: Option<String>,
) -> Result<crate::ai::GeneratedSql> {
    let config = state.config(&id)?;
    if config.environment == Environment::Prod {
        return Err(AppError::Invalid("Natural-language SQL is off for prod connections".into()));
    }
    if !config.ai_enabled {
        return Err(AppError::Invalid(format!("Turn on “Natural-language SQL” in {}'s settings first", config.name)));
    }
    let key = state
        .secret(crate::ai::API_KEY_ACCOUNT)?
        .ok_or_else(|| AppError::Invalid("Add your Anthropic API key in Settings first".into()))?;
    let session = state.session(&id).await?;
    let tables = session.completion_tables().await?;
    let keys = session.all_foreign_keys().await.unwrap_or_default();
    let context = crate::ai::schema_context(&tables, &keys);
    let body = crate::ai::request_body(config.engine, &context, default_schema.as_deref(), &prompt, current_sql.as_deref());
    crate::ai::generate(&key, &body).await
}

// ---- Comfort ----

/// The index advisor's input: this connection's slowest queries from history.
#[tauri::command]
pub async fn slow_queries(state: State<'_, AppState>, id: Uuid, min_ms: f64) -> Result<Vec<crate::appdb::SlowQuery>> {
    state.vault()?.slow_queries(&id.to_string(), min_ms, 40)
}

/// A macOS notification (query alerts). The text goes to osascript as an argument, never as code.
#[tauri::command]
pub async fn notify(title: String, body: String) -> Result<()> {
    let script = "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";
    let status = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", script, &title, &body])
        .status()
        .await
        .map_err(|e| AppError::Invalid(format!("Couldn't show a notification: {e}")))?;
    if !status.success() {
        return Err(AppError::Invalid("Couldn't show a notification".into()));
    }
    Ok(())
}

/// Earlier runs of exactly this SQL, for a saved query's timing history.
#[tauri::command]
pub async fn query_timings(state: State<'_, AppState>, sql: String) -> Result<Vec<HistoryEntry>> {
    state.vault()?.runs_of(&sql, 50)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_files_are_checked_by_extension() {
        let csv = ["csv".to_owned(), "tsv".to_owned()];
        assert!(check_extension(std::path::Path::new("/x/orders.CSV"), &csv).is_ok());
        assert!(check_extension(std::path::Path::new("/x/anything"), &[]).is_ok());
        let err = check_extension(std::path::Path::new("/x/notes.pdf"), &csv).unwrap_err().to_string();
        assert!(err.contains("notes.pdf isn't a supported file here: choose a .csv, .tsv file"), "{err}");
    }

    #[test]
    fn app_info_serializes_camel_case() {
        let json = serde_json::to_value(app_info()).unwrap();
        assert_eq!(json["name"], "Onyx");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert!(json["tauriVersion"].as_str().is_some_and(|v| !v.is_empty()));
        assert_eq!(json["os"], std::env::consts::OS);
    }
}
