# Investigation PRD: implementation brief

This brief covers what Phase 0 found and what the first slices deliver. It answers the PRD's planning handoff (§12). Scope: PostgreSQL first; other engines are gated, not approximated.

## Phase 0: foundations audit

| Foundation (PRD §3, §5) | State before this work | Action |
|---|---|---|
| Typed values, precision | Values travel as exact text (Arrow utf8). JSON copy used to round long decimals and CSV merged NULL with `''`. | Fixed. Regression tests cover bigint limits, 38-digit decimals, Unicode, NULL vs `''`, through the stream, CSV, JSON and SQL export, and the clipboard formats. |
| Duplicate / NULL matching keys | Result compare paired rows by repeated keys. | Fixed. Compare refuses non-unique or NULL keys, falls back to whole rows and shows why. |
| Guarded writes | Edits matched by primary key only. | Fixed. A pre-save re-read is compared with the loaded values. Postgres also guards inside the UPDATE (WHERE on the loaded text). After saving, rows are read back. |
| Undo conflicts | Undo restored old values over newer changes. | Fixed. The post-change image is recorded, and undo checks it with the rows locked (`FOR UPDATE` on PG/MySQL). Entries recorded before this change have no image and are undone unchecked. |
| View invalidation | Open tables stayed stale after undo and writes. | Fixed for undo and editor writes. Bulk import / copy-related don't announce yet. |
| Cancellation and unknown outcomes | Cancel is a request; a lost connection used to be silently reopened (PG) or left broken (MySQL). | Fixed. A lost tab connection is reported once. A write that loses its connection is marked "outcome unknown" and re-running it asks first. |
| Stream completeness | Helpers trusted the command's return, but channel messages can arrive later (the EXPLAIN "Unexpected EOF" bug). | Fixed. Every helper waits for the stream's `done`. |
| Session ownership | Per-tab sessions exist; undo and migrations use their own sessions and close them. | Reused for F12 and F13 (owned sessions, closed on exit). |
| Evidence storage | None. | Built: investigations in the encrypted vault (SQLCipher), versioned JSON, local only. |
| Artifact privacy | Credentials are in the vault, never in artifacts. | Investigations store connection *references* (id, name, engine, environment), never secrets. Export shows a preview and lets you leave out row data. |

## Slices delivered

| Feature | Slice | Support |
|---|---|---|
| Investigations | Question, scope, evidence (with provenance, time, completeness), findings labelled Observed / Derived / Hypothesis / Unknown / Partial. Save from compare, results, context reports and race runs. Export with a redaction preview. | All engines (evidence is engine-neutral) |
| F12 Context comparison | A copyable read-only diagnostic query for the app's connection; paste its JSON report, then diff it against Onyx's own capture. Every field is marked captured / supplied / unknown. Reproduce allowlisted settings in a dedicated session, re-run a query in both sessions and compare. | PostgreSQL |
| F04 Semantic JSON | A precision-safe parser (big numbers stay exact), a tree explorer with search, and a semantic diff. Key order is ignored; arrays are compared by position by default or by a unique key, and duplicate keys show as ambiguity. Missing key, JSON null, SQL NULL, `""` and `[]` are kept distinct. Generates PG path expressions. | Any engine's JSON text; expressions for PostgreSQL |
| F11 Three-way merge | Each edited field is compared base / mine / theirs. Changes on different fields are kept automatically; both changing to the same value is not a conflict; real conflicts are resolved per field (keep mine / take theirs). Remote deletes are conflicts. The apply is guarded in the transaction (PG and MySQL). | PG, MySQL (guarded in the write); SQLite, DuckDB, SQL Server (pre-save check only) |
| F02 Entity comparison | Two entities of one table, their parents and children through declared foreign keys (depth 1–2). Related rows are matched by a chosen business key with uniqueness validated. Shows missing relationships, changed fields and count differences. Capped collections are marked partial and never "equal". Ignored fields stay visible and reversible. | Same-engine SQL |
| F13 Race lab | Two owned sessions, setup / teardown / assertion SQL and an explicit step schedule. Blocked steps show as waiting while the schedule continues, under a bounded lock timeout. Fixture reset is verified each run, and the schedule plus its outcome can be saved. | PostgreSQL, non-prod connections only |

## Phases 2–5

