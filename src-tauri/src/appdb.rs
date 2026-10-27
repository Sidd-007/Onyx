//! Onyx's vault: query history, saved queries, and connection secrets (database and SSH
//! passwords). SQLite encrypted with SQLCipher; its random key is the only thing Onyx
//! keeps in the Keychain (see `secrets`), so macOS asks at most once per launch.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use zeroize::Zeroizing;

use crate::error::{AppError, Result};

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS history (
        id            INTEGER PRIMARY KEY,
        connection_id TEXT NOT NULL,
        sql           TEXT NOT NULL,
        executed_at   INTEGER NOT NULL, -- unix ms
        duration_ms   REAL NOT NULL,
        row_count     INTEGER NOT NULL,
        error         TEXT
    );
    CREATE INDEX IF NOT EXISTS history_executed_at ON history (executed_at DESC);

    CREATE TABLE IF NOT EXISTS secrets (
        account TEXT PRIMARY KEY,
        value   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal (
        id            INTEGER PRIMARY KEY,
        connection_id TEXT NOT NULL,
        at            INTEGER NOT NULL, -- unix ms
        statement     TEXT NOT NULL,
        target        TEXT NOT NULL,     -- the table written to
        rows          INTEGER NOT NULL,  -- rows captured before the write
        reverse       TEXT,              -- SQL that undoes it; NULL when it can't be undone
        note          TEXT,              -- why not, or what to know
        undone_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS journal_connection ON journal (connection_id, at DESC);

    CREATE TABLE IF NOT EXISTS saved_queries (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        sql           TEXT NOT NULL,
        connection_id TEXT,
        updated_at    INTEGER NOT NULL
    );

    -- Investigations: a question, its scope, evidence and findings (versioned JSON the UI
    -- owns). They can hold customer data, which is why they live in the encrypted vault.
    CREATE TABLE IF NOT EXISTS investigations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        body       TEXT NOT NULL
    );
";

/// History keeps this many entries; older ones are dropped.
const HISTORY_LIMIT: i64 = 10_000;

/// A query that ran slowly at least once (the index advisor's input).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowQuery {
    pub sql: String,
    pub runs: i64,
    pub max_ms: f64,
    pub avg_ms: f64,
    pub last_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub sql: String,
    pub executed_at: i64,
    pub duration_ms: f64,
    pub row_count: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    /// "folder/name" groups queries into folders.
    pub name: String,
    pub sql: String,
    pub connection_id: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}

/// A write Onyx ran, with the SQL that reverses it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: i64,
    pub connection_id: String,
    pub at: i64,
    pub statement: String,
    pub target: String,
    pub rows: i64,
    pub reverse: Option<String>,
    pub note: Option<String>,
    pub undone_at: Option<i64>,
    /// What the change left behind (JSON, see `journal::AfterState`): undo checks the rows
    /// still look like this, so it never overwrites a newer change.
    #[serde(skip_serializing)]
    pub after_state: Option<String>,
}

pub struct AppDb {
    conn: Mutex<Connection>,
}

/// Columns added after the first release (ALTER fails harmlessly once they exist).
fn migrate(conn: &Connection) {
    let _ = conn.execute("ALTER TABLE journal ADD COLUMN after_state TEXT", []);
}

