# Onyx

A fast, secure, keyboard-first database client for macOS, built with Tauri 2, Rust and React. Engines:
PostgreSQL, MySQL, SQLite, DuckDB (through its CLI), SQL Server, ClickHouse, MongoDB (mongosh-style
queries, document view) and Redis (key browser, commands).

**IDE mode** (⇧⌘E, or the folder-code button in the sidebar) opens a folder of `.sql` files: create
files and folders, edit with autosave, select a query and run it from the bar that appears.

## Run

```bash
pnpm install
pnpm start        # starts the dev Postgres (if needed) and the app
```

`pnpm db:stop` stops the dev databases.

### Keychain prompts

Onyx keeps one Keychain item: the key to its encrypted vault (history, saved queries, and every
database and SSH password). macOS asks once when a build first reads it; choose **Always Allow**.
macOS ties that permission to the exact binary, so each new Rust build asks again: in development
that's after Rust changes, for an installed release only after an update. (A paid Apple developer
certificate would make it survive rebuilds.)

## Where things are stored

- Connection settings: `~/Library/Application Support/dev.siddhant.onyx/connections.json` (no secrets)
- The vault key: macOS Keychain, service `dev.siddhant.onyx`, account `app-db-key`
- History, saved queries, database and SSH passwords: `onyx.db` in the app data directory, encrypted with SQLCipher
- Trusted SSH host keys: `known_hosts` in the app config directory (plus your `~/.ssh/known_hosts`, read-only)

## Test

```bash
pnpm test                                   # frontend unit tests
cd src-tauri && ONYX_TEST_PG=1 ONYX_TEST_MYSQL=1 ONYX_TEST_REDIS=63799 ONYX_TEST_CLICKHOUSE=8124 cargo test
# ONYX_TEST_MONGO=27019 adds MongoDB (needs mongod; scripts/dev-db.sh starts it when installed)
```

SQL Server has unit tests only: it needs a server (Docker or Azure SQL) for integration tests.

## Layout

- `src/` — React + TypeScript UI
  - `lib/ipc.ts` — typed wrappers for every Rust command
  - `lib/resultSet.ts` — streamed Arrow batches behind a cell lookup
  - `lib/sqlSplit.ts` — statement splitting for "run statement under cursor"
  - `store/` — zustand stores (connections, tabs, runs, UI)
  - `components/` — sidebar, schema tree, editor, results grid
- `src-tauri/src/`
  - `commands.rs` — everything the UI can call
  - `connections.rs` — saved connections (JSON, no secrets)
  - `secrets.rs` — passwords in the macOS Keychain
  - `appdb.rs` — the encrypted vault: history, saved queries, secrets
  - `guard.rs` — prod guard: finds destructive statements
  - `ssh.rs` — SSH tunnels and host-key checks
  - `menu.rs` — native menu (⌘T, ⌘W, ⌘K, ⌘S, …)
  - `db/edit.rs` — table edits → parameterized SQL
  - `workspace.rs` — IDE mode's folder of SQL files (paths kept inside the folder)
  - `db/` — one `Session` over every engine: shared result streaming (`stream.rs`), TLS (`tls.rs`)
    - `db/postgres/`, `db/mysql/`, `sqlite.rs`, `duckdb.rs`, `sqlserver.rs`, `clickhouse.rs` — SQL engines
    - `db/mongo/` (with `shell.rs`, the mongosh-style parser), `redis.rs` — document and key-value engines
- `src-tauri/capabilities/` — what the UI is allowed to call
