import { describe, expect, it } from "vitest";
import { compare, conclude, keyFor, type CacheMapping } from "./cacheCheck";

const m: CacheMapping = { name: "user", sql: "", keyTemplate: "user:{id}", format: "json", fields: [{ column: "plan", field: "plan.code", compare: "text" }, { column: "balance", field: "balance", compare: "number" }], versionColumn: "version", versionField: "v", windowMs: 2000 };
const row = { plan: "pro", balance: "10.50", version: "18" };

describe("cache consistency", () => {
  it("compares mapped fields and versions", () => {
    expect(keyFor("user:{id}", "42")).toBe("user:42");
    const v = compare(m, row, { state: "value", raw: '{"plan":{"code":"free"},"balance":10.5,"v":17}', ttlMs: 1000, at: 1 });
    expect(v.state).toBe("differ");
    expect(v.fields.map((f) => f.status)).toEqual(["different", "same"]);
    expect(v.version).toEqual({ db: "18", cache: "17", relation: "db-newer" });
  });

  it("keeps missing, null, expired and undecodable apart", () => {
    expect(compare(m, row, { state: "value", raw: '{"balance":null}', ttlMs: null, at: 1 }).fields.map((f) => f.status)).toEqual(["missing-field", "different"]);
    expect(compare(m, row, { state: "expired-between-reads", at: 1 }).state).toBe("no-cache-entry");
    expect(compare(m, row, { state: "value", raw: "{not json", ttlMs: null, at: 1 }).state).toBe("decode-error");
    expect(compare(m, null, { state: "absent", at: 1 }).state).toBe("no-db-row");
  });

  it("tells a passing delay from a stale cache", () => {
    const differ = compare(m, row, { state: "value", raw: '{"plan":{"code":"free"},"balance":10.5}', ttlMs: null, at: 1 });
    const agree = compare(m, row, { state: "value", raw: '{"plan":{"code":"pro"},"balance":10.5}', ttlMs: null, at: 1 });
    expect(conclude([{ dbAt: 0, cacheAt: 0, verdict: differ }, { dbAt: 500, cacheAt: 500, verdict: agree }], 2000).kind).toBe("converged");
    expect(conclude([{ dbAt: 0, cacheAt: 0, verdict: differ }, { dbAt: 2100, cacheAt: 2100, verdict: differ }], 2000).kind).toBe("persistent");
    expect(conclude([{ dbAt: 0, cacheAt: 0, verdict: differ }], 2000).kind).toBe("inconclusive");
    // A key that never exists is reported as missing, never as stale.
    const absent = { state: "no-cache-entry" as const, fields: [], version: null };
    const missing = conclude([{ dbAt: 0, cacheAt: 0, verdict: absent }, { dbAt: 600, cacheAt: 600, verdict: absent }], 500);
    expect(missing.kind).toBe("missing");
    expect(missing.text).not.toMatch(/looks stale/);
  });
});