impl AppDb {
    /// `key`: 64 hex characters (a raw 256-bit SQLCipher key).
    pub fn open(path: &Path, key: &str) -> Result<Self> {
        if !(key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(AppError::Invalid("app database key must be 64 hex characters".into()));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";")).map_err(db_err)?;
        // Fails with "file is not a database" if the key is wrong.
        conn.execute_batch(SCHEMA).map_err(db_err)?;
        migrate(&conn);
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(SCHEMA).expect("schema");
        migrate(&conn);
        Self { conn: Mutex::new(conn) }
    }

    pub fn add_journal(&self, e: &JournalEntry) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO journal (connection_id, at, statement, target, rows, reverse, note, after_state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![e.connection_id, e.at, e.statement, e.target, e.rows, e.reverse, e.note, e.after_state],
        )
        .map_err(db_err)?;
        // Keep the newest 5,000 per database connection.
        conn.execute(
            "DELETE FROM journal WHERE connection_id = ?1 AND id NOT IN (SELECT id FROM journal WHERE connection_id = ?1 ORDER BY at DESC LIMIT 5000)",
            params![e.connection_id],
        )
        .map_err(db_err)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn journal(&self, connection_id: &str, limit: i64) -> Result<Vec<JournalEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, connection_id, at, statement, target, rows, reverse, note, undone_at, after_state FROM journal WHERE connection_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2")
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![connection_id, limit], |r| {
                Ok(JournalEntry {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    at: r.get(2)?,
                    statement: r.get(3)?,
                    target: r.get(4)?,
                    rows: r.get(5)?,
                    reverse: r.get(6)?,
                    note: r.get(7)?,
                    undone_at: r.get(8)?,
                    after_state: r.get(9)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db_err)
    }

    pub fn journal_entry(&self, id: i64) -> Result<JournalEntry> {
        let conn = self.conn.lock().unwrap();
        let connection_id: String = conn.query_row("SELECT connection_id FROM journal WHERE id = ?1", params![id], |r| r.get(0)).map_err(db_err)?;
        drop(conn);
        self.journal(&connection_id, 5000)?.into_iter().find(|e| e.id == id).ok_or_else(|| AppError::Invalid("No such change".into()))
    }

    pub fn mark_undone(&self, id: i64, at: i64) -> Result<()> {
        self.conn.lock().unwrap().execute("UPDATE journal SET undone_at = ?2 WHERE id = ?1", params![id, at]).map_err(db_err)?;
        Ok(())
    }

    pub fn add_history(&self, entry: &HistoryEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO history (connection_id, sql, executed_at, duration_ms, row_count, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![entry.connection_id, entry.sql, entry.executed_at, entry.duration_ms, entry.row_count, entry.error],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM history WHERE id <= (SELECT max(id) FROM history) - ?1",
            params![HISTORY_LIMIT],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Newest first. `search` matches anywhere in the SQL, ignoring case.
    pub fn history(&self, search: Option<&str>, limit: i64) -> Result<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", search.unwrap_or("").replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn
            .prepare(
                "SELECT id, connection_id, sql, executed_at, duration_ms, row_count, error FROM history
                 WHERE sql LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![pattern, limit], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    sql: r.get(2)?,
                    executed_at: r.get(3)?,
                    duration_ms: r.get(4)?,
                    row_count: r.get(5)?,
                    error: r.get(6)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)
    }

    /// The connection's slowest successful queries (at least `min_ms` once), slowest first.
    pub fn slow_queries(&self, connection_id: &str, min_ms: f64, limit: i64) -> Result<Vec<SlowQuery>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT sql, count(*), max(duration_ms), avg(duration_ms), max(executed_at) FROM history
                 WHERE connection_id = ?1 AND error IS NULL
                 GROUP BY sql HAVING max(duration_ms) >= ?2 ORDER BY max(duration_ms) DESC LIMIT ?3",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![connection_id, min_ms, limit], |r| Ok(SlowQuery { sql: r.get(0)?, runs: r.get(1)?, max_ms: r.get(2)?, avg_ms: r.get(3)?, last_at: r.get(4)? }))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)
    }

    /// Past runs of exactly this SQL, newest first: a saved query's timing history.
    pub fn runs_of(&self, sql: &str, limit: i64) -> Result<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, connection_id, sql, executed_at, duration_ms, row_count, error FROM history
                 WHERE trim(sql, char(32, 9, 10, 13)) = ?1 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![sql.trim(), limit], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    sql: r.get(2)?,
                    executed_at: r.get(3)?,
                    duration_ms: r.get(4)?,
                    row_count: r.get(5)?,
                    error: r.get(6)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)
    }

    pub fn clear_history(&self) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM history", []).map_err(db_err)?;
        Ok(())
    }

    pub fn saved_queries(&self) -> Result<Vec<SavedQuery>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, sql, connection_id, updated_at FROM saved_queries ORDER BY name COLLATE NOCASE")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SavedQuery {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    connection_id: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)
    }

    pub fn save_query(&self, query: &SavedQuery) -> Result<SavedQuery> {
        let name = query.name.trim();
        if name.is_empty() {
            return Err(AppError::Invalid("Name is required".into()));
        }
        let saved = SavedQuery { name: name.to_owned(), updated_at: now_ms(), ..query.clone() };
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO saved_queries (id, name, sql, connection_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (id) DO UPDATE SET name = ?2, sql = ?3, connection_id = ?4, updated_at = ?5",
                params![saved.id, saved.name, saved.sql, saved.connection_id, saved.updated_at],
            )
            .map_err(db_err)?;
        Ok(saved)
    }

    /// Every investigation's id, title and last change (newest first); bodies load one at a time.
    pub fn investigations(&self) -> Result<Vec<(String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, title, updated_at FROM investigations ORDER BY updated_at DESC").map_err(db_err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db_err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db_err)
    }

    pub fn investigation(&self, id: &str) -> Result<String> {
        use rusqlite::OptionalExtension;
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT body FROM investigations WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(db_err)?
            .ok_or_else(|| AppError::Invalid("No such investigation".into()))
    }

    pub fn save_investigation(&self, id: &str, title: &str, body: &str) -> Result<i64> {
        let at = now_ms();
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO investigations (id, title, updated_at, body) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET title = ?2, updated_at = ?3, body = ?4",
                params![id, title, at, body],
            )
            .map_err(db_err)?;
        Ok(at)
    }

    pub fn delete_investigation(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM investigations WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    pub fn delete_saved_query(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM saved_queries WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    pub fn secret(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock().unwrap();
        let value: Option<String> = conn
            .query_row("SELECT value FROM secrets WHERE account = ?1", [account], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        Ok(value.map(Zeroizing::new))
    }

    pub fn set_secret(&self, account: &str, value: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO secrets (account, value) VALUES (?1, ?2) ON CONFLICT (account) DO UPDATE SET value = ?2",
                params![account, value],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn delete_secret(&self, account: &str) -> Result<()> {
        self.conn.lock().unwrap().execute("DELETE FROM secrets WHERE account = ?1", [account]).map_err(db_err)?;
        Ok(())
    }

    #[cfg(test)]
    fn saved_query(&self, id: &str) -> Result<Option<SavedQuery>> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id, name, sql, connection_id, updated_at FROM saved_queries WHERE id = ?1", [id], |r| {
            Ok(SavedQuery { id: r.get(0)?, name: r.get(1)?, sql: r.get(2)?, connection_id: r.get(3)?, updated_at: r.get(4)? })
        })
        .optional()
        .map_err(db_err)
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn db_err(e: rusqlite::Error) -> AppError {
    AppError::Invalid(format!("app database: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_investigations() {
        let db = AppDb::in_memory();
        db.save_investigation("a", "Why is order 7 missing?", r#"{"version":1}"#).unwrap();
        db.save_investigation("a", "Order 7", r#"{"version":1,"evidence":[]}"#).unwrap();
        assert_eq!(db.investigations().unwrap().iter().map(|r| r.1.clone()).collect::<Vec<_>>(), ["Order 7"]);
        assert!(db.investigation("a").unwrap().contains("evidence"));
        db.delete_investigation("a").unwrap();
        assert!(db.investigation("a").is_err());
    }

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("onyx-appdb-{}.db", uuid::Uuid::new_v4()))
    }

    fn entry(sql: &str) -> HistoryEntry {
        HistoryEntry {
            id: 0,
            connection_id: "c1".into(),
            sql: sql.into(),
            executed_at: now_ms(),
            duration_ms: 1.5,
            row_count: 3,
            error: None,
        }
    }

    #[test]
    fn file_is_encrypted_and_needs_the_key() {
        let path = temp_path();
        let db = AppDb::open(&path, KEY).unwrap();
        db.add_history(&entry("SELECT 'top secret marker'")).unwrap();
        drop(db);

        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(17).any(|w| w == b"top secret marker"), "plaintext found on disk");
        assert!(!bytes.starts_with(b"SQLite format 3"), "file has a plain SQLite header");

        let wrong = KEY.replace('0', "f");
        assert!(AppDb::open(&path, &wrong).is_err());
        let reopened = AppDb::open(&path, KEY).unwrap();
        assert_eq!(reopened.history(None, 10).unwrap().len(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn history_is_newest_first_and_searchable() {
        let db = AppDb::in_memory();
        db.add_history(&entry("SELECT * FROM users")).unwrap();
        db.add_history(&entry("SELECT 100% done")).unwrap();
        db.add_history(&entry("DELETE FROM orders")).unwrap();

        let all = db.history(None, 10).unwrap();
        assert_eq!(all[0].sql, "DELETE FROM orders");
        assert_eq!(db.history(Some("users"), 10).unwrap().len(), 1);
        assert_eq!(db.history(Some("USERS"), 10).unwrap().len(), 1);
        // % and _ are literal characters in searches.
        assert_eq!(db.history(Some("100%"), 10).unwrap().len(), 1);
        assert_eq!(db.history(Some("%"), 10).unwrap().len(), 1);
        db.add_history(&entry("SELECT * FROM users")).unwrap();
        assert_eq!(db.runs_of(" SELECT * FROM users\n", 10).unwrap().len(), 2);
        db.clear_history().unwrap();
        assert!(db.history(None, 10).unwrap().is_empty());
    }

    #[test]
    fn secrets_are_stored_encrypted() {
        let path = temp_path();
        let db = AppDb::open(&path, KEY).unwrap();
        db.set_secret("conn-1", "hunter2-staging-password").unwrap();
        db.set_secret("conn-1", "rotated-password").unwrap();
        assert_eq!(db.secret("conn-1").unwrap().unwrap().as_str(), "rotated-password");
        assert!(db.secret("missing").unwrap().is_none());
        drop(db);

        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(16).any(|w| w == b"rotated-password"), "secret in plaintext on disk");
        let db = AppDb::open(&path, KEY).unwrap();
        db.delete_secret("conn-1").unwrap();
        assert!(db.secret("conn-1").unwrap().is_none());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn saved_queries_upsert_and_delete() {
        let db = AppDb::in_memory();
        let mut q = SavedQuery { id: "q1".into(), name: " reports/daily ".into(), sql: "SELECT 1".into(), connection_id: None, updated_at: 0 };
        let saved = db.save_query(&q).unwrap();
        assert_eq!(saved.name, "reports/daily");
        q.sql = "SELECT 2".into();
        db.save_query(&q).unwrap();
        assert_eq!(db.saved_queries().unwrap().len(), 1);
        assert_eq!(db.saved_query("q1").unwrap().unwrap().sql, "SELECT 2");
        assert!(db.save_query(&SavedQuery { name: "  ".into(), ..q.clone() }).is_err());
        db.delete_saved_query("q1").unwrap();
        assert!(db.saved_queries().unwrap().is_empty());
    }
}
