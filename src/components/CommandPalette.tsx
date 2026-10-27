import { Command, defaultFilter } from "cmdk";
import {
  Activity,
  Bookmark,
  Clock,
  Columns2,
  BellRing,
  Combine,
  Camera,
  Code2,
  DatabaseZap,
  ListTree,
  Minimize2,
  Orbit,
  Shapes,
  ShieldQuestion,
  Timer,
  Waypoints,
  Wrench,
  Building2,
  FlaskConical,
  FolderSearch,
  ScanSearch,
  Users2,
  FileDown,
  Lightbulb,
  Database,
  EyeOff,
  FileCode,
  FileUp,
  FolderCode,
  Gauge,
  GitCompare,
  Network,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Settings,
  Sparkles,
  Table2,
  Grid2x2Plus,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { tabCommands } from "../lib/editors";
import { api, type HistoryEntry } from "../lib/ipc";
import { openDatabaseFile } from "../lib/dropFiles";
import { defaultSchemaOf } from "../lib/ipc";
import { closeActiveTab, exportDatabaseSql, openQueryTab, openSql, openTabForCurrentConnection, openTable, openTool, runSqlFile } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import { useIde } from "../store/ide";
import { useLibrary } from "../store/library";
import { canCreateTables } from "../lib/newTable";
import { useDialogs } from "../store/dialogs";
import { togglePrivacy, toggleSidebarSide, useSettings } from "../store/settings";
import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { Modal } from "./Modal";

/** ⌘K: jump to any table, saved query, recent query or action. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}

function Palette() {
  const close = () => useUi.getState().setPaletteOpen(false);
  const connections = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const completion = useConnections((s) => s.completion);
  const saved = useLibrary((s) => s.saved);
  const ideEnabled = useIde((s) => s.enabled);
  const ideListing = useIde((s) => s.listing);
  const ideFiles = useMemo(() => (ideEnabled ? (ideListing?.entries.filter((e) => !e.dir) ?? []) : []), [ideEnabled, ideListing]);
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const recentTables = useWorkspace((s) => s.recent).filter((r) => isConnected(status[r.connectionId]));
  const current = connections.find((c) => c.id === (activeTab?.connectionId ?? useUi.getState().sidebarConnectionId));
  const currentConnected = current && isConnected(status[current.id]) ? current : null;

  useEffect(() => {
    void api.listHistory().then((h) => setRecent(h.slice(0, 8)), () => {});
    void useLibrary.getState().loadSaved();
  }, []);

  const run = (action: () => void) => () => {
    close();
    action();
  };
  const active = () => tabCommands(useTabs.getState().activeId);
  const connected = connections.filter((c) => isConnected(status[c.id]));

  return (
    <Modal onClose={close}>
      <Command label="Command palette" loop filter={rank} className="flex flex-col">
        <Command.Input
          autoFocus
          placeholder="Search tables, saved queries, actions…"
          className="h-11 border-b border-border bg-transparent px-4 text-[14px] outline-none placeholder:text-faint"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-muted">No results.</Command.Empty>

          {recentTables.length > 0 && (
            <Group heading="Recent tables">
              {recentTables.slice(0, 6).map((r) => (
                <Item
                  key={`${r.connectionId}.${r.schema}.${r.table}`}
                  value={`recent table ${r.schema}.${r.table} ${r.connectionId}`}
                  icon={Table2}
                  onSelect={run(() => openTable(r.connectionId, r.schema, r.table))}
                >
                  {r.table}
                  <span className="ml-1.5 text-faint">
                    {r.schema} · {connections.find((c) => c.id === r.connectionId)?.name}
                  </span>
                </Item>
              ))}
            </Group>
          )}

          {ideFiles.length > 0 && (
            <Group heading="Files">
              {ideFiles.slice(0, 500).map((f) => (
                <Item key={f.path} value={`file ${f.path}`} icon={FileCode} onSelect={run(() => void useIde.getState().openFile(f.path))}>
                  {f.path.split("/").pop()}
                  {f.path.includes("/") && <span className="ml-1.5 text-faint">{f.path.split("/").slice(0, -1).join("/")}</span>}
                </Item>
              ))}
            </Group>
          )}

          <Group heading="Actions">
            <Item icon={Plus} onSelect={run(openTabForCurrentConnection)} shortcut="⌘T">
              New query
            </Item>
            <Item icon={Database} onSelect={run(() => useUi.getState().newConnection())} shortcut="⌘N">
              New connection
            </Item>
            {activeTab?.kind === "query" && (
              <>
                <Item icon={Play} onSelect={run(() => active()?.run("current"))} shortcut="⌘↵">
                  Run statement
                </Item>
                <Item icon={WandSparkles} onSelect={run(() => active()?.format())} shortcut="⇧⌘F">
                  Format SQL
                </Item>
                <Item icon={Bookmark} onSelect={run(() => active()?.save())} shortcut="⌘S">
                  Save query
                </Item>
                <Item icon={Gauge} onSelect={run(() => active()?.explain?.(false))} shortcut="⌘E">
                  Explain query plan
                </Item>
                <Item icon={Sparkles} onSelect={run(() => active()?.askAi?.())} shortcut="⇧⌘I">
                  Write SQL from a description
                </Item>
              </>
            )}
            {currentConnected && (canCreateTables(currentConnected.engine) || currentConnected.engine === "mongodb") && !currentConnected.readOnly && (
              <Item
                icon={Grid2x2Plus}
                onSelect={run(() =>
                  useDialogs.getState().open({
                    kind: "new-table",
                    connectionId: currentConnected.id,
                    schema: useUi.getState().sidebarSchema[currentConnected.id] ?? defaultSchemaOf(currentConnected),
                  }),
                )}
              >
                {currentConnected.engine === "mongodb" ? "New collection" : "New table"} · {currentConnected.name}
              </Item>
            )}
            {currentConnected && (
              <Item icon={Combine} onSelect={run(() => openTool("crossdb", currentConnected.id))}>
                Cross-database query (join tables from different connections)
              </Item>
            )}
            {currentConnected && currentConnected.engine !== "redis" && currentConnected.engine !== "mongodb" && (
              <>
                <Item icon={FileDown} onSelect={run(() => exportDatabaseSql(currentConnected.id, useUi.getState().sidebarSchema[currentConnected.id] || defaultSchemaOf(currentConnected), false))}>
                  Export database structure as one .sql file (CREATE statements)
                </Item>
                <Item icon={FileDown} onSelect={run(() => exportDatabaseSql(currentConnected.id, useUi.getState().sidebarSchema[currentConnected.id] || defaultSchemaOf(currentConnected), true))}>
                  Export database structure and data as one .sql file
                </Item>
              </>
            )}
            {currentConnected && (
              <Item icon={FolderSearch} onSelect={run(() => openTool("investigation", currentConnected.id))}>
                Investigations
              </Item>
            )}
            {currentConnected && currentConnected.engine !== "redis" && currentConnected.engine !== "mongodb" && (
              <Item icon={Users2} onSelect={run(() => openTool("entitydiff", currentConnected.id, useUi.getState().sidebarSchema[currentConnected.id] || defaultSchemaOf(currentConnected)))}>
                Compare a working and a failing entity
              </Item>
            )}
            {currentConnected?.engine === "postgres" && (
              <>
                <Item icon={ListTree} onSelect={run(() => openTool("logic", currentConnected.id))}>Query debugger (stages, missing row, rows behind a total)</Item>
                <Item icon={ShieldQuestion} onSelect={run(() => openTool("rls", currentConnected.id))}>Permissions and row visibility</Item>
                <Item icon={Timer} onSelect={run(() => openTool("perf", currentConnected.id))}>Performance experiment (baseline vs candidate)</Item>
                <Item icon={Wrench} onSelect={run(() => openTool("backfill", currentConnected.id))}>Resumable backfill</Item>
                <Item icon={Orbit} onSelect={run(() => openTool("vector", currentConnected.id))}>Vector search debugger</Item>
                {currentConnected.environment !== "prod" && <Item icon={Minimize2} onSelect={run(() => openTool("shrink", currentConnected.id))}>Shrink a failing example</Item>}
              </>
            )}
            {currentConnected && (
              <>
                <Item icon={Camera} onSelect={run(() => openTool("observe", currentConnected.id))}>Before / after an action</Item>
                <Item icon={DatabaseZap} onSelect={run(() => openTool("cache", currentConnected.id))}>Cache consistency (database vs Redis)</Item>
                <Item icon={Waypoints} onSelect={run(() => openTool("trace", currentConnected.id))}>Open a request trace (OpenTelemetry)</Item>
                <Item icon={Building2} onSelect={run(() => openTool("tenant", currentConnected.id))}>Tenant workspace</Item>
                <Item icon={Code2} onSelect={run(() => openTool("code", currentConnected.id))}>Find a table in code</Item>
                <Item icon={Shapes} onSelect={run(() => openTool("fixtures", currentConnected.id))}>Edge-case fixtures</Item>
              </>
            )}
            {currentConnected?.engine === "postgres" && (
              <Item icon={ScanSearch} onSelect={run(() => openTool("context", currentConnected.id))}>
                Compare execution contexts (app vs Onyx)
              </Item>
            )}
            {currentConnected?.engine === "postgres" && currentConnected.environment !== "prod" && (
              <Item icon={FlaskConical} onSelect={run(() => openTool("race", currentConnected.id))}>
                Race lab (reproduce a race between two transactions)
              </Item>
            )}
            {currentConnected && (
              <Item icon={BellRing} onSelect={run(() => openTool("alerts", currentConnected.id))}>
                Query alerts
              </Item>
            )}
            {(currentConnected?.engine === "postgres" || currentConnected?.engine === "mysql") && (
              <Item icon={Lightbulb} onSelect={run(() => openTool("advisor", currentConnected.id))}>
                Index advisor (suggest indexes for slow queries)
              </Item>
            )}
            {currentConnected && currentConnected.engine !== "redis" && currentConnected.engine !== "mongodb" && !currentConnected.readOnly && (
              <Item icon={FileUp} onSelect={run(() => runSqlFile(currentConnected.id))}>
                Run SQL file · {currentConnected.name}
              </Item>
            )}
            {currentConnected && (
              <>
                <Item icon={Network} onSelect={run(() => openTool("er", currentConnected.id, useUi.getState().sidebarSchema[currentConnected.id] ?? defaultSchemaOf(currentConnected)))}>
                  ER diagram · {currentConnected.name}
                </Item>
                <Item icon={GitCompare} onSelect={run(() => openTool("diff", currentConnected.id))}>
                  Compare schemas
                </Item>
                {["postgres", "mysql", "sqlserver", "clickhouse"].includes(currentConnected.engine) && (
                  <Item icon={Activity} onSelect={run(() => openTool("activity", currentConnected.id))}>
                    Server activity · {currentConnected.name}
                  </Item>
                )}
              </>
            )}
            <Item
              icon={FileUp}
              onSelect={run(() =>
                void api
                  .pickFile("Open a SQLite or DuckDB database", ["db", "sqlite", "sqlite3", "db3", "duckdb", "ddb"])
                  .then((p) => (p ? openDatabaseFile(p) : undefined)),
              )}
              shortcut="⌘O"
            >
              Open database file
            </Item>
            <Item icon={PanelLeft} onSelect={run(() => useUi.getState().toggleSidebar())} shortcut="⌘B">
              Toggle sidebar
            </Item>
            <Item icon={PanelRight} onSelect={run(toggleSidebarSide)} shortcut="⌥⌘B">
              Move sidebar {useSettings.getState().sidebarSide === "left" ? "to the right" : "to the left"}
            </Item>
            {activeTab && (
              <Item icon={Columns2} onSelect={run(() => useTabs.getState().toggleSplit())} shortcut="⌘\\">
                {useTabs.getState().splitId ? "Close split view" : "Split editor"}
              </Item>
            )}
            <Item icon={EyeOff} onSelect={run(togglePrivacy)} shortcut="⇧⌘P">
              {useSettings.getState().privacy ? "Turn off privacy mode" : "Privacy mode: mask personal data"}
            </Item>
            <Item icon={PanelBottom} onSelect={run(() => useUi.getState().toggleResults())} shortcut="⌘J">
              Toggle results
            </Item>
            <Item icon={FolderCode} onSelect={run(() => useIde.getState().toggle())} shortcut="⇧⌘E">
              Toggle IDE mode (SQL files)
            </Item>
            <Item icon={Settings} onSelect={run(() => useUi.getState().showSettings())} shortcut="⌘,">
              Settings
            </Item>
            {activeTab && (
              <Item icon={X} onSelect={run(closeActiveTab)} shortcut="⌘W">
                Close tab
              </Item>
            )}
            <Item icon={Clock} onSelect={run(() => useUi.getState().showPanel("history"))}>
              Show query history
            </Item>
            <Item icon={Bookmark} onSelect={run(() => useUi.getState().showPanel("saved"))}>
              Show saved queries
            </Item>
          </Group>

          {connected.map((c) => {
            const tables = Object.entries(completion[c.id] ?? {}).flatMap(([schema, t]) =>
              Object.keys(t as Record<string, unknown>).map((table) => ({ schema, table })),
            );
            return tables.length ? (
              <Group key={c.id} heading={`Tables · ${c.name}`}>
                {tables.map(({ schema, table }) => (
                  <Item
                    key={`${schema}.${table}`}
                    value={`${c.name} ${schema}.${table}`}
                    icon={Table2}
                    onSelect={run(() => openTable(c.id, schema, table))}
                  >
                    {table}
                    <span className="ml-1.5 text-faint">{schema}</span>
                  </Item>
                ))}
              </Group>
            ) : null;
          })}

          {saved.length > 0 && (
            <Group heading="Saved queries">
              {saved.map((q) => (
                <Item
                  key={q.id}
                  value={`saved ${q.name} ${q.id}`}
                  icon={Bookmark}
                  onSelect={run(() =>
                    openSql(q.sql, q.connectionId, { title: q.name.split("/").pop(), savedQueryId: q.id }),
                  )}
                >
                  {q.name}
                </Item>
              ))}
            </Group>
          )}

          <Group heading="Connections">
            {connections.map((c) => (
              <Item
                key={c.id}
                value={`connection ${c.name} ${c.id}`}
                icon={Database}
                onSelect={run(() =>
                  isConnected(status[c.id]) ? openQueryTab(c.id) : void useConnections.getState().connect(c.id),
                )}
              >
                {isConnected(status[c.id]) ? `New query on ${c.name}` : `Connect to ${c.name}`}
              </Item>
            ))}
          </Group>

          {recent.length > 0 && (
            <Group heading="Recent queries">
              {recent.map((h) => (
                <Item key={h.id} value={`recent ${h.sql} ${h.id}`} icon={Clock} onSelect={run(() => openSql(h.sql, h.connectionId))}>
                  <span className="truncate font-mono text-[12px]">{h.sql.trim().replace(/\s+/g, " ")}</span>
                </Item>
              ))}
            </Group>
          )}

        </Command.List>
      </Command>
    </Modal>
  );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] [&_[cmdk-group-heading]]:text-faint"
    >
      {children}
    </Command.Group>
  );
}

/**
 * Every typed word found in the item ranks it well above a loose fuzzy match, and actions
 * above recent queries and files (whose long SQL text fuzzy-matches almost anything), so the
 * selected row is the strongest visible match.
 */
function rank(value: string, search: string, keywords?: string[]): number {
  const fuzzy = defaultFilter(value, search, keywords);
  const text = `${value} ${keywords?.join(" ") ?? ""}`.toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const history = /^(recent|file|saved) /.test(value.toLowerCase());
  if (words.length && words.every((w) => text.includes(w))) return (history ? 2 : 3) + fuzzy;
  return history ? fuzzy * 0.1 : fuzzy;
}

function Item({
  icon: Icon,
  children,
  onSelect,
  shortcut,
  value,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onSelect(): void;
  shortcut?: string;
  value?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-7 cursor-default items-center gap-2.5 rounded-[8px] px-2.5 text-[12.5px]"
    >
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {shortcut && <kbd className="q-kbd">{shortcut}</kbd>}
    </Command.Item>
  );
}
