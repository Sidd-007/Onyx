import { describe, expect, it } from "vitest";
import { migrationFiles, newVersion, scriptOf } from "./migrations";

describe("migrations", () => {
  it("pairs up and down files in order", () => {
    const files = migrationFiles(["migrations/2_b.up.sql", "migrations/10_c.up.sql", "migrations/2_b.down.sql", "migrations/old/1_x.up.sql", "other/3.up.sql", "migrations"]);
    expect(files).toEqual([
      { version: "2_b", up: "migrations/2_b.up.sql", down: "migrations/2_b.down.sql" },
      { version: "10_c", up: "migrations/10_c.up.sql", down: null },
    ]);
  });

  it("names and writes migrations", () => {
    expect(newVersion("Sync public → staging", new Date(2026, 9, 23, 14, 5, 1))).toBe("20261023140501_sync_public_staging");
    expect(scriptOf(["ALTER TABLE a ADD b int", "-- DROP TABLE c"])).toBe("ALTER TABLE a ADD b int;\n\n-- DROP TABLE c\n");
  });
});
