/**
 * F06: compare a candidate query with a baseline under stated conditions. Both run as
 * prepared statements with typed parameters (as an application runs them), timings are
 * server execution times from EXPLAIN ANALYZE, and results are compared as multisets so a
 * faster query that answers differently is never recommended.
 */

export interface ParamSpec {
  /** Postgres types for $1, $2…, e.g. "int, text". */
  types: string[];
  /** One parameter set per line: values separated by |. */
  sets: string[][];
}

export function parseParams(types: string, sets: string): ParamSpec {
  const t = types.split(",").map((x) => x.trim()).filter(Boolean);
  const s = sets
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((v) => v.trim()));
  for (const [i, row] of s.entries()) if (row.length !== t.length) throw new Error(`Parameter set ${i + 1} has ${row.length} values for ${t.length} types`);
  return { types: t, sets: t.length ? (s.length ? s : []) : [[]] };
}

const lit = (v: string) => (v.toUpperCase() === "NULL" ? "NULL" : `'${v.replace(/'/g, "''")}'`);

export const prepareSql = (name: string, types: string[], sql: string) => `PREPARE ${name}${types.length ? `(${types.join(", ")})` : ""} AS ${sql.trim().replace(/;\s*$/, "")}`;
export const executeSql = (name: string, values: string[]) => `EXECUTE ${name}${values.length ? `(${values.map(lit).join(", ")})` : ""}`;

export interface Stats {
  n: number;
  median: number;
  min: number;
  max: number;
  /** Interquartile range: the middle half of the runs. */
  q1: number;
  q3: number;
}

export function stats(xs: number[]): Stats | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  return { n: s.length, median: q(0.5), min: s[0], max: s[s.length - 1], q1: q(0.25), q3: q(0.75) };
}

/** Planning and execution time (ms) and the plan's node types from EXPLAIN (ANALYZE, FORMAT JSON). */
export function readPlan(json: string): { planningMs: number | null; executionMs: number | null; cost: number | null; nodes: string[] } {
  const p = JSON.parse(json)[0];
  const nodes: string[] = [];
  const walk = (n: Record<string, unknown>) => {
    nodes.push(`${n["Node Type"]}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""}`);
    ((n.Plans as Record<string, unknown>[]) ?? []).forEach(walk);
  };
  walk(p.Plan);
  return { planningMs: p["Planning Time"] ?? null, executionMs: p["Execution Time"] ?? null, cost: p.Plan?.["Total Cost"] ?? null, nodes };
}

/** Same rows, ignoring order (duplicates count). */
export function sameMultiset(a: (string | null)[][], b: (string | null)[][]): { same: boolean; onlyA: number; onlyB: number } {
  const key = (r: (string | null)[]) => JSON.stringify(r);
  const counts = new Map<string, number>();
  for (const r of a) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  let onlyB = 0;
  for (const r of b) {
    const n = counts.get(key(r)) ?? 0;
    if (n) counts.set(key(r), n - 1);
    else onlyB++;
  }
  const onlyA = [...counts.values()].reduce((s, n) => s + n, 0);
  return { same: onlyA === 0 && onlyB === 0, onlyA, onlyB };
}

export interface Verdict {
  kind: "faster" | "slower" | "no-clear-difference" | "different-results" | "not-measured";
  text: string;
}

/** A conclusion only when results agree and the middle halves of the runs don't overlap. */
export function verdict(base: Stats | null, cand: Stats | null, resultsSame: boolean | null): Verdict {
  if (resultsSame === false) return { kind: "different-results", text: "The candidate returns different rows: it isn't a drop-in replacement, whatever its speed." };
  if (!base || !cand) return { kind: "not-measured", text: "Only estimated plans so far: run measured trials to compare times." };
  if (base.n < 3 || cand.n < 3) return { kind: "no-clear-difference", text: "Too few runs to tell (run at least 3 of each)." };
  const ratio = base.median / Math.max(cand.median, 0.001);
  if (cand.q3 < base.q1) return { kind: "faster", text: `Faster on this data: median ${fmt(cand.median)} vs ${fmt(base.median)} (${ratio.toFixed(1)}×), and the middle half of the runs doesn't overlap.${resultsSame ? " Same rows." : ""}` };
  if (cand.q1 > base.q3) return { kind: "slower", text: `Slower: median ${fmt(cand.median)} vs ${fmt(base.median)}.` };
  return { kind: "no-clear-difference", text: `No clear difference: the runs overlap (medians ${fmt(cand.median)} vs ${fmt(base.median)}).` };
}

export const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);
