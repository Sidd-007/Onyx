import { describe, expect, it } from "vitest";
import { canonicalNumber, compact, prettyJson, diffJson, parseJson, pgFilter, pgPath, stringify } from "./jsonDiff";

const p = parseJson;

describe("semantic JSON", () => {
  it("keeps big numbers and decimals exactly", () => {
    const n = p('{"id": 9223372036854775807, "price": 12345678901234567890.123456789}');
    expect(stringify(n)).toContain("9223372036854775807");
    expect(stringify(n)).toContain("12345678901234567890.123456789");
    expect(canonicalNumber("1.50")).toBe(canonicalNumber("15e-1"));
    expect(diffJson(p("[9007199254740993]"), p("[9007199254740992]")).changes).toHaveLength(1);
  });

  it("ignores key order but not arrays' order (unless keyed)", () => {
    expect(diffJson(p('{"a":1,"b":{"c":2}}'), p('{"b":{"c":2},"a":1.0}')).changes).toEqual([]);
    const a = p('[{"id":1,"v":"x"},{"id":2,"v":"y"}]');
    const b = p('[{"id":2,"v":"y"},{"id":1,"v":"z"}]');
    expect(diffJson(a, b).changes.length).toBeGreaterThan(1);
    const keyed = diffJson(a, b, "id");
    expect(keyed.changes).toEqual([{ path: [1, "v"], kind: "changed", before: { t: "string", v: "x" }, after: { t: "string", v: "z" } }]);
  });

  it("refuses to merge duplicate keys, and reports duplicate object keys", () => {
    const d = diffJson(p('[{"id":1},{"id":1}]'), p('[{"id":1}]'), "id");
    expect(d.ambiguous[0].reason).toMatch(/share id = 1/);
    expect(diffJson(p('{"a":1,"a":2}'), p('{"a":2}')).duplicateKeys).toEqual([{ path: [], keys: ["a"] }]);
  });

  it("tells missing from null from empty", () => {
    const d = diffJson(p('{"a":null,"b":"","c":[]}'), p('{"b":null,"c":[],"d":1}'));
    expect(d.changes.map((c) => `${c.path.join(".")}:${c.kind}`)).toEqual(["a:removed", "b:type", "d:added"]);
  });

  it("writes Postgres paths with escaped keys", () => {
    expect(pgPath("settings", ["billing", "plan code", 0], true)).toBe(`settings #>> '{billing,"plan code",0}'`);
    expect(pgPath("Data", ["it's"], false)).toBe(`"Data" #> '{"it''s"}'`);
    expect(pgFilter("s", ["n"], p("12345678901234567890.5"))).toBe("(s #>> '{n}')::numeric = 12345678901234567890.5");
    expect(() => p('{"a": 1,}')).toThrow(/Not valid JSON/);
  });

  it("formats and compacts without rounding big numbers", () => {
    const text = '{"id": 9007199254740993, "price": 12.50, "n": [1e400, -0.0]}';
    expect(compact(parseJson(text))).toBe('{"id":9007199254740993,"price":12.50,"n":[1e400,-0.0]}');
    expect(prettyJson(text)).toContain('"id": 9007199254740993');
    expect(prettyJson("{not json")).toBe("{not json");
  });
});
