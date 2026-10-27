import { describe, expect, it } from "vitest";
import type { StructureColumn, TableSnapshot } from "./ipc";
import { diffSchemas } from "./schemaDiff";

const col = (name: string, dataType: string, extra: Partial<StructureColumn> = {}): StructureColumn => ({
  name,
  dataType,
  nullable: true,
  default: null,
  primaryKey: false,
  extra: null,
  comment: null,
  ...extra,
});

const pk = { name: "users_pkey", columns: ["id"], unique: true, primary: true, sizeBytes: null, scans: null };

const users = (extra: Partial<TableSnapshot> = {}): TableSnapshot => ({
  name: "users",
  kind: "table",
  columns: [col("id", "bigint", { nullable: false, primaryKey: true }), col("email", "text", { nullable: false })],
  indexes: [pk],
  foreignKeys: [],
  ...extra,
});

describe("schema diff", () => {
  it("creates missing tables and keys", () => {
    const orders: TableSnapshot = {
      name: "orders",
      kind: "table",
      columns: [col("id", "bigint", { nullable: false }), col("user_id", "bigint")],
      indexes: [{ ...pk, name: "orders_pkey" }, { name: "orders_user", columns: ["user_id"], unique: false, primary: false, sizeBytes: null, scans: null }],
      foreignKeys: [{ name: "orders_user_fk", columns: ["user_id"], refSchema: "app", refTable: "users", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "CASCADE" }],
    };
    const d = diffSchemas({ engine: "postgres", schema: "app", tables: [users(), orders] }, { engine: "postgres", schema: "staging", tables: [users()] });
    expect(d.tables).toEqual([{ name: "orders", status: "added", notes: ["2 columns"] }]);
    expect(d.sql[0]).toBe('CREATE TABLE "staging"."orders" (\n  "id" bigint NOT NULL,\n  "user_id" bigint,\n  PRIMARY KEY ("id")\n)');
    expect(d.sql[1]).toBe('CREATE INDEX "orders_user" ON "staging"."orders" ("user_id")');
    // Foreign keys last, pointing at the target schema.
    expect(d.sql[2]).toContain('REFERENCES "staging"."users" ("id") ON DELETE CASCADE');
  });

  it("alters changed columns and comments out drops", () => {
    const source = users({ columns: [...users().columns, col("name", "text")] });
    const target = users({
      columns: [col("id", "bigint", { nullable: false, primaryKey: true }), col("email", "varchar(100)", { nullable: true }), col("legacy", "int")],
    });
    const d = diffSchemas({ engine: "postgres", schema: "public", tables: [source] }, { engine: "postgres", schema: "public", tables: [target, users({ name: "old" })] });
    const changed = d.tables.find((t) => t.name === "users")!;
    expect(changed.notes).toEqual(["~ column email: type varchar(100) → text, NOT NULL", "+ column name text", "− column legacy"]);
    expect(d.sql).toContain('ALTER TABLE "public"."users" ALTER COLUMN "email" TYPE text USING "email"::text');
    expect(d.sql).toContain('ALTER TABLE "public"."users" ALTER COLUMN "email" SET NOT NULL');
    expect(d.sql).toContain('-- ALTER TABLE "public"."users" DROP COLUMN "legacy"');
    expect(d.sql).toContain('-- DROP TABLE "public"."old"');
    expect(d.tables.find((t) => t.name === "old")?.status).toBe("removed");
  });

  it("finds nothing when the schemas match", () => {
    const d = diffSchemas({ engine: "mysql", schema: "a", tables: [users()] }, { engine: "mysql", schema: "b", tables: [users()] });
    expect(d).toEqual({ tables: [], sql: [] });
  });
});
