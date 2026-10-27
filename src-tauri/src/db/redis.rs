//! Redis: a key browser and a command console. Query tabs run one command per line
//! (`HGETALL user:1`, `SCAN 0 MATCH user:* COUNT 100`), and each reply becomes a small table.
//! Schemas are the numbered databases; objects are keys (a first page, filtered in the UI).

use std::collections::HashMap;
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::{ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value};
use zeroize::Zeroizing;

use super::model::{ColumnInfo, DbObject, TableStructure};
use super::stream::{Events, Run, RunSummary};
use crate::connections::{ConnectionConfig, SslMode};
use crate::error::{AppError, ErrorPayload, Result};
use crate::ssh::Tunnel;

/// Keys listed per database in the sidebar.
const KEY_PAGE: usize = 2000;

pub struct RedisSession {
    pub server_version: String,
    client: redis::Client,
    /// The shared connection (sidebar, menus).
    conn: MultiplexedConnection,
    /// Query tabs' own connections, so `SELECT n` in one tab stays in that tab.
    tabs: tokio::sync::Mutex<HashMap<String, MultiplexedConnection>>,
    default_db: i64,
    read_only: bool,
    tunnel: Option<Tunnel>,
    /// Stops what a tab (or "" for the shared session) is running: a command, or MONITOR.
    running: std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Notify>>>,
}

fn redis_err(e: redis::RedisError) -> AppError {
    AppError::Invalid(format!("Redis: {e}"))
}

