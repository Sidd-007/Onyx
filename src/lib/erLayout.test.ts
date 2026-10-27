import { describe, expect, it } from "vitest";
import { boxHeight, layout } from "./erLayout";

describe("ER layout", () => {
  it("puts referenced tables to the left", () => {
    const boxes = layout([
      { name: "items", columns: 3, refs: ["orders", "products"] },
      { name: "orders", columns: 4, refs: ["users"] },
      { name: "users", columns: 5, refs: [] },
      { name: "products", columns: 2, refs: [] },
    ]);
    expect(boxes.get("users")!.x).toBe(0);
    expect(boxes.get("products")!.x).toBe(0);
    expect(boxes.get("orders")!.x).toBeGreaterThan(0);
    expect(boxes.get("items")!.x).toBeGreaterThan(boxes.get("orders")!.x);
  });

  it("survives cycles and self references", () => {
    const boxes = layout([
      { name: "a", columns: 1, refs: ["b", "a"] },
      { name: "b", columns: 1, refs: ["a"] },
    ]);
    expect(boxes.size).toBe(2);
  });

  it("caps tall tables", () => {
    expect(boxHeight(100)).toBe(boxHeight(14) + 20);
  });
});

describe("ER layout of big schemas", () => {
  it("keeps a schema without foreign keys roughly screen-shaped", () => {
    const tables = Array.from({ length: 233 }, (_, i) => ({ name: `t${String(i).padStart(3, "0")}`, columns: 5 + (i % 20), refs: [] }));
    const boxes = [...layout(tables).values()];
    const w = Math.max(...boxes.map((b) => b.x + b.w));
    const h = Math.max(...boxes.map((b) => b.y + b.h));
    expect(w / h).toBeGreaterThan(0.9);
    expect(w / h).toBeLessThan(3);
  });

  it("wraps a tall layer and keeps groups apart from loose tables", () => {
    const tables = [
      ...Array.from({ length: 40 }, (_, i) => ({ name: `child${i}`, columns: 6, refs: ["users"] })),
      { name: "users", columns: 6, refs: [] },
      { name: "loose", columns: 3, refs: [] },
    ];
    const boxes = layout(tables);
    const childXs = new Set(Array.from({ length: 40 }, (_, i) => boxes.get(`child${i}`)!.x));
    expect(childXs.size).toBeGreaterThan(1);
    expect(Math.min(...childXs)).toBeGreaterThan(boxes.get("users")!.x);
    // No overlaps.
    const all = [...boxes.values()];
    for (const a of all) for (const b of all) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });
});
