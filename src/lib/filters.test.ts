import { describe, expect, it } from "vitest";
import { literal, whereClause, type Filter } from "./filters";

const f = (column: string, op: Filter["op"], value = ""): Filter => ({ column, op, value });

describe("literal", () => {
  it("escapes quotes per engine", () => {
    expect(literal("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(literal("O'Brien", "mysql")).toBe("'O\\'Brien'");
    expect(literal("a\\b", "mysql")).toBe("'a\\\\b'");
    expect(literal("a\\b", "postgres")).toBe("'a\\b'");
  });
});

describe("whereClause", () => {
  it("builds comparisons with quoted identifiers", () => {
    expect(whereClause([f("status", "=", "paid"), f("total", ">=", "100")], "postgres")).toBe(
      "status = 'paid' AND total >= '100'",
    );
    expect(whereClause([f("Status", "!=", "x")], "mysql")).toBe("`Status` != 'x'");
  });

  it("makes LIKE a contains search unless wildcards are given", () => {
    expect(whereClause([f("email", "like", "gmail")], "mysql")).toBe("`email` LIKE '%gmail%'");
    expect(whereClause([f("email", "like", "a%")], "mysql")).toBe("`email` LIKE 'a%'");
    expect(whereClause([f("id", "not like", "12")], "postgres")).toBe("id::text NOT LIKE '%12%'");
  });

  it("splits IN lists and handles null checks", () => {
    expect(whereClause([f("id", "in", "1, 2,3,")], "postgres")).toBe("id IN ('1', '2', '3')");
    expect(whereClause([f("name", "is null")], "postgres")).toBe("name IS NULL");
    expect(whereClause([f("name", "is not null")], "mysql")).toBe("`name` IS NOT NULL");
  });

  it("skips filters that have no value yet", () => {
    expect(whereClause([f("name", "="), f("id", "=", "1")], "postgres")).toBe("id = '1'");
    expect(whereClause([], "postgres")).toBe("");
  });

  it("keeps hostile values inside the literal", () => {
    expect(whereClause([f("name", "=", "x' OR '1'='1")], "postgres")).toBe("name = 'x'' OR ''1''=''1'");
    expect(whereClause([f("name", "=", "x\\' OR 1=1 -- ")], "mysql")).toBe("`name` = 'x\\\\\\' OR 1=1 -- '");
  });
});
