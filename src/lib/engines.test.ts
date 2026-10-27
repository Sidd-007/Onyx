import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "./connectionUrl";
import { defaultSchemaOf } from "./ipc";
import { mongoFind, redisArg, redisReadCommand } from "./nosql";
import { pageSql } from "./sqlGen";
import { quoteIdent, splitStatements, statementAt } from "./sqlSplit";
import { beginSql, transactionEffect } from "./transactions";

describe("engines beyond Postgres and MySQL", () => {
  it("quotes and splits SQL Server and ClickHouse", () => {
    expect(quoteIdent("order", "sqlserver")).toBe("[order]");
    expect(quoteIdent("a]b", "sqlserver")).toBe("[a]]b]");
    expect(quoteIdent("x", "clickhouse")).toBe("`x`");
    expect(splitStatements("SELECT [a;b] FROM t; SELECT 2", "sqlserver").map((s) => s.text)).toEqual(["SELECT [a;b] FROM t", "SELECT 2"]);
    expect(splitStatements("SELECT 'it\\'s;' ; SELECT 2", "clickhouse")).toHaveLength(2);
  });

  it("finds the Redis line and the Mongo block under the cursor", () => {
    const redis = "GET a\nHGETALL user:1\n";
    expect(statementAt(redis, 8, "redis")?.text).toBe("HGETALL user:1");
    const mongo = "db.users.find({})\n\n// paid orders\ndb.orders\n  .find({ status: 'paid' })\n  .limit(5)\n\n// only a comment";
    expect(statementAt(mongo, 40, "mongodb")?.text).toBe("// paid orders\ndb.orders\n  .find({ status: 'paid' })\n  .limit(5)");
    expect(statementAt(mongo, mongo.length, "mongodb")?.text).toContain("db.orders");
  });

  it("opens keys and collections with the right command", () => {
    expect(redisArg("user:1")).toBe("user:1");
    expect(redisArg('my "key"')).toBe('"my \\"key\\""');
    expect(redisReadCommand("cart:9", "hash")).toBe("HGETALL cart:9");
    expect(redisReadCommand("q", "list")).toBe("LRANGE q 0 99");
    expect(mongoFind("users")).toBe("db.users.find({}).limit(100)");
    expect(mongoFind("weird-name")).toBe('db.getCollection("weird-name").find({}).limit(100)');
  });

  it("pages, transactions and default schemas per engine", () => {
    expect(pageSql("sqlserver", "SELECT * FROM [dbo].[t]", false, 100, 200)).toBe(
      "SELECT * FROM [dbo].[t] ORDER BY (SELECT NULL) OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY",
    );
    expect(pageSql("clickhouse", "SELECT * FROM t", false, 10, 0)).toBe("SELECT * FROM t LIMIT 10 OFFSET 0");
    expect(beginSql("sqlserver")).toBe("BEGIN TRANSACTION");
    expect(transactionEffect("BEGIN\n  SELECT 1\nEND", "sqlserver")).toBe(null);
    expect(transactionEffect("BEGIN TRAN; UPDATE t SET a = 1", "sqlserver")).toBe("begin");
    expect(defaultSchemaOf({ engine: "sqlserver", database: "app" })).toBe("dbo");
    expect(defaultSchemaOf({ engine: "redis", database: "2" })).toBe("db2");
    expect(defaultSchemaOf({ engine: "mongodb", database: "" })).toBe("test");
  });

  it("reads Atlas, Redis and SQL Server URLs", () => {
    const atlas = parseConnectionUrl("mongodb+srv://ann:s3cret@cluster0.ab1cd.mongodb.net/shop?retryWrites=true");
    expect(atlas).toMatchObject({ engine: "mongodb", user: "ann", password: "s3cret", database: "shop", sslMode: "verify-full" });
    expect(atlas?.host).toBe("mongodb+srv://cluster0.ab1cd.mongodb.net/shop?retryWrites=true");
    expect(parseConnectionUrl("rediss://:pw@cache.example.com:6380/1")).toMatchObject({ engine: "redis", port: 6380, database: "1", sslMode: "require" });
    expect(parseConnectionUrl("sqlserver://sa:pw@db.local/app")).toMatchObject({ engine: "sqlserver", port: 1433, database: "app" });
  });
});
