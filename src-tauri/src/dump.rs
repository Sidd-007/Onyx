//! Dump and restore with the engines' own tools (pg_dump, pg_restore, psql, mysqldump,
//! mysql, sqlite3). Passwords reach the tool through its environment or a private
//! options file that is deleted afterwards; they never appear in arguments or logs.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use zeroize::Zeroizing;

use crate::connections::{ConnectionConfig, Engine, SslMode};
use crate::error::{AppError, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpResult {
    pub path: String,
    pub bytes: u64,
}

/// Where the tool connects: the database's host, or the local end of the SSH tunnel.
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub tunnelled: bool,
}

fn tool(name: &str) -> Result<PathBuf> {
    crate::tools::find(name).ok_or_else(|| {
        let formula = match name {
            "pg_dump" | "pg_restore" | "psql" => "postgresql",
            "mysqldump" | "mysql" => "mysql-client",
            _ => name,
        };
        AppError::Invalid(format!("{name} isn't installed. Install it with `brew install {formula}`."))
    })
}

/// A file only this user can read, removed when dropped.
struct PrivateFile(PathBuf);

impl PrivateFile {
    fn new(contents: &[u8], suffix: &str) -> Result<Self> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let path = std::env::temp_dir().join(format!("onyx-{}{suffix}", uuid::Uuid::new_v4().simple()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
        file.write_all(contents)?;
        Ok(Self(path))
    }
}

impl Drop for PrivateFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn log(events: &Channel<InvokeResponseBody>, event: serde_json::Value) {
    let _ = events.send(InvokeResponseBody::Json(event.to_string()));
}

/// Connection settings for a Postgres tool, as environment variables.
fn pg_env(cmd: &mut Command, config: &ConnectionConfig, at: &Endpoint, password: Option<&str>) -> Result<Option<PrivateFile>> {
    cmd.env("PGHOST", &at.host)
        .env("PGPORT", at.port.to_string())
        .env("PGUSER", &config.user)
        .env("PGDATABASE", &config.database)
        .env("PGAPPNAME", "Onyx")
        .env("PGCONNECT_TIMEOUT", "10");
    if let Some(p) = password {
        cmd.env("PGPASSWORD", p);
    }
    let mut ca = None;
    let mode = match config.ssl_mode {
        SslMode::Disable => "disable",
        SslMode::Prefer => "prefer",
        SslMode::Require => "require",
        // Through a tunnel the certificate's name can't match 127.0.0.1.
        SslMode::VerifyFull if at.tunnelled => "require",
        SslMode::VerifyFull => {
            let file = PrivateFile::new(crate::db::tls_bundle(), ".pem")?;
            cmd.env("PGSSLROOTCERT", &file.0);
            ca = Some(file);
            "verify-full"
        }
    };
    cmd.env("PGSSLMODE", mode);
    Ok(ca)
}

/// A mysql/mysqldump options file with the password and TLS settings.
fn mysql_options(config: &ConnectionConfig, at: &Endpoint, password: Option<&str>) -> Result<(PrivateFile, Option<PrivateFile>)> {
    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut text = format!("[client]\nhost=\"{}\"\nport={}\nuser=\"{}\"\n", escape(&at.host), at.port, escape(&config.user));
    if let Some(p) = password {
        text += &format!("password=\"{}\"\n", escape(p));
    }
    let mut ca = None;
    let mode = match config.ssl_mode {
        SslMode::Disable => "DISABLED",
        SslMode::Prefer => "PREFERRED",
        SslMode::Require => "REQUIRED",
        SslMode::VerifyFull if at.tunnelled => "REQUIRED",
        SslMode::VerifyFull => {
            let file = PrivateFile::new(crate::db::tls_bundle(), ".pem")?;
            text += &format!("ssl-ca=\"{}\"\n", file.0.display());
            ca = Some(file);
            "VERIFY_IDENTITY"
        }
    };
    text += &format!("ssl-mode={mode}\n");
    let text = Zeroizing::new(text);
    Ok((PrivateFile::new(text.as_bytes(), ".cnf")?, ca))
}

/// Runs the tool, forwarding its stderr as log lines and the output file's size as progress.
async fn run_tool(mut cmd: Command, output: Option<&Path>, events: &Channel<InvokeResponseBody>) -> Result<()> {
    cmd.stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take().expect("piped stderr");
    let mut lines = BufReader::new(stderr).lines();
    let mut errors: Vec<String> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let status = loop {
        tokio::select! {
            line = lines.next_line() => match line? {
                Some(line) => {
                    log(events, serde_json::json!({ "type": "log", "line": line }));
                    errors.push(line);
                }
                None => break child.wait().await?,
            },
            _ = tick.tick() => {
                if let Some(bytes) = output.and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()) {
                    log(events, serde_json::json!({ "type": "progress", "bytes": bytes }));
                }
            }
        }
    };
    if !status.success() {
        let tail = errors.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(AppError::Invalid(if tail.is_empty() { format!("The tool exited with {status}") } else { tail }));
    }
    Ok(())
}

