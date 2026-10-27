import { Channel, invoke } from "@tauri-apps/api/core";
import { toast } from "../store/toasts";

// Types mirror the Rust structs in src-tauri/src (serde camelCase).

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
}

export type Engine = "postgres" | "mysql" | "sqlite" | "duckdb" | "sqlserver" | "clickhouse" | "redis" | "mongodb";
export type SslMode = "disable" | "prefer" | "require" | "verify-full";
export type Environment = "local" | "staging" | "prod";

export type SshAuth = "agent" | "key" | "password";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyPath: string | null;
}

export interface ConnectionConfig {
  id: string;
  engine: Engine;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  environment: Environment;
  color: string;
  /** Server-enforced read-only sessions. */
  readOnly: boolean;
  ssh: SshConfig | null;
  /** Groups connections on the Connections screen. */
  folder?: string | null;
  /** Natural-language SQL may send this connection's schema to the Claude API. */
  aiEnabled?: boolean;
  /** PEM files: a CA to trust, a client certificate and its key. */
  sslCa?: string | null;
  sslCert?: string | null;
  sslKey?: string | null;
  /** Amazon RDS IAM sign-in instead of a password (Postgres, MySQL). */
  awsIam?: { profile?: string | null; region?: string | null } | null;
}

/** A write Onyx ran, with the SQL that reverses it (null: can't be undone, `note` says why). */
export interface JournalEntry {
  id: number;
  connectionId: string;
  at: number;
  statement: string;
  target: string;
  rows: number;
  reverse: string | null;
  note: string | null;
  undoneAt: number | null;
}

export interface WritePreview {
  update: boolean;
  target: string;
  columns: string[];
  keyColumns: string[];
  before: (string | null)[][];
  after: (string | null)[][];
  total: number;
}

export interface SshConfigHost {
  alias: string;
  hostName: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export interface ConnectInfo {
  serverVersion: string;
}

export interface Risk {
  statement: string;
  reason: string;
}

export interface HostKeyIssue {
  host: string;
  port: number;
  fingerprint: string;
  key: string;
  /** A different key is on record: possibly an attack. */
  changed: boolean;
}

export interface ErrorPayload {
  message: string;
  detail: string | null;
  hint: string | null;
  /** 1-based character offset into the SQL that was sent. */
  position: number | null;
  code: string | null;
  /** Prod guard: statements that need confirmation. */
  risks?: Risk[];
  /** SSH host key that isn't trusted. */
  hostKey?: HostKeyIssue;
}

export interface ShrinkSpec {
  schema: string;
  tables: string[];
  query: string;
  other: string;
  expect: string;
  rowCap: number;
  maxTrials: number;
  maxSeconds: number;
}

export interface BackfillSpec {
  schema: string;
  table: string;
  key: string;
  eligible: string;
  set: string;
  postcondition: string;
  batchSize: number;
  pauseMs: number;
  lockTimeoutMs: number;
  maxFailedBatches: number;
}

export interface BackfillJob {
  id: string;
  spec: BackfillSpec;
  status: string;
  candidates: number;
  committed: number;
  skipped: number;
  failed: number;
  pending: number;
  batches: number;
  lastError: string | null;
  updatedAt: string;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}

export interface HistoryEntry {
  id: number;
  connectionId: string;
  sql: string;
  executedAt: number;
  durationMs: number;
  rowCount: number;
  error: string | null;
}

export interface SavedQuery {
  id: string;
  /** "folder/name" groups queries into folders. */
  name: string;
  sql: string;
  connectionId: string | null;
  updatedAt: number;
}

export interface Cell {
  column: string;
  value: string | null;
}

/** `original`: the values as loaded, so a row someone else changed meanwhile isn't overwritten. */
export type RowEdit =
  | { kind: "update"; key: Cell[]; set: Cell[]; original?: Cell[] }
  | { kind: "insert"; values: Cell[] }
  | { kind: "delete"; key: Cell[]; original?: Cell[] };

/** What saving edits did, read back from the database afterwards. */
export interface ApplyReport {
  changed: number;
  checked: number;
  /** Values stored differently from what was typed (the database's own formatting). */
  notes: string[];
  problems: string[];
}

export type DbObjectKind =
  | "table"
  | "partitioned-table"
  | "view"
  | "materialized-view"
  | "foreign-table"
  | "sequence"
  | "function"
  | "procedure"
  | "enum"
  /** A MongoDB collection. */
  | "collection"
  /** A Redis key; `detail` is its type. */
  | "key";

export interface DbObject {
  name: string;
  kind: DbObjectKind;
  detail: string | null;
  estimatedRows: number | null;
  sizeBytes: number | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  default: string | null;
}

export interface StructureColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  extra: string | null;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  sizeBytes: number | null;
  /** Index scans since statistics were reset (Postgres), or uses since restart (MySQL). */
  scans: number | null;
}

