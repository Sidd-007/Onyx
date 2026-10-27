import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "./ipc";
import { generateSql } from "./sqlGen";
import { findVariables, substitute, variableNames } from "./variables";

const columns: ColumnInfo[] = [
  { name: "id", dataType: "bigint", nullable: false, primaryKey: true, default: "nextval('users_id_seq'::regclass)" },
  { name: "email", dataType: "text", nullable: false, primaryKey: false, default: null },
  { name: "full name", dataType: "text", nullable: true, primaryKey: false, default: null },
];

describe("generated SQL", () => {
  it("writes templates with placeholders", () => {
    expect(generateSql("select", "postgres", "public", "order", columns.slice(0, 1))).toContain('FROM public."order"');
    expect(generateSql("select", "postgres", "public", "users", columns)).toBe(
      'SELECT\n  id,\n  email,\n  "full name"\nFROM public.users\nLIMIT 100;',
    );
    expect(generateSql("insert", "mysql", "db", "users", columns)).toBe(
      "INSERT INTO `db`.`users` (`email`, `full name`)\nVALUES (:email, :full_name);",
    );
    expect(generateSql("update", "postgres", "public", "users", columns)).toContain("WHERE id = :id;");
    expect(generateSql("delete", "sqlite", "main", "users", columns)).toBe('DELETE FROM main.users\nWHERE id = :id;');
  });
});

describe("query variables", () => {
  it("finds placeholders but not casts, strings or comments", () => {
    const sql = "SELECT :a, x::int, ':nope', \"col:x\" -- :c\nFROM t WHERE id = :b AND n = :a /* :d */ AND @v := 1";
    expect(variableNames(sql)).toEqual(["a", "b"]);
    expect(findVariables("SELECT $$ :x $$, :y").map((v) => v.name)).toEqual(["y"]);
  });

  it("substitutes values by type", () => {
    const values = { id: { value: "42", raw: false }, name: { value: "O'Neil", raw: false }, at: { value: "now()", raw: true } };
    expect(substitute("SELECT :id, :name, :at, :id", values, "postgres")).toBe("SELECT 42, 'O''Neil', now(), 42");
    expect(substitute("SELECT :name", values, "mysql")).toBe("SELECT 'O\\'Neil'");
    expect(substitute("SELECT :n", { n: { value: "null", raw: false } }, "postgres")).toBe("SELECT NULL");
  });
});
