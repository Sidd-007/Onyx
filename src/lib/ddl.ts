import { literal } from "./filters";
import type { Engine } from "./ipc";

/** A column as the schema editor holds it. `default` is SQL (an expression or a quoted literal). */
export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  /** MySQL EXTRA (auto_increment, on update …) / Postgres identity; kept as-is. */
  extra?: string | null;
  comment?: string | null;
}

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
export const FK_ACTIONS: FkAction[] = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

export type SchemaChange =
  | { kind: "addColumn"; column: ColumnDef }
  | { kind: "alterColumn"; from: ColumnDef; to: ColumnDef }
  | { kind: "dropColumn"; name: string }
  | { kind: "addIndex"; name: string; columns: string[]; unique: boolean }
  | { kind: "dropIndex"; name: string }
  | {
      kind: "addForeignKey";
      name: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete: FkAction;
      onUpdate: FkAction;
    }
  | { kind: "dropForeignKey"; name: string };

const q = (name: string, engine: Engine) =>
  engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

/**
 * MySQL reports defaults without quotes ("pending", "CURRENT_TIMESTAMP"); turn one back
 * into SQL so re-saving a column keeps it.
 */
export function mysqlDefaultSql(value: string | null, extra: string | null | undefined): string | null {
  if (value === null) return null;
  if (/DEFAULT_GENERATED/i.test(extra ?? "") || /^current_timestamp/i.test(value)) return value;
  return literal(value, "mysql");
}

function mysqlColumnSql(c: ColumnDef): string {
  const extra = (c.extra ?? "").toLowerCase();
  let sql = `${q(c.name, "mysql")} ${c.type.trim()} ${c.nullable ? "NULL" : "NOT NULL"}`;
  if (c.default !== null && c.default.trim() !== "") sql += ` DEFAULT ${c.default.trim()}`;
  if (extra.includes("auto_increment")) sql += " AUTO_INCREMENT";
  const onUpdate = /on update (\S+(?:\(\d*\))?)/i.exec(c.extra ?? "");
  if (onUpdate) sql += ` ON UPDATE ${onUpdate[1].toUpperCase()}`;
  if (c.comment) sql += ` COMMENT ${literal(c.comment, "mysql")}`;
  return sql;
}

/** What an engine's ALTER TABLE can't do, so the editor can say so before anything runs. */
export function unsupported(engine: Engine, change: SchemaChange): string | null {
  const fk = change.kind === "addForeignKey" || change.kind === "dropForeignKey";
  if (!["postgres", "mysql", "sqlite", "duckdb"].includes(engine)) return "Change this engine's schema with SQL in a query tab";
  if (engine === "sqlite") {
    if (fk) return "SQLite can't add or drop foreign keys on an existing table (recreate the table instead)";
    if (change.kind === "alterColumn") {
      const { from, to } = change;
      if (from.type.trim() !== to.type.trim() || from.nullable !== to.nullable || (from.default ?? "") !== (to.default ?? "")) {
        return "SQLite can only rename a column; changing its type, NULL or default means recreating the table";
      }
    }
    if (change.kind === "addColumn" && !change.column.nullable && (change.column.default ?? "").trim() === "") {
      return "SQLite needs a default for a new NOT NULL column";
    }
  }
  if (engine === "duckdb" && fk) return "DuckDB can't add or drop foreign keys on an existing table";
  return null;
}

/** The statements one change needs. Throws for changes the engine can't make (see `unsupported`). */
export function changeSql(engine: Engine, schema: string, table: string, change: SchemaChange): string[] {
  const t = `${q(schema, engine)}.${q(table, engine)}`;
  const col = (n: string) => q(n, engine);
  const blank = (s: string | null | undefined) => s === null || s === undefined || s.trim() === "";
  const problem = unsupported(engine, change);
  if (problem) throw new Error(problem);

  switch (change.kind) {
    case "addColumn": {
      const c = change.column;
      if (engine === "mysql") return [`ALTER TABLE ${t} ADD COLUMN ${mysqlColumnSql(c)}`];
      let sql = `ALTER TABLE ${t} ADD COLUMN ${col(c.name)} ${c.type.trim()}`;
      if (!blank(c.default)) sql += ` DEFAULT ${c.default!.trim()}`;
      if (!c.nullable) sql += " NOT NULL";
      return [sql];
    }
    case "alterColumn": {
      const { from, to } = change;
      if (engine === "mysql") return [`ALTER TABLE ${t} CHANGE COLUMN ${col(from.name)} ${mysqlColumnSql(to)}`];
      const out: string[] = [];
      if (from.name !== to.name) out.push(`ALTER TABLE ${t} RENAME COLUMN ${col(from.name)} TO ${col(to.name)}`);
      if (engine === "sqlite") return out;
      const c = col(to.name);
      if (from.type.trim() !== to.type.trim()) {
        out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${to.type.trim()} USING ${c}::${to.type.trim()}`);
      }
      if (from.nullable !== to.nullable) {
        out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${to.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`);
      }
      if ((from.default ?? "").trim() !== (to.default ?? "").trim()) {
        out.push(
          blank(to.default)
            ? `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`
            : `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${to.default!.trim()}`,
        );
      }
      return out;
    }
    case "dropColumn":
      return [`ALTER TABLE ${t} DROP COLUMN ${col(change.name)}`];
    case "addIndex": {
      const unique = change.unique ? "UNIQUE " : "";
      const columns = change.columns.map(col).join(", ");
      // SQLite puts the schema on the index name, not the table.
      if (engine === "sqlite") return [`CREATE ${unique}INDEX ${q(schema, engine)}.${col(change.name)} ON ${col(table)} (${columns})`];
      return [`CREATE ${unique}INDEX ${col(change.name)} ON ${t} (${columns})`];
    }
    case "dropIndex":
      return engine === "mysql"
        ? [`DROP INDEX ${col(change.name)} ON ${t}`]
        : [`DROP INDEX ${q(schema, engine)}.${col(change.name)}`];
    case "addForeignKey":
      return [
        `ALTER TABLE ${t} ADD CONSTRAINT ${col(change.name)} FOREIGN KEY (${change.columns.map(col).join(", ")}) ` +
          `REFERENCES ${q(change.refSchema, engine)}.${q(change.refTable, engine)} (${change.refColumns.map(col).join(", ")}) ` +
          `ON DELETE ${change.onDelete} ON UPDATE ${change.onUpdate}`,
      ];
    case "dropForeignKey":
      return engine === "mysql"
        ? [`ALTER TABLE ${t} DROP FOREIGN KEY ${col(change.name)}`]
        : [`ALTER TABLE ${t} DROP CONSTRAINT ${col(change.name)}`];
  }
}