export interface CheckInfo {
  name: string;
  kind: "check" | "unique" | "exclude";
  definition: string;
}

export interface TriggerInfo {
  name: string;
  timing: string;
  definition: string;
}

export interface ForeignKeyRef extends ForeignKeyInfo {
  schema: string;
  table: string;
}

export interface TableSnapshot {
  name: string;
  kind: "table" | "view";
  columns: StructureColumn[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

/** A foreign key in another table that points at this one. */
export interface IncomingReference {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refColumns: string[];
}

export interface TableStructure {
  columns: StructureColumn[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  referencedBy: IncomingReference[];
  checks: CheckInfo[];
  triggers: TriggerInfo[];
  ddl: string;
}

export type ExportFormat = "csv" | "json" | "sql" | "xlsx";

export interface CompletionTable {
  schema: string;
  name: string;
  columns: string[];
  types: string[];
}

export interface CsvPreview {
  path: string;
  delimiter: string;
  headers: string[];
  rows: string[][];
  sizeBytes: number;
}

export interface ImportPlan {
  path: string;
  delimiter: string;
  hasHeader: boolean;
  /** Per CSV column: the table column it goes into, or null to skip it. */
  mapping: (string | null)[];
  emptyAsNull: boolean;
}

/** Bulk jobs (import, copy, dump) report progress as JSON events. */
export type ProgressEvent =
  | { type: "progress"; rows?: number; bytes?: number | null }
  | { type: "log"; line: string };

export interface ToolStatus {
  duckdb: boolean;
  pgDump: boolean;
  mysqldump: boolean;
  sqlite3: boolean;
}

export type QueryEvent =
  | { type: "resultStart"; index: number; columns: string[] }
  | { type: "resultEnd"; index: number; rowCount: number; truncated: boolean }
  | { type: "command"; index: number; rowsAffected: number }
  | { type: "error"; error: ErrorPayload; cancelled: boolean }
  | { type: "done"; elapsedMs: number };

/** Query events arrive as JSON; row batches arrive as raw Arrow IPC bytes. */
export type QueryMessage = QueryEvent | ArrayBuffer;

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  /** The UI is up. True in startup-probe mode, where the app quits without opening the vault. */
  appReady: () => invoke<boolean>("app_ready"),

  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  /** Secrets: undefined keeps the stored one, "" removes it. */
  saveConnection: (config: ConnectionConfig, password?: string, sshSecret?: string) =>
    invoke<void>("save_connection", { config, password, sshSecret }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig, password?: string, sshSecret?: string) =>
    invoke<ConnectInfo>("test_connection", { config, password, sshSecret }),
  trustSshHost: (issue: HostKeyIssue) =>
    invoke<void>("trust_ssh_host", { host: issue.host, port: issue.port, key: issue.key }),

  connect: (id: string) => invoke<ConnectInfo>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),

  listSchemas: (id: string) => invoke<string[]>("list_schemas", { id }),
  listObjects: (id: string, schema: string) => invoke<DbObject[]>("list_objects", { id, schema }),
  listColumns: (id: string, schema: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, schema, table }),
  completionTables: (id: string) => invoke<CompletionTable[]>("completion_tables", { id }),
  tableStructure: (id: string, schema: string, table: string) =>
    invoke<TableStructure>("table_structure", { id, schema, table }),
  /** Opens a native save dialog; resolves null if the user cancels. */
  exportQuery: (id: string, sql: string, format: ExportFormat, name: string) =>
    invoke<{ path: string; rows: number } | null>("export_query", { id, sql, format, name }),

