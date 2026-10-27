import { portableType } from "./createTable";
import { changeSql, type ColumnDef, type FkAction, type SchemaChange } from "./ddl";
import type { Engine, StructureColumn, TableSnapshot } from "./ipc";

/** Always quoted, like the ALTER statements from ddl.ts. */
const quote = (name: string, engine: Engine) =>
  engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

export interface TableDiff {
  name: string;
  status: "added" | "removed" | "changed";
  /** Human-readable differences. */
  notes: string[];
}

export interface SchemaDiffResult {
  tables: TableDiff[];
  /** Statements that make the target look like the source. Drops are commented out. */
  sql: string[];
}

export interface Side {
  engine: Engine;
  schema: string;
  tables: TableSnapshot[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function columnDef(c: StructureColumn, from: Engine, to: Engine): ColumnDef {
  return {
    name: c.name,
    type: portableType(c.dataType, from, to),
    nullable: c.nullable,
    // Defaults are engine SQL: only carried over between the same engine.
    default: from === to ? c.default : null,
    extra: from === to ? c.extra : null,
    comment: c.comment,
  };
}

/** CREATE TABLE with the primary key, in the target's dialect. */
function createTable(t: TableSnapshot, source: Side, target: Side): string {
  const q = (n: string) => quote(n, target.engine);
  const lines = t.columns.map((c) => {
    const def = columnDef(c, source.engine, target.engine);
    let line = `  ${q(c.name)} ${def.type}`;
    if (!c.nullable) line += " NOT NULL";
    if (def.default) line += ` DEFAULT ${def.default}`;
    if (target.engine === "mysql" && /auto_increment/i.test(def.extra ?? "")) line += " AUTO_INCREMENT";
    return line;
  });
  const pk = t.indexes.find((i) => i.primary);
  if (pk?.columns.length) lines.push(`  PRIMARY KEY (${pk.columns.map(q).join(", ")})`);
  return `CREATE TABLE ${q(target.schema)}.${q(t.name)} (\n${lines.join(",\n")}\n)`;
}

function sqlFor(target: Side, table: string, change: SchemaChange): string[] {
  try {
    return changeSql(target.engine, target.schema, table, change);
  } catch (e) {
    return [`-- Can't do here: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/** Compares `source` to `target` and writes the migration for the target. */
export function diffSchemas(source: Side, target: Side): SchemaDiffResult {
  const out: SchemaDiffResult = { tables: [], sql: [] };
  const later: string[] = [];
  const targetByName = new Map(target.tables.map((t) => [t.name.toLowerCase(), t]));
  const sourceByName = new Map(source.tables.map((t) => [t.name.toLowerCase(), t]));
  const refSchema = (s: string) => (s === source.schema ? target.schema : s);
  const fkChange = (fk: TableSnapshot["foreignKeys"][number]): SchemaChange => ({
    kind: "addForeignKey",
    name: fk.name,
    columns: fk.columns,
    refSchema: refSchema(fk.refSchema),
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete as FkAction,
    onUpdate: fk.onUpdate as FkAction,
  });

  for (const s of source.tables) {
    const t = targetByName.get(s.name.toLowerCase());
    if (s.kind === "view") {
      if (!t) out.tables.push({ name: s.name, status: "added", notes: ["view: create it from its definition (see Structure → DDL)"] });
      continue;
    }
    if (!t) {
      out.tables.push({ name: s.name, status: "added", notes: [`${s.columns.length} columns`] });
      out.sql.push(createTable(s, source, target));
      for (const i of s.indexes.filter((i) => !i.primary)) {
        out.sql.push(...sqlFor(target, s.name, { kind: "addIndex", name: i.name, columns: i.columns, unique: i.unique }));
      }
      for (const fk of s.foreignKeys) later.push(...sqlFor(target, s.name, fkChange(fk)));
      continue;
    }
    const notes: string[] = [];
    const statements: string[] = [];
    const tCols = new Map(t.columns.map((c) => [c.name.toLowerCase(), c]));
    const sCols = new Map(s.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const c of s.columns) {
      const other = tCols.get(c.name.toLowerCase());
      const def = columnDef(c, source.engine, target.engine);
      if (!other) {
        notes.push(`+ column ${c.name} ${c.dataType}`);
        statements.push(...sqlFor(target, s.name, { kind: "addColumn", column: def }));
        continue;
      }
      const typeDiff = source.engine === target.engine ? norm(c.dataType) !== norm(other.dataType) : false;
      const nullDiff = c.nullable !== other.nullable;
      const defaultDiff = source.engine === target.engine && norm(c.default) !== norm(other.default);
      if (typeDiff || nullDiff || defaultDiff) {
        const what = [
          typeDiff && `type ${other.dataType} → ${c.dataType}`,
          nullDiff && (c.nullable ? "allows NULL" : "NOT NULL"),
          defaultDiff && `default ${other.default ?? "none"} → ${c.default ?? "none"}`,
        ].filter(Boolean);
        notes.push(`~ column ${c.name}: ${what.join(", ")}`);
        statements.push(...sqlFor(target, s.name, { kind: "alterColumn", from: columnDef(other, target.engine, target.engine), to: { ...def, default: defaultDiff ? c.default : other.default } }));
      }
    }
    for (const c of t.columns) {
      if (!sCols.has(c.name.toLowerCase())) {
        notes.push(`− column ${c.name}`);
        statements.push(...sqlFor(target, s.name, { kind: "dropColumn", name: c.name }).map((x) => `-- ${x}`));
      }
    }
    const indexKey = (i: TableSnapshot["indexes"][number]) => `${i.unique}:${i.columns.join(",").toLowerCase()}`;
    const tIdx = new Map(t.indexes.filter((i) => !i.primary).map((i) => [i.name.toLowerCase(), i]));
    const sIdx = new Map(s.indexes.filter((i) => !i.primary).map((i) => [i.name.toLowerCase(), i]));
    for (const [name, i] of sIdx) {
      const other = tIdx.get(name);
      if (other && indexKey(other) === indexKey(i)) continue;
      if (other) statements.push(...sqlFor(target, s.name, { kind: "dropIndex", name: other.name }));
      notes.push(`${other ? "~" : "+"} index ${i.name} (${i.columns.join(", ")})`);
      statements.push(...sqlFor(target, s.name, { kind: "addIndex", name: i.name, columns: i.columns, unique: i.unique }));
    }
    for (const [name, i] of tIdx) {
      if (!sIdx.has(name)) {
        notes.push(`− index ${i.name}`);
        statements.push(...sqlFor(target, s.name, { kind: "dropIndex", name: i.name }));
      }
    }
    const fkKey = (f: TableSnapshot["foreignKeys"][number]) => `${f.columns.join(",")}>${f.refTable}(${f.refColumns.join(",")})`.toLowerCase();
    const tFk = new Map(t.foreignKeys.map((f) => [fkKey(f), f]));
    const sFk = new Map(s.foreignKeys.map((f) => [fkKey(f), f]));
    for (const [key, fk] of sFk) {
      if (!tFk.has(key)) {
        notes.push(`+ foreign key ${fk.columns.join(", ")} → ${fk.refTable}`);
        later.push(...sqlFor(target, s.name, fkChange(fk)));
      }
    }
    for (const [key, fk] of tFk) {
      if (!sFk.has(key)) {
        notes.push(`− foreign key ${fk.name}`);
        statements.push(...sqlFor(target, s.name, { kind: "dropForeignKey", name: fk.name }));
      }
    }
    if (notes.length) {
      out.tables.push({ name: s.name, status: "changed", notes });
      out.sql.push(...statements);
    }
  }
  for (const t of target.tables) {
    if (sourceByName.has(t.name.toLowerCase())) continue;
    out.tables.push({ name: t.name, status: "removed", notes: [t.kind === "view" ? "view" : `${t.columns.length} columns`] });
    if (t.kind === "table") out.sql.push(`-- DROP TABLE ${quote(target.schema, target.engine)}.${quote(t.name, target.engine)}`);
  }
  out.sql.push(...later);
  out.tables.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
