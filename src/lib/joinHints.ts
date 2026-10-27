import type { ForeignKeyRef } from "./ipc";

export interface TableInScope {
  schema: string | null;
  table: string;
  /** What the query calls it: the alias, or the table name. */
  alias: string;
}

const NOT_ALIAS = new Set([
  "on", "using", "where", "join", "left", "right", "inner", "outer", "full", "cross", "natural", "group", "order",
  "limit", "having", "union", "set", "values", "lateral", "as", "and", "or", "window", "offset", "returning",
]);

const unquote = (s: string) => s.replace(/^["`[]|["`\]]$/g, "").replace(/""/g, '"');
const IDENT = String.raw`(?:"(?:[^"]|"")+"|\`[^\`]+\`|[A-Za-z_][\w$]*)`;
const REF = new RegExp(String.raw`\b(?:from|join)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(${IDENT}))?`, "gi");

/** Tables named after FROM and JOIN, with their aliases, in order. */
export function tablesInScope(sql: string): TableInScope[] {
  const out: TableInScope[] = [];
  for (const m of sql.matchAll(REF)) {
    const parts = m[1].split(/\s*\.\s*/).map(unquote);
    const table = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[0] : null;
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? unquote(m[2]) : table;
    out.push({ schema, table, alias });
  }
  return out;
}

const sameTable = (t: TableInScope, schema: string, table: string, defaultSchema: string) =>
  t.table.toLowerCase() === table.toLowerCase() && (t.schema ?? defaultSchema).toLowerCase() === schema.toLowerCase();

/**
 * After `… JOIN t [alias] ON `, the conditions the foreign keys between `t` and the
 * tables already in the query suggest, e.g. `o.user_id = u.id`.
 */
export function joinConditions(before: string, keys: ForeignKeyRef[], defaultSchema: string): string[] {
  if (!/\bjoin\s+\S+(?:\s+(?:as\s+)?\S+)?\s+on\s+[\w.]*$/i.test(before)) return [];
  const scope = tablesInScope(before);
  const joined = scope[scope.length - 1];
  if (!joined) return [];
  const others = scope.slice(0, -1);
  const out = new Set<string>();
  const condition = (a: string, aCols: string[], b: string, bCols: string[]) =>
    aCols.map((c, i) => `${a}.${c} = ${b}.${bCols[i]}`).join(" AND ");
  for (const k of keys) {
    for (const other of others) {
      // joined → other
      if (sameTable(joined, k.schema, k.table, defaultSchema) && sameTable(other, k.refSchema, k.refTable, defaultSchema)) {
        out.add(condition(joined.alias, k.columns, other.alias, k.refColumns));
      }
      // other → joined
      if (sameTable(other, k.schema, k.table, defaultSchema) && sameTable(joined, k.refSchema, k.refTable, defaultSchema)) {
        out.add(condition(joined.alias, k.refColumns, other.alias, k.columns));
      }
    }
  }
  return [...out];
}