/// Dumps `schema` (or the whole database) to `path`. Postgres writes its custom format for
/// `.dump` files and plain SQL otherwise.
pub async fn dump(
    config: &ConnectionConfig,
    at: Endpoint,
    password: Option<Zeroizing<String>>,
    schema: Option<String>,
    path: &Path,
    events: &Channel<InvokeResponseBody>,
) -> Result<DumpResult> {
    let password = password.as_deref().map(String::as_str);
    let _keep;
    match config.engine {
        Engine::Postgres => {
            let mut cmd = Command::new(tool("pg_dump")?);
            _keep = (pg_env(&mut cmd, config, &at, password)?, None);
            cmd.args(["--no-password", "--verbose", "--file"]).arg(path);
            if path.extension().is_some_and(|e| e == "dump") {
                cmd.arg("--format=custom");
            }
            if let Some(s) = &schema {
                cmd.arg(format!("--schema={s}"));
            }
            run_tool(cmd, Some(path), events).await?;
        }
        Engine::Mysql => {
            let (options, ca) = mysql_options(config, &at, password)?;
            let mut cmd = Command::new(tool("mysqldump")?);
            cmd.arg(format!("--defaults-extra-file={}", options.0.display()))
                .args(["--single-transaction", "--routines", "--triggers", "--events", "--no-tablespaces", "--verbose"])
                .arg(format!("--result-file={}", path.display()));
            let database = schema.unwrap_or_else(|| config.database.clone());
            if database.is_empty() {
                return Err(AppError::Invalid("Pick a database to dump".into()));
            }
            cmd.arg("--databases").arg(database);
            _keep = (Some(options), ca);
            run_tool(cmd, Some(path), events).await?;
        }
        Engine::Sqlite => {
            _keep = (None, None);
            let file = std::fs::File::create(path)?;
            let mut cmd = Command::new(tool("sqlite3")?);
            cmd.arg(crate::db::sqlite::expand_path(&config.database)).arg(".dump").stdout(file).stderr(Stdio::piped());
            let output = cmd.spawn()?.wait_with_output().await?;
            if !output.status.success() {
                return Err(AppError::Invalid(String::from_utf8_lossy(&output.stderr).trim().to_owned()));
            }
        }
        Engine::Duckdb => return Err(AppError::Invalid("For DuckDB, run EXPORT DATABASE 'folder' in a query tab".into())),
        other => return Err(AppError::Invalid(format!("Dumps aren't available for {other:?} connections"))),
    }
    let bytes = std::fs::metadata(path)?.len();
    Ok(DumpResult { path: path.display().to_string(), bytes })
}

