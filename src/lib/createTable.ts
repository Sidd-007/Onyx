import { typeKind } from "./columnTypes";
import type { Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

export interface SourceColumn {
  name: string;
  /** The source's type, if known (a query result's columns have none). */
  dataType?: string;
}

const SQLSERVER: Record<string, string> = {
  BIGINT: "BIGINT",
  "DOUBLE PRECISION": "FLOAT",
  NUMERIC: "DECIMAL(38,10)",
  BOOLEAN: "BIT",
  DATE: "DATE",
  TIMESTAMP: "DATETIME2",
  JSONB: "NVARCHAR(MAX)",
  TEXT: "NVARCHAR(MAX)",
};
const CLICKHOUSE: Record<string, string> = {
  BIGINT: "Int64",
  "DOUBLE PRECISION": "Float64",
  NUMERIC: "Decimal(38,10)",
  BOOLEAN: "Bool",
  DATE: "Date32",
  TIMESTAMP: "DateTime64(6)",
  JSONB: "String",
  TEXT: "String",
};

/** A type for `target` that holds values of the source type. Same engine: the same type. */
export function portableType(dataType: string | undefined, source: Engine, target: Engine): string {
  if (!dataType) return target === "mysql" ? "LONGTEXT" : "TEXT";
  if (source === target) return dataType;
  const t = dataType.toLowerCase();
  const kind = typeKind(dataType);
  // ClickHouse and SQL Server get their own spellings of the same choices.
  const pick = (pg: string, my: string, lite: string, duck: string): string => {
    if (target === "sqlserver") return SQLSERVER[pg] ?? "NVARCHAR(MAX)";
    if (target === "clickhouse") return `Nullable(${CLICKHOUSE[pg] ?? "String"})`;
    return ({ postgres: pg, mysql: my, sqlite: lite, duckdb: duck } as Record<string, string>)[target] ?? lite;
  };
  switch (kind) {
    case "number":
      if (/int|serial/.test(t)) return pick("BIGINT", "BIGINT", "INTEGER", "BIGINT");
      if (/float|double|real/.test(t)) return pick("DOUBLE PRECISION", "DOUBLE", "REAL", "DOUBLE");
      return pick("NUMERIC", "DECIMAL(38,10)", "NUMERIC", "DECIMAL(38,10)");
    case "bool":
      return pick("BOOLEAN", "TINYINT(1)", "INTEGER", "BOOLEAN");
    case "date":
      return /^date$/.test(t) ? pick("DATE", "DATE", "TEXT", "DATE") : pick("TIMESTAMP", "DATETIME(6)", "TEXT", "TIMESTAMP");
    case "time":
      return pick("TEXT", "VARCHAR(64)", "TEXT", "VARCHAR");
    case "json":
      return pick("JSONB", "JSON", "TEXT", "JSON");
    case "binary":
      return pick("TEXT", "LONGTEXT", "TEXT", "VARCHAR");
    default:
      return pick("TEXT", "LONGTEXT", "TEXT", "VARCHAR");
  }
}

/** CREATE TABLE for copying rows into a new table. */
export function createTableSql(target: Engine, schema: string, table: string, columns: SourceColumn[], source: Engine): string {
  const q = (n: string) => quoteIdent(n, target);
  const body = columns.map((c) => `  ${q(c.name)} ${portableType(c.dataType, source, target)}`).join(",\n");
  // ClickHouse tables need an engine; MergeTree without a sort key keeps rows in insert order.
  const engine = target === "clickhouse" ? " ENGINE = MergeTree ORDER BY tuple()" : "";
  return `CREATE TABLE ${q(schema)}.${q(table)} (\n${body}\n)${engine}`;
}
