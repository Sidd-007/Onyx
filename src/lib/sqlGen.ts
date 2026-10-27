import type { ColumnInfo, Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

export type Statement = "select" | "insert" | "update" | "delete";

/** `:name` placeholder for a column (filled in by query variables). */
const variable = (column: string) => `:${column.replace(/\W+/g, "_").replace(/^(\d)/, "_$1") || "value"}`;

/** Generated keys: serial/identity/autoincrement columns get their own values. */
function generated(c: ColumnInfo, columns: ColumnInfo[]): boolean {
  if (/nextval\(|identity|auto_increment|autoincrement/i.test(c.default ?? "")) return true;
  const keys = columns.filter((k) => k.primaryKey);
  return keys.length === 1 && keys[0] === c && /int/i.test(c.dataType) && c.default === null;
}

/** A statement template for a table, with `:column` placeholders. */
export function generateSql(kind: Statement, engine: Engine, schema: string, table: string, columns: ColumnInfo[]): string {
  const q = (n: string) => quoteIdent(n, engine);
  const target = `${q(schema)}.${q(table)}`;
  const keys = columns.filter((c) => c.primaryKey);
  const where = (keys.length ? keys : columns.slice(0, 1)).map((c) => `${q(c.name)} = ${variable(c.name)}`).join("\n  AND ");
  switch (kind) {
    case "select":
      return engine === "sqlserver"
        ? `SELECT TOP 100\n${columns.map((c) => `  ${q(c.name)}`).join(",\n")}\nFROM ${target};`
        : `SELECT\n${columns.map((c) => `  ${q(c.name)}`).join(",\n")}\nFROM ${target}\nLIMIT 100;`;
    case "insert": {
      const cols = columns.filter((c) => !generated(c, columns));
      return `INSERT INTO ${target} (${cols.map((c) => q(c.name)).join(", ")})\nVALUES (${cols.map((c) => variable(c.name)).join(", ")});`;
    }
    case "update": {
      const cols = columns.filter((c) => !c.primaryKey);
      return `UPDATE ${target}\nSET\n${cols.map((c) => `  ${q(c.name)} = ${variable(c.name)}`).join(",\n")}\nWHERE ${where};`;
    }
    case "delete":
      return `DELETE FROM ${target}\nWHERE ${where};`;
  }
}

/** One page of `sql` (a SELECT). SQL Server pages with OFFSET … FETCH, which needs an ORDER BY. */
export function pageSql(engine: Engine, sql: string, ordered: boolean, limit: number, offset: number): string {
  if (engine === "sqlserver") {
    return `${sql}${ordered ? "" : " ORDER BY (SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return `${sql} LIMIT ${limit} OFFSET ${offset}`;
}
