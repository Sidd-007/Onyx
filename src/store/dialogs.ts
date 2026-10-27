import { create } from "zustand";

/** App-wide dialogs that menus can open (they're plain functions, not components). */
export type Dialog =
  | { kind: "import-csv"; connectionId: string; schema: string; table: string }
  | { kind: "fake-data"; connectionId: string; schema: string; table: string }
  /** Copies `sql`'s rows (a table, or a query's result) into a table on any connection. */
  | { kind: "copy"; connectionId: string; sql: string; name: string; schema?: string; table?: string }
  | { kind: "dump"; connectionId: string; schema?: string }
  | { kind: "restore"; connectionId: string; schema?: string }
  /** The table designer (a collection on MongoDB). */
  | { kind: "new-table"; connectionId: string; schema: string }
  /** Rows and everything they're related to, into another connection. */
  | { kind: "copy-related"; connectionId: string; schema: string; table: string };

interface DialogStore {
  dialog: Dialog | null;
  open(dialog: Dialog): void;
  close(): void;
}

export const useDialogs = create<DialogStore>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));
