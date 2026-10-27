/** A result as rows of text, for comparing two runs. */
export interface Table {
  columns: string[];
  rows: (string | null)[][];
}

export type DiffRow =
  | { kind: "added"; row: (string | null)[] }
  | { kind: "removed"; row: (string | null)[] }
  | { kind: "changed"; before: (string | null)[]; row: (string | null)[]; changed: Set<number> };

export interface ResultDiff {
  /** The columns both results have, in the newer result's order. */
  columns: string[];
  rows: DiffRow[];
  added: number;
  removed: number;
  changed: number;
  same: number;
  /** The chosen key can't identify rows (repeated or NULL): whole rows were compared instead. */
  keyProblem?: string;
}

const NUL = "\u0000";

/**
 * Compares rows of `before` and `after` over their shared columns. With a `key` column, rows
 * are matched by it (so changed rows show which cells changed); without one, whole rows are
 * compared and repeated rows are counted.
 */
/** Why `key` can't identify rows in `t` (a repeated value or a NULL), or null when it can. */
export function keyIssue(t: Table, key: string, label: string): string | null {
  const i = t.columns.indexOf(key);
  if (i < 0) return `the ${label} result has no ${key} column`;
  const seen = new Map<string, number>();
  let nulls = 0;
  for (const r of t.rows) {
    const v = r[i];
    if (v === null) nulls++;
    else seen.set(v, (seen.get(v) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, n]) => n > 1);
  if (repeated.length) {
    const [value, n] = repeated[0];
    return `${key} isn't unique in the ${label} result (${n} rows have ${key} = ${value}${repeated.length > 1 ? `, and ${repeated.length - 1} more repeated values` : ""})`;
  }
  if (nulls) return `${key} is NULL in ${nulls} row${nulls === 1 ? "" : "s"} of the ${label} result`;
  return null;
}

export function diffResults(before: Table, after: Table, key: string | null): ResultDiff {
  // A key that repeats would pair the wrong rows: refuse it, and compare whole rows instead.
  const problem = key === null ? null : (keyIssue(before, key, "pinned") ?? keyIssue(after, key, "latest"));
  if (problem) return { ...diffResults(before, after, null), keyProblem: problem };
  const columns = after.columns.filter((c) => before.columns.includes(c));
  const pick = (t: Table) => {
    const idx = columns.map((c) => t.columns.indexOf(c));
    return t.rows.map((r) => idx.map((i) => r[i]));
  };
  const a = pick(before);
  const b = pick(after);
  const out: ResultDiff = { columns, rows: [], added: 0, removed: 0, changed: 0, same: 0 };
  const k = key === null ? -1 : columns.indexOf(key);

  if (k < 0) {
    const counts = new Map<string, number>();
    for (const r of a) counts.set(r.join(NUL), (counts.get(r.join(NUL)) ?? 0) + 1);
    for (const r of b) {
      const id = r.join(NUL);
      const n = counts.get(id) ?? 0;
      if (n > 0) {
        counts.set(id, n - 1);
        out.same++;
      } else {
        out.rows.push({ kind: "added", row: r });
        out.added++;
      }
    }
    for (const r of a) {
      const id = r.join(NUL);
      const n = counts.get(id) ?? 0;
      if (n > 0) {
        counts.set(id, n - 1);
        out.rows.push({ kind: "removed", row: r });
        out.removed++;
      }
    }
    return out;
  }

  const byKey = new Map<string, (string | null)[]>();
  for (const r of a) byKey.set(String(r[k]), r);
  const seen = new Set<string>();
  for (const r of b) {
    const id = String(r[k]);
    seen.add(id);
    const old = byKey.get(id);
    if (!old) {
      out.rows.push({ kind: "added", row: r });
      out.added++;
      continue;
    }
    const changed = new Set(columns.map((_, i) => i).filter((i) => old[i] !== r[i]));
    if (changed.size) {
      out.rows.push({ kind: "changed", before: old, row: r, changed });
      out.changed++;
    } else {
      out.same++;
    }
  }
  for (const r of a) {
    if (!seen.has(String(r[k]))) {
      out.rows.push({ kind: "removed", row: r });
      out.removed++;
    }
  }
  return out;
}

/**
 * The column that identifies a row in both results: unique and never NULL in each. Names like
 * `id`, `uuid` or `…_id` win; null when no column qualifies (then whole rows are compared).
 */
export function suggestKey(before: Table, after: Table): string | null {
  const shared = after.columns.filter((c) => before.columns.includes(c));
  const unique = (t: Table, c: string) => {
    const i = t.columns.indexOf(c);
    const seen = new Set<string>();
    for (const r of t.rows) {
      const v = r[i];
      if (v === null || seen.has(v)) return false;
      seen.add(v);
    }
    return true;
  };
  const score = (c: string) => (/^(id|uuid|guid)$/i.test(c) ? 0 : /(^|_)(id|uuid|key|code)$/i.test(c) ? 1 : 2);
  return [...shared].sort((a, b) => score(a) - score(b)).find((c) => unique(before, c) && unique(after, c)) ?? null;
}