/// Restores a dump file into the connection's database.
/// Restores a dump. Postgres custom-format archives go through pg_restore (it runs no shell
/// commands); plain SQL for Postgres and MySQL runs through Onyx's own statement runner, never
/// psql or the mysql client, whose `\\!` / `system` commands a crafted file could use to run
/// programs. SQLite files go through sqlite3 in safe mode (no `.shell`, `.system`, `.load`).
#[allow(clippy::too_many_arguments)]
pub async fn restore(
    config: &ConnectionConfig,
    session: &crate::db::Session,
    at: Endpoint,
    password: Option<Zeroizing<String>>,
    schema: Option<String>,
    path: &Path,
    events: &Channel<InvokeResponseBody>,
) -> Result<()> {
    let password = password.as_deref().map(String::as_str);
    let mut head = [0u8; 5];
    let custom = {
        use std::io::Read;
        std::fs::File::open(path)?.read(&mut head).ok() == Some(5) && &head == b"PGDMP"
    };
    let report = |done: crate::sqlfile::FileRun| {
        if !done.skipped.is_empty() {
            log(events, serde_json::json!({ "type": "log", "line": format!("Skipped {} client command(s) in the file; they were not run", done.skipped.len()) }));
        }
    };
    match config.engine {
        Engine::Postgres if custom => {
            let mut cmd = Command::new(tool("pg_restore")?);
            let _ca = pg_env(&mut cmd, config, &at, password)?;
            cmd.args(["--no-password", "--no-owner", "--verbose", "--exit-on-error", "--dbname", &config.database]).arg(path);
            run_tool(cmd, None, events).await
        }
        Engine::Postgres => {
            report(crate::sqlfile::restore_file(session, path, None, true, events).await?);
            Ok(())
        }
        Engine::Mysql => {
            let database = schema.unwrap_or_else(|| config.database.clone());
            let setup = (!database.is_empty()).then(|| format!("USE {}", crate::dialect::ident(Engine::Mysql, &database)));
            report(crate::sqlfile::restore_file(session, path, setup, false, events).await?);
            Ok(())
        }
        Engine::Sqlite => {
            let mut cmd = Command::new(tool("sqlite3")?);
            cmd.arg("-safe").arg("-bail").arg(crate::db::sqlite::expand_path(&config.database)).stdin(std::fs::File::open(path)?);
            run_tool(cmd, None, events).await
        }
        Engine::Duckdb => Err(AppError::Invalid("For DuckDB, run IMPORT DATABASE 'folder' in a query tab".into())),
        other => Err(AppError::Invalid(format!("Restores aren't available for {other:?} connections"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::stream::testing::recorder;

    #[test]
    fn private_files_are_owner_only_and_cleaned_up() {
        use std::os::unix::fs::PermissionsExt;
        let file = PrivateFile::new(b"secret", ".cnf").unwrap();
        let path = file.0.clone();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        drop(file);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn dumps_and_restores_a_sqlite_file() {
        if tool("sqlite3").is_err() {
            return;
        }
        let dir = std::env::temp_dir();
        let db = dir.join(format!("onyx-dump-{}.db", uuid::Uuid::new_v4()));
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);").unwrap();
        let mut config = crate::bulk_test_config(&db);
        let out = dir.join(format!("onyx-dump-{}.sql", uuid::Uuid::new_v4()));
        let (events, _) = recorder();
        let at = Endpoint { host: String::new(), port: 0, tunnelled: false };
        let result = dump(&config, at, None, None, &out, &events).await.unwrap();
        assert!(result.bytes > 0);
        assert!(std::fs::read_to_string(&out).unwrap().contains("INSERT INTO t VALUES(2)"));

        // (SQLite restores go through sqlite3; the session isn't used for them.)
        let session = crate::db::Session::connect(&config, None, None).await.unwrap();
        let copy = dir.join(format!("onyx-restore-{}.db", uuid::Uuid::new_v4()));
        config.database = copy.display().to_string();
        let at = Endpoint { host: String::new(), port: 0, tunnelled: false };
        restore(&config, &session, at, None, None, &out, &events).await.unwrap();
        let n: i64 = rusqlite::Connection::open(&copy).unwrap().query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);

        // A crafted dump can't run a program: sqlite3 runs in safe mode, so .shell is refused.
        let marker = dir.join(format!("onyx-marker-{}", uuid::Uuid::new_v4()));
        let evil = dir.join(format!("onyx-evil-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(&evil, format!("CREATE TABLE z (x INTEGER);\n.shell touch {}\n", marker.display())).unwrap();
        let at = Endpoint { host: String::new(), port: 0, tunnelled: false };
        assert!(restore(&config, &session, at, None, None, &evil, &events).await.is_err());
        assert!(!marker.exists(), ".shell ran");
        for p in [db, out, copy, evil] {
            std::fs::remove_file(p).unwrap();
        }
    }

    #[tokio::test]
    async fn dumps_the_dev_postgres_schema() {
        if std::env::var("ONYX_TEST_PG").is_err() || tool("pg_dump").is_err() {
            return;
        }
        let mut config = crate::bulk_test_config(Path::new("onyx_dev"));
        config.engine = Engine::Postgres;
        config.user = "postgres".into();
        config.database = "onyx_dev".into();
        let out = std::env::temp_dir().join(format!("onyx-dump-{}.sql", uuid::Uuid::new_v4()));
        let (events, _) = recorder();
        let at = Endpoint { host: "localhost".into(), port: 54329, tunnelled: false };
        let result = dump(&config, at, None, Some("shop".into()), &out, &events).await.unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("CREATE TABLE shop.orders"), "{} bytes", result.bytes);
        std::fs::remove_file(out).unwrap();
    }

    /// `ONYX_TEST_PG=1 cargo test restore`: a plain dump with psql shell commands restores its
    /// SQL, and the commands are skipped, never run.
    #[tokio::test]
    async fn plain_postgres_restores_never_run_shell_commands() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = crate::db::Session::connect(&config, None, None).await.unwrap();
        let dir = std::env::temp_dir();
        let schema = format!("onyx_restore_{}", uuid::Uuid::new_v4().simple());
        let marker = dir.join(format!("onyx-marker-{}", uuid::Uuid::new_v4()));
        let file = dir.join(format!("onyx-evil-{}.sql", uuid::Uuid::new_v4()));
        std::fs::write(
            &file,
            format!(
                "CREATE SCHEMA {schema};\nCREATE TABLE {schema}.t (i int);\n\\! touch {m}\n\\copy {schema}.t from program 'touch {m}'\nINSERT INTO {schema}.t VALUES (1);\n",
                m = marker.display()
            ),
        )
        .unwrap();
        let (events, _) = recorder();
        let at = Endpoint { host: String::new(), port: 0, tunnelled: false };
        restore(&config, &session, at, None, None, &file, &events).await.unwrap();
        assert!(!marker.exists(), "a shell command in the dump ran");
        let (_, rows) = crate::journal::collect(&session, &format!("SELECT count(*) FROM {schema}.t"), None, None).await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("1"));
        session.execute_meta(&format!("DROP SCHEMA {schema} CASCADE")).await.unwrap();
        std::fs::remove_file(&file).unwrap();
    }
}