  /** `record`: add to history. `confirmed`: the user approved risky SQL on prod. */
  runQuery: (
    id: string,
    sql: string,
    /** `tab`: run on that query tab's own session. */
    opts: { record: boolean; confirmed: boolean; maxRows?: number | null; timeoutMs?: number | null; tab?: string | null },
    onEvent: Channel<QueryMessage>,
  ) => invoke<void>("run_query", { id, sql, maxRows: null, timeoutMs: null, tab: null, ...opts, onEvent }),
  cancelQuery: (id: string, tab: string | null = null) => invoke<void>("cancel_query", { id, tab }),
  /** A query tab closed: its session closes (rolling back an open transaction). */
  closeTabSession: (id: string, tab: string) => invoke<void>("close_tab_session", { id, tab }),

  previewEdits: (id: string, schema: string, table: string, edits: RowEdit[]) =>
    invoke<string[]>("preview_edits", { id, schema, table, edits }),
  /** Three-way check: fields someone else changed since they were loaded. */
  checkEdits: (id: string, schema: string, table: string, edits: RowEdit[]) => invoke<import("./merge").FieldState[]>("check_edits", { id, schema, table, edits }),
  applyEdits: (id: string, schema: string, table: string, edits: RowEdit[], confirmed: boolean) =>
    invoke<ApplyReport>("apply_edits", { id, schema, table, edits, confirmed }),

  listHistory: (search?: string) => invoke<HistoryEntry[]>("list_history", { search }),
  clearHistory: () => invoke<void>("clear_history"),
  listSavedQueries: () => invoke<SavedQuery[]>("list_saved_queries"),
  saveQuery: (query: SavedQuery) => invoke<SavedQuery>("save_query", { query }),
  deleteSavedQuery: (id: string) => invoke<void>("delete_saved_query", { id }),

  reorderConnections: (ids: string[]) => invoke<void>("reorder_connections", { ids }),
  /** Native Open dialog; null if cancelled. */
  /** null when cancelled; a wrong kind of file shows its error and returns null. */
  pickFile: (title: string, extensions: string[] = []) =>
    invoke<string | null>("pick_file", { title, extensions }).catch((e) => {
      toast(toError(e).message, "error");
      return null;
    }),
  /** Native Save dialog, then writes the file; null if cancelled. */
  saveFile: (name: string, extension: string, contents: string, base64 = false) =>
    invoke<string | null>("save_file", { name, extension, contents, base64 }),
  toolStatus: () => invoke<ToolStatus>("tool_status"),

  allForeignKeys: (id: string) => invoke<ForeignKeyRef[]>("all_foreign_keys", { id }),
  schemaSnapshot: (id: string, schema: string) => invoke<TableSnapshot[]>("schema_snapshot", { id, schema }),

  csvPreview: (path: string) => invoke<CsvPreview>("csv_preview", { path }),
  importCsv: (id: string, schema: string, table: string, plan: ImportPlan, confirmed: boolean, onProgress: Channel<ProgressEvent>) =>
    invoke<number>("import_csv", { id, schema, table, plan, confirmed, onProgress }),
  insertRows: (id: string, schema: string, table: string, columns: string[], rows: (string | null)[][]) =>
    invoke<number>("insert_rows", { id, schema, table, columns, rows }),
  copyRows: (args: {
    sourceId: string;
    sql: string;
    targetId: string;
    schema: string;
    table: string;
    columns: string[] | null;
    createSql: string | null;
    confirmed: boolean;
    onProgress: Channel<ProgressEvent>;
  }) => invoke<number>("copy_rows", args),

