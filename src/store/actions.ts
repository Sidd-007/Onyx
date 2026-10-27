import { Channel } from "@tauri-apps/api/core";
import { tableFromIPC } from "apache-arrow";
import { api, toError, type ErrorPayload, type ExportFormat, type QueryMessage } from "../lib/ipc";
import { ResultSet } from "../lib/resultSet";
import { quoteIdent } from "../lib/sqlSplit";
import { plural } from "../lib/format";
import { runJob } from "./jobs";
import { toast } from "./toasts";
import { isConnected, useConnections } from "./connections";
import { useOverlays } from "./overlays";
import { useRuns } from "./runs";
import { useTabs, type ToolKind } from "./tabs";
import { useUi } from "./ui";
import { useWorkspace } from "./workspace";

/** Tool tab titles (kept here so stores don't import components). */
const TOOL_TITLES: Record<ToolKind, string> = {
  er: "ER diagram",
  diff: "Schema diff",
  activity: "Activity",
  datadiff: "Compare data",
  users: "Users",
  rediskey: "Key",
  monitor: "Monitor",
  changes: "Changes",
  crossdb: "Cross-database query",
  notebook: "Notebook",
  related: "Related",
  tail: "Live tail",
  alerts: "Alerts",
  advisor: "Index advisor",
  migrations: "Migrations",
  investigation: "Investigations",
  context: "Execution contexts",
  entitydiff: "Compare entities",
  race: "Race lab",
  cache: "Cache consistency",
  observe: "Before / after",
  rls: "Permissions",
  fixtures: "Edge-case fixtures",
  logic: "Query debugger",
  perf: "Performance experiment",
  backfill: "Backfill",
  code: "Find in code",
  trace: "Request trace",
  tenant: "Tenant workspace",
  shrink: "Shrink a reproducer",
  vector: "Vector search",
};

/** New query tab on the active tab's connection, else the first connected one. */
export function openTabForCurrentConnection() {
  const { tabs, activeId } = useTabs.getState();
  const { status, saved } = useConnections.getState();
  const connectionId =
    tabs.find((t) => t.id === activeId)?.connectionId ??
    saved.find((c) => isConnected(status[c.id]))?.id;
  if (connectionId) openQueryTab(connectionId);
}

export function openQueryTab(connectionId: string) {
  useUi.getState().showTabs();
  useTabs.getState().open(connectionId);
}

/** Opens (or switches to) a table tab: its rows, or its structure; `filter` is a WHERE clause. */
export function openTable(connectionId: string, schema: string, table: string, view?: "data" | "structure", filter?: string) {
  useUi.getState().showTabs();
  useTabs.getState().openTable(connectionId, schema, table, view, filter);
  useWorkspace.getState().touch({ connectionId, schema, table });
}

export function openTool(kind: ToolKind, connectionId: string, schema?: string, table?: string) {
  const name = useConnections.getState().saved.find((c) => c.id === connectionId)?.name ?? "";
  const title = TOOL_TITLES[kind];
  useUi.getState().showTabs();
  useTabs.getState().openTool(kind, connectionId, table ? `${title} · ${table}` : schema ? `${title} · ${schema}` : `${title} · ${name}`, schema, table);
}

/** The related-rows view centred on one row (`where` picks it); one such tab per connection. */
export function openRelated(connectionId: string, schema: string, table: string, where: string) {
  useUi.getState().showTabs();
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t) => t.kind === "related" && t.connectionId === connectionId);
  if (existing) {
    tabs.update(existing.id, { schema, table, filter: where, title: `Related · ${table}` });
    return tabs.activate(existing.id);
  }
  const id = tabs.openTool("related", connectionId, `Related · ${table}`, schema, table);
  useTabs.getState().update(id, { filter: where });
}

/** A query tab with `SELECT *` for the table, to take it further in SQL. */
export function openTableAsQuery(connectionId: string, schema: string, table: string) {
  const engine = useConnections.getState().saved.find((c) => c.id === connectionId)?.engine ?? "postgres";
  const name = `${quoteIdent(schema, engine)}.${quoteIdent(table, engine)}`;
  const sql = engine === "sqlserver" ? `SELECT TOP 1000 * FROM ${name};` : `SELECT * FROM ${name} LIMIT 1000;`;
  useUi.getState().showTabs();
  const tabId = useTabs.getState().open(connectionId, { title: table, sql });
  void useRuns.getState().start(tabId, connectionId, sql, 0);
}

