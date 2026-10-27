# Onyx: what's built today

Onyx is a native macOS database client: fast, keyboard-first, safe on production, and built for a developer's daily work. It's made with Tauri 2, a Rust backend and a React/TypeScript UI. Query results stream from Rust to the UI as Apache Arrow batches, so large results stay responsive.

This document lists everything that works today, end to end, so you can suggest what would make it remarkable. The last section lists ideas already on the table, so you can go past them.

---

## 1. Databases it speaks

| Engine | What works |
|---|---|
| **PostgreSQL** | Full SQL, schemas, views, materialized views, functions, sequences, enums, EXPLAIN plans, server activity, users and roles |
| **MySQL / MariaDB** | Full SQL, databases, views, procedures, EXPLAIN, activity, users and grants |
| **SQLite** | Files, editing, structure |
| **DuckDB** (via its CLI) | Database files, plus querying CSV / Parquet / JSON files directly |
| **SQL Server** | SQL, browsing, editing (unit-tested; no live server tested yet) |
| **ClickHouse** | SQL over its HTTP interface, browsing |
| **MongoDB** | mongosh-style queries (`db.users.find({...})`), document view, editing and deleting documents |
| **Redis** | Key browser by type, key editor (string/hash/list/set/zset, TTL, rename, delete), commands, live MONITOR |

Drop a `.db`, `.sqlite`, `.duckdb`, CSV, Parquet or JSON file on the window and it opens right away.

---

## 2. Connections

- Connection form with engine cards, paste-a-URL autofill (`postgres://`, `mysql://`, `mongodb+srv://`, `redis://`…), and Test before saving.
- **SSL/TLS** modes (verify-full / require / prefer / disable), with warnings when traffic to a remote host is unencrypted or unverified.
- **Client certificates**: CA, client certificate and key files.
- **AWS RDS IAM sign-in**: a fresh short-lived token on every connection, from `~/.aws` profiles. No AWS SDK; the request signing is written in-house and tested against AWS's published example.
- **SSH tunnels**: ssh-agent, key file or password. Host keys are checked against `known_hosts`, with a trust-this-key flow. Hosts can be filled in from `~/.ssh/config`.
- **Environment tags**: Local / Staging / Prod. Prod gets a red marker everywhere and extra guards.
- **Read-only connections**, enforced by the server where the engine allows it.
- Folders and colours for connections. Each connection's colour follows it into tabs and the sidebar.
- **Secrets**: every password (database and SSH) and the AI API key live in an encrypted SQLCipher vault. Only that vault's key sits in the macOS Keychain, so macOS asks at most once per launch. Logs mask credentials.

---

## 3. Browsing a database

- Sidebar schema tree: tables (with row-count estimates), views, materialized views, functions, procedures, sequences, enums. It has filter, pins, collapse all, and can sit on the left or right.
- Table menu:
  - view data or structure
  - generate SELECT / INSERT / UPDATE / DELETE templates
  - export (CSV, JSON, SQL INSERTs, Excel)
  - import CSV
  - generate realistic test rows (not on prod)
  - copy to another connection
  - copy with related rows
  - live tail
  - truncate (guarded)
  - show in ER diagram
- **Structure view**:
  - columns, indexes, foreign keys (both directions), checks, triggers and the full DDL
  - edit columns and drop columns, indexes or foreign keys
  - every change is reviewed as SQL before it's applied
- **New table designer**:
  - columns with type suggestions, primary key and identity/auto-increment per engine
  - indexes (including unique) and foreign keys picked from existing tables
  - live SQL preview, then Create or Open in editor
  - MongoDB gets create-collection instead
- **ER diagram**:
  - auto-layout that stays readable for 200+ table schemas: related groups, wrapped columns, and a grid for tables with no relations
  - a keys-only mode and a zoomed-out overview that shows table names
  - drag tables, highlight relations on hover, export SVG or PNG

---

## 4. Writing and running queries

- **Editor (CodeMirror 6)**:
  - completion for schemas, tables and columns; JOIN … ON suggestions from foreign keys
  - snippets (`sel` ⇥), Vim keys, SQL formatting (⇧⌘F)
  - inline error marks
