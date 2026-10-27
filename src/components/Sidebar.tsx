import {
  Bookmark,
  ChevronDown,
  ChevronsDownUp,
  Clock,
  Database,
  Ellipsis,
  Files,
  FolderCode,
  Layers,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, defaultSchemaOf, ENGINE_LABEL, type ConnectionConfig } from "../lib/ipc";
import { exportDatabaseSql, openQueryTab, openTool, runSqlFile } from "../store/actions";
import { canCreateTables } from "../lib/newTable";
import { useDialogs } from "../store/dialogs";
import { useIde } from "../store/ide";
import { useSettings } from "../store/settings";
import { useOverlays } from "../store/overlays";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useUi, type SidebarPanel } from "../store/ui";
import { FilesPanel } from "./FilesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Select, type SelectOption } from "./Select";
import { SavedPanel } from "./SavedPanel";
import { EntityList } from "./SchemaTree";
import { Button, EnvBadge, IconButton, useTrafficLightInset, ConnectionDot } from "./ui";

const PANELS: { id: SidebarPanel; label: string; icon: LucideIcon; placeholder: string }[] = [
  { id: "files", label: "Files", icon: Files, placeholder: "Find a file" },
  { id: "connections", label: "Database", icon: Database, placeholder: "Filter tables" },
  { id: "saved", label: "Saved queries", icon: Bookmark, placeholder: "Filter saved queries" },
  { id: "history", label: "History", icon: Clock, placeholder: "Search history" },
];

