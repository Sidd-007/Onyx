import type { Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

/** A column in the New table designer. `default` is SQL ('text', 0, now()); empty is none. */
export interface NewColumn {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
}

export interface NewIndex {
  id: string;
  columns: string[];
  unique: boolean;
}

export interface NewForeignKey {
  id: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  onDelete: "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL";
}

/** Engines that take FOREIGN KEY constraints in CREATE TABLE (ClickHouse has none). */
export const hasForeignKeys = (engine: Engine) => engine !== "clickhouse";

/** Common types per engine, offered next to the type field (any type can be typed). */
export const TYPE_SUGGESTIONS: Partial<Record<Engine, string[]>> = {
  postgres: ["bigint", "integer", "smallint", "text", "varchar(255)", "boolean", "numeric(12,2)", "double precision", "date", "timestamptz", "timestamp", "uuid", "jsonb", "bytea"],
  mysql: ["bigint", "int", "tinyint(1)", "varchar(255)", "text", "decimal(12,2)", "double", "date", "datetime", "timestamp", "json", "blob"],
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB"],
  duckdb: ["BIGINT", "INTEGER", "VARCHAR", "BOOLEAN", "DECIMAL(12,2)", "DOUBLE", "DATE", "TIMESTAMP", "UUID", "JSON"],
  sqlserver: ["bigint", "int", "nvarchar(255)", "nvarchar(max)", "bit", "decimal(12,2)", "float", "date", "datetime2", "uniqueidentifier"],
  clickhouse: ["UInt64", "Int64", "Int32", "String", "Bool", "Decimal(12,2)", "Float64", "Date", "DateTime", "UUID"],
};

/** Engines whose tables the designer can create. */
export const canCreateTables = (engine: Engine) => engine in TYPE_SUGGESTIONS;

/** Engines with an auto-increment (identity) column. */
export const hasAutoIncrement = (engine: Engine) => engine !== "clickhouse";

const isInteger = (type: string) => /^(big|small|tiny|medium)?int(eger)?\b|^u?int\d*\b|^serial|^bigserial/i.test(type.trim());

let nextId = 1;
export const newColumn = (patch: Partial<NewColumn> = {}): NewColumn => ({
  id: `c${nextId++}`,
  name: "",
  type: "",
  nullable: true,
  default: "",
  primaryKey: false,
  autoIncrement: false,
  unique: false,
  ...patch,
});

/** The starting columns: an auto-increment id, as most tables have. */
export function starterColumns(engine: Engine): NewColumn[] {
  const id = { postgres: "bigint", mysql: "bigint", sqlite: "INTEGER", duckdb: "BIGINT", sqlserver: "bigint", clickhouse: "UInt64" }[engine as string] ?? "bigint";
  return [newColumn({ name: "id", type: id, nullable: false, primaryKey: true, autoIncrement: hasAutoIncrement(engine) }), newColumn()];
}

/** What's wrong with the design, if anything (shown under the form; Create stays off). */
export function problems(engine: Engine, table: string, columns: NewColumn[]): string | null {
  if (!table.trim()) return "Name the table";
  const named = columns.filter((c) => c.name.trim());
  if (!named.length) return "Add at least one column";
  const untyped = named.find((c) => !c.type.trim());
  if (untyped) return `Give ${untyped.name} a type`;
  const seen = new Set<string>();
  for (const c of named) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) return `Two columns are called ${c.name.trim()}`;
    seen.add(key);
  }
  const auto = named.filter((c) => c.autoIncrement);
  if (auto.length > 1) return "Only one column can auto-increment";
  if (auto[0] && !auto[0].primaryKey && engine !== "postgres" && engine !== "duckdb") return "The auto-increment column must be the primary key";
  if (auto[0] && !isInteger(auto[0].type)) return "Auto-increment needs an integer type";
  if (engine === "sqlite" && auto[0] && named.filter((c) => c.primaryKey).length > 1) return "SQLite auto-increments only a single-column primary key";
  return null;
}

