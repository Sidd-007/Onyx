import { describe, expect, it } from "vitest";
import { interleaved, parseSchedule, runSchedule, type Exec, type Lane } from "./race";

describe("race lab", () => {
  it("validates schedules", () => {
    const lanes = { A: ["BEGIN", "COMMIT"], B: ["BEGIN"] };
    expect(interleaved(lanes)).toBe("A1 B1 A2");
    expect(parseSchedule("a1 b1 A2", lanes).map((s) => s.id)).toEqual(["A1", "B1", "A2"]);
    expect(() => parseSchedule("A2 A1", lanes)).toThrow(/in order/);
    expect(() => parseSchedule("B2", lanes)).toThrow(/doesn't exist/);
  });

  it("moves on past a step that waits for a lock, and finishes it later", async () => {
    // B2 waits until A2 (the commit) runs, like a row lock.
    let release = () => {};
    const lock = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const exec: Exec = async (lane: Lane, sql: string) => {
      order.push(`${lane}:${sql}`);
      if (lane === "B" && sql === "update") await lock;
      if (lane === "A" && sql === "commit") release();
      return { columns: [], rows: [] };
    };
    const lanes = { A: ["update", "commit"], B: ["update"] };
    const out = await runSchedule(exec, parseSchedule("A1 B1 A2", lanes), lanes, 30);
    expect(out.map((o) => [o.id, o.status, o.blocked])).toEqual([
      ["A1", "done", false],
      ["B1", "done", true],
      ["A2", "done", false],
    ]);
    expect(order).toEqual(["A:update", "B:update", "A:commit"]);
  });

  it("reports errors and keeps going", async () => {
    const exec: Exec = async (_lane, sql) => {
      if (sql === "bad") throw { message: "deadlock detected" };
      return { columns: ["v"], rows: [["1"]] };
    };
    const lanes = { A: ["bad", "after"], B: [] };
    const out = await runSchedule(exec, parseSchedule("A1 A2", lanes), lanes, 30);
    expect(out[0]).toMatchObject({ status: "error", error: "deadlock detected" });
    expect(out[1].status).toBe("done");
  });
});
