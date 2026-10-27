import { describe, expect, it } from "vitest";
import { buildFixture, casesFor } from "./edgeCases";

const col = (name: string, dataType: string, nullable = true, primaryKey = false, def: string | null = null) => ({ name, dataType, nullable, primaryKey, default: def });

describe("edge-case fixtures", () => {
  it("never puts NULL in a NOT NULL column, and lists it as expected-to-fail instead", () => {
    const c = casesFor(col("email", "varchar(20)", false), "postgres");
    expect(c.valid.some((x) => x.value === null)).toBe(false);
    expect(c.omitted).toContainEqual({ column: "email", name: "NULL", reason: "NOT NULL column" });
    expect(c.invalid.map((x) => x.name)).toEqual(["NULL in NOT NULL", "over max length"]);
    expect(c.valid.find((x) => x.name === "exactly max length")?.value).toHaveLength(20);
  });

  it("keeps big numbers exact and knows numeric bounds", () => {
    expect(casesFor(col("n", "bigint"), "postgres").valid.find((x) => x.name === "maximum")?.value).toBe("9223372036854775807");
    expect(casesFor(col("n", "bigint"), "postgres").invalid.find((x) => x.name === "above maximum")?.value).toBe("9223372036854775808");
    expect(casesFor(col("p", "numeric(10,2)"), "postgres").valid.find((x) => x.name === "maximum")?.value).toBe("99999999.99");
  });

  it("is deterministic for a seed and records what each row tests", () => {
    const cols = [col("id", "bigint", false, true, "nextval('x')"), col("name", "text"), col("total", "numeric(8,2)", false), col("customer_id", "bigint", false)];
    const a = buildFixture(cols, "postgres", 42, { customer_id: ["1", "2"] });
    const b = buildFixture(cols, "postgres", 42, { customer_id: ["1", "2"] });
    expect(a).toEqual(b);
    expect(a.columns).toEqual(["name", "total", "customer_id"]);
    expect(a.manifest[0].name).toBe("baseline");
    expect(a.manifest.length - 1).toBe(a.rows.length - 1 + 1); // + the cardinality note
    expect(a.rows.every((r) => r[a.columns.indexOf("total")] !== null)).toBe(true);
    expect(a.rows.filter((r) => r[2] === "1")).toHaveLength(1);
  });

  it("only offers strings that fit the column, and says what it left out", () => {
    const c = casesFor(col("short_name", "character varying(5)"), "postgres");
    const length = (v: string | null) => [...(v ?? "")].length;
    expect(c.valid.every((x) => length(x.value) <= 5)).toBe(true);
    expect(c.valid.find((x) => x.name === "unicode")?.value).toBe("é你👋🏽");
    expect(c.valid.find((x) => x.name === "quotes")?.value).toBe(`'"\\`);
    expect(c.valid.find((x) => x.name === "combining")?.value).toBe("e\u0301");
    const tiny = casesFor(col("c", "varchar(1)"), "postgres");
    expect(tiny.omitted.map((o) => o.name)).toEqual(expect.arrayContaining(["unicode", "right to left", "zero width", "quotes", "combining"]));
    expect(tiny.valid.every((x) => length(x.value) <= 1)).toBe(true);
  });

  it("changes one column at a time from one baseline", () => {
    const cols = [col("id", "integer", false, true), col("short_name", "varchar(5)"), col("amount", "numeric(5,2)"), col("small", "smallint"), col("active", "boolean"), col("payload", "jsonb"), col("email", "text")];
    const f = buildFixture(cols, "postgres", 42, {}, ["email"]);
    const base = f.rows[0];
    const own = ["id", "email"].map((c) => f.columns.indexOf(c));
    for (const [r, m] of f.manifest.entries()) {
      if (r === 0 || m.row < 0) continue;
      const row = f.rows[m.row];
      const changed = f.columns.filter((_, k) => !own.includes(k) && row[k] !== base[k]);
      expect(changed.length <= 1 && (changed.length === 0 || changed[0] === m.column)).toBe(true);
    }
    expect(new Set(f.rows.map((r) => r[f.columns.indexOf("id")])).size).toBe(f.rows.length);
    expect(new Set(f.rows.map((r) => r[f.columns.indexOf("email")])).size).toBe(f.rows.length);
    expect(f.manifest[0].why).toContain("id, email");
  });
});
