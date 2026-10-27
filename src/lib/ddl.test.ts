import { describe, expect, it } from "vitest";
import { changeSql, mysqlDefaultSql, type ColumnDef } from "./ddl";

const col = (over: Partial<ColumnDef> = {}): ColumnDef => ({ name: "status", type: "text", nullable: true, default: null, ...over });

describe("changeSql (Postgres)", () => {
  const pg = (c: Parameters<typeof changeSql>[3]) => changeSql("postgres", "shop", "orders", c);

  it("adds and drops columns", () => {
    expect(pg({ kind: "addColumn", column: col({ name: "note", type: "varchar(80)", nullable: false, default: "''" }) })).toEqual([
      `ALTER TABLE "shop"."orders" ADD COLUMN "note" varchar(80) DEFAULT '' NOT NULL`,
    ]);
    expect(pg({ kind: "dropColumn", name: "note" })).toEqual([`ALTER TABLE "shop"."orders" DROP COLUMN "note"`]);
  });

  it("alters only what changed, renaming first", () => {
    const from = col({ default: "'pending'::text" });
    expect(pg({ kind: "alterColumn", from, to: { ...from } })).toEqual([]);
    expect(pg({ kind: "alterColumn", from, to: { ...from, name: "state", nullable: false, default: "" } })).toEqual([
      `ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state"`,
      `ALTER TABLE "shop"."orders" ALTER COLUMN "state" SET NOT NULL`,
      `ALTER TABLE "shop"."orders" ALTER COLUMN "state" DROP DEFAULT`,
    ]);
    expect(pg({ kind: "alterColumn", from, to: { ...from, type: "varchar(20)" } })).toEqual([
      `ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE varchar(20) USING "status"::varchar(20)`,
    ]);
  });

  it("creates and drops indexes and foreign keys", () => {
    expect(pg({ kind: "addIndex", name: "orders_status_idx", columns: ["status", "placed_at"], unique: false })).toEqual([
      `CREATE INDEX "orders_status_idx" ON "shop"."orders" ("status", "placed_at")`,
    ]);
    expect(pg({ kind: "dropIndex", name: "orders_status_idx" })).toEqual([`DROP INDEX "shop"."orders_status_idx"`]);
    expect(
      pg({ kind: "addForeignKey", name: "fk_user", columns: ["user_id"], refSchema: "shop", refTable: "users", refColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION" }),
    ).toEqual([
      `ALTER TABLE "shop"."orders" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "shop"."users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    ]);
    expect(pg({ kind: "dropForeignKey", name: "fk_user" })).toEqual([`ALTER TABLE "shop"."orders" DROP CONSTRAINT "fk_user"`]);
  });
});

describe("changeSql (MySQL)", () => {
  const my = (c: Parameters<typeof changeSql>[3]) => changeSql("mysql", "app", "orders", c);

  it("redefines the whole column, keeping auto_increment, on update and comments", () => {
    const id = col({ name: "id", type: "bigint", nullable: false, extra: "auto_increment" });
    expect(my({ kind: "alterColumn", from: id, to: { ...id, name: "order_id" } })).toEqual([
      "ALTER TABLE `app`.`orders` CHANGE COLUMN `id` `order_id` bigint NOT NULL AUTO_INCREMENT",
    ]);
    const updated = col({ name: "updated_at", type: "timestamp", default: "CURRENT_TIMESTAMP", extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", comment: "it's set" });
    expect(my({ kind: "alterColumn", from: updated, to: { ...updated, nullable: false } })).toEqual([
      "ALTER TABLE `app`.`orders` CHANGE COLUMN `updated_at` `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'it\\'s set'",
    ]);
  });

  it("uses MySQL's own index and foreign key syntax", () => {
    expect(my({ kind: "dropIndex", name: "idx" })).toEqual(["DROP INDEX `idx` ON `app`.`orders`"]);
    expect(my({ kind: "dropForeignKey", name: "fk" })).toEqual(["ALTER TABLE `app`.`orders` DROP FOREIGN KEY `fk`"]);
    expect(my({ kind: "addColumn", column: col({ name: "n", type: "int", nullable: false, default: "0" }) })).toEqual([
      "ALTER TABLE `app`.`orders` ADD COLUMN `n` int NOT NULL DEFAULT 0",
    ]);
  });

  it("re-quotes MySQL string defaults but keeps expressions", () => {
    expect(mysqlDefaultSql("pending", "")).toBe("'pending'");
    expect(mysqlDefaultSql("O'Neil", null)).toBe("'O\\'Neil'");
    expect(mysqlDefaultSql("CURRENT_TIMESTAMP", "DEFAULT_GENERATED")).toBe("CURRENT_TIMESTAMP");
    expect(mysqlDefaultSql("(uuid())", "DEFAULT_GENERATED")).toBe("(uuid())");
    expect(mysqlDefaultSql(null, "")).toBeNull();
  });

  it("knows what SQLite and DuckDB can't alter", () => {
    const col = { name: "n", type: "INTEGER", nullable: true, default: null };
    expect(changeSql("sqlite", "main", "t", { kind: "alterColumn", from: col, to: { ...col, name: "m" } })).toEqual([
      'ALTER TABLE "main"."t" RENAME COLUMN "n" TO "m"',
    ]);
    expect(() => changeSql("sqlite", "main", "t", { kind: "alterColumn", from: col, to: { ...col, type: "TEXT" } })).toThrow(/rename/);
    expect(changeSql("sqlite", "main", "t", { kind: "addIndex", name: "i", columns: ["n"], unique: true })).toEqual([
      'CREATE UNIQUE INDEX "main"."i" ON "t" ("n")',
    ]);
    expect(() => changeSql("duckdb", "main", "t", { kind: "dropForeignKey", name: "f" })).toThrow();
    expect(changeSql("duckdb", "main", "t", { kind: "dropColumn", name: "n" })).toEqual(['ALTER TABLE "main"."t" DROP COLUMN "n"']);
  });
});