  dumpDatabase: (id: string, schema: string | null, format: "plain" | "custom", onProgress: Channel<ProgressEvent>) =>
    invoke<{ path: string; bytes: number } | null>("dump_database", { id, schema, format, onProgress }),
  /** Every CREATE TABLE / VIEW of a schema in one .sql file, optionally with INSERTs; null if cancelled. */
  exportDatabaseSql: (id: string, schema: string, includeData: boolean, onProgress: Channel<ProgressEvent>) =>
    invoke<{ path: string; tables: number; views: number; rows: number } | null>("export_database_sql", { id, schema, includeData, onProgress }),
  /** Picks a .sql file (native dialog) and runs it; null if cancelled. */
  runSqlFile: (id: string, stopOnError: boolean, confirmed: boolean, onProgress: Channel<ProgressEvent>) =>
    invoke<{ statements: number; failed: number; errors: string[]; skipped: string[] } | null>("run_sql_file", { id, stopOnError, confirmed, onProgress }),
  sshConfigHosts: () => invoke<SshConfigHost[]>("ssh_config_hosts"),
  listChanges: (id: string) => invoke<JournalEntry[]>("list_changes", { id }),
  undoChange: (id: string, change: number, confirmed: boolean) => invoke<void>("undo_change", { id, change, confirmed }),
  copyRelated: (
    id: string,
    target: string,
    request: { schema: string; table: string; filter: string; limit: number; children: boolean; targetSchema: string },
    confirmed: boolean,
    onProgress: Channel<ProgressEvent>,
  ) => invoke<{ tables: Record<string, number>; read: number }>("copy_related", { id, target, request, confirmed, onProgress }),
  federatedQuery: (sources: { alias: string; connectionId: string }[], sql: string, maxRows: number | null, onEvent: Channel<QueryMessage>) =>
    invoke<void>("federated_query", { sources, sql, maxRows, onEvent }),
  previewWrite: (id: string, sql: string) => invoke<WritePreview | null>("preview_write", { id, sql }),
  restoreDatabase: (id: string, path: string, schema: string | null, confirmed: boolean, onProgress: Channel<ProgressEvent>) =>
    invoke<void>("restore_database", { id, path, schema, confirmed, onProgress }),

  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  hasApiKey: () => invoke<boolean>("has_api_key"),
  uiStateGet: (key: string) => invoke<string | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: string | null) => invoke<void>("ui_state_set", { key, value }),
  aiSql: (id: string, prompt: string, currentSql: string | null, defaultSchema: string | null) =>
    invoke<{ sql: string; explanation: string }>("ai_sql", { id, prompt, currentSql, defaultSchema }),

  queryTimings: (sql: string) => invoke<HistoryEntry[]>("query_timings", { sql }),
  slowQueries: (id: string, minMs: number) =>
    invoke<{ sql: string; runs: number; maxMs: number; avgMs: number; lastAt: number }[]>("slow_queries", { id, minMs }),
  migrationStatus: (id: string) => invoke<string[]>("migration_status", { id }),
  applyMigration: (id: string, version: string, sql: string, up: boolean, confirmed: boolean) =>
    invoke<number>("apply_migration", { id, version, sql, up, confirmed }),
  // Git in IDE mode (the workspace folder's repository).
  gitStatus: () => invoke<GitStatus | null>("git_status"),
  gitDiff: (path: string, staged: boolean) => invoke<string>("git_diff", { path, staged }),
  gitStage: (paths: string[]) => invoke<void>("git_stage", { paths }),
  gitUnstage: (paths: string[]) => invoke<void>("git_unstage", { paths }),
  gitCommit: (message: string) => invoke<string>("git_commit", { message }),
  sqlStages: (id: string, sql: string) => invoke<import("./sqlLogic").StageReport>("sql_stages", { id, sql }),
  sqlMissing: (id: string, sql: string, alias: string, key: [string, string][]) => invoke<import("./sqlLogic").MissingStep[]>("sql_missing", { id, sql, alias, key }),
  sqlDrill: (id: string, sql: string, row: Record<string, string | null>, column: string) => invoke<import("./sqlLogic").Drill>("sql_drill", { id, sql, row, column }),
  backfillSetup: (id: string, schema: string, confirmed: boolean) => invoke<void>("backfill_setup", { id, schema, confirmed }),
  backfillCreate: (id: string, spec: BackfillSpec, confirmed: boolean) => invoke<BackfillJob>("backfill_create", { id, spec, confirmed }),
  backfillList: (id: string, schema: string) => invoke<BackfillJob[]>("backfill_list", { id, schema }),
  backfillRun: (id: string, schema: string, job: string, confirmed: boolean, onProgress: Channel<ProgressEvent>) => invoke<BackfillJob>("backfill_run", { id, schema, job, confirmed, onProgress }),
  backfillPause: (job: string) => invoke<void>("backfill_pause", { job }),
  backfillVerify: (id: string, schema: string, job: string) => invoke<{ checked: number; violations: number; examples: string[]; skipped: number; failed: number }>("backfill_verify", { id, schema, job }),
  backfillRetry: (id: string, schema: string, job: string, confirmed: boolean) => invoke<void>("backfill_retry", { id, schema, job, confirmed }),
  codeReferences: (schema: string, table: string, column: string | null) =>
    invoke<{ references: { path: string; line: number; text: string; kind: "resolved" | "probable" | "textual"; via: string }[]; filesScanned: number; truncated: boolean; revision: string | null; models: string[] }>("code_references", { schema, table, column }),
  openCode: (path: string, line: number) => invoke<void>("open_code", { path, line }),
  shrinkRun: (id: string, run: string, spec: ShrinkSpec, confirmed: boolean, onProgress: Channel<ProgressEvent>) =>
    invoke<{ scratch: string; tables: [string, number, number][]; trials: number; seconds: number; stopped: boolean; verifiedClean: boolean; notes: string[] }>("shrink_run", { id, run, spec, confirmed, onProgress }),
  shrinkStop: (run: string) => invoke<void>("shrink_stop", { run }),
  shrinkExport: (id: string, scratch: string, spec: ShrinkSpec) => invoke<string>("shrink_export", { id, scratch, spec }),
  shrinkDrop: (id: string, scratch: string) => invoke<void>("shrink_drop", { id, scratch }),
  listInvestigations: () => invoke<{ id: string; title: string; updatedAt: number }[]>("list_investigations"),
  getInvestigation: (id: string) => invoke<string>("get_investigation", { id }),
  saveInvestigation: (id: string, title: string, body: string) => invoke<number>("save_investigation", { id, title, body }),
  deleteInvestigation: (id: string) => invoke<void>("delete_investigation", { id }),
  /** A macOS notification. */
  notify: (title: string, body: string) => invoke<void>("notify", { title, body }),
  /** Activity queries and session kills, on the connection's second session. */
  adminQuery: (id: string, sql: string, confirmed = false) =>
    invoke<{ columns: string[]; rows: (string | null)[][] }>("admin_query", { id, sql, confirmed }),

  // IDE mode: a folder of SQL files. Paths are relative to the folder.
  workspaceList: () => invoke<WorkspaceListing | null>("workspace_list"),
  /** A native folder dialog; null when cancelled. */
  workspaceOpen: () => invoke<WorkspaceListing | null>("workspace_open"),
  workspaceRead: (path: string) => invoke<string>("workspace_read", { path }),
  workspaceWrite: (path: string, content: string) => invoke<void>("workspace_write", { path, content }),
  workspaceCreate: (path: string, dir: boolean) => invoke<void>("workspace_create", { path, dir }),
  workspaceRename: (from: string, to: string) => invoke<void>("workspace_rename", { from, to }),
  workspaceReveal: (path: string) => invoke<void>("workspace_reveal", { path }),
};