/// Commands a read-only Redis connection refuses (Redis has no server-side read-only mode).
/// Commands that only read, for read-only connections and exports. An allow-list: a command
/// that isn't here (a new one, a module's, a write) is refused rather than guessed at.
const READS: &[&str] = &[
    "GET", "MGET", "STRLEN", "GETRANGE", "SUBSTR", "LCS", "EXISTS", "TYPE", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME",
    "KEYS", "SCAN", "RANDOMKEY", "DBSIZE", "DUMP", "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS",
    "HSTRLEN", "HSCAN", "HRANDFIELD", "HTTL", "HPTTL", "HEXPIRETIME", "HPEXPIRETIME", "LRANGE", "LLEN", "LINDEX", "LPOS",
    "SMEMBERS", "SISMEMBER", "SMISMEMBER", "SCARD", "SRANDMEMBER", "SSCAN", "SINTER", "SUNION", "SDIFF", "SINTERCARD",
    "ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANGEBYLEX", "ZSCORE", "ZMSCORE",
    "ZCARD", "ZCOUNT", "ZLEXCOUNT", "ZRANK", "ZREVRANK", "ZSCAN", "ZRANDMEMBER", "ZDIFF", "ZINTER", "ZUNION", "ZINTERCARD",
    "XRANGE", "XREVRANGE", "XLEN", "XREAD", "XPENDING", "PFCOUNT", "GETBIT", "BITCOUNT", "BITPOS", "BITFIELD_RO",
    "GEOPOS", "GEODIST", "GEOHASH", "GEOSEARCH", "GEORADIUS_RO", "GEORADIUSBYMEMBER_RO", "SORT_RO", "EVAL_RO",
    "EVALSHA_RO", "FCALL_RO", "PING", "ECHO", "TIME", "INFO", "SELECT", "LASTSAVE", "ROLE", "LOLWUT", "JSON.GET",
    "JSON.MGET", "JSON.TYPE", "JSON.STRLEN", "JSON.ARRLEN", "JSON.ARRINDEX", "JSON.OBJKEYS", "JSON.OBJLEN", "JSON.RESP",
];
/// Commands with read and write forms: only these subcommands read.
const READ_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("CONFIG", &["GET"]),
    ("CLIENT", &["LIST", "INFO", "GETNAME", "ID"]),
    ("OBJECT", &["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"]),
    ("MEMORY", &["USAGE", "STATS", "DOCTOR", "HELP"]),
    ("SLOWLOG", &["GET", "LEN", "HELP"]),
    ("XINFO", &["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
    ("COMMAND", &["COUNT", "INFO", "DOCS", "LIST", "GETKEYS", "HELP"]),
    ("SCRIPT", &["EXISTS"]),
    ("FUNCTION", &["LIST", "STATS", "DUMP"]),
    ("ACL", &["WHOAMI", "LIST", "USERS", "CAT", "GETUSER"]),
    ("CLUSTER", &["INFO", "NODES", "SLOTS", "SHARDS", "MYID", "KEYSLOT", "COUNTKEYSINSLOT"]),
    ("LATENCY", &["LATEST", "HISTORY", "DOCTOR", "GRAPH", "HELP"]),
];

/// Whether a command (its words, name first) only reads.
pub fn reads(words: &[String]) -> bool {
    let Some(name) = words.first().map(|w| w.to_ascii_uppercase()) else { return true };
    if READS.contains(&name.as_str()) {
        return true;
    }
    // SORT and GEORADIUS read unless told to STORE the result.
    if ["SORT", "GEORADIUS", "GEORADIUSBYMEMBER"].contains(&name.as_str()) {
        return !words.iter().skip(1).any(|w| w.eq_ignore_ascii_case("STORE") || w.eq_ignore_ascii_case("STOREDIST"));
    }
    let sub = words.get(1).map(|w| w.to_ascii_uppercase()).unwrap_or_default();
    READ_SUBCOMMANDS.iter().any(|(n, subs)| *n == name && subs.contains(&sub.as_str()))
}

impl RedisSession {
    pub async fn connect(config: &ConnectionConfig, password: Option<Zeroizing<String>>, tunnel: Option<Tunnel>) -> Result<Self> {
        crate::db::tls::ensure_provider();
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_owned(), t.local_port),
            None => (config.host.trim().to_owned(), config.port),
        };
        let default_db: i64 = config.database.trim().parse().unwrap_or(0);
        let mut settings = RedisConnectionInfo::default().set_db(default_db);
        if !config.user.trim().is_empty() && config.user.trim() != "default" {
            settings = settings.set_username(config.user.trim());
        }
        if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
            settings = settings.set_password(p.as_str());
        }
        let plain = ConnectionAddr::Tcp(host.clone(), port);
        // The Redis client checks a certificate against the address it connects to, which through a
        // tunnel is 127.0.0.1: rather than silently skip the check, verify-full refuses.
        if tunnel.is_some() && config.ssl_mode == SslMode::VerifyFull {
            return Err(AppError::Invalid(
                "Verify-full can't check Redis's certificate through an SSH tunnel. Choose “Require” to encrypt without checking it, or connect without the tunnel.".into(),
            ));
        }
        let tls = ConnectionAddr::TcpTls { host, port, insecure: config.ssl_mode != SslMode::VerifyFull, tls_params: None };
        let (client, mut conn) = match config.ssl_mode {
            SslMode::Disable => open(plain, &settings, CONNECT_TIMEOUT).await,
            // Redis has no in-protocol TLS upgrade: try TLS briefly, then plain (a plain server
            // never answers a TLS handshake, so waiting the full timeout would just hang).
            SslMode::Prefer => match open(tls, &settings, Duration::from_secs(3)).await {
                Ok(opened) => Ok(opened),
                Err(_) => open(plain, &settings, CONNECT_TIMEOUT).await,
            },
            SslMode::Require | SslMode::VerifyFull => open(tls, &settings, CONNECT_TIMEOUT).await,
        }
        .map_err(|e| match e {
            AppError::Invalid(m) if m == TIMED_OUT => AppError::Invalid(format!("Timed out connecting to {}:{}", config.host, config.port)),
            other => other,
        })?;
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut conn).await.map_err(redis_err)?;
        let server_version = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_version:").or_else(|| l.strip_prefix("valkey_version:")))
            .unwrap_or("")
            .trim()
            .to_owned();
        Ok(Self { server_version, client, conn, tabs: Default::default(), default_db, read_only: config.read_only, tunnel, running: Default::default() })
    }

    pub fn tunnel_port(&self) -> Option<u16> {
        self.tunnel.as_ref().map(|t| t.local_port)
    }

    async fn editor(&self, tab: Option<&str>) -> Result<MultiplexedConnection> {
        let Some(tab) = tab else { return Ok(self.conn.clone()) };
        let mut tabs = self.tabs.lock().await;
        if let Some(c) = tabs.get(tab) {
            return Ok(c.clone());
        }
        let conn = self.client.get_multiplexed_async_connection().await.map_err(redis_err)?;
        tabs.insert(tab.to_owned(), conn.clone());
        Ok(conn)
    }

    pub async fn close_tab(&self, tab: &str) {
        self.tabs.lock().await.remove(tab);
    }

    /// Redis commands are short; there's nothing to cancel.
    pub async fn cancel(&self, tab: Option<&str>) -> Result<()> {
        if let Some(stop) = self.running.lock().unwrap().get(tab.unwrap_or("")) {
            stop.notify_one();
        }
        Ok(())
    }

    /// MONITOR: every command the server runs, streamed as rows until cancelled.
    async fn monitor(&self, run: &mut Run<'_>, stop: &tokio::sync::Notify) -> Result<()> {
        use futures_util::StreamExt;
        let monitor = self.client.get_async_monitor().await.map_err(redis_err)?;
        let mut stream = std::pin::pin!(monitor.into_on_message::<String>());
        run.start_result(vec!["time".into(), "database".into(), "client".into(), "command".into()])?;
        loop {
            tokio::select! {
                line = stream.next() => match line {
                    Some(line) => run.push_row(monitor_row(&line).into_iter().map(Some))?,
                    None => break,
                },
                _ = stop.notified() => break,
            }
        }
        run.end_result(None)
    }

    /// Runs one command per line; `#` and `//` lines are comments.
    pub async fn run(&self, text: &str, events: &Events, limit: Option<u64>, tab: Option<&str>) -> Result<RunSummary> {
        let key = tab.unwrap_or("").to_owned();
        let stop = std::sync::Arc::new(tokio::sync::Notify::new());
        self.running.lock().unwrap().insert(key.clone(), stop.clone());
        let mut cancelled = false;
        let mut run = Run::with_limit(events, limit);
        let outcome: Result<()> = async {
            if text.trim().trim_end_matches(';').eq_ignore_ascii_case("monitor") {
                return self.monitor(&mut run, &stop).await;
            }
            let mut conn = self.editor(tab).await?;
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//")) {
                let words = split_command(line.trim_end_matches(';'))?;
                let Some(name) = words.first().map(|w| w.to_ascii_uppercase()) else { continue };
                if self.read_only && !reads(&words) {
                    return Err(AppError::Invalid(format!("{name} isn't a read command, and this connection is read-only")));
                }
                let mut cmd = redis::cmd(&words[0]);
                for w in &words[1..] {
                    cmd.arg(w);
                }
                let value: Value = tokio::select! {
                    v = cmd.query_async(&mut conn) => v.map_err(redis_err)?,
                    _ = stop.notified() => {
                        cancelled = true;
                        return Err(AppError::Invalid("Cancelled".into()));
                    }
                };
                emit(&mut run, &name, &words, value)?;
            }
            Ok(())
        }
        .await;
        self.running.lock().unwrap().remove(&key);
        let error = outcome.as_ref().err().map(|e| (ErrorPayload::from(e), cancelled));
        run.finish(outcome, error)
    }

    pub async fn schemas(&self) -> Result<Vec<String>> {
        let mut conn = self.conn.clone();
        let info: String = redis::cmd("INFO").arg("keyspace").query_async(&mut conn).await.map_err(redis_err)?;
        let mut dbs: Vec<i64> = info.lines().filter_map(|l| l.strip_prefix("db")?.split(':').next()?.parse().ok()).collect();
        if !dbs.contains(&self.default_db) {
            dbs.push(self.default_db);
        }
        dbs.sort_unstable();
        Ok(dbs.into_iter().map(|d| format!("db{d}")).collect())
    }

    fn db_number(schema: &str) -> Result<i64> {
        schema.trim_start_matches("db").parse().map_err(|_| AppError::Invalid(format!("Not a Redis database: {schema}")))
    }

    /// A first page of keys (sorted), each with its type.
    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>> {
        let db = Self::db_number(schema)?;
        // A connection on that database, without disturbing the shared one.
        let mut conn = self.client.get_multiplexed_async_connection().await.map_err(redis_err)?;
        redis::cmd("SELECT").arg(db).query_async::<()>(&mut conn).await.map_err(redis_err)?;
        let mut keys: Vec<String> = Vec::new();
        let mut cursor: u64 = 0;
        loop {
            let (next, batch): (u64, Vec<String>) =
                redis::cmd("SCAN").arg(cursor).arg("COUNT").arg(1000).query_async(&mut conn).await.map_err(redis_err)?;
            keys.extend(batch);
            cursor = next;
            if cursor == 0 || keys.len() >= KEY_PAGE {
                break;
            }
        }
        keys.sort();
        keys.truncate(KEY_PAGE);
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k);
        }
        let types: Vec<String> = if keys.is_empty() { vec![] } else { pipe.query_async(&mut conn).await.map_err(redis_err)? };
        Ok(keys
            .into_iter()
            .zip(types)
            .map(|(name, kind)| DbObject { name, kind: "key", detail: Some(kind), estimated_rows: None, size_bytes: None })
            .collect())
    }

    pub async fn columns(&self, _schema: &str, _table: &str) -> Result<Vec<ColumnInfo>> {
        Ok(vec![])
    }

    pub async fn structure(&self, _schema: &str, _table: &str) -> Result<TableStructure> {
        Err(AppError::Invalid("Redis keys have no table structure".into()))
    }

    pub async fn completion_tables(&self) -> Result<Vec<super::model::CompletionTable>> {
        Ok(vec![])
    }

    pub async fn all_foreign_keys(&self) -> Result<Vec<super::model::ForeignKeyRef>> {
        Ok(vec![])
    }

    pub async fn snapshot(&self, _schema: &str) -> Result<Vec<super::model::TableSnapshot>> {
        Ok(vec![])
    }

    pub async fn apply(&self, _statements: &[super::edit::EditStatement]) -> Result<u64> {
        Err(AppError::Invalid("Redis values are changed with commands in a query tab".into()))
    }
}