export function Sidebar() {
  const panel = useUi((s) => s.sidebarPanel);
  const width = useUi((s) => s.sidebarWidth);
  const ide = useIde((s) => s.enabled);
  const insetLights = useTrafficLightInset("sidebar");
  const right = useSettings((s) => s.sidebarSide === "right");
  const [filters, setFilters] = useState<Record<SidebarPanel, string>>({ files: "", connections: "", saved: "", history: "" });
  const filter = filters[panel];
  const current = PANELS.find((p) => p.id === panel)!;
  // The Files panel exists only in IDE mode.
  const panels = PANELS.filter((p) => p.id !== "files" || ide);

  const search = (
    <label className="q-field flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2">
      <Search className="size-3 shrink-0 text-faint" />
      <input
        value={filter}
        onChange={(e) => setFilters((f) => ({ ...f, [panel]: e.target.value }))}
        placeholder={current.placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
      />
    </label>
  );

  return (
    <aside className={`relative flex shrink-0 flex-col border-border bg-panel ${right ? "border-l" : "border-r"}`} style={{ width }}>
      <ResizeHandle />
      {/* The top row lines up with the tab strip, holds the window buttons and drags the window. */}
      <div data-tauri-drag-region className={`flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-1.5 ${insetLights ? "pl-[78px]" : ""}`}>
        <span data-tauri-drag-region className="h-full flex-1" />
        <IconButton title={ide ? "Leave IDE mode" : "IDE mode: write and run .sql files from a folder"} shortcut="⇧⌘E" active={ide} onClick={() => useIde.getState().toggle()}>
          <FolderCode className="size-3.5" />
        </IconButton>
        <IconButton title="Connections" onClick={() => useUi.getState().showConnections()}>
          <Plug className="size-3.5" />
        </IconButton>
        <IconButton title="New connection" shortcut="⌘N" onClick={() => useUi.getState().newConnection()}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton title="Settings" shortcut="⌘," onClick={() => useUi.getState().showSettings()}>
          <Settings className="size-3.5" />
        </IconButton>
      </div>
      <div className="px-1.5 pt-1.5 pb-1.5">
        <div className="q-seg flex w-full">
          {panels.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              data-tip={label}
              aria-pressed={panel === id}
              onClick={() => useUi.getState().showPanel(id)}
              className="flex flex-1 items-center justify-center !py-[4px]"
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </div>
      {panel === "files" && ide ? (
        <FilesPanel search={search} filter={filter.trim().toLowerCase()} />
      ) : panel === "connections" || panel === "files" ? (
        <DatabasePanel search={search} filter={filter.trim().toLowerCase()} />
      ) : (
        <>
          <div className="flex px-1.5 pb-1.5">{search}</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            {panel === "saved" && <SavedPanel filter={filter.trim().toLowerCase()} />}
            {panel === "history" && <HistoryPanel search={filter} />}
          </div>
        </>
      )}
    </aside>
  );
}

/** Drag the sidebar's right edge to resize it (⌘B hides it). */
function ResizeHandle() {
  const right = useSettings((s) => s.sidebarSide === "right");
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUi.getState().sidebarWidth;
    // On the right, dragging the left edge leftwards widens it.
    const move = (ev: MouseEvent) => useUi.getState().setSidebarWidth(startWidth + (right ? startX - ev.clientX : ev.clientX - startX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div
      onMouseDown={start}
      onDoubleClick={() => useUi.getState().setSidebarWidth(240)}
      className={`absolute inset-y-0 z-10 w-2 cursor-col-resize transition-colors duration-150 hover:bg-selected ${right ? "-left-1" : "-right-1"}`}
    />
  );
}

/** Connection ▾, database ▾, then that database's tables. */
function DatabasePanel({ search, filter }: { search: ReactNode; filter: string }) {
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const chosenId = useUi((s) => s.sidebarConnectionId);
  const collapseVersion = useUi((s) => s.collapseVersion);
  const activeTabConnection = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.connectionId);

  const live = saved.filter((c) => ["connected", "connecting"].includes(status[c.id]?.state ?? ""));
  const connection = live.find((c) => c.id === chosenId) ?? live.at(-1);

  // Follow the tab you're working in.
  useEffect(() => {
    if (activeTabConnection && status[activeTabConnection]?.state === "connected") {
      useUi.getState().setSidebarConnection(activeTabConnection);
    }
  }, [activeTabConnection, status]);

  if (!connection) {
    return (
      <div className="m-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
        <Plug className="size-4 text-faint" />
        <p className="text-[11.5px] text-muted">Not connected to a database.</p>
        <div className="flex gap-1.5">
          <Button variant="primary" onClick={() => useUi.getState().showConnections()}>
            Connect
          </Button>
          <Button onClick={() => useUi.getState().newConnection()}>New</Button>
        </div>
      </div>
    );
  }

  const connected = status[connection.id]?.state === "connected";
  return (
    <>
      <div className="flex flex-col px-1.5 pb-1">
        <Picker
          icon={<ConnectionDot environment={connection.environment} className="size-2" />}
          value={connection.id}
          tip={`${ENGINE_LABEL[connection.engine]} · ${connection.user}@${connection.host}`}
          onChange={(id) => (id === "__connect" ? useUi.getState().showConnections() : useUi.getState().setSidebarConnection(id))}
          options={[...live.map((c) => ({ value: c.id, label: c.name, hint: ENGINE_LABEL[c.engine] })), { value: "__connect", label: "Connect another…" }]}
          trailing={<EnvBadge environment={connection.environment} />}
        />
        {connected && <SchemaPicker connection={connection} />}
      </div>
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        {search}
        <IconButton title="New query" shortcut="⌘T" disabled={!connected} onClick={() => openQueryTab(connection.id)}>
          <SquarePen className="size-3.5" />
        </IconButton>
        <IconButton title="Refresh" disabled={!connected} onClick={() => void useConnections.getState().refreshSchema(connection.id)}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        <IconButton title="Collapse all" onClick={() => useUi.getState().collapseAll()}>
          <ChevronsDownUp className="size-3.5" />
        </IconButton>
        <IconButton
          title="More"
          disabled={!connected}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const schema = useUi.getState().sidebarSchema[connection.id] ?? defaultSchemaOf(connection);
            const engine = connection.engine;
            const server = ["postgres", "mysql", "sqlserver", "clickhouse"].includes(engine);
            // pg_dump, mysqldump, sqlite3 and the DuckDB CLI do dumps; the other engines have none here.
            const dumps = ["postgres", "mysql", "sqlite", "duckdb"].includes(engine);
            useOverlays.getState().openMenu(r.left, r.bottom + 4, [
              ...((canCreateTables(engine) || engine === "mongodb") && !connection.readOnly
                ? [
                    {
                      label: engine === "mongodb" ? "New collection…" : "New table…",
                      onSelect: () => useDialogs.getState().open({ kind: "new-table", connectionId: connection.id, schema }),
                    },
                    "separator" as const,
                  ]
                : []),
              ...(engine !== "redis"
                ? [
                    { label: "ER diagram", onSelect: () => openTool("er", connection.id, schema) },
                    { label: "Compare schemas…", onSelect: () => openTool("diff", connection.id) },
                    ...(engine !== "mongodb" ? [{ label: "Compare data…", onSelect: () => openTool("datadiff", connection.id, schema) }] : []),
                    { label: "Cross-database query…", onSelect: () => openTool("crossdb", connection.id) },
                    { label: "Query alerts…", onSelect: () => openTool("alerts", connection.id) },
                    "separator" as const,
                    { heading: "Investigate" },
                    { label: "Investigations", onSelect: () => openTool("investigation", connection.id) },
                    { label: "Compare entities…", onSelect: () => openTool("entitydiff", connection.id, schema) },
                    { label: "Before / after an action…", onSelect: () => openTool("observe", connection.id) },
                    { label: "Cache consistency (Redis)…", onSelect: () => openTool("cache", connection.id) },
                    { label: "Request trace (OpenTelemetry)…", onSelect: () => openTool("trace", connection.id) },
                    { label: "Tenant workspace…", onSelect: () => openTool("tenant", connection.id, schema) },
                    { label: "Find in code…", onSelect: () => openTool("code", connection.id, schema) },
                    ...(engine === "postgres"
                      ? [
                          { label: "Query debugger…", onSelect: () => openTool("logic", connection.id) },
                          { label: "Compare execution contexts…", onSelect: () => openTool("context", connection.id) },
                          { label: "Permissions & row visibility…", onSelect: () => openTool("rls", connection.id, schema) },
                          { label: "Performance experiment…", onSelect: () => openTool("perf", connection.id) },
                          { label: "Vector search…", onSelect: () => openTool("vector", connection.id, schema) },
                          ...(connection.environment !== "prod"
                            ? [
                                { label: "Race lab…", onSelect: () => openTool("race", connection.id) },
                                { label: "Shrink a failing example…", onSelect: () => openTool("shrink", connection.id, schema) },
                              ]
                            : []),
                          { label: "Resumable backfill…", onSelect: () => openTool("backfill", connection.id, schema) },
                        ]
                      : []),
                    "separator" as const,
                    ...(["postgres", "mysql", "sqlite", "duckdb", "sqlserver"].includes(engine) ? [{ label: "Migrations…", onSelect: () => openTool("migrations", connection.id) }] : []),
                    ...(engine === "postgres" || engine === "mysql" ? [{ label: "Index advisor…", onSelect: () => openTool("advisor", connection.id) }] : []),
                  ]
                : []),
              ...(server ? [{ label: "Server activity", onSelect: () => openTool("activity", connection.id) }] : []),
              ...(engine !== "redis" && engine !== "mongodb" ? [{ label: "Changes (undo)", onSelect: () => openTool("changes", connection.id) }] : []),
              ...(engine === "postgres" || engine === "mysql" ? [{ label: "Users & permissions", onSelect: () => openTool("users", connection.id) }] : []),
              ...(engine === "redis" ? [{ label: "Monitor live commands", onSelect: () => openTool("monitor", connection.id) }] : []),
              ...(engine !== "redis" && engine !== "mongodb"
                ? [
                    "separator" as const,
                    { label: "Export structure as SQL…", hint: "CREATE", onSelect: () => void exportDatabaseSql(connection.id, schema, false) },
                    { label: "Export structure and data as SQL…", hint: "+ INSERT", onSelect: () => void exportDatabaseSql(connection.id, schema, true) },
                  ]
                : []),
              ...(engine !== "redis" && engine !== "mongodb" && !connection.readOnly
                ? [{ label: "Run SQL file…", hint: "background", onSelect: () => runSqlFile(connection.id) }]
                : []),
              ...(dumps
                ? [
                    "separator" as const,
                    { label: "Dump database…", onSelect: () => useDialogs.getState().open({ kind: "dump", connectionId: connection.id, schema }) },
                    ...(!connection.readOnly
                      ? [{ label: "Restore from a dump…", onSelect: () => useDialogs.getState().open({ kind: "restore", connectionId: connection.id, schema }) }]
                      : []),
                  ]
                : []),
              "separator",
              { label: "Edit connection…", onSelect: () => useUi.getState().editConnection(connection.id) },
              { label: "Disconnect", onSelect: () => void useConnections.getState().disconnect(connection.id) },
            ]);
          }}
        >
          <Ellipsis className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {connected ? (
          <SchemaEntities key={`${connection.id}-${collapseVersion}`} connection={connection} filter={filter} />
        ) : (
          <Loading />
        )}
      </div>
    </>
  );
}