/** A new query tab with `sql`, run right away (a Redis key, a MongoDB collection). */
export function openAndRun(connectionId: string, title: string, sql: string) {
  useUi.getState().showTabs();
  const tabId = useTabs.getState().open(connectionId, { title, sql });
  void useRuns.getState().start(tabId, connectionId, sql, 0, { session: tabId });
}

/** Opens SQL from history or a saved query, on its connection (or the current one). */
export function openSql(sql: string, connectionId: string | null, init?: { title?: string; savedQueryId?: string }) {
  if (init?.savedQueryId) {
    const open = useTabs.getState().tabs.find((t) => t.savedQueryId === init.savedQueryId);
    if (open) {
      useUi.getState().showTabs();
      useTabs.getState().activate(open.id);
      return;
    }
  }
  const { tabs, activeId } = useTabs.getState();
  const target = connectionId ?? tabs.find((t) => t.id === activeId)?.connectionId ?? useConnections.getState().saved[0]?.id;
  if (!target) return;
  useUi.getState().showTabs();
  useTabs.getState().open(target, { sql, ...init });
}

export function closeActiveTab() {
  const { activeId } = useTabs.getState();
  if (activeId) closeTab(activeId);
}

/** Closes a tab; the last query tab on a connection with an open transaction asks first. */
export function closeTab(id: string) {
  const { tabs, close } = useTabs.getState();
  const tab = tabs.find((t) => t.id === id);
  const { txOpen, saved } = useConnections.getState();
  const finish = () => {
    close(id);
    // Each query tab has its own session on the server: close it with the tab.
    if (tab?.kind === "query") {
      void api.closeTabSession(tab.connectionId, tab.id).catch(() => {});
      useConnections.getState().setTxOpen(tab.id, null);
    }
  };
  if (!tab || tab.kind !== "query" || !txOpen[tab.id]) return finish();
  const connection = saved.find((c) => c.id === tab.connectionId);
  useOverlays.getState().askDanger({
    title: "This tab has an open transaction",
    statement: "ROLLBACK -- closing the tab ends its session",
    connectionName: connection?.name ?? "",
    prod: connection?.environment === "prod",
    action: "Roll back and close",
    run: async () => finish(),
  });
}

/**
 * Runs a query and resolves once its stream says "done". The command can return before the
 * channel has delivered everything (big messages travel separately), so waiting on the call
 * alone can miss rows or the error.
 */
async function runToEnd(connectionId: string, sql: string, opts: Parameters<typeof api.runQuery>[2], onMessage: (m: QueryMessage) => void): Promise<void> {
  let finish = () => {};
  const ended = new Promise<void>((resolve) => (finish = resolve));
  const channel = new Channel<QueryMessage>();
  channel.onmessage = (m) => {
    onMessage(m);
    if (!(m instanceof ArrayBuffer) && m.type === "done") finish();
  };
  await api.runQuery(connectionId, sql, opts, channel);
  // Every successful run ends with "done"; the timeout only guards against a lost message.
  let timer = 0;
  await Promise.race([ended, new Promise<void>((resolve) => (timer = window.setTimeout(resolve, 30_000)))]);
  window.clearTimeout(timer);
}

/** Runs one statement outside the editor (menus). Resolves to the error, or null. `session`: a query tab's own. */
export async function executeStatement(
  connectionId: string,
  sql: string,
  session: string | null = null,
  record = true,
): Promise<ErrorPayload | null> {
  if (!(await useConnections.getState().connect(connectionId))) return toError("Not connected");
  let error: ErrorPayload | null = null;
  try {
    // The caller has already asked the user, on prod too.
    await runToEnd(connectionId, sql, { record, confirmed: true, tab: session }, (m) => {
      if (!(m instanceof ArrayBuffer) && m.type === "error") error = m.error;
    });
  } catch (e) {
    return toError(e);
  }
  return error;
}

/** The database each MySQL tab was last pointed at (and the connection it was on, to redo after a reconnect). */
const tabDatabases = new Map<string, { db: string; status: unknown }>();

/**
 * MySQL connections saved without a database: point the tab's own session at the database
 * picked in the sidebar, so `SELECT * FROM users` works there. Redone only when the sidebar's
 * choice changes (or the connection reconnects), so a `USE` typed in the tab sticks.
 */
