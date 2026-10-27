import { describe, expect, it } from "vitest";
import { connectionLost, readOnly } from "./transactions";

describe("lost connections", () => {
  it("tells a dropped connection from a SQL error", () => {
    expect(connectionLost("This tab's connection to the server was lost, so the server rolled back anything it hadn't committed.")).toBe(true);
    expect(connectionLost("Lost connection to MySQL server during query")).toBe(true);
    expect(connectionLost("MySQL server has gone away")).toBe(true);
    expect(connectionLost('relation "users" does not exist')).toBe(false);
    expect(connectionLost("duplicate key value violates unique constraint")).toBe(false);
    expect(readOnly("-- check\nSELECT 1")).toBe(true);
    expect(readOnly("UPDATE t SET a = 1")).toBe(false);
  });
});

describe("writtenTables", () => {
  it("finds the tables a script writes to", async () => {
    const { writtenTables } = await import("./transactions");
    expect(writtenTables(`UPDATE shop.orders SET status = 'update x' WHERE id = 1; -- delete from nope\nINSERT INTO "Audit Log" VALUES (1); DELETE FROM \`items\` WHERE 1; SELECT * FROM users`)).toEqual([
      "shop.orders",
      "Audit Log",
      "items",
    ]);
  });
});
