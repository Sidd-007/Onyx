import { describe, expect, it } from "vitest";
import { createTableSql, portableType } from "./createTable";
import { enumValues, generate, pickGenerator, random } from "./fakeData";
import type { ColumnInfo } from "./ipc";

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  nullable: true,
  primaryKey: false,
  default: null,
  ...extra,
});

describe("fake data", () => {
  it("picks generators from names and types", () => {
    expect(pickGenerator(col("id", "bigint", { primaryKey: true, default: "nextval('s')" }), false)).toBe("skip");
    expect(pickGenerator(col("id", "int", { primaryKey: true }), false)).toBe("sequence");
    expect(pickGenerator(col("email", "varchar(255)"), false)).toBe("email");
    expect(pickGenerator(col("created_at", "timestamp"), false)).toBe("timestamp");
    expect(pickGenerator(col("status", "enum('new','paid')"), false)).toBe("choice");
    expect(pickGenerator(col("user_id", "bigint"), true)).toBe("reference");
    expect(pickGenerator(col("is_active", "boolean"), false)).toBe("boolean");
    expect(enumValues("enum('a','it''s')")).toEqual(["a", "it's"]);
  });

  it("makes values that fit the column", () => {
    const r = random(1);
    expect(generate("email", col("email", "varchar(10)"), 4, r)).toHaveLength(10);
    expect(generate("uuid", col("id", "uuid"), 0, r)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generate("timestamp", col("t", "timestamp"), 0, r)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(generate("reference", col("u", "int"), 0, r, ["7"])).toBe("7");
    expect(generate("boolean", col("b", "tinyint(1)"), 0, r)).toMatch(/^[01]$/);
    expect(generate("sequence", col("id", "int"), 9, r)).toBe("10");
    // Same seed, same values.
    expect(generate("full_name", col("n", "text"), 0, random(5))).toBe(generate("full_name", col("n", "text"), 0, random(5)));
  });
});

describe("copy tables", () => {
  it("maps types across engines", () => {
    expect(portableType("integer", "postgres", "postgres")).toBe("integer");
    expect(portableType("int unsigned", "mysql", "postgres")).toBe("BIGINT");
    expect(portableType("jsonb", "postgres", "mysql")).toBe("JSON");
    expect(portableType("timestamp with time zone", "postgres", "sqlite")).toBe("TEXT");
    expect(portableType(undefined, "postgres", "mysql")).toBe("LONGTEXT");
    expect(createTableSql("mysql", "db", "t", [{ name: "id", dataType: "bigint" }, { name: "note" }], "postgres")).toBe(
      "CREATE TABLE `db`.`t` (\n  `id` BIGINT,\n  `note` LONGTEXT\n)",
    );
  });
});
