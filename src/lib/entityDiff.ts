/**
 * F02: compare a working and a failing entity with their related rows. Related rows are
 * matched by a business key (never by surrogate ids, which always differ), the columns that
 * link them to the entity are expected to differ, and capped collections are never "equal".
 */
import { diffJson, parseJson } from "./jsonDiff";
import { keyIssue } from "./resultDiff";

export type Rows = { columns: string[]; rows: (string | null)[][] };

export interface FieldDiff {
  column: string;
  working: string | null;
  failing: string | null;
  /** For JSON values: the semantic changes (key order and number formatting don't count). */
  json?: string[];
}

export interface CollectionDiff {
  /** e.g. "orders.customer_id → customers" */
  relation: string;
  table: string;
  working: number;
  failing: number;
  /** Either side hit the row cap: counts and matches are lower bounds. */
  partial: boolean;
  key: string | null;
  /** Why the key can't pair rows (repeats, NULLs): rows are listed, not paired. */
  ambiguity: string | null;
  onlyWorking: (string | null)[][];
  onlyFailing: (string | null)[][];
  changed: { key: string; fields: FieldDiff[] }[];
  columns: string[];
  ignored: string[];
}

const looksJson = (v: string | null) => !!v && /^\s*[[{]/.test(v);

/** Field differences between two rows, skipping `ignored`; JSON compared by meaning. */
export function diffFields(columns: string[], a: (string | null)[], b: (string | null)[], ignored: Set<string>): FieldDiff[] {
  const out: FieldDiff[] = [];
  columns.forEach((c, i) => {
    if (ignored.has(c) || a[i] === b[i]) return;
    if (looksJson(a[i]) && looksJson(b[i])) {
      try {
        const d = diffJson(parseJson(a[i]!), parseJson(b[i]!));
        if (!d.changes.length) return;
        out.push({ column: c, working: a[i], failing: b[i], json: d.changes.slice(0, 20).map((x) => `${x.kind} ${x.path.join(".") || "(root)"}`) });
        return;
      } catch {
        // Not JSON after all: compare as text.
      }
    }
    out.push({ column: c, working: a[i], failing: b[i] });
  });
  return out;
}

/** A unique, non-NULL column on both sides that isn't ignored: names like code/sku/slug win. */
export function suggestBusinessKey(a: Rows, b: Rows, ignored: Set<string>): string | null {
  const score = (c: string) => (/(^|_)(code|sku|slug|key|type|kind|name|email|plan)$/i.test(c) ? 0 : 1);
  const candidates = a.columns.filter((c) => !ignored.has(c) && b.columns.includes(c)).sort((x, y) => score(x) - score(y));
  return candidates.find((c) => !keyIssue(a, c, "working") && !keyIssue(b, c, "failing")) ?? null;
}

export function diffCollection(relation: string, table: string, a: Rows, b: Rows, cap: number, key: string | null, ignored: Set<string>): CollectionDiff {
  const partial = a.rows.length >= cap || b.rows.length >= cap;
  const base: CollectionDiff = { relation, table, working: a.rows.length, failing: b.rows.length, partial, key, ambiguity: null, onlyWorking: [], onlyFailing: [], changed: [], columns: a.columns, ignored: [...ignored] };
  if (!key) {
    // No key: compare whole rows (without the ignored columns), as multisets.
    const keep = a.columns.map((c, i) => (ignored.has(c) ? -1 : i)).filter((i) => i >= 0);
    const sig = (r: (string | null)[]) => JSON.stringify(keep.map((i) => r[i]));
    const counts = new Map<string, number>();
    for (const r of a.rows) counts.set(sig(r), (counts.get(sig(r)) ?? 0) + 1);
    for (const r of b.rows) {
      const n = counts.get(sig(r)) ?? 0;
      if (n) counts.set(sig(r), n - 1);
      else base.onlyFailing.push(r);
    }
    for (const r of a.rows) {
      const n = counts.get(sig(r)) ?? 0;
      if (n) {
        counts.set(sig(r), n - 1);
        base.onlyWorking.push(r);
      }
    }
    return base;
  }
  const issue = keyIssue(a, key, "working entity's") ?? keyIssue(b, key, "failing entity's");
  if (issue) return { ...base, ambiguity: issue, onlyWorking: a.rows, onlyFailing: b.rows };
  const k = a.columns.indexOf(key);
  const kb = b.columns.indexOf(key);
  const byKey = new Map(a.rows.map((r) => [r[k]!, r]));
  const seen = new Set<string>();
  for (const r of b.rows) {
    const id = r[kb]!;
    seen.add(id);
    const old = byKey.get(id);
    if (!old) base.onlyFailing.push(r);
    else {
      const fields = diffFields(a.columns, old, b.columns.map((c) => r[b.columns.indexOf(c)]), new Set([...ignored, key]));
      if (fields.length) base.changed.push({ key: id, fields });
    }
  }
  for (const r of a.rows) if (!seen.has(r[k]!)) base.onlyWorking.push(r);
  return base;
}

/** Nothing differs and nothing was cut off: the only state allowed to read as "same". */
export const collectionEqual = (d: CollectionDiff) => !d.partial && !d.ambiguity && !d.onlyWorking.length && !d.onlyFailing.length && !d.changed.length;