/** The statements that create the table, then its indexes (DuckDB's auto-increment needs a sequence first). */
export function createTableStatements(
  engine: Engine,
  schema: string,
  table: string,
  columns: NewColumn[],
  indexes: NewIndex[] = [],
  foreignKeys: NewForeignKey[] = [],
): string[] {
  const q = (n: string) => quoteIdent(n, engine);
  const named = columns.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim(), type: c.type.trim(), default: c.default.trim() }));
  const target = schema ? `${q(schema)}.${q(table.trim())}` : q(table.trim());
  const keys = named.filter((c) => c.primaryKey);
  const before: string[] = [];
  // SQLite auto-increment is spelled on the column itself, as the only primary key.
  const sqliteAuto = engine === "sqlite" && keys.length === 1 && keys[0].autoIncrement;

  const lines = named.map((c) => {
    let type = c.type;
    if (engine === "clickhouse" && c.nullable && !c.primaryKey && !/^Nullable\(/i.test(type)) type = `Nullable(${type})`;
    let line = `  ${q(c.name)} ${type}`;
    if (c.autoIncrement) {
      if (engine === "postgres") line += " GENERATED BY DEFAULT AS IDENTITY";
      else if (engine === "mysql") line += " AUTO_INCREMENT";
      else if (engine === "sqlserver") line += " IDENTITY(1,1)";
      else if (engine === "duckdb") {
        const sequence = `${table.trim()}_${c.name}_seq`;
        before.push(`CREATE SEQUENCE ${schema ? `${q(schema)}.` : ""}${q(sequence)}`);
        line += ` DEFAULT nextval('${(schema ? `${schema}.` : "") + sequence}')`;
      }
    }
    if (sqliteAuto && c.primaryKey) return `${line} PRIMARY KEY AUTOINCREMENT`;
    if (engine !== "clickhouse") line += c.nullable && !c.primaryKey ? (engine === "sqlserver" ? " NULL" : "") : " NOT NULL";
    if (c.default && !c.autoIncrement) line += ` DEFAULT ${c.default}`;
    if (c.unique && !c.primaryKey && engine !== "clickhouse") line += " UNIQUE";
    return line;
  });
  if (keys.length && !sqliteAuto && engine !== "clickhouse") lines.push(`  PRIMARY KEY (${keys.map((k) => q(k.name)).join(", ")})`);
  const known = new Set(named.map((c) => c.name));
  if (hasForeignKeys(engine)) {
    for (const fk of foreignKeys.filter((f) => known.has(f.column) && f.refTable && f.refColumn)) {
      const ref = fk.refSchema ? `${q(fk.refSchema)}.${q(fk.refTable)}` : q(fk.refTable);
      // DuckDB only enforces the plain kind.
      const action = engine === "duckdb" || fk.onDelete === "NO ACTION" ? "" : ` ON DELETE ${fk.onDelete}`;
      lines.push(`  CONSTRAINT ${q(`fk_${table.trim()}_${fk.column}`)} FOREIGN KEY (${q(fk.column)}) REFERENCES ${ref} (${q(fk.refColumn)})${action}`);
    }
  }

  let create = `CREATE TABLE ${target} (\n${lines.join(",\n")}\n)`;
  if (engine === "mysql") create += " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
  // MergeTree sorts by the key; without one, rows stay in insert order.
  if (engine === "clickhouse") create += `\nENGINE = MergeTree\nORDER BY ${keys.length ? `(${keys.map((k) => q(k.name)).join(", ")})` : "tuple()"}`;
  const after = indexes
    .map((i) => ({ ...i, columns: i.columns.filter((c) => known.has(c)) }))
    .filter((i) => i.columns.length && engine !== "clickhouse")
    .map((i) => {
      const name = q(`${i.unique ? "uq" : "idx"}_${table.trim()}_${i.columns.join("_")}`);
      // Postgres and DuckDB index names live in the table's schema; MySQL's and SQL Server's on the table.
      return `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${engine === "sqlite" && schema ? `${q(schema)}.` : ""}${name} ON ${target} (${i.columns.map(q).join(", ")})`;
    });
  return [...before, create, ...after];
}
