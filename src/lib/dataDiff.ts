import { literal } from "./filters";
import type { Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

export type Row = (string | null)[];

export interface ChangedRow {
  key: Row;
  source: Row;
  target: Row;
  /** Columns (indexes into `columns`) whose values differ. */
  changed: number[];
}

export interface DataDiff {
  /** Columns both tables have, in the source's order. */
  columns: string[];
  keyColumns: string[];
  /** Rows only in the source (to insert into the target). */
  added: Row[];
  /** Rows only in the target (to delete from it). */
  removed: Row[];
  changed: ChangedRow[];
  same: number;
}

const keyOf = (row: Row, idx: number[]) => JSON.stringify(idx.map((i) => row[i]));

/**
 * Compares two tables' rows by their key columns. Values are compared as text, the way
 * both engines print them, so `1.50` and `1.5` differ (they're shown, not hidden).
 */
export function diffRows(
  source: { columns: string[]; rows: Row[] },
  target: { columns: string[]; rows: Row[] },
  keyColumns: string[],
): DataDiff {
  const columns = source.columns.filter((c) => target.columns.includes(c));
  const sIdx = columns.map((c) => source.columns.indexOf(c));
  const tIdx = columns.map((c) => target.columns.indexOf(c));
  const keyIdx = keyColumns.map((k) => columns.indexOf(k));
  if (keyIdx.some((i) => i < 0)) throw new Error(`Both tables need the key column${keyColumns.length > 1 ? "s" : ""} ${keyColumns.join(", ")}`);
  const project = (row: Row, idx: number[]) => idx.map((i) => row[i] ?? null);

  const targetByKey = new Map<string, Row>();
  for (const r of target.rows) {
    const row = project(r, tIdx);
    targetByKey.set(keyOf(row, keyIdx), row);
  }
  const added: Row[] = [];
  const changed: ChangedRow[] = [];
  let same = 0;
  const seen = new Set<string>();
  for (const r of source.rows) {
    const row = project(r, sIdx);
    const key = keyOf(row, keyIdx);
    seen.add(key);
    const other = targetByKey.get(key);
    if (!other) {
      added.push(row);
      continue;
    }
    const differs = columns.map((_, i) => i).filter((i) => row[i] !== other[i]);
    if (differs.length) changed.push({ key: keyIdx.map((i) => row[i]), source: row, target: other, changed: differs });
    else same++;
  }
  const removed = [...targetByKey].filter(([k]) => !seen.has(k)).map(([, row]) => row);
  return { columns, keyColumns, added, removed, changed, same };
}

const value = (v: string | null, engine: Engine) => (v === null ? "NULL" : literal(v, engine));

/** SQL that makes the target table match the source. */
export function syncSql(diff: DataDiff, engine: Engine, schema: string, table: string, opts: { deletes: boolean }): string {
  const q = (n: string) => quoteIdent(n, engine);
  const target = schema ? `${q(schema)}.${q(table)}` : q(table);
  const keyIdx = diff.keyColumns.map((k) => diff.columns.indexOf(k));
  const where = (row: Row) => keyIdx.map((i) => (row[i] === null ? `${q(diff.columns[i])} IS NULL` : `${q(diff.columns[i])} = ${value(row[i], engine)}`)).join(" AND ");
  const out: string[] = [];
  for (const row of diff.added) {
    out.push(`INSERT INTO ${target} (${diff.columns.map(q).join(", ")}) VALUES (${row.map((v) => value(v, engine)).join(", ")});`);
  }
  for (const c of diff.changed) {
    const set = c.changed.map((i) => `${q(diff.columns[i])} = ${value(c.source[i], engine)}`).join(", ");
    out.push(`UPDATE ${target} SET ${set} WHERE ${where(c.source)};`);
  }
  if (opts.deletes) for (const row of diff.removed) out.push(`DELETE FROM ${target} WHERE ${where(row)};`);
  return out.join("\n");
}
