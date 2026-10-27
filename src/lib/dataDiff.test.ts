import { describe, expect, it } from "vitest";
import { diffRows, syncSql } from "./dataDiff";

describe("data compare", () => {
  const source = { columns: ["id", "name", "plan"], rows: [["1", "Ann", "pro"], ["2", "Bo", "free"], ["3", "Cy", null]] };
  const target = { columns: ["id", "plan", "name", "extra"], rows: [["1", "pro", "Ann", "x"], ["2", "pro", "Bo", "y"], ["9", "free", "Zed", "z"]] };

  it("finds added, changed and removed rows by key", () => {
    const d = diffRows(source, target, ["id"]);
    expect(d.columns).toEqual(["id", "name", "plan"]);
    expect(d.added).toEqual([["3", "Cy", null]]);
    expect(d.removed).toEqual([["9", "Zed", "free"]]);
    expect(d.changed).toEqual([{ key: ["2"], source: ["2", "Bo", "free"], target: ["2", "Bo", "pro"], changed: [2] }]);
    expect(d.same).toBe(1);
    expect(() => diffRows(source, target, ["missing"])).toThrow(/key column/);
  });

  it("writes SQL that makes the target match", () => {
    const sql = syncSql(diffRows(source, target, ["id"]), "mysql", "shop", "users", { deletes: true });
    expect(sql.split("\n")).toEqual([
      "INSERT INTO `shop`.`users` (`id`, `name`, `plan`) VALUES ('3', 'Cy', NULL);",
      "UPDATE `shop`.`users` SET `plan` = 'free' WHERE `id` = '2';",
      "DELETE FROM `shop`.`users` WHERE `id` = '9';",
    ]);
    expect(syncSql(diffRows(source, target, ["id"]), "postgres", "s", "t", { deletes: false })).not.toContain("DELETE");
  });
});
