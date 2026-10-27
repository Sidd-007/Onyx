import { create } from "zustand";
import { writtenTables } from "../lib/transactions";

/** A table whose rows changed outside its view (undo, a write in an editor, a save). */
export interface DataChange {
  seq: number;
  connectionId: string;
  /** null: unqualified in the SQL, so any schema's table of that name. */
  schema: string | null;
  table: string;
  why: string;
}

interface DataChangesStore {
  last: DataChange | null;
  changed(connectionId: string, schema: string | null, table: string, why: string): void;
}

let seq = 0;

/** Open table views listen here and reload (or show that they're out of date). */
export const useDataChanges = create<DataChangesStore>((set) => ({
  last: null,
  changed: (connectionId, schema, table, why) => set({ last: { seq: ++seq, connectionId, schema, table, why } }),
}));

/** `schema.table` as the journal records it. */
export function changedTarget(connectionId: string, target: string, why: string) {
  const dot = target.lastIndexOf(".");
  useDataChanges.getState().changed(connectionId, dot > 0 ? target.slice(0, dot) : null, target.slice(dot + 1), why);
}

/** After SQL ran: every table it wrote to. */
export function changedBySql(connectionId: string, sql: string) {
  for (const t of writtenTables(sql)) changedTarget(connectionId, t, "a query changed it");
}

export const affects = (c: DataChange, connectionId: string, schema: string, table: string) =>
  c.connectionId === connectionId && c.table.toLowerCase() === table.toLowerCase() && (c.schema === null || c.schema.toLowerCase() === schema.toLowerCase());
