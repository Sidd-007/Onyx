/** F11: turning a three-way check (base / mine / theirs) plus the user's choices into edits to save. */
import type { RowEdit } from "./ipc";

export interface FieldState {
  edit: number;
  key: { column: string; value: string | null }[];
  column: string;
  base: string | null;
  /** null: a delete (no new value). */
  mine: string | null | undefined;
  theirs: string | null;
  converged: boolean;
  deleted: boolean;
}

export type Choice = "mine" | "theirs";

export const fieldId = (f: FieldState) => `${f.edit}:${f.column}`;

/** Fields the user must decide (converged ones are already settled). */
export const decisions = (fields: FieldState[]) => fields.filter((f) => !f.converged);

/**
 * The edits to save. For a field someone else changed: "mine" saves my value over theirs (the
 * check then expects theirs, so a further change is caught), "theirs" drops my change to it.
 * A converged field needs no write. A deleted row's edit is dropped: it's never recreated.
 */
export function resolve(edits: RowEdit[], fields: FieldState[], choices: Record<string, Choice>): RowEdit[] {
  const out: RowEdit[] = [];
  edits.forEach((e, i) => {
    const mine = fields.filter((f) => f.edit === i);
    if (mine.some((f) => f.deleted)) return;
    if (e.kind === "delete") {
      // Their changes to a row I delete: deleting anyway is "mine"; keeping the row is "theirs".
      if (mine.some((f) => !f.converged && choices[fieldId(f)] !== "mine")) return;
      const theirs = new Map(mine.map((f) => [f.column, f.theirs]));
      out.push({ ...e, original: e.original?.map((c) => (theirs.has(c.column) ? { ...c, value: theirs.get(c.column)! } : c)) });
      return;
    }
    if (e.kind !== "update") return void out.push(e);
    let set = e.set;
    let original = e.original ?? [];
    for (const f of mine) {
      if (f.converged || choices[fieldId(f)] === "theirs") {
        set = set.filter((c) => c.column !== f.column);
        original = original.filter((c) => c.column !== f.column);
      } else {
        original = original.map((c) => (c.column === f.column ? { ...c, value: f.theirs } : c));
      }
    }
    if (set.length) out.push({ ...e, set, original });
  });
  return out;
}
