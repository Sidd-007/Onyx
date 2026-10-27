import type { Engine } from "./ipc";

export interface PlanNode {
  label: string;
  /** Conditions, sort keys … */
  detail: string[];
  cost: number | null;
  estimatedRows: number | null;
  actualRows: number | null;
  loops: number | null;
  /** Time in this node and below, over all loops (ANALYZE only). */
  totalMs: number | null;
  /** Time in this node alone. */
  selfMs: number | null;
  warnings: string[];
  children: PlanNode[];
}

export interface Plan {
  nodes: PlanNode[];
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
  /** Engines without a structured plan (DuckDB) show the text as it came. */
  text: string | null;
  /** The plan exactly as the server returned it (JSON pretty-printed), to inspect by hand. */
  raw?: string;
  /** Why the plan couldn't be drawn as a tree (the raw plan is shown instead). */
  problem?: string;
}

/** The EXPLAIN statement for `sql`. ANALYZE runs the query. */
export function explainSql(engine: Engine, sql: string, analyze: boolean): string {
  const body = sql.trim().replace(/;\s*$/, "");
  switch (engine) {
    case "postgres":
      return `EXPLAIN (FORMAT JSON${analyze ? ", ANALYZE, BUFFERS" : ""}) ${body}`;
    case "mysql":
      return analyze ? `EXPLAIN ANALYZE ${body}` : `EXPLAIN FORMAT=TREE ${body}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${body}`;
    case "duckdb":
      return analyze ? `EXPLAIN ANALYZE ${body}` : `EXPLAIN ${body}`;
    case "clickhouse":
      return analyze ? `EXPLAIN PIPELINE ${body}` : `EXPLAIN indexes = 1 ${body}`;
    default:
      throw new Error(`Query plans aren't available for ${engine}`);
  }
}

/** Engines with an EXPLAIN Onyx can show. */
export const canExplain = (engine: Engine) => ["postgres", "mysql", "sqlite", "duckdb", "clickhouse"].includes(engine);

/** Only queries are safe to run for EXPLAIN ANALYZE. */
export const isReadQuery = (sql: string) => /^\s*(\(\s*)*(select|with|values|table)\b/i.test(sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, ""));

function node(label: string): PlanNode {
  return { label, detail: [], cost: null, estimatedRows: null, actualRows: null, loops: null, totalMs: null, selfMs: null, warnings: [], children: [] };
}

/** Self time from total times, and warnings that need the whole tree. */
function finish(n: PlanNode): PlanNode {
  n.children.forEach(finish);
  if (n.totalMs !== null) {
    const below = n.children.reduce((sum, c) => sum + (c.totalMs ?? 0), 0);
    n.selfMs = Math.max(0, n.totalMs - below);
  }
  if (n.estimatedRows !== null && n.actualRows !== null) {
    const est = Math.max(1, n.estimatedRows);
    const act = Math.max(1, n.actualRows);
    if (act / est >= 10 || est / act >= 10) {
      n.warnings.push(`Estimated ${n.estimatedRows.toLocaleString()} rows, got ${n.actualRows.toLocaleString()}: statistics may be stale (ANALYZE the table)`);
    }
  }
  return n;
}