| Feature | Slice | Support | Verified |
|---|---|---|---|
| F15 Cache consistency | A mapping from a SQL row selector to a Redis key template and fields (JSON path, hash field or whole string), with an optional version on both sides. Every read is timed separately; a bounded re-check tells a passing delay from a stale cache. Missing key, missing field, NULL, expired-between-reads and decode errors are kept distinct. | SQL connection + Redis (string / JSON / hash) | Unit tests |
| F03 Before / after | Bounded selectors (capped at 1,000 rows), each database captured in one consistent read-only snapshot. Capture after, or watch until something changes, within a time budget. Changes are labelled "observed during the interval", never attributed. | SQL engines (snapshot on PG/MySQL) | Unit tests |
| F14 Permissions / RLS | Grants, RLS enabled/forced, owner and bypass (superuser, BYPASSRLS, owner without FORCE), and policies. Tests run as each role (with Supabase JWT claims) in a transaction that is always rolled back, then the session's identity is checked. A missing grant is distinguished from zero visible rows; tests have allow/deny expectations. | PostgreSQL / Supabase | Live on local PG (policy, claims, cleanup) |
| F09 Edge-case fixtures | One baseline row plus one row per edge case (one column at a time), with a manifest of what each row tests and what was left out and why. NULL never goes into NOT NULL columns. Integer, numeric(p,s) and varchar(n) boundaries; Unicode; DST gaps and overlaps; enums; JSON; zero/one/many parents. Invalid values are tested in savepoints and rolled back. Deterministic per seed and generator version. | SQL engines | Unit tests |
| F19 / F01 / F05 Query debugger | One shared analysis (sqlparser) of a documented subset: SELECT, INNER/LEFT JOIN … ON, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT. Stage counts include distinct records and fan-out; each predicate is TRUE/FALSE/NULL; missing-row explanations step through the stages (unknown ≠ false, inner-join removal, HAVING, beyond LIMIT with tie disclosure); aggregates drill down with reconciliation, NULL eligibility and repeated contributors. All in one REPEATABLE READ READ ONLY snapshot. Everything else is named as unsupported. | PostgreSQL | Live: 100 orders → 342 rows, NULL-unknown, join removal, SUM reconciles |
| F06 Performance experiments | Baseline and candidate as PREPARE/EXECUTE with typed parameters. Estimated plans separately from measured runs; warm-ups; alternating order; median, IQR and range with n. Results compared as multisets (capped compares are partial). Settings captured before and after, and changes flagged. "Faster" is only claimed when results match and the IQRs don't overlap. Measured runs are refused on prod. | PostgreSQL | Unit tests + PREPARE/EXPLAIN EXECUTE checked on local PG |
| F07 Resumable backfills | Candidates materialized once; each batch updates still-eligible rows and records its checkpoint in one transaction (`onyx_jobs`, `onyx_job_keys`, created on explicit approval). Pause between batches, resume from durable state, lock timeouts, failed batches commit nothing and are counted, postcondition verification. | PostgreSQL, one table, unique key | Live: pause/resume, skipped, failed batch, verify |
| F08 Find in code | Scans the IDE folder without running code. Prisma `@@map`/`@map` resolved; Prisma client calls and table-touching SQL probable; mentions textual; other schemas excluded; deps, build output and secrets skipped. Opens Cursor / VS Code at the line. Records the git revision. | Prisma, TS/JS, SQL, Python files | Unit test |
| F16 Request traces | OTLP/JSON (and a flat `spans` form) parsed with exact nanosecond times. Timeline, query shapes, N+1 detection, overlap-aware DB time (union, not sum), partial-trace detection. Replay refuses to guess missing parameters; opening a span never runs it. | Any trace with db.* attributes | Unit tests |
| F10 Tenant workspace | A recipe (schema, tenant column, approved queries with `:tenant`). Tables with the column are browsed scoped; tables without it are labelled shared. SQL is never rewritten; the tenant badge is shown on every view and saved with the evidence; read-only. | SQL engines | Manual |
| F18 Shrink a reproducer | Tables copied (constraints and foreign keys among them) into a scratch schema; a deterministic check is required first. Row chunks are deleted in savepoints and kept only if the failure persists. Re-verified from a clean copy. Budgets and stop keep the last verified state; export as SQL. Never on prod; the source is untouched. | PostgreSQL | Live: 500 → 1 order, clean re-check, source untouched |
| F17 Vector search | Exact reference (index scans off, one snapshot) vs approximate runs under session-scoped `hnsw.*` / `ivfflat.*` settings. Recall handles ties at the cut and fewer-than-k eligible rows; missed neighbors are listed; rows the filter removed are labelled separately. Extension version and indexes recorded. | PostgreSQL + pgvector | Unit tests (pgvector isn't installed locally) |

Every investigation tab sits behind its own error boundary: a crash in one tool stays in that tab.

## Known limits

- Live verification still pending for: F17 (needs pgvector), F15 against a real app cache, F12 against a real app connection, SQL reduction (F18 reduces data only).
- F01/F05/F19 cover the documented SQL subset; CTEs, UNION, window functions, DISTINCT and lateral joins are reported, not approximated.
