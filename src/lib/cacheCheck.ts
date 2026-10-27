/**
 * F15: does the cached copy of a row agree with the database? An explicit mapping (SQL
 * selector → Redis key template → fields) is read on both sides, each read timed, and
 * re-checked within a propagation window so a passing delay isn't called stale.
 */
import { canonicalNumber, parseJson, stringify, type JsonNode } from "./jsonDiff";

export type CacheFormat = "json" | "hash" | "string";

export interface FieldMap {
  column: string;
  /** JSON: a dotted path (a.b.0.c); hash: the field name; string: ignored (the whole value). */
  field: string;
  compare: "text" | "number" | "boolean" | "json";
}

export interface CacheMapping {
  name: string;
  /** A SELECT with :id returning the row (one). */
  sql: string;
  keyTemplate: string;
  format: CacheFormat;
  fields: FieldMap[];
  /** Optional: a version or updated_at on both sides, to tell newer from older. */
  versionColumn: string;
  versionField: string;
  windowMs: number;
}

/** What one read of the cache found. TTL is remaining lifetime, never age. */
export type CacheRead =
  | { state: "value"; raw: string | Record<string, string>; ttlMs: number | null; at: number }
  | { state: "absent"; at: number }
  /** The key existed when typed but was gone when read: it expired (or was deleted) between reads. */
  | { state: "expired-between-reads"; at: number }
  | { state: "wrong-type"; type: string; at: number };

export interface FieldResult {
  column: string;
  field: string;
  db: string | null;
  cache: string | null | undefined;
  /** undefined cache: the field (or path) isn't there at all, which isn't the same as null. */
  status: "same" | "different" | "missing-field" | "decode-error";
  detail?: string;
}

export interface Verdict {
  state: "agree" | "differ" | "no-cache-entry" | "no-db-row" | "decode-error" | "wrong-type";
  fields: FieldResult[];
  version: { db: string | null; cache: string | null; relation: "same" | "db-newer" | "cache-newer" | "unknown" } | null;
}

export const keyFor = (template: string, id: string) => template.replace(/\{id\}/g, id);

function at(node: JsonNode, path: string): JsonNode | undefined {
  let n: JsonNode | undefined = node;
  for (const p of path.split(".").filter(Boolean)) {
    if (n?.t === "object") n = [...n.entries].reverse().find((e) => e[0] === p)?.[1];
    else if (n?.t === "array" && /^\d+$/.test(p)) n = n.items[Number(p)];
    else return undefined;
  }
  return n;
}

/** A JSON node as the text a database column would hold. */
const asText = (n: JsonNode) => (n.t === "string" ? n.v : n.t === "null" ? null : stringify(n));

function same(compare: FieldMap["compare"], db: string | null, cache: string | null): boolean {
  if (db === null || cache === null) return db === cache;
  switch (compare) {
    case "number":
      return /^-?\d/.test(db) && /^-?\d/.test(cache) ? canonicalNumber(db.trim()) === canonicalNumber(cache.trim()) : db === cache;
    case "boolean": {
      const b = (v: string) => (/^(t|true|1|yes)$/i.test(v) ? "t" : /^(f|false|0|no)$/i.test(v) ? "f" : v);
      return b(db) === b(cache);
    }
    case "json":
      try {
        return stringify(parseJson(db)) === stringify(parseJson(cache)) || canonicalJson(db) === canonicalJson(cache);
      } catch {
        return db === cache;
      }
    default:
      return db === cache;
  }
}

