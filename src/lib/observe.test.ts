import { describe, expect, it } from "vitest";
import { changed, compareSnapshots, type Selector } from "./observe";

describe("before/after observation", () => {
  it("shows a parent update, a new child and a deleted child", () => {
    const sel: Selector[] = [
      { id: "o", connectionId: "c", label: "order", sql: "", key: "id" },
      { id: "i", connectionId: "c", label: "items", sql: "", key: "id" },
    ];
    const before = { at: 0, results: { o: { columns: ["id", "status"], rows: [["7", "pending"]], truncated: false }, i: { columns: ["id", "sku"], rows: [["1", "a"], ["2", "b"]], truncated: false } } };
    const after = { at: 1, results: { o: { columns: ["id", "status"], rows: [["7", "paid"]], truncated: false }, i: { columns: ["id", "sku"], rows: [["1", "a"], ["3", "c"]], truncated: false } } };
    const c = compareSnapshots(sel, before, after);
    expect(c[0].diff?.changed).toBe(1);
    expect([c[1].diff?.added, c[1].diff?.removed]).toEqual([1, 1]);
    expect(changed(c)).toBe(true);
    expect(compareSnapshots(sel, before, { at: 2, results: { o: { error: "boom" } } })[0].error).toBe("boom");
  });
});
