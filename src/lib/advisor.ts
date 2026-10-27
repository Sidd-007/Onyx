/**
 * Index advisor: reads EXPLAIN (JSON) plans of slow queries and suggests indexes for tables
 * that are read in full to filter a few rows. Suggestions only; nothing is created for you.
 */
import type { Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

export interface Scan {
  schema: string | null;
  table: string;
  /** Columns the scan filters on, in the order they appear. */
  columns: string[];
  rows: number;
}

export interface Suggestion {
  schema: string | null;
  table: string;
  columns: string[];
  rows: number;
  sql: string;
  /** The slow queries this would help. */
  queries: string[];
}

const SKIP = new Set(["and", "or", "not", "null", "true", "false", "is", "in", "any", "like", "text", "numeric", "integer", "bigint", "date", "timestamp", "without", "with", "time", "zone", "character", "varying", "boolean"]);

/** Column names compared in a Postgres filter: `((status = 'paid'::text) AND (user_id = 4))`. */
export function filterColumns(filter: string): string[] {
  const out: string[] = [];
  // Drop string literals so their contents aren't read as names.
  const clean = filter.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of clean.matchAll(/(?:^|[(\s,.])(?:"([^"]+)"|([a-z_][a-z0-9_]*))(?:\)?::[a-z ]+)?\s*(?:=|<>|!=|<=|>=|<|>|~~\*?|!~~|IS\b|= ANY|IN\b)/gi)) {
    const name = m[1] ?? m[2];
    if (!SKIP.has(name.toLowerCase()) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Full scans in a Postgres `EXPLAIN (FORMAT JSON)` plan. */
export function postgresScans(plan: unknown): Scan[] {
  const out: Scan[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (node["Node Type"] === "Seq Scan" && typeof node["Relation Name"] === "string") {
      const filter = typeof node.Filter === "string" ? node.Filter : "";
      out.push({
        schema: typeof node.Schema === "string" ? node.Schema : null,
        table: node["Relation Name"],
        columns: filterColumns(filter),
        rows: Number(node["Plan Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0),
      });
    }
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  const root = Array.isArray(plan) ? plan[0] : plan;
  const top = (root as { Plan?: Record<string, unknown> } | undefined)?.Plan;
  if (top) walk(top);
  return out;
}

/** Full scans in a MySQL `EXPLAIN FORMAT=JSON` plan (`access_type: "ALL"`). */
export function mysqlScans(plan: unknown): Scan[] {
  const out: Scan[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.access_type === "ALL" && typeof o.table_name === "string") {
      const cond = typeof o.attached_condition === "string" ? o.attached_condition : "";
      const columns: string[] = [];
      const clean = cond.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
      for (const m of clean.matchAll(/`[^`]+`\.`([^`]+)`\.`([^`]+)`\s*(?:=|<>|!=|<=|>=|<|>|like\b|in\b|is\b|between\b)/gi)) {
        if (m[1] === o.table_name && !columns.includes(m[2])) columns.push(m[2]);
      }
      out.push({ schema: null, table: o.table_name, columns, rows: Number(o.rows_examined_per_scan ?? 0) });
    }
    Object.values(o).forEach(walk);
  };
  walk(plan);
  return out;
}

export const MIN_ROWS = 10_000;

/** One suggestion per table and column list, skipping columns an existing index already leads with. */
export function suggest(
  engine: Engine,
  found: { sql: string; scans: Scan[] }[],
  indexed: (schema: string | null, table: string) => string[][],
): Suggestion[] {
  const by = new Map<string, Suggestion>();
  for (const { sql, scans } of found) {
    for (const s of scans) {
      if (!s.columns.length || s.rows < MIN_ROWS) continue;
      const columns = s.columns.slice(0, 3);
      if (indexed(s.schema, s.table).some((ix) => ix[0] === columns[0])) continue;
      const key = `${s.schema}.${s.table}(${columns.join(",")})`;
      const existing = by.get(key);
      if (existing) {
        if (!existing.queries.includes(sql)) existing.queries.push(sql);
        continue;
      }
      const q = (n: string) => quoteIdent(n, engine);
      const name = `idx_${s.table}_${columns.join("_")}`.replace(/\W+/g, "_").slice(0, 60);
      const target = s.schema ? `${q(s.schema)}.${q(s.table)}` : q(s.table);
      const concurrently = engine === "postgres" ? "CONCURRENTLY " : "";
      by.set(key, { schema: s.schema, table: s.table, columns, rows: s.rows, queries: [sql], sql: `CREATE INDEX ${concurrently}${q(name)} ON ${target} (${columns.map(q).join(", ")});` });
    }
  }
  return [...by.values()].sort((a, b) => b.queries.length - a.queries.length || b.rows - a.rows);
}

/** Only plain reads are explained (EXPLAIN without ANALYZE never runs them anyway). */
export const isRead = (sql: string) => /^\s*(select|with)\b/i.test(sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, "")) && !/;\s*\S/.test(sql.trim().replace(/;\s*$/, ""));
