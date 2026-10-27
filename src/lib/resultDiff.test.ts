import { describe, expect, it } from "vitest";
import { diffResults, suggestKey } from "./resultDiff";

const before = {
  columns: ["id", "name", "n"],
  rows: [
    ["1", "a", "10"],
    ["2", "b", "20"],
    ["3", "c", null],
  ],
};
const after = {
  columns: ["id", "n", "name", "extra"],
  rows: [
    ["1", "10", "a", "x"],
    ["2", "21", "b", "x"],
    ["4", "40", "d", "x"],
  ],
};

describe("result diff", () => {
  it("matches rows by key and finds changed cells", () => {
    const d = diffResults(before, after, "id");
    expect(d.columns).toEqual(["id", "n", "name"]);
    expect([d.added, d.removed, d.changed, d.same]).toEqual([1, 1, 1, 1]);
    const changed = d.rows.find((r) => r.kind === "changed");
    expect(changed && changed.kind === "changed" && [...changed.changed]).toEqual([1]);
  });

  it("compares whole rows without a key, counting repeats", () => {
    const d = diffResults(
      { columns: ["x"], rows: [["1"], ["1"], ["2"]] },
      { columns: ["x"], rows: [["1"], ["3"]] },
      null,
    );
    expect([d.added, d.removed, d.same]).toEqual([1, 2, 1]);
  });
});

describe("suggestKey", () => {
  it("picks a unique, non-null identifier both results share", () => {
    const before = { columns: ["status", "user_id", "id"], rows: [["a", "1", "10"], ["a", "1", "11"]] };
    const after = { columns: ["id", "status", "user_id"], rows: [["10", "b", "1"], ["12", "a", "2"]] };
    expect(suggestKey(before, after)).toBe("id");
    expect(suggestKey({ columns: ["x"], rows: [["1"], ["1"]] }, { columns: ["x"], rows: [["1"]] })).toBeNull();
  });
});

describe("keys that can't identify rows", () => {
  it("refuses a repeated key instead of pairing the wrong rows", () => {
    const before = { columns: ["id", "v"], rows: [["1", "b"], ["1", "x"]] };
    const after = { columns: ["id", "v"], rows: [["1", "a"], ["1", "c"]] };
    const d = diffResults(before, after, "id");
    expect(d.keyProblem).toMatch(/id isn't unique in the pinned result \(2 rows have id = 1\)/);
    expect(d.changed).toBe(0);
    expect(d.rows.map((r) => r.kind).sort()).toEqual(["added", "added", "removed", "removed"]);
  });

  it("refuses NULL keys, and never matches NULL to the text 'null'", () => {
    const d = diffResults({ columns: ["id"], rows: [[null]] }, { columns: ["id"], rows: [["null"]] }, "id");
    expect(d.keyProblem).toMatch(/NULL in 1 row/);
    expect(d.added + d.removed).toBe(2);
  });
});