function postgres(text: string, analyzed: boolean): Plan {
  const parsed = JSON.parse(text) as { Plan: Record<string, unknown>; "Planning Time"?: number; "Execution Time"?: number }[];
  const top = parsed[0];
  const walk = (p: Record<string, unknown>): PlanNode => {
    const type = String(p["Node Type"]);
    let label = type;
    if (p["Join Type"] && /Join|Nested Loop/.test(type)) label = `${p["Join Type"]} ${type}`;
    if (p["Relation Name"]) {
      label += ` on ${p["Relation Name"]}`;
      if (p.Alias && p.Alias !== p["Relation Name"]) label += ` ${p.Alias}`;
    }
    if (p["Index Name"]) label += ` using ${p["Index Name"]}`;
    const n = node(label);
    for (const key of ["Index Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "Recheck Cond", "Sort Key", "Group Key"]) {
      const v = p[key];
      if (v) n.detail.push(`${key}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    }
    if (p["Rows Removed by Filter"]) n.detail.push(`Rows removed by filter: ${Number(p["Rows Removed by Filter"]).toLocaleString()}`);
    n.cost = typeof p["Total Cost"] === "number" ? p["Total Cost"] : null;
    n.estimatedRows = typeof p["Plan Rows"] === "number" ? p["Plan Rows"] : null;
    if (typeof p["Actual Rows"] === "number") {
      n.loops = Number(p["Actual Loops"] ?? 1);
      n.actualRows = (p["Actual Rows"] as number) * n.loops;
      n.estimatedRows = n.estimatedRows !== null ? n.estimatedRows * n.loops : null;
      n.totalMs = Number(p["Actual Total Time"] ?? 0) * n.loops;
    }
    if (type === "Seq Scan") n.warnings.push("Sequential scan: reads every row of the table");
    if (String(p["Sort Space Type"] ?? "") === "Disk") n.warnings.push("Sort spilled to disk (raise work_mem or add an index)");
    n.children = ((p.Plans as Record<string, unknown>[] | undefined) ?? []).map(walk);
    return n;
  };
  return {
    nodes: [finish(walk(top.Plan))],
    analyzed,
    planningMs: top["Planning Time"] ?? null,
    executionMs: top["Execution Time"] ?? null,
    text: null,
  };
}

/** MySQL's FORMAT=TREE / EXPLAIN ANALYZE text: one node per "-> " line, nested by indentation. */
function mysql(text: string, analyzed: boolean): Plan {
  const roots: PlanNode[] = [];
  const stack: { depth: number; node: PlanNode }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    const depth = m[1].length;
    let rest = m[2];
    const actual = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(rest);
    const cost = /\(cost=(?:[\d.e+]+\.\.)?([\d.e+]+) rows=([\d.e+]+)\)/.exec(rest);
    rest = rest.replace(/\s*\(cost=[^)]*\)/, "").replace(/\s*\(actual time=[^)]*\)/, "").replace(/\s*\(never executed\)/, "").trim();
    const n = node(rest);
    if (cost) {
      n.cost = Number(cost[1]);
      n.estimatedRows = Math.round(Number(cost[2]));
    }
    if (actual) {
      n.loops = Number(actual[4]);
      n.actualRows = Math.round(Number(actual[3]) * n.loops);
      n.totalMs = Number(actual[2]) * n.loops;
      if (n.estimatedRows !== null) n.estimatedRows *= n.loops;
    }
    if (/^Table scan on /.test(rest)) n.warnings.push("Full table scan: reads every row");
    if (/temporary table|filesort/i.test(rest)) n.warnings.push("Uses a temporary table or filesort");
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(n);
    else roots.push(n);
    stack.push({ depth, node: n });
  }
  return { nodes: roots.map(finish), analyzed, planningMs: null, executionMs: null, text: roots.length ? null : text };
}

/** SQLite's EXPLAIN QUERY PLAN rows: id, parent, notused, detail. */
function sqlite(rows: (string | null)[][]): Plan {
  const byId = new Map<string, PlanNode>();
  const roots: PlanNode[] = [];
  for (const [id, parent, , detail] of rows) {
    const n = node(detail ?? "");
    if (/^SCAN /.test(detail ?? "") && !/COVERING INDEX/.test(detail ?? "")) n.warnings.push("Full scan: reads every row");
    if (/TEMP B-TREE/.test(detail ?? "")) n.warnings.push("Builds a temporary index to sort or group");
    byId.set(id ?? "", n);
    const p = byId.get(parent ?? "");
    if (p && parent !== "0") p.children.push(n);
    else roots.push(n);
  }
  return { nodes: roots, analyzed: false, planningMs: null, executionMs: null, text: null };
}

/** Reads an EXPLAIN result into a plan tree. */
/**
 * The plan to show. A plan that can't be drawn still shows: as the server's raw output, with
 * a readable reason, never as a parser exception.
 */
export function parsePlan(engine: Engine, columns: string[], rows: (string | null)[][], analyzed: boolean): Plan {
  const rawText = rows.map((r) => (engine === "postgres" || engine === "mysql" ? (r[0] ?? "") : r.map((v) => v ?? "").join("  "))).join("\n");
  let raw = rawText;
  if (engine === "postgres") {
    try {
      raw = JSON.stringify(JSON.parse(rawText), null, 2);
    } catch {
      // Not JSON: keep it as it came.
    }
  }
  const fallback = (problem: string): Plan => ({ nodes: [], analyzed, planningMs: null, executionMs: null, text: raw || "(empty)", raw, problem });
  if (!rows.length || !rawText.trim()) return fallback("The server returned no plan for this statement.");
  try {
    const plan = parseRows(engine, columns, rows, analyzed);
    if (plan.text === null && !plan.nodes.length) return fallback("Onyx couldn't read the steps of this plan; here it is as the server returned it.");
    return { ...plan, raw };
  } catch (e) {
    return fallback(`Onyx couldn't draw this plan (${e instanceof Error ? e.message : String(e)}); here it is as the server returned it.`);
  }
}

function parseRows(engine: Engine, columns: string[], rows: (string | null)[][], analyzed: boolean): Plan {
  if (engine === "postgres") return postgres(rows.map((r) => r[0] ?? "").join("\n"), analyzed);
  if (engine === "mysql") return mysql(rows.map((r) => r[0] ?? "").join("\n"), analyzed);
  if (engine === "sqlite") return sqlite(rows);
  const text = rows.map((r) => r[columns.length - 1] ?? "").join("\n");
  return { nodes: [], analyzed, planningMs: null, executionMs: null, text };
}

/** The node with the most time of its own (or the highest cost without ANALYZE). */
export function slowest(nodes: PlanNode[]): PlanNode | null {
  let best: PlanNode | null = null;
  const score = (n: PlanNode) => n.selfMs ?? n.cost ?? -1;
  const visit = (n: PlanNode) => {
    if (!best || score(n) > score(best)) best = n;
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return best;
}
