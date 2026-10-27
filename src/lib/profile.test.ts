import { describe, expect, it } from "vitest";
import { profile } from "./profile";

describe("column profile", () => {
  it("profiles numbers", () => {
    const p = profile(["1", "2", "2", "10", null, "4"], 3);
    expect(p).toMatchObject({ count: 6, nulls: 1, distinct: 4, kind: "number", min: "1", max: "10", median: 2 });
    expect(p.mean).toBeCloseTo(3.8);
    expect(p.top[0]).toEqual({ value: "2", count: 2 });
    expect(p.histogram?.map((b) => b.count)).toEqual([3, 1, 1]);
  });
  it("profiles dates and text", () => {
    expect(profile(["2026-10-02 10:00:00", "2026-10-01"]).kind).toBe("date");
    const t = profile(["ann", "", "bob", "ann"]);
    expect(t).toMatchObject({ kind: "text", empty: 1, distinct: 3, min: "ann", max: "bob", lengths: { min: 3, max: 3, mean: 3 } });
  });
});
