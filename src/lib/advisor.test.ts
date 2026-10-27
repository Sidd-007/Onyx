import { describe, expect, it } from "vitest";
import { filterColumns, isRead, mysqlScans, postgresScans, suggest } from "./advisor";

describe("index advisor", () => {
  it("reads Postgres filters", () => {
    expect(filterColumns("((status = 'paid = x'::text) AND (user_id = 4))")).toEqual(["status", "user_id"]);
    // VERBOSE plans qualify names.
    expect(filterColumns("((orders.status = 'paid'::text) AND (\"o\".\"userId\" = 4))")).toEqual(["status", "userId"]);
    expect(filterColumns('(("createdAt" >= now()) OR (email ~~ \'%@x%\'::text))')).toEqual(["createdAt", "email"]);
  });

  it("finds full scans and suggests indexes", () => {
    const pg = [{ Plan: { "Node Type": "Hash Join", Plans: [
      { "Node Type": "Seq Scan", "Relation Name": "orders", Schema: "shop", Filter: "(status = 'paid'::text)", "Plan Rows": 1000, "Rows Removed by Filter": 119000 },
      { "Node Type": "Index Scan", "Relation Name": "users" },
    ] } }];
    const scans = postgresScans(pg);
    expect(scans).toEqual([{ schema: "shop", table: "orders", columns: ["status"], rows: 120000 }]);
    const s = suggest("postgres", [{ sql: "q1", scans }, { sql: "q2", scans }], () => []);
    expect(s).toHaveLength(1);
    expect(s[0].sql).toBe("CREATE INDEX CONCURRENTLY idx_orders_status ON shop.orders (status);");
    expect(s[0].queries).toEqual(["q1", "q2"]);
    // Already indexed: nothing.
    expect(suggest("postgres", [{ sql: "q1", scans }], () => [["status", "id"]])).toEqual([]);
  });

  it("reads MySQL plans", () => {
    const plan = { query_block: { nested_loop: [{ table: { table_name: "orders", access_type: "ALL", rows_examined_per_scan: 50000, attached_condition: "((`shop`.`orders`.`status` = 'paid') and (`shop`.`orders`.`total` > 10))" } }] } };
    expect(mysqlScans(plan)).toEqual([{ schema: null, table: "orders", columns: ["status", "total"], rows: 50000 }]);
  });

  it("explains only single reads", () => {
    expect(isRead("-- hi\nSELECT 1")).toBe(true);
    expect(isRead("WITH x AS (SELECT 1) SELECT * FROM x;")).toBe(true);
    expect(isRead("UPDATE t SET a = 1")).toBe(false);
    expect(isRead("SELECT 1; DELETE FROM t")).toBe(false);
  });
});