/// Shell-like words: spaces separate, quotes group, backslashes escape inside double quotes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TIMED_OUT: &str = "timed out";

/// A MONITOR line, `1700000000.123456 [0 127.0.0.1:50000] "SET" "a" "1"`, as time, db, client, command.
pub fn monitor_row(line: &str) -> Vec<String> {
    let (time, rest) = line.split_once(' ').unwrap_or((line, ""));
    let (meta, command) = match (rest.find('['), rest.find(']')) {
        (Some(a), Some(b)) if a < b => (&rest[a + 1..b], rest[b + 1..].trim()),
        _ => ("", rest),
    };
    let (db, client) = meta.split_once(' ').unwrap_or((meta, ""));
    let secs: f64 = time.parse().unwrap_or(0.0);
    let ms = (secs * 1000.0) as i64;
    let clock = format!("{:02}:{:02}:{:02}.{:03}", (ms / 3_600_000) % 24, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000);
    vec![format!("{clock} UTC"), db.to_owned(), client.to_owned(), command.to_owned()]
}

/// A client for this address and its first connection, within `timeout`.
async fn open(addr: ConnectionAddr, settings: &RedisConnectionInfo, timeout: Duration) -> Result<(redis::Client, MultiplexedConnection)> {
    let info = addr.into_connection_info().map_err(redis_err)?.set_redis_settings(settings.clone());
    let client = redis::Client::open(info).map_err(redis_err)?;
    let conn = tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| AppError::Invalid(TIMED_OUT.into()))?
        .map_err(redis_err)?;
    Ok((client, conn))
}