export interface WorkspaceListing {
  root: string;
  /** Sorted by path; `/`-separated, relative to the root. */
  entries: { path: string; dir: boolean }[];
  truncated: boolean;
}

/** Commands reject with an `ErrorPayload`; normalize anything else into one. */
export function toError(e: unknown): ErrorPayload {
  if (e && typeof e === "object" && "message" in e) {
    const p = e as Partial<ErrorPayload>;
    return {
      message: String(p.message),
      detail: p.detail ?? null,
      hint: p.hint ?? null,
      position: p.position ?? null,
      code: p.code ?? null,
      risks: p.risks,
      hostKey: p.hostKey,
    };
  }
  return { message: String(e), detail: null, hint: null, position: null, code: null };
}

export const ENGINE_LABEL: Record<Engine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  duckdb: "DuckDB",
  sqlserver: "SQL Server",
  clickhouse: "ClickHouse",
  redis: "Redis",
  mongodb: "MongoDB",
};
/** Engines that take SQL (Redis takes commands, MongoDB shell-style queries). */
export const isSqlEngine = (engine: Engine) => engine !== "redis" && engine !== "mongodb";
/** Engines whose table view can edit rows in place. */
export const canEditRows = (engine: Engine) => ["postgres", "mysql", "sqlite", "duckdb", "sqlserver"].includes(engine);

/** SQLite and DuckDB: a file, no host or user. */
export const isFileEngine = (engine: Engine) => engine === "sqlite" || engine === "duckdb";

/** Where unqualified names resolve: Postgres "public", the MySQL database, SQLite/DuckDB "main",
 * SQL Server "dbo", the ClickHouse or MongoDB database, Redis "db0". */
export function defaultSchemaOf(c: Pick<ConnectionConfig, "engine" | "database">): string {
  switch (c.engine) {
    case "mysql":
      return c.database;
    case "postgres":
      return "public";
    case "sqlserver":
      return "dbo";
    case "clickhouse":
      return c.database || "default";
    case "mongodb":
      return c.database || "test";
    case "redis":
      return `db${c.database || "0"}`;
    default:
      return "main";
  }
}
