import { create } from "zustand";
import { persist } from "zustand/middleware";
import { vaultStorage } from "../lib/vaultStorage";

export interface TableRef {
  connectionId: string;
  schema: string;
  table: string;
}

const same = (a: TableRef, b: TableRef) => a.connectionId === b.connectionId && a.schema === b.schema && a.table === b.table;

interface WorkspaceStore {
  /** Tables pinned to the top of the sidebar. */
  pinned: TableRef[];
  /** Most recently opened tables, newest first. */
  recent: TableRef[];
  togglePin(ref: TableRef): void;
  isPinned(ref: TableRef): boolean;
  touch(ref: TableRef): void;
}

export const useWorkspace = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      pinned: [],
      recent: [],
      togglePin: (ref) =>
        set((s) => ({ pinned: s.pinned.some((p) => same(p, ref)) ? s.pinned.filter((p) => !same(p, ref)) : [...s.pinned, ref] })),
      isPinned: (ref) => get().pinned.some((p) => same(p, ref)),
      touch: (ref) => set((s) => ({ recent: [ref, ...s.recent.filter((r) => !same(r, ref))].slice(0, 12) })),
    }),
    { name: "onyx.workspace", version: 1, storage: vaultStorage },
  ),
);
