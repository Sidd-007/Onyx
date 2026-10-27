import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "./connectionUrl";

describe("parseConnectionUrl", () => {
  it("reads Postgres URLs", () => {
    expect(parseConnectionUrl("postgresql://app:s3cret@db.example.com:6543/shop?sslmode=require")).toEqual({
      engine: "postgres",
      host: "db.example.com",
      port: 6543,
      user: "app",
      password: "s3cret",
      database: "shop",
      sslMode: "require",
    });
  });

  it("reads MySQL URLs with MySQL's ssl-mode names and defaults", () => {
    expect(
      parseConnectionUrl("mysql://admin:p%40ss@db.example.eu-west-1.rds.amazonaws.com/shop?ssl-mode=VERIFY_IDENTITY"),
    ).toEqual({
      engine: "mysql",
      host: "db.example.eu-west-1.rds.amazonaws.com",
      port: 3306,
      user: "admin",
      password: "p@ss",
      database: "shop",
      sslMode: "verify-full",
    });
    expect(parseConnectionUrl("mysql://root@localhost")?.database).toBe("");
  });

  it("ignores text that isn't a database URL", () => {
    expect(parseConnectionUrl("db.example.com")).toBeNull();
    expect(parseConnectionUrl("https://example.com")).toBeNull();
  });
});
