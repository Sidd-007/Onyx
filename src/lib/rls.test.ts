import { describe, expect, it } from "vitest";
import { asIdentity, classify, passes, policyApplies, readEvidence } from "./rls";

const ev = (over: Record<string, string>) => {
  const cols = ["role", "can_select", "superuser", "bypass_rls", "acts_as_owner", "rls_enabled", "rls_forced", "onyx_can_become"];
  const base: Record<string, string> = { role: "app", can_select: "t", superuser: "f", bypass_rls: "f", acts_as_owner: "f", rls_enabled: "t", rls_forced: "f", onyx_can_become: "t", ...over };
  return readEvidence(cols, cols.map((c) => base[c]));
};

describe("permissions debugger", () => {
  it("knows when policies don't apply", () => {
    expect(policyApplies(ev({})).applies).toBe(true);
    expect(policyApplies(ev({ superuser: "t" })).why).toMatch(/superuser/);
    expect(policyApplies(ev({ acts_as_owner: "t" })).applies).toBe(false);
    expect(policyApplies(ev({ acts_as_owner: "t", rls_forced: "t" })).applies).toBe(true);
  });

  it("tells a missing grant from zero visible rows", () => {
    const denied = classify("permission denied for table orders", null);
    expect(denied.kind).toBe("no-privilege");
    expect(passes({ kind: "deny-rows", n: 0 }, denied)).toBe(false);
    expect(passes({ kind: "deny-privilege", n: 0 }, denied)).toBe(true);
    expect(passes({ kind: "deny-rows", n: 0 }, classify(null, 0))).toBe(true);
    expect(passes({ kind: "allow", n: 1 }, classify(null, 3))).toBe(true);
  });

  it("acts as an identity with claims, transaction-scoped", () => {
    expect(asIdentity("authenticated", '{"sub":"u1","role":"authenticated"}')).toEqual([
      "BEGIN",
      "SET LOCAL ROLE authenticated",
      `SELECT set_config('request.jwt.claims', '{"sub":"u1","role":"authenticated"}', true)`,
      "SELECT set_config('request.jwt.claim.sub', 'u1', true)",
      "SELECT set_config('request.jwt.claim.role', 'authenticated', true)",
    ]);
    expect(() => asIdentity("x", "not json")).toThrow(/JSON object/);
  });
});