- Run the statement under the cursor (⌘↵) or everything (⇧⌘↵). Cancel and timeouts are supported.
- **Query variables**: `:name` placeholders prompt for values.
- **Transactions**: open one in a tab and commit or roll back explicitly. The tab keeps its own session.
- **Split editor** (⌘\\): two tabs side by side with a resizable divider.
- **Command palette** (⌘K): every action, file, table, theme and saved query.
- **Natural-language SQL** (⇧⌘I): describe what you want and get SQL from the Claude API. Sent: your request, the schema (names, types, foreign keys), Claude's previous answer in the chat, and the editor's SQL only if you include it. Never rows. It's opt-in per connection and always off for prod. You can Insert, Replace, Run, or **Run & chart**.
- **EXPLAIN view**: a visual plan tree with costs, rows and time per node. EXPLAIN ANALYZE asks first because it runs the query.
- **History** (searchable, with timings), **saved queries** (⌘S), and a timing history per saved query.
- **Run a big .sql file in the background**: streams statements of any size with progress. It understands dumps (Postgres `COPY … FROM stdin`, dollar quoting, MySQL `DELIMITER`).

---

## 5. Results and data editing

- **Fast canvas grid** (Glide Data Grid) fed by streamed Arrow batches:
  - sort, hide columns, find, row details panel
  - "Load more" or "Fetch all" when a result is capped
- **Copy** as TSV, CSV, JSON, Markdown table or INSERT statements, with or without column names.
- **Table editing**:
  - inline cell edits, add / duplicate / delete rows, Set NULL
  - "Set value for N cells", paste a block from a spreadsheet, edit a row in a form, a JSON editor for JSON columns
  - every change is staged and reviewed as SQL before it's applied
- **Filter bar** with typed conditions, pagination, and export of the filtered rows.
- **Follow foreign keys**: ⌘-click a value to open the row it points at.
- **Related rows view**:
  - one row in the middle, the rows it references on the left, the rows that reference it on the right
  - click any row to move to it
- **Column profile**: null %, distinct values, min/max, top values and a histogram.
- **Charts**: line or bar from any result. Pick X and up to several Y series.
- **Compare runs**: pin a result, re-run, then see side by side or a row-level diff.
- **Result to image**: copy or save the grid or the chart as a PNG, in the current theme.
- **Export** any query's full result to CSV, JSON, SQL or XLSX, streamed to disk and run in the background.

---

## 6. Safety nets

- **Prod guard**: statements that destroy data or change the schema need confirmation on prod connections. This covers SQL, plus Redis and Mongo bulk operations.
- **Preview before commit on prod**: an UPDATE or DELETE runs inside a transaction that is always rolled back, to show the exact rows before and after. Then you decide.
- **Cost guard**: warns when a query on prod would fully scan a large table (200k+ rows), using the engine's EXPLAIN.
- **Undo journal**: every UPDATE/DELETE Onyx runs records the rows it changed (up to 5,000) and the reverse SQL. Undo puts them back in one transaction.
- **Privacy mode** (⇧⌘P): masks emails, phones, tokens and similar data everywhere: grid, row panel, documents, live tail, exported images. Handy for screen sharing.
- Read-only connections, prod-only confirmations for restores and bulk writes, and history can be turned off for prod.

---

## 7. Moving data around

- **Copy rows to another connection**: a query or table result goes into a new or existing table, with type translation across engines.
- **Copy with related rows**: pick rows (say 50 users) and copy them with everything they reference, plus optionally the rows that reference them (their orders, payments…). Parents are inserted first, and rows already there are skipped. Built for making realistic local test data from staging.
- **Compare data between two connections**: matched by key columns, shown as changed / added / removed, with generated sync SQL.
- **Compare schemas** across connections, even across engines. You get a migration script (drops commented out) and can **save it as a migration** (up and down files).
- **Export a whole database as one .sql file**: the CREATE statements for every table and view, optionally with all data as INSERTs. It's built in, with no pg_dump needed.
- **Dump and restore** with the native tools (pg_dump / pg_restore / mysqldump / sqlite3). Passwords are never passed on the command line.
- **CSV import** with column mapping and a preview.
- **Test data generator**: realistic values from column names and types, respecting foreign keys and enums.
- **Background jobs** for every long task, with a progress indicator and a toast when done.

