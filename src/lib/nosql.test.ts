import { describe, expect, it } from "vitest";
import { findCollection, updateFor } from "./nosql";

describe("document edits", () => {
  it("knows which collection a find reads", () => {
    expect(findCollection("db.users.find({}).limit(100)")).toBe("users");
    expect(findCollection('db.getCollection("weird-name").find({})')).toBe("weird-name");
    expect(findCollection("db['a.b'].findOne({})")).toBe("a.b");
    expect(findCollection("db.users.aggregate([])")).toBeNull();
  });

  it("sets and unsets only changed top-level fields", () => {
    const before = { _id: { $oid: "65f1" }, name: "Ann", plan: "pro", n: { $numberLong: "5" }, old: 1 };
    const after = { _id: { $oid: "65f1" }, name: "Ann B", plan: "pro", n: { $numberLong: "5" }, extra: [1] };
    expect(updateFor(before, after)).toBe('{ "$set": {"name":"Ann B","extra":[1]}, "$unset": {"old":""} }');
    expect(updateFor(before, before)).toBeNull();
  });
});
