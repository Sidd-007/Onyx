/**
 * F17: for one vector query, which eligible neighbors did the approximate (index) search miss,
 * and how do search settings trade quality for time? The reference is an exact scan of the
 * eligible rows under the same metric and filter, in the same read-only snapshot.
 */

export type Metric = "l2" | "cosine" | "ip";
export const OPERATOR: Record<Metric, string> = { l2: "<->", cosine: "<=>", ip: "<#>" };

export interface Neighbor {
  id: string;
  distance: number;
}

/**
 * Recall of the approximate result against the exact reference. Ties at the k-th distance are
 * all acceptable answers; with fewer eligible rows than k, the target is the number eligible.
 */
export function recall(exact: Neighbor[], approx: Neighbor[], k: number, eligible: number): { recall: number; target: number; missed: Neighbor[]; tiesAtCut: number } {
  const target = Math.min(k, eligible, exact.length);
  if (!target) return { recall: 1, target: 0, missed: [], tiesAtCut: 0 };
  const cut = exact[target - 1].distance;
  const eps = Math.abs(cut) * 1e-9 + 1e-12;
  const acceptable = new Set(exact.filter((n) => n.distance <= cut + eps).map((n) => n.id));
  const hits = approx.slice(0, k).filter((n) => acceptable.has(n.id)).length;
  const got = new Set(approx.map((n) => n.id));
  // Missed: reference neighbors strictly inside the cut that the index didn't return.
  const missed = exact.slice(0, target).filter((n) => !got.has(n.id) && n.distance < cut - eps);
  const tiesAtCut = exact.filter((n) => Math.abs(n.distance - cut) <= eps).length;
  return { recall: Math.min(1, hits / target), target, missed, tiesAtCut };
}

/** Exact neighbors that the filter excluded: not index misses, but often the real surprise. */
export function filteredOut(unfiltered: Neighbor[], eligibleIds: Set<string>): Neighbor[] {
  return unfiltered.filter((n) => !eligibleIds.has(n.id));
}

const id = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

export interface VectorQuery {
  schema: string;
  table: string;
  idColumn: string;
  column: string;
  metric: Metric;
  /** A vector literal like [0.1, 0.2, …], or the id of a row whose vector to use. */
  query: string;
  fromRow: boolean;
  filter: string;
  k: number;
}

export function queryVector(v: VectorQuery): string {
  const t = `${id(v.schema)}.${id(v.table)}`;
  return v.fromRow ? `(SELECT ${id(v.column)} FROM ${t} WHERE ${id(v.idColumn)}::text = '${v.query.replace(/'/g, "''")}')` : `'${v.query.replace(/'/g, "''").trim()}'::vector`;
}

/** Neighbors (id, distance) ordered by distance; `limit` rows; with or without the filter. */
export function neighborsSql(v: VectorQuery, limit: number, withFilter: boolean): string {
  const t = `${id(v.schema)}.${id(v.table)}`;
  const d = `${id(v.column)} ${OPERATOR[v.metric]} ${queryVector(v)}`;
  const where = withFilter && v.filter.trim() ? `WHERE ${v.filter}` : "";
  return `SELECT ${id(v.idColumn)}::text AS id, (${d})::float8 AS distance FROM ${t} ${where} ORDER BY ${d} LIMIT ${limit}`;
}

export const eligibleSql = (v: VectorQuery) => `SELECT count(*) FROM ${id(v.schema)}.${id(v.table)}${v.filter.trim() ? ` WHERE ${v.filter}` : ""}`;

/** Session-scoped setting statements for an approximate run (never global, never persisted). */
export function settingSql(name: string, value: string): string {
  if (!/^(hnsw\.(ef_search|iterative_scan|max_scan_tuples)|ivfflat\.(probes|iterative_scan|max_probes))$/.test(name)) throw new Error(`${name} isn't a pgvector search setting`);
  if (!/^[\w.]+$/.test(value)) throw new Error(`Bad value for ${name}`);
  return `SET LOCAL ${name} = ${/^\d+$/.test(value) ? value : `'${value}'`}`;
}

export const toNeighbors = (rows: (string | null)[][]): Neighbor[] => rows.map((r) => ({ id: r[0] ?? "", distance: Number(r[1]) }));
