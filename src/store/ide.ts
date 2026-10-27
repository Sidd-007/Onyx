import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, toError, type WorkspaceListing } from "../lib/ipc";
import { isNotebook } from "../lib/notebook";
import { useTabs } from "./tabs";
import { toast } from "./toasts";
import { useUi } from "./ui";

interface IdeStore {
  /** IDE mode: the sidebar gets a file explorer for a folder of .sql files. */
  enabled: boolean;
  listing: WorkspaceListing | null;
  /** Folders open in the explorer. */
  expanded: string[];
  /** The connection each file last ran on. */
  fileConnections: Record<string, string>;
  toggle(): void;
  refresh(): Promise<void>;
  openFolder(): Promise<void>;
  setExpanded(path: string, open: boolean): void;
  rememberConnection(path: string, connectionId: string): void;
  /** Opens the file in a tab (or activates the one showing it). */
  openFile(path: string): Promise<void>;
  create(path: string, dir: boolean): Promise<boolean>;
  rename(from: string, to: string): Promise<boolean>;
}

export const baseName = (path: string) => path.split("/").pop() ?? path;
export const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

export const useIde = create<IdeStore>()(
  persist(
    (set, get) => ({
      enabled: false,
      listing: null,
      expanded: [],
      fileConnections: {},

      toggle() {
        const enabled = !get().enabled;
        set({ enabled });
        const ui = useUi.getState();
        if (enabled) {
          ui.showPanel("files");
          if (ui.sidebarHidden) ui.toggleSidebar();
          void get().refresh();
        } else if (ui.sidebarPanel === "files") {
          ui.showPanel("connections");
        }
      },

      async refresh() {
        try {
          set({ listing: await api.workspaceList() });
        } catch (e) {
          toast(toError(e).message, "error");
        }
      },

      async openFolder() {
        try {
          const listing = await api.workspaceOpen();
          if (listing) set({ listing, expanded: [] });
        } catch (e) {
          toast(toError(e).message, "error");
        }
      },

      setExpanded(path, open) {
        set((s) => ({ expanded: open ? [...new Set([...s.expanded, path])] : s.expanded.filter((p) => p !== path) }));
      },

      rememberConnection(path, connectionId) {
        set((s) => ({ fileConnections: { ...s.fileConnections, [path]: connectionId } }));
      },

      async openFile(path) {
        const tabs = useTabs.getState();
        useUi.getState().showTabs();
        const open = tabs.tabs.find((t) => t.filePath === path);
        if (open) return tabs.activate(open.id);
        try {
          const sql = await api.workspaceRead(path);
          const { tabs: all, activeId } = useTabs.getState();
          const connectionId =
            get().fileConnections[path] ?? all.find((t) => t.id === activeId)?.connectionId ?? useUi.getState().sidebarConnectionId ?? "";
          useTabs.getState().openFile(path, connectionId, sql, isNotebook(path) ? "notebook" : "query");
        } catch (e) {
          toast(toError(e).message, "error");
        }
      },

      async create(path, dir) {
        try {
          await api.workspaceCreate(path, dir);
          const parent = parentOf(path);
          if (parent) get().setExpanded(parent, true);
          await get().refresh();
          if (!dir) await get().openFile(path);
          else get().setExpanded(path, true);
          return true;
        } catch (e) {
          toast(toError(e).message, "error");
          return false;
        }
      },

      async rename(from, to) {
        try {
          await api.workspaceRename(from, to);
          // Tabs follow the file (or everything under a renamed folder).
          for (const t of useTabs.getState().tabs) {
            if (!t.filePath) continue;
            if (t.filePath === from || t.filePath.startsWith(`${from}/`)) {
              const filePath = to + t.filePath.slice(from.length);
              useTabs.getState().update(t.id, { filePath, title: baseName(filePath) });
            }
          }
          set((s) => {
            const fileConnections = Object.fromEntries(
              Object.entries(s.fileConnections).map(([p, c]) => [p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p, c]),
            );
            return { fileConnections };
          });
          await get().refresh();
          return true;
        } catch (e) {
          toast(toError(e).message, "error");
          return false;
        }
      },
    }),
    {
      name: "onyx.ide",
      version: 1,
      partialize: (s) => ({ enabled: s.enabled, expanded: s.expanded, fileConnections: s.fileConnections }),
    },
  ),
);