---

## 8. Analysis

- **Cross-database queries**: give connections short names and join them in one query, e.g. `pg.public.users` JOIN `my.orders` (Postgres × MySQL × SQLite × …). Tables are pulled into an in-memory SQLite and joined there; nothing is written to the sources.
- **Notebooks** (`.qnb` files in the IDE folder):
  - SQL and Markdown cells, each SQL cell with its results underneath, and Run all
  - all cells share one session, so temp tables carry between cells
- **Ask → chart**: a question in plain English becomes SQL and opens straight as a chart.

---

## 9. Monitoring

- **Server activity**: running sessions, what they wait on and how long they've run, with cancel or end session (guarded on prod).
- **Live tail**: new rows of a table as they arrive, followed by an increasing key or timestamp, with a WHERE filter. New rows glow.
- **Query alerts**: a saved SELECT checked on a schedule while Onyx is open, e.g. "failed payments in the last hour > 0". Shows a macOS notification and an in-app toast when the condition turns true.
- **Index advisor**:
  - finds the slowest reads in your query history and EXPLAINs them, without running them
  - spots full scans of big tables and suggests `CREATE INDEX` statements
  - skips columns that are already indexed
- **Redis MONITOR**: live command stream.

---

## 10. IDE mode (a folder of SQL files)

- Open any folder: a file explorer with create, rename, drag-to-move, and Reveal in Finder. Files autosave and each file remembers its connection.
- Cursor-style layout with results in a bottom panel.
- **Migrations panel**:
  - `migrations/<version>_name.up.sql` / `.down.sql` files
  - shows applied or pending against any connection, recorded in its `onyx_migrations` table
  - apply pending or roll back the last; on Postgres each migration runs in a transaction
- **Git**: branch and ahead/behind, changed files, diffs, stage/unstage, commit. It never discards changes or rewrites history.

---

## 11. Look and feel

- Several dark and light themes, following the system appearance or fixed. Custom dropdowns, switches and fields throughout.
- Native macOS title bar integration, thin scrollbars, interface size and font settings.
- Editor-style tabs that carry each connection's colour, right-click tab menu, middle-click to close.
- Everything reachable from the keyboard: native menu shortcuts and the ⌘K palette.

---

## 12. Under the hood

- **Rust backend**: one `Session` abstraction over 8 engines, streaming results as Arrow IPC over Tauri channels. Each editor tab can have its own server session.
- **Its own implementations**:
  - TLS on rustls
  - a minimal HTTP client (Claude API, ClickHouse)
  - AWS request signing
  - SQL statement splitting for dumps
  - a mongosh-style query parser
- **Tests**: 113 Rust tests, including live integration tests against local Postgres, MySQL, Redis and ClickHouse, and 87 frontend unit tests.

---

## Ideas already on the list (so you can go past them)

Visual query builder · pivot tables · JSON column explorer · find & replace in a column · query forms from `:variables` · data dictionary export · impact check before DROP/ALTER · schema history timeline · unused/duplicate index report and table bloat · lock/blocking tree · anonymized dumps · scheduled local backups · per-connection safety limits (timeouts, max rows) · dashboards of pinned charts · join a dropped CSV with a live table · AI that explains plans and errors · real-time row changes via Postgres LISTEN/NOTIFY · shareable bundles of connections and saved queries.

---

## The question

**What would make a developer say "wow, I can't go back to my old database client"?**

We're especially interested in things that:
- save real time in daily work (debugging production data, building features, reviewing data changes),
- make working on production data safer or less scary,
- use the fact that Onyx sees *across* databases and *over time* (history, journal, alerts),
- or turn a data question into an answer in seconds.