export async function applySidebarDatabase(connectionId: string, tabId: string) {
  const connection = useConnections.getState().saved.find((c) => c.id === connectionId);
  if (connection?.engine !== "mysql" || connection.database.trim()) return;
  const db = useUi.getState().sidebarSchema[connectionId];
  if (!db || !(await useConnections.getState().connect(connectionId))) return;
  const status = useConnections.getState().status[connectionId];
  const last = tabDatabases.get(tabId);
  if (last && last.db === db && last.status === status) return;
  const error = await executeStatement(connectionId, `USE ${quoteIdent(db, "mysql")}`, tabId, false);
  if (!error) tabDatabases.set(tabId, { db, status });
}

/** Export a query's rows to a file the user picks. */
export function exportRows(connectionId: string, sql: string, format: ExportFormat, name: string) {
  // Big exports take a while: they run as a background job.
  return runJob(`Export ${name}`, async () => {
    const result = await api.exportQuery(connectionId, sql.trim().replace(/;\s*$/, ""), format, name);
    return result && `Exported ${result.rows.toLocaleString()} rows to ${result.path}`;
  });
}

/** Runs a .sql file the user picks, in the background; prod asks first. */
export function runSqlFile(connectionId: string) {
  const connection = useConnections.getState().saved.find((c) => c.id === connectionId);
  if (!connection) return;
  const start = (confirmed: boolean) =>
    runJob(`Run SQL file on ${connection.name}`, async (job) => {
      const done = await api.runSqlFile(connectionId, true, confirmed, job.progress());
      if (!done) return null;
      await useConnections.getState().refreshSchema(connectionId);
      return `Ran ${done.statements.toLocaleString()} statements on ${connection.name}${done.skipped.length ? ` (skipped ${done.skipped.length} psql commands)` : ""}`;
    });
  if (connection.environment !== "prod") return void start(false);
  useOverlays.getState().askDanger({
    title: "Run a .sql file on prod?",
    statement: "-- every statement in the file you pick next",
    connectionName: connection.name,
    prod: true,
    action: "Choose file and run",
    run: async () => void start(true),
  });
}

/** A whole schema as one .sql file (CREATE statements, and rows if `withData`), in the background. */
export function exportDatabaseSql(connectionId: string, schema: string, withData: boolean) {
  return runJob(`Export ${schema}${withData ? "" : " schema"}`, async (job) => {
    const result = await api.exportDatabaseSql(connectionId, schema, withData, job.progress());
    if (!result) return null;
    const what = `${plural(result.tables, "table")}${result.views ? `, ${plural(result.views, "view")}` : ""}`;
    return `Exported ${schema} (${what}${withData ? `, ${result.rows.toLocaleString()} rows` : ""}) to ${result.path}`;
  });
}

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "success");
  } catch {
    toast("Couldn't copy to the clipboard", "error");
  }
}

/** First value of a query's first row (e.g. a COUNT). Not recorded in history. */
export async function queryScalar(connectionId: string, sql: string): Promise<string | null> {
  let value: string | null = null;
  let error: ErrorPayload | null = null;
  await runToEnd(connectionId, sql, { record: false, confirmed: false }, (m) => {
    if (m instanceof ArrayBuffer) {
      if (value === null) value = (tableFromIPC(new Uint8Array(m)).getChildAt(0)?.get(0) as string | null) ?? null;
    } else if (m.type === "error") {
      error = m.error;
    }
  });
  if (error) throw error;
  return value;
}

/** The first result of a query, all rows as text (EXPLAIN, activity, lookups). Not recorded in history. */
export async function queryRows(
  connectionId: string,
  sql: string,
  maxRows = 10_000,
  session: string | null = null,
): Promise<{ columns: string[]; rows: (string | null)[][] }> {
  let result: ResultSet | null = null;
  let error: ErrorPayload | null = null;
  // Only the first result's batches (later statements' rows aren't part of it).
  let first = true;
  await runToEnd(connectionId, sql, { record: false, confirmed: false, maxRows, timeoutMs: null, tab: session }, (m) => {
    if (m instanceof ArrayBuffer) {
      if (first) result?.addBatch(m);
    } else if (m.type === "resultStart") {
      if (!result) result = new ResultSet(m.columns);
    } else if (m.type === "resultEnd") {
      if (result) first = false;
    } else if (m.type === "error") error = m.error;
  });
  if (error) throw error;
  const r = result as ResultSet | null;
  if (!r) return { columns: [], rows: [] };
  return { columns: r.columns, rows: Array.from({ length: r.rowCount }, (_, row) => r.columns.map((_, c) => r.cell(c, row))) };
}
