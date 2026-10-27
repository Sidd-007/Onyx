import { describe, expect, it } from "vitest";
import { coverage, groupQueries, normalize, parseTrace, replayable } from "./trace";

const otlp = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            { spanId: "r", name: "GET /orders", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000" },
            ...Array.from({ length: 6 }, (_, i) => ({
              spanId: `q${i}`,
              parentSpanId: "r",
              name: "SELECT",
              startTimeUnixNano: String(1700000000010000000n + BigInt(i) * 5000000n),
              endTimeUnixNano: String(1700000000020000000n + BigInt(i) * 5000000n),
              attributes: [
                { key: "db.system.name", value: { stringValue: "postgresql" } },
                { key: "db.query.text", value: { stringValue: `SELECT * FROM items WHERE order_id = $1` } },
                ...(i === 0 ? [] : [{ key: "db.query.parameter.1", value: { stringValue: String(i) } }]),
              ],
            })),
            { spanId: "x", parentSpanId: "missing", name: "orphan", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000001000000" },
          ],
        },
      ],
    },
  ],
};

describe("trace import", () => {
  it("parses OTLP/JSON and finds repeated query shapes", () => {
    const t = parseTrace(JSON.stringify(otlp));
    expect(t.spans).toHaveLength(8);
    expect(t.orphans).toEqual(["x"]);
    const g = groupQueries(t);
    expect(g[0].spans).toHaveLength(6);
    expect(g[0].repeatedUnder).toEqual({ parent: "r", count: 6 });
    expect(normalize("SELECT * FROM t WHERE id IN (1, 2, 3) AND s = 'x'")).toBe("SELECT * FROM t WHERE id IN (?…) AND s = ?");
  });

  it("doesn't add up overlapping spans, and won't replay without parameters", () => {
    const t = parseTrace(JSON.stringify(otlp));
    const db = t.spans.filter((s) => s.db);
    const c = coverage(db);
    expect(c.sumMs).toBeCloseTo(60);
    expect(c.unionMs).toBeCloseTo(35);
    expect(replayable(db[0])).toEqual({ ok: false, missing: ["1"] });
    expect(replayable(db[1]).ok).toBe(true);
  });

  it("rejects files with no spans", () => {
    expect(() => parseTrace("{}")).toThrow(/No spans/);
  });
});