pub fn split_command(line: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                in_word = true;
                let quote = c;
                loop {
                    match chars.next() {
                        Some(ch) if ch == quote => break,
                        Some('\\') if quote == '"' => match chars.next() {
                            Some('n') => current.push('\n'),
                            Some('t') => current.push('\t'),
                            Some(other) => current.push(other),
                            None => return Err(AppError::Invalid("Unfinished escape in the command".into())),
                        },
                        Some(ch) => current.push(ch),
                        None => return Err(AppError::Invalid(format!("Unclosed {quote} in the command"))),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                current.push(c);
            }
        }
    }
    if in_word {
        words.push(current);
    }
    Ok(words)
}

/// A reply as text: strings as they are, nested replies as JSON.
fn text(value: &Value) -> Option<String> {
    match value {
        Value::Nil => None,
        Value::Int(i) => Some(i.to_string()),
        Value::BulkString(b) => Some(match std::str::from_utf8(b) {
            Ok(s) => s.to_owned(),
            Err(_) => b.iter().fold(String::from("0x"), |mut s, byte| {
                s.push_str(&format!("{byte:02x}"));
                s
            }),
        }),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Okay => Some("OK".into()),
        Value::Double(d) => Some(d.to_string()),
        Value::Boolean(b) => Some(b.to_string()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::BigNumber(n) => Some(format!("{n:?}")),
        Value::Attribute { data, .. } => text(data),
        Value::ServerError(e) => Some(format!("ERR {e:?}")),
        Value::Array(items) | Value::Set(items) | Value::Push { data: items, .. } => {
            Some(serde_json::Value::Array(items.iter().map(json).collect()).to_string())
        }
        Value::Map(pairs) => Some(
            serde_json::Value::Object(pairs.iter().map(|(k, v)| (text(k).unwrap_or_default(), json(v))).collect()).to_string(),
        ),
        _ => Some(format!("{value:?}")),
    }
}

fn json(value: &Value) -> serde_json::Value {
    match value {
        Value::Nil => serde_json::Value::Null,
        Value::Int(i) => (*i).into(),
        Value::Boolean(b) => (*b).into(),
        Value::Array(items) | Value::Set(items) => serde_json::Value::Array(items.iter().map(json).collect()),
        other => text(other).map_or(serde_json::Value::Null, serde_json::Value::String),
    }
}

/// Turns one reply into a result set shaped by the command.
fn emit(run: &mut Run, name: &str, words: &[String], value: Value) -> Result<()> {
    let pairs = |items: &[Value]| -> Vec<(Option<String>, Option<String>)> {
        items.chunks(2).map(|p| (text(&p[0]), p.get(1).and_then(text))).collect()
    };
    let with_scores = words.iter().any(|w| w.eq_ignore_ascii_case("WITHSCORES"));
    match value {
        Value::Map(entries) => {
            run.start_result(vec!["field".into(), "value".into()])?;
            for (k, v) in entries {
                run.push_row([text(&k), text(&v)])?;
            }
        }
        Value::Array(items) if matches!(name, "HGETALL" | "CONFIG") || (name.starts_with('Z') && with_scores) => {
            let headers = if name.starts_with('Z') { ["member", "score"] } else { ["field", "value"] };
            run.start_result(headers.iter().map(|h| (*h).to_owned()).collect())?;
            for (k, v) in pairs(&items) {
                run.push_row([k, v])?;
            }
        }
        // SCAN / HSCAN / SSCAN / ZSCAN: [cursor, [items…]]
        Value::Array(items) if name.ends_with("SCAN") && items.len() == 2 => {
            let cursor = text(&items[0]);
            let inner = match &items[1] {
                Value::Array(v) => v.clone(),
                _ => vec![],
            };
            if name == "HSCAN" || name == "ZSCAN" {
                run.start_result(vec!["field".into(), "value".into(), "next cursor".into()])?;
                for (k, v) in pairs(&inner) {
                    run.push_row([k, v, cursor.clone()])?;
                }
            } else {
                run.start_result(vec!["value".into(), "next cursor".into()])?;
                for v in &inner {
                    run.push_row([text(v), cursor.clone()])?;
                }
            }
        }
        Value::Array(items) | Value::Set(items) => {
            run.start_result(vec!["#".into(), "value".into()])?;
            for (i, v) in items.iter().enumerate() {
                run.push_row([Some((i + 1).to_string()), text(v)])?;
            }
        }
        Value::Okay => return run.command(0),
        other => {
            run.start_result(vec!["value".into()])?;
            run.push_row([text(&other)])?;
        }
    }
    run.end_result(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::stream::testing::{batches, event_types, recorder};
    use arrow_array::{Array, StringArray};

    #[test]
    fn splits_commands_like_redis_cli() {
        assert_eq!(split_command(r#"SET "user name" 'it''s' plain"#).unwrap(), ["SET", "user name", "its", "plain"]);
        assert_eq!(split_command(r#"SET k "a\"b\n""#).unwrap(), ["SET", "k", "a\"b\n"]);
        assert!(split_command(r#"GET "open"#).is_err());
    }

    fn config() -> Option<ConnectionConfig> {
        let port: u16 = std::env::var("ONYX_TEST_REDIS").ok()?.parse().ok()?;
        let mut config = crate::bulk_test_config(std::path::Path::new("0"));
        config.engine = crate::connections::Engine::Redis;
        config.host = "127.0.0.1".into();
        config.port = port;
        config.database = "15".into();
        Some(config)
    }

    #[test]
    fn reads_monitor_lines() {
        assert_eq!(
            monitor_row(r#"1700000000.123456 [3 127.0.0.1:50000] "SET" "a" "1""#),
            ["22:13:20.123 UTC", "3", "127.0.0.1:50000", r#""SET" "a" "1""#]
        );
    }

    /// MONITOR streams other clients' commands until cancelled.
    #[tokio::test]
    async fn monitors_until_cancelled() {
        let Some(config) = config() else { return };
        let session = std::sync::Arc::new(RedisSession::connect(&config, None, None).await.unwrap());
        let (channel, log) = recorder();
        let watcher = {
            let session = session.clone();
            tokio::spawn(async move { session.run("MONITOR", &channel, None, Some("mon")).await.unwrap() })
        };
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let (c2, _) = recorder();
        session.run("PING\nECHO onyx-monitor-test", &c2, None, Some("other")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        session.cancel(Some("mon")).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), watcher).await.unwrap().unwrap();
        let log = log.lock().unwrap();
        let b = batches(&log);
        let commands: Vec<String> = b.iter().flat_map(|b| {
            let c = b.column(3).as_any().downcast_ref::<StringArray>().unwrap();
            (0..c.len()).map(|i| c.value(i).to_owned()).collect::<Vec<_>>()
        }).collect();
        assert!(commands.iter().any(|c| c.contains("onyx-monitor-test")), "{commands:?}");
        assert!(!event_types(&log).contains(&"error".to_owned()), "a stop isn't an error");
    }

    /// "Prefer" falls back to plain TCP on a server without TLS (it used to hang until timing out).
    #[tokio::test]
    async fn prefer_falls_back_to_plain() {
        let Some(mut config) = config() else { return };
        config.ssl_mode = SslMode::Prefer;
        let started = std::time::Instant::now();
        let session = RedisSession::connect(&config, None, None).await.unwrap();
        assert!(!session.server_version.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
        // Require stays strict: no silent downgrade.
        config.ssl_mode = SslMode::Require;
        assert!(RedisSession::connect(&config, None, None).await.is_err());
    }

    fn column(log: &[crate::db::stream::testing::Received], result: usize, col: usize) -> Vec<Option<String>> {
        let b = batches(log)[result];
        let c = b.column(col).as_any().downcast_ref::<StringArray>().unwrap();
        (0..c.len()).map(|i| (!c.is_null(i)).then(|| c.value(i).to_owned())).collect()
    }

    /// `ONYX_TEST_REDIS=63799 cargo test redis` with scripts/dev-db.sh running.
    #[tokio::test]
    async fn runs_commands_and_browses_keys() {
        let Some(config) = config() else { return };
        let session = RedisSession::connect(&config, None, None).await.unwrap();
        assert!(!session.server_version.is_empty());
        let (channel, log) = recorder();
        session
            .run(
                "FLUSHDB\nHSET user:1 name Ann plan pro\nSET greeting 'hello world'\nRPUSH queue a b c\n\
                 # a comment\nHGETALL user:1\nGET greeting\nLRANGE queue 0 -1\nGET missing\nNOPE",
                &channel,
                None,
                Some("t1"),
            )
            .await
            .unwrap();
        {
            let log = log.lock().unwrap();
            let types = event_types(&log);
            assert_eq!(types.last().unwrap(), "done");
            assert!(types.contains(&"error".to_owned()), "unknown commands report an error");
            // FLUSHDB and SET reply OK (no result); the rest are tables.
            assert_eq!(column(&log, 0, 0), [Some("2".into())], "HSET: fields added");
            assert_eq!(column(&log, 1, 0), [Some("3".into())], "RPUSH: list length");
            let hash: Vec<_> = column(&log, 2, 0).into_iter().zip(column(&log, 2, 1)).collect();
            assert!(hash.contains(&(Some("plan".into()), Some("pro".into()))), "{hash:?}");
            assert_eq!(column(&log, 3, 0), [Some("hello world".into())]);
            assert_eq!(column(&log, 4, 1), [Some("a".into()), Some("b".into()), Some("c".into())]);
            assert_eq!(column(&log, 5, 0), [None]);
        }

        // The tab's SELECT doesn't move the shared connection (or the sidebar).
        assert!(session.schemas().await.unwrap().contains(&"db15".to_owned()));
        let keys = session.objects("db15").await.unwrap();
        let listed: Vec<(&str, &str)> = keys.iter().map(|k| (k.name.as_str(), k.detail.as_deref().unwrap())).collect();
        assert_eq!(listed, [("greeting", "string"), ("queue", "list"), ("user:1", "hash")]);

        let ro = RedisSession::connect(&crate::connections::ConnectionConfig { read_only: true, ..config.clone() }, None, None)
            .await
            .unwrap();
        let (channel, log) = recorder();
        ro.run("DEL greeting", &channel, None, None).await.unwrap();
        assert!(event_types(&log.lock().unwrap()).contains(&"error".to_owned()));
        let (channel, _) = recorder();
        session.run("FLUSHDB", &channel, None, None).await.unwrap();
    }
}
