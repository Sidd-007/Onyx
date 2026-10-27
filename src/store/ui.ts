import { create } from "zustand";
import type { ConnectionConfig } from "../lib/ipc";

export type MainView =
  | { kind: "tabs" }
  | { kind: "connections" }
  | { kind: "settings" }
  | { kind: "connection-form"; editingId: string | null; prefill?: Partial<ConnectionConfig> };
export type SidebarPanel = "files" | "connections" | "saved" | "history";

interface UiStore {
  view: MainView;
  sidebarPanel: SidebarPanel;
  paletteOpen: boolean;
  /** The connection and database the sidebar shows. */
  sidebarConnectionId: string | null;
  sidebarSchema: Record<string, string>;
  /** Bumped by "collapse all" to reset the tree. */
  collapseVersion: number;
  sidebarHidden: boolean;
  sidebarWidth: number;
  /** ⌘J: query tabs show only the editor. */
  resultsHidden: boolean;
  showTabs(): void;
  /** The Connections screen: a card per saved connection. */
  showConnections(): void;
  /** `prefill`: e.g. a database file dropped on the window. */
  newConnection(prefill?: Partial<ConnectionConfig>): void;
  editConnection(id: string): void;
  showPanel(panel: SidebarPanel): void;
  setPaletteOpen(open: boolean): void;
  setSidebarConnection(id: string): void;
  setSidebarSchema(connectionId: string, schema: string): void;
  collapseAll(): void;
  showSettings(): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  toggleResults(): void;
}

export const useUi = create<UiStore>((set) => ({
  view: { kind: "tabs" },
  sidebarPanel: "connections",
  paletteOpen: false,
  sidebarConnectionId: null,
  sidebarSchema: {},
  collapseVersion: 0,
  sidebarHidden: false,
  sidebarWidth: 240,
  resultsHidden: false,
  showTabs: () => set({ view: { kind: "tabs" } }),
  showConnections: () => set({ view: { kind: "connections" } }),
  newConnection: (prefill) => set({ view: { kind: "connection-form", editingId: null, prefill } }),
  editConnection: (id) => set({ view: { kind: "connection-form", editingId: id } }),
  showPanel: (sidebarPanel) => set({ sidebarPanel }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSidebarConnection: (sidebarConnectionId) => set({ sidebarConnectionId }),
  setSidebarSchema: (connectionId, schema) => set((s) => ({ sidebarSchema: { ...s.sidebarSchema, [connectionId]: schema } })),
  collapseAll: () => set((s) => ({ collapseVersion: s.collapseVersion + 1 })),
  showSettings: () => set({ view: { kind: "settings" } }),
  toggleSidebar: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.round(Math.min(480, Math.max(180, width))) }),
  toggleResults: () => set((s) => ({ resultsHidden: !s.resultsHidden })),
}));
