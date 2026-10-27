import { describe, expect, it } from "vitest";
import { explainSql, isReadQuery, parsePlan, slowest } from "./explain";
import { transactionEffect } from "./transactions";

describe("explain", () => {
  it("builds EXPLAIN per engine", () => {
    expect(explainSql("postgres", "select 1;", true)).toBe("EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) select 1");
    expect(explainSql("mysql", "select 1", false)).toBe("EXPLAIN FORMAT=TREE select 1");
    expect(explainSql("sqlite", "select 1", true)).toBe("EXPLAIN QUERY PLAN select 1");
    expect(isReadQuery("-- hi\nWITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(isReadQuery("DELETE FROM t")).toBe(false);
  });

  it("reads a Postgres ANALYZE plan with self times and warnings", () => {
    const json = JSON.stringify([
      {
        Plan: {
          "Node Type": "Hash Join",
          "Join Type": "Inner",
          "Total Cost": 100,
          "Plan Rows": 10,
          "Actual Rows": 500,
          "Actual Loops": 1,
          "Actual Total Time": 12,
          "Hash Cond": "(o.user_id = u.id)",
          Plans: [
            { "Node Type": "Seq Scan", "Relation Name": "orders", Alias: "o", "Plan Rows": 1000, "Actual Rows": 1000, "Actual Loops": 1, "Actual Total Time": 8 },
            { "Node Type": "Hash", "Actual Rows": 50, "Plan Rows": 50, "Actual Loops": 1, "Actual Total Time": 1, Plans: [] },
          ],
        },
        "Planning Time": 0.2,
        "Execution Time": 12.5,
      },
    ]);
    const plan = parsePlan("postgres", ["QUERY PLAN"], [[json]], true);
    const root = plan.nodes[0];
    expect(root.label).toBe("Inner Hash Join");
    expect(root.selfMs).toBe(3);
    expect(root.detail).toContain("Hash Cond: (o.user_id = u.id)");
    expect(root.warnings[0]).toMatch(/Estimated 10 rows, got 500/);
    expect(root.children[0].label).toBe("Seq Scan on orders o");
    expect(root.children[0].warnings[0]).toMatch(/Sequential scan/);
    expect(slowest(plan.nodes)?.label).toBe("Seq Scan on orders o");
    expect(plan.executionMs).toBe(12.5);
  });

  it("reads MySQL's tree format", () => {
    const text = [
      "-> Nested loop inner join  (cost=4.5 rows=10) (actual time=0.1..2.0 rows=12 loops=1)",
      "    -> Table scan on u  (cost=1.25 rows=10) (actual time=0.05..0.5 rows=10 loops=1)",
      "    -> Index lookup on o using user_id (user_id=u.id)  (cost=0.3 rows=1) (actual time=0.1..0.12 rows=1 loops=10)",
    ].join("\n");
    const plan = parsePlan("mysql", ["EXPLAIN"], [[text]], true);
    const root = plan.nodes[0];
    expect(root.label).toBe("Nested loop inner join");
    expect(root.children).toHaveLength(2);
    expect(root.children[0].warnings[0]).toMatch(/Full table scan/);
    expect(root.children[1].totalMs).toBeCloseTo(1.2);
    expect(root.selfMs).toBeCloseTo(0.3);
  });

  it("reads SQLite's query plan", () => {
    const plan = parsePlan("sqlite", ["id", "parent", "notused", "detail"], [
      ["2", "0", "0", "SCAN users"],
      ["5", "0", "0", "SEARCH orders USING INDEX orders_user (user_id=?)"],
      ["9", "0", "0", "USE TEMP B-TREE FOR ORDER BY"],
    ], false);
    expect(plan.nodes).toHaveLength(3);
    expect(plan.nodes[0].warnings).toHaveLength(1);
    expect(plan.nodes[1].warnings).toHaveLength(0);
  });
});


describe("transactions", () => {
  it("notices BEGIN and COMMIT in what ran", () => {
    expect(transactionEffect("BEGIN; UPDATE t SET x = 1", "postgres")).toBe("begin");
    expect(transactionEffect("update t set x = 1; commit;", "postgres")).toBe("end");
    expect(transactionEffect("start transaction", "mysql")).toBe("begin");
    expect(transactionEffect("ROLLBACK TO SAVEPOINT a", "postgres")).toBe(null);
    expect(transactionEffect("SELECT 'begin'", "postgres")).toBe(null);
  });
});

describe("plans that can't be drawn", () => {
  it("shows the raw plan with a reason instead of throwing", () => {
    const empty = parsePlan("postgres", ["QUERY PLAN"], [], false);
    expect(empty.problem).toMatch(/no plan/);
    const broken = parsePlan("postgres", ["QUERY PLAN"], [['[{"Plan": {"Node Type": "Aggre']], false);
    expect(broken.problem).toMatch(/couldn't draw/);
    expect(broken.text).toContain("Aggre");
    const ok = parsePlan("postgres", ["QUERY PLAN"], [['[{"Plan": {"Node Type": "Limit", "Plans": [{"Node Type": "GroupAggregate", "Group Key": ["bucket"]}]}}]']], false);
    expect(ok.problem).toBeUndefined();
    expect(ok.nodes[0].children[0].label).toBe("GroupAggregate");
    expect(ok.raw).toContain('"Node Type": "Limit"');
  });
});