function useSchemas(connection: ConnectionConfig) {
  const version = useConnections((s) => s.schemaVersion[connection.id] ?? 0);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    api.listSchemas(connection.id).then(
      (list) => live && setSchemas(list),
      () => live && setSchemas([]),
    );
    return () => {
      live = false;
    };
  }, [connection.id, version]);
  return schemas;
}

/** The database (MySQL) or schema (Postgres) the sidebar lists. */
function useCurrentSchema(connection: ConnectionConfig, schemas: string[] | null) {
  const chosen = useUi((s) => s.sidebarSchema[connection.id]);
  const preferred = chosen ?? defaultSchemaOf(connection);
  const current = !schemas ? null : schemas.includes(preferred) ? preferred : (schemas[0] ?? null);
  // Remember the fallback too: MySQL query tabs use the database shown here.
  useEffect(() => {
    if (current && current !== chosen) useUi.getState().setSidebarSchema(connection.id, current);
  }, [current, chosen, connection.id]);
  return current;
}

function SchemaPicker({ connection }: { connection: ConnectionConfig }) {
  const schemas = useSchemas(connection);
  const current = useCurrentSchema(connection, schemas);
  if (!schemas || !current) return null;
  return (
    <Picker
      icon={connection.engine === "mysql" ? <Database className="size-3 text-faint" /> : <Layers className="size-3 text-faint" />}
      value={current}
      tip={connection.engine === "mysql" ? "Database" : "Schema"}
      onChange={(schema) => useUi.getState().setSidebarSchema(connection.id, schema)}
      options={schemas.map((s) => ({ value: s, label: s }))}
    />
  );
}

function SchemaEntities({ connection, filter }: { connection: ConnectionConfig; filter: string }) {
  const schemas = useSchemas(connection);
  const current = useCurrentSchema(connection, schemas);
  if (!schemas) return <Loading />;
  if (!current) return <p className="px-2 py-1 text-[11.5px] text-faint">No databases.</p>;
  return <EntityList connection={connection} schema={current} filter={filter} />;
}

/** A native select dressed as a quiet row: icon, value, chevron. */
function Picker({
  icon,
  value,
  options,
  onChange,
  tip,
  trailing,
}: {
  icon: ReactNode;
  value: string;
  options: SelectOption<string>[];
  onChange(value: string): void;
  tip?: string;
  trailing?: ReactNode;
}) {
  const label = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Select value={value} options={options} onChange={onChange} title={tip} className="flex h-7 w-full gap-2 rounded-md px-2 hover:bg-hover">
      <span className="flex size-3 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
      {trailing}
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </Select>
  );
}

function Loading() {
  return <p className="px-2 py-1 text-[11.5px] text-faint">Loading…</p>;
}
