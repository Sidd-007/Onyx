import { create } from "zustand";
import { persist } from "zustand/middleware";
import { vaultStorage } from "../lib/vaultStorage";

/** Tool tabs; components/tools.tsx has each one's screen. */
export type ToolKind = "er" | "diff" | "activity" | "datadiff" | "users" | "rediskey" | "monitor" | "changes" | "crossdb" | "notebook" | "related" | "tail" | "alerts" | "advisor" | "migrations" | "investigation" | "context" | "entitydiff" | "race" | "cache" | "observe" | "rls" | "fixtures" | "logic" | "perf" | "backfill" | "code" | "trace" | "tenant" | "shrink" | "vector";
export type TabKind = "query" | "table" | ToolKind;

export interface QueryTab {
  id: string;
  /** "query": an editor; "table": a table's rows, editable; the rest are tools. */
  kind: TabKind;
  connectionId: string;
  title: string;
  sql: string;
  /** Set once the tab is saved; ⌘S then updates that saved query. */
  savedQueryId?: string;
  /** IDE mode: the workspace file this tab edits (saved as you type). */
  filePath?: string;
  /** Cross-database tabs: the aliased connections. */
  sources?: { alias: string; connectionId: string }[];
  schema?: string;
  table?: string;
  /** Table tabs: rows or structure. */
  tableView?: "data" | "structure";
  /** Table tabs: a WHERE clause to apply (e.g. following a foreign key), and a counter to re-apply it. */
  filter?: string;
  filterVersion?: number;
}

interface TabsStore {
  tabs: QueryTab[];
  activeId: string | null;
  /** Split view: the tab shown on the right, beside the active one. */
  splitId: string | null;
  /** The tab active before this one (⌘\ splits with it). */
  previousId: string | null;
  setSplit(id: string | null): void;
  /** ⌘\: close the split, or open the previous tab (or a new query) beside this one. */
  toggleSplit(): void;
  open(connectionId: string, init?: { title?: string; sql?: string; savedQueryId?: string }): string;
  /** Activates the table's tab if it's open, else opens one. */
  openTable(connectionId: string, schema: string, table: string, view?: "data" | "structure", filter?: string): string;
  /** A query tab editing a workspace file. */
  openFile(path: string, connectionId: string, sql: string, kind?: "query" | "notebook"): string;
  /** Activates the connection's tool tab (ER diagram, schema diff, activity), or opens one. */
  openTool(kind: ToolKind, connectionId: string, title: string, schema?: string, table?: string): string;
  close(id: string): void;
  activate(id: string): void;
  update(id: string, patch: Partial<Pick<QueryTab, "title" | "sql" | "savedQueryId" | "tableView" | "filePath" | "connectionId" | "sources" | "schema" | "table" | "filter">>): void;
  /** Closes every tab showing this table (after it's dropped). */
  closeTable(connectionId: string, schema: string, table: string): void;
}

/** Open tabs and their SQL survive restarts (in the encrypted vault). */
export const useTabs = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      splitId: null,
      previousId: null,

      open(connectionId, init) {
        const id = crypto.randomUUID();
        const count = get().tabs.filter((t) => t.title.startsWith("Query")).length;
        const tab: QueryTab = {
          id,
          kind: "query",
          connectionId,
          title: init?.title ?? `Query ${count + 1}`,
          sql: init?.sql ?? "",
          savedQueryId: init?.savedQueryId,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
        return id;
      },

      openFile(filePath, connectionId, sql, kind = "query") {
        const id = crypto.randomUUID();
        const tab: QueryTab = { id, kind, connectionId, title: filePath.split("/").pop() ?? filePath, sql, filePath };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
        return id;
      },

      openTable(connectionId, schema, table, view, filter) {
        const existing = get().tabs.find(
          (t) => t.kind === "table" && t.connectionId === connectionId && t.schema === schema && t.table === table,
        );
        if (existing) {
          set((s) => ({
            activeId: existing.id,
            tabs: s.tabs.map((t) =>
              t.id !== existing.id
                ? t
                : {
                    ...t,
                    ...(view ? { tableView: view } : {}),
                    ...(filter !== undefined ? { filter, filterVersion: (t.filterVersion ?? 0) + 1, tableView: "data" as const } : {}),
                  },
            ),
          }));
          return existing.id;
        }
        const id = crypto.randomUUID();
        const tab: QueryTab = {
          id,
          kind: "table",
          connectionId,
          title: table,
          sql: "",
          schema,
          table,
          tableView: view ?? "data",
          ...(filter ? { filter, filterVersion: 1 } : {}),
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
        return id;
      },

      openTool(kind, connectionId, title, schema, table) {
        const existing = get().tabs.find((t) => t.kind === kind && t.connectionId === connectionId && t.schema === schema && t.table === table);
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        const id = crypto.randomUUID();
        set((s) => ({ tabs: [...s.tabs, { id, kind, connectionId, title, sql: "", schema, table }], activeId: id }));
        return id;
      },

      close(id) {
        set((s) => {
          const index = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const activeId =
            s.activeId === id ? (s.splitId ?? tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : s.activeId;
          const splitId = s.splitId === id || activeId === s.splitId ? null : s.splitId;
          return { tabs, activeId, splitId };
        });
      },

      closeTable(connectionId, schema, table) {
        for (const t of get().tabs) {
          if (t.kind === "table" && t.connectionId === connectionId && t.schema === schema && t.table === table) {
            get().close(t.id);
          }
        }
      },

      activate(id) {
        set((s) => {
          if (s.activeId === id) return s;
          // Clicking the right pane's tab swaps the panes.
          const splitId = s.splitId === id ? s.activeId : s.splitId;
          return { activeId: id, previousId: s.activeId, splitId };
        });
      },

      setSplit(id) {
        set((s) => ({ splitId: id && id !== s.activeId ? id : null }));
      },

      toggleSplit() {
        const s = get();
        if (s.splitId) return set({ splitId: null });
        const other = s.tabs.find((t) => t.id === s.previousId && t.id !== s.activeId) ?? s.tabs.find((t) => t.id !== s.activeId);
        if (other) return set({ splitId: other.id });
        const active = s.tabs.find((t) => t.id === s.activeId);
        if (!active) return;
        const keep = s.activeId;
        const id = get().open(active.connectionId);
        set({ activeId: keep, splitId: id });
      },

      update(id, patch) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
      },
    }),
    {
      name: "onyx.tabs",
      storage: vaultStorage,
      version: 2,
      // v1 tabs were all query tabs.
      migrate: (state) => {
        const s = state as { tabs?: QueryTab[]; activeId?: string | null };
        return { ...s, tabs: (s.tabs ?? []).map((t) => ({ ...t, kind: t.kind ?? "query" })) } as TabsStore;
      },
    },
  ),
);
