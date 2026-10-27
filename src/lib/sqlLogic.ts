/** Types of the query debugger's reports (computed in Rust: src-tauri/src/sqllogic.rs). */
export interface Source {
  alias: string;
  schema: string | null;
  table: string;
  keys: string[];
}
export interface Agg {
  output: string;
  func: string;
  arg: string | null;
  distinct: boolean;
  text: string;
}
export interface Analysis {
  base: Source;
  joins: { left: boolean; source: Source; on: string }[];
  filters: string[];
  groupBy: string[];
  having: string | null;
  projection: [string, string][];
  aggregates: Agg[];
  orderBy: string[];
  limit: string | null;
  offset: string | null;
  notes: string[];
}
export interface StageReport {
  analysis: Analysis;
  stages: { label: string; detail: string; rows: number; entities: number | null; maxPerEntity: number | null }[];
  predicates: { text: string; trueRows: number; falseRows: number; unknownRows: number }[];
  observations: string[];
}
export interface MissingStep {
  stage: string;
  status: "kept" | "removed" | "not-found" | "beyond-limit" | "unknown";
  detail: string;
  values: [string[], (string | null)[][]] | null;
}
export interface Drill {
  aggregate: Agg;
  group: [string, string | null][];
  columns: string[];
  rows: (string | null)[][];
  capped: boolean;
  totalRows: number;
  nullRows: number;
  distinctEntities: number | null;
  recomputed: string | null;
  avgParts: [string | null, number] | null;
  repeated: [string | null, number][];
}
