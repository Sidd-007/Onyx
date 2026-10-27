import { describe, expect, it } from "vitest";
import { exportInvestigation, newInvestigation, parseInvestigation, withEvidence } from "./investigation";

describe("investigations", () => {
  it("round-trips, tracks scope and redacts on export", () => {
    let inv = newInvestigation("Order 7 missing");
    inv = withEvidence(inv, { id: "e1", kind: "result", label: "orders", observedAt: 1, complete: false, limits: "first 100 rows", connection: { id: "c1", name: "Local", engine: "postgres", environment: "local" }, data: { rows: [["7", "secret@example.com"]] } });
    expect(inv.scope.connections.map((c) => c.id)).toEqual(["c1"]);
    expect(parseInvestigation(JSON.stringify(inv))).toEqual(inv);
    const redacted = exportInvestigation(inv, false);
    expect(redacted).not.toContain("secret@example.com");
    expect(redacted).toContain("first 100 rows; data left out of the export");
    expect(() => parseInvestigation(JSON.stringify({ ...inv, version: 99 }))).toThrow(/newer/);
  });
});
