mod ai;
mod appdb;
mod aws;
mod backfill;
mod bulk;
mod codeindex;
mod commands;
mod connections;
mod db;
mod dialect;
mod dump;
mod error;
mod export;
mod export_db;
mod federated;
mod git;
mod guard;
mod http;
mod journal;
mod menu;
mod migrations;
mod readonly;
mod redact;
mod safe_edit;
mod secrets;
mod shrink;
mod ssh;
mod sqlfile;
mod sqllogic;
mod state;
mod subset;
mod tools;
mod workspace;

use tauri::Manager;

/// A local SQLite connection for tests.
#[cfg(test)]
pub(crate) fn bulk_test_config(path: &std::path::Path) -> connections::ConnectionConfig {
    use connections::*;
    ConnectionConfig {
        id: uuid::Uuid::new_v4(),
        engine: Engine::Sqlite,
        name: "test".into(),
        host: "localhost".into(),
        port: 0,
        user: String::new(),
        database: path.display().to_string(),
        ssl_mode: SslMode::Disable,
        environment: Environment::Local,
        color: "#000".into(),
        read_only: false,
        ssh: None,
        folder: None,
        ai_enabled: false,
        ssl_ca: None,
        ssl_cert: None,
        ssl_key: None,
        aws_iam: None,
    }
}

/// When the process started, for the startup probe.
pub(crate) static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    db::tls::ensure_provider();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .setup(|app| {
            ssh::set_known_hosts_path(app.path().app_config_dir()?.join("known_hosts"));
            let path = app.path().app_config_dir()?.join("connections.json");
            let store = connections::ConnectionStore::load(path)?;
            // The vault unlocks on first use; the UI asks for it right after launch.
            let vault_path = app.path().app_data_dir()?.join("onyx.db");
            app.manage(state::AppState::new(store, vault_path));
            app.manage(workspace::Workspace::load(app.path().app_config_dir()?.join("workspace")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::app_ready,
            commands::log_frontend_error,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::trust_ssh_host,
            commands::connect,
            commands::disconnect,
            commands::list_schemas,
            commands::list_objects,
            commands::list_columns,
            commands::completion_tables,
            commands::table_structure,
            commands::export_query,
            commands::check_sql,
            commands::run_query,
            commands::cancel_query,
            commands::close_tab_session,
            commands::preview_edits,
            commands::apply_edits,
            commands::list_history,
            commands::clear_history,
            commands::list_saved_queries,
            commands::save_query,
            commands::delete_saved_query,
            commands::reorder_connections,
            commands::pick_file,
            commands::save_file,
            commands::tool_status,
            commands::all_foreign_keys,
            commands::schema_snapshot,
            commands::csv_preview,
            commands::import_csv,
            commands::insert_rows,
            commands::copy_rows,
            commands::dump_database,
            commands::export_database_sql,
            commands::run_sql_file,
            commands::ssh_config_hosts,
            commands::list_changes,
            commands::undo_change,
            commands::preview_write,
            commands::copy_related,
            commands::federated_query,
            commands::restore_database,
            commands::set_api_key,
            commands::has_api_key,
            commands::alert_query,
            commands::ui_state_get,
            commands::ui_state_set,
            commands::ai_sql,
            commands::query_timings,
            commands::slow_queries,
            commands::check_edits,
            commands::sql_stages,
            commands::shrink_run,
            commands::shrink_stop,
            commands::shrink_export,
            commands::shrink_drop,
            commands::backfill_setup,
            commands::backfill_create,
            commands::backfill_list,
            commands::backfill_run,
            commands::backfill_pause,
            commands::backfill_verify,
            commands::backfill_retry,
            commands::sql_missing,
            commands::sql_drill,
            commands::list_investigations,
            commands::get_investigation,
            commands::save_investigation,
            commands::delete_investigation,
            commands::notify,
            commands::admin_query,
            workspace::workspace_list,
            workspace::workspace_open,
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_reveal,
            workspace::code_references,
            workspace::open_code,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            commands::migration_status,
            commands::apply_migration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Onyx");
}