const canonicalJson = (t: string) => {
  const walk = (n: JsonNode): string =>
    n.t === "object" ? `{${[...n.entries].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${JSON.stringify(k)}:${walk(v)}`).join(",")}}` : n.t === "array" ? `[${n.items.map(walk).join(",")}]` : n.t === "number" ? canonicalNumber(n.raw) : stringify(n);
  return walk(parseJson(t));
};

/** Compares the database row with one cache read. */
export function compare(m: CacheMapping, dbRow: Record<string, string | null> | null, read: CacheRead): Verdict {
  if (!dbRow) return { state: "no-db-row", fields: [], version: null };
  if (read.state === "absent" || read.state === "expired-between-reads") return { state: "no-cache-entry", fields: [], version: null };
  if (read.state === "wrong-type") return { state: "wrong-type", fields: [], version: null };
  let lookup: (field: string) => { value: string | null | undefined; error?: string };
  if (m.format === "hash") {
    const h = read.raw as Record<string, string>;
    lookup = (f) => ({ value: f in h ? h[f] : undefined });
  } else if (m.format === "json") {
    let doc: JsonNode | null = null;
    let error: string | undefined;
    try {
      doc = parseJson(read.raw as string);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    lookup = (f) => {
      if (!doc) return { value: undefined, error };
      const n = at(doc, f);
      return { value: n === undefined ? undefined : asText(n) };
    };
  } else {
    lookup = () => ({ value: read.raw as string });
  }
  const fields: FieldResult[] = m.fields.map((f) => {
    const db = dbRow[f.column] ?? null;
    const { value, error } = lookup(f.field);
    if (error) return { column: f.column, field: f.field, db, cache: undefined, status: "decode-error", detail: error };
    if (value === undefined) return { column: f.column, field: f.field, db, cache: undefined, status: "missing-field" };
    return { column: f.column, field: f.field, db, cache: value, status: same(f.compare, db, value) ? "same" : "different" };
  });
  let version: Verdict["version"] = null;
  if (m.versionColumn && m.versionField) {
    const dbv = dbRow[m.versionColumn] ?? null;
    const cv = lookup(m.versionField).value ?? null;
    const num = (v: string | null) => (v !== null && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v !== null && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
    const a = num(dbv);
    const b = num(cv);
    version = { db: dbv, cache: cv, relation: a === null || b === null ? "unknown" : a === b ? "same" : a > b ? "db-newer" : "cache-newer" };
  }
  const state = fields.some((f) => f.status === "decode-error") ? "decode-error" : fields.every((f) => f.status === "same") ? "agree" : "differ";
  return { state, fields, version };
}

export interface Observation {
  dbAt: number;
  cacheAt: number;
  verdict: Verdict;
}

/**
 * The overall finding over a window of observations. Only a cached value that is there and
 * disagrees is called stale; a missing entry, a missing field, an undecodable value, a wrong
 * type or no database row each keep their own conclusion.
 */
export function conclude(observations: Observation[], windowMs: number): { kind: "agree" | "converged" | "persistent" | "missing" | "inconclusive"; text: string } {
  if (!observations.length) return { kind: "inconclusive", text: "No observations" };
  const first = observations[0];
  const last = observations[observations.length - 1];
  const span = last.cacheAt - first.cacheAt;
  if (first.verdict.state === "agree") return { kind: "agree", text: "The cache agrees with the database for the mapped fields." };
  const settled = observations.findIndex((o) => o.verdict.state === "agree");
  if (settled > 0) return { kind: "converged", text: `They disagreed, then agreed ${observations[settled].cacheAt - first.cacheAt} ms later: a propagation delay within the ${windowMs} ms window, not a stale cache.` };
  if (span < windowMs) return { kind: "inconclusive", text: `Still disagreeing, but observed for only ${span} ms of the ${windowMs} ms window.` };
  const lasting = `for ${span} ms (window ${windowMs} ms)`;
  const v = last.verdict;
  switch (v.state) {
    case "no-cache-entry":
      return { kind: "missing", text: `No cache entry ${lasting}. That isn't a stale value: a cache-aside cache fills on first read, the entry may have expired, the key template may not match, or nothing populated it.` };
    case "no-db-row":
      return { kind: "inconclusive", text: `No database row for this id ${lasting}: there's nothing to compare the cache with.` };
    case "decode-error":
      return { kind: "inconclusive", text: `The cached value couldn't be decoded ${lasting}: check the mapping's format before calling it stale.` };
    case "wrong-type":
      return { kind: "inconclusive", text: `The key holds a different Redis type than the mapping expects ${lasting}: check the mapping.` };
    default: {
      const different = v.fields.filter((f) => f.status === "different").map((f) => f.field);
      const missing = v.fields.filter((f) => f.status === "missing-field").map((f) => f.field);
      if (!different.length) return { kind: "missing", text: `The cache entry lacks ${missing.join(", ")} ${lasting}. A missing field isn't a stale value: the cached shape may differ from the mapping.` };
      return { kind: "persistent", text: `${different.join(", ")} still differ${different.length === 1 ? "s" : ""} ${lasting}: the cached value looks stale, not just behind.${missing.length ? ` (${missing.join(", ")} missing from the entry.)` : ""}` };
    }
  }
}
