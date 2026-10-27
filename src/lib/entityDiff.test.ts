import { describe, expect, it } from "vitest";
import { collectionEqual, diffCollection, diffFields, suggestBusinessKey } from "./entityDiff";

const subs = (rows: (string | null)[][]) => ({ columns: ["id", "customer_id", "plan_code", "status"], rows });
const ignored = new Set(["id", "customer_id"]);

describe("entity comparison", () => {
  it("matches related rows by business key, not ids", () => {
    const working = subs([["10", "1", "pro", "active"], ["11", "1", "addon", "active"]]);
    const failing = subs([["90", "2", "pro", "past_due"]]);
    expect(suggestBusinessKey(working, failing, ignored)).toBe("plan_code");
    const d = diffCollection("subscriptions", "subscriptions", working, failing, 200, "plan_code", ignored);
    expect(d.changed).toEqual([{ key: "pro", fields: [{ column: "status", working: "active", failing: "past_due" }] }]);
    expect(d.onlyWorking.map((r) => r[2])).toEqual(["addon"]);
    expect(collectionEqual(d)).toBe(false);
  });

  it("won't pair by a repeated key, and never calls a capped collection equal", () => {
    const dup = subs([["1", "1", "pro", "a"], ["2", "1", "pro", "b"]]);
    expect(diffCollection("s", "s", dup, subs([["3", "2", "pro", "a"]]), 200, "plan_code", ignored).ambiguity).toMatch(/isn't unique/);
    const same = subs([["1", "1", "pro", "a"]]);
    expect(collectionEqual(diffCollection("s", "s", same, subs([["9", "2", "pro", "a"]]), 1, "plan_code", ignored))).toBe(false);
    expect(collectionEqual(diffCollection("s", "s", same, subs([["9", "2", "pro", "a"]]), 200, "plan_code", ignored))).toBe(true);
  });

  it("compares JSON by meaning", () => {
    expect(diffFields(["s"], ['{"a":1,"b":2}'], ['{"b":2,"a":1.0}'], new Set())).toEqual([]);
    expect(diffFields(["s"], ['{"a":1}'], ['{"a":2}'], new Set())[0].json).toEqual(["changed a"]);
  });
});
