import { describe, expect, it } from "vitest";
import { POINTS, SPACING, STILL, WireModel, ropePath, type WireSpec } from "./wires";

const wire = (id: string, ay: number, by: number, endKey = "users:l:in"): WireSpec => ({ id, a: { x: 0, y: ay, dx: 1 }, b: { x: 400, y: by, dx: -1 }, startKey: `${id}:r`, endKey });

describe("bouncy wires", () => {
  it("stay pinned to their columns and hang below the straight line", () => {
    const m = new WireModel();
    m.sync([wire("a", 100, 100)]);
    m.settle();
    const p = m.points("a")!;
    expect([p[0], p[1]]).toEqual([0, 100]);
    expect([p[2 * POINTS - 2], p[2 * POINTS - 1]]).toEqual([400, 100]);
    expect(p[POINTS + 1]).toBeGreaterThan(100); // the middle sags
    expect([...p].every(Number.isFinite)).toBe(true);
    expect(ropePath(p)).toMatch(/^M0\.0,100\.0 Q/);
  });

  it("bundles wires into the same table into a ribbon near it, in the order of their columns", () => {
    const m = new WireModel();
    m.sync([wire("a", 0, 100), wire("b", 300, 112), wire("c", 600, 124)]);
    m.settle();
    const i = POINTS - 4;
    const y = (id: string) => m.points(id)![2 * i + 1];
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("b")).toBeLessThan(y("c"));
    // Close together near the shared table, far apart near their sources.
    expect(y("c") - y("a")).toBeLessThan(SPACING * 2 * 3);
    expect(m.points("c")![2 * 3 + 1] - m.points("a")![2 * 3 + 1]).toBeGreaterThan(200);
    expect(m.clips().length).toBeGreaterThan(0);
  });

  it("swings after a table moves, then comes to rest", () => {
    const m = new WireModel();
    m.sync([wire("a", 100, 100)]);
    m.settle();
    m.sync([{ ...wire("a", 100, 100), b: { x: 400, y: 260, dx: -1 } }]);
    expect(m.step()).toBeGreaterThan(STILL);
    m.settle(2000);
    expect(m.step()).toBeLessThan(STILL);
    m.sync([]);
    expect(m.points("a")).toBeUndefined();
  });
});
