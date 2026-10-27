import { describe, expect, it } from "vitest";
import type { RowEdit } from "./ipc";
import { resolve, type FieldState } from "./merge";

const key = [{ column: "id", value: "1" }];
const update: RowEdit = { kind: "update", key, set: [{ column: "status", value: "cancelled" }, { column: "name", value: "Anne" }], original: [{ column: "status", value: "new" }, { column: "name", value: "Ann" }] };
const clash: FieldState = { edit: 0, key, column: "status", base: "new", mine: "cancelled", theirs: "paid", converged: false, deleted: false };

describe("three-way resolve", () => {
  it("keeps mine by expecting theirs, or drops my field for theirs", () => {
    const mine = resolve([update], [clash], { "0:status": "mine" })[0] as Extract<RowEdit, { kind: "update" }>;
    expect(mine.original?.find((c) => c.column === "status")?.value).toBe("paid");
    expect(mine.set.map((c) => c.column)).toEqual(["status", "name"]);
    const theirs = resolve([update], [clash], { "0:status": "theirs" })[0] as Extract<RowEdit, { kind: "update" }>;
    expect(theirs.set.map((c) => c.column)).toEqual(["name"]);
  });

  it("needs no write for converged fields and never recreates deleted rows", () => {
    const converged = resolve([update], [{ ...clash, theirs: "cancelled", converged: true }], {});
    expect((converged[0] as Extract<RowEdit, { kind: "update" }>).set.map((c) => c.column)).toEqual(["name"]);
    expect(resolve([update], [{ ...clash, column: "", deleted: true }], {})).toEqual([]);
  });
});
