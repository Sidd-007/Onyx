import { describe, expect, it } from "vitest";
import { executeSql, parseParams, prepareSql, readPlan, sameMultiset, stats, verdict } from "./perf";

describe("performance experiments", () => {
  it("prepares with typed parameters", () => {
    const p = parseParams("int, text", "42 | paid\n7 | NULL");
    expect(prepareSql("onyx_b", p.types, "SELECT * FROM orders WHERE customer_id = $1 AND status = $2;")).toBe("PREPARE onyx_b(int, text) AS SELECT * FROM orders WHERE customer_id = $1 AND status = $2");
    expect(executeSql("onyx_b", p.sets[1])).toBe("EXECUTE onyx_b('7', NULL)");
    expect(() => parseParams("int", "1 | 2")).toThrow(/has 2 values/);
  });

  it("never recommends a faster query that answers differently", () => {
    const fast = stats([1, 1.1, 1.2, 1.1, 1]);
    const slow = stats([10, 11, 12, 10, 11]);
    expect(verdict(slow, fast, true).kind).toBe("faster");
    expect(verdict(slow, fast, false).kind).toBe("different-results");
    expect(verdict(stats([5, 6, 7]), stats([5.5, 6, 6.5]), true).kind).toBe("no-clear-difference");
    expect(verdict(stats([1]), stats([2]), true).text).toMatch(/Too few runs/);
  });

  it("compares results as multisets and reads plans", () => {
    expect(sameMultiset([["1"], ["2"], ["2"]], [["2"], ["1"], ["2"]]).same).toBe(true);
    expect(sameMultiset([["1"], ["2"]], [["1"], ["1"]])).toEqual({ same: false, onlyA: 1, onlyB: 1 });
    const plan = readPlan(JSON.stringify([{ Plan: { "Node Type": "Index Scan", "Relation Name": "orders", "Index Name": "o_idx", "Total Cost": 8.3, Plans: [] }, "Planning Time": 0.1, "Execution Time": 0.5 }]));
    expect(plan).toEqual({ planningMs: 0.1, executionMs: 0.5, cost: 8.3, nodes: ["Index Scan on orders using o_idx"] });
  });
});
