import { describe, expect, it } from "vitest";
import type { ForeignKeyRef } from "./ipc";
import { joinConditions, tablesInScope } from "./joinHints";

const fk = (schema: string, table: string, columns: string[], refTable: string, refColumns: string[]): ForeignKeyRef => ({
  schema,
  table,
  name: "fk",
  columns,
  refSchema: schema,
  refTable,
  refColumns,
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
});

const keys = [fk("shop", "orders", ["user_id"], "users", ["id"]), fk("shop", "items", ["order_id"], "orders", ["id"])];

describe("join hints", () => {
  it("reads tables and aliases", () => {
    expect(tablesInScope('SELECT * FROM shop.users u JOIN "orders" AS o ON')).toEqual([
      { schema: "shop", table: "users", alias: "u" },
      { schema: null, table: "orders", alias: "o" },
    ]);
    expect(tablesInScope("select * from users where id = 1")[0].alias).toBe("users");
  });

  it("suggests conditions from foreign keys in either direction", () => {
    expect(joinConditions("SELECT * FROM users u JOIN orders o ON ", keys, "shop")).toEqual(["o.user_id = u.id"]);
    expect(joinConditions("SELECT * FROM orders o\nLEFT JOIN shop.users ON ", keys, "shop")).toEqual(["users.id = o.user_id"]);
    expect(joinConditions("SELECT * FROM users u JOIN orders o ON o.", keys, "shop")).toEqual(["o.user_id = u.id"]);
    expect(joinConditions("SELECT * FROM users u WHERE ", keys, "shop")).toEqual([]);
    expect(joinConditions("SELECT * FROM users u JOIN items i ON ", keys, "shop")).toEqual([]);
  });
});
