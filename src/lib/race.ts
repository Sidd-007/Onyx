/**
 * F13: a race-condition lab. SQL steps in two transaction lanes run in an explicit order on
 * two dedicated sessions. A step that waits on a lock is shown as blocked while the schedule
 * moves on to the other lane, exactly like PostgreSQL's isolation tester.
 */

export type Lane = "A" | "B";

export interface Step {
  lane: Lane;
  sql: string;
}

export interface RaceSpec {
  setup: string;
  /** Optional: a query whose single value must equal `fixtureExpect` after setup (verifies the reset). */
  fixtureCheck: string;
  fixtureExpect: string;
  lanes: Record<Lane, string[]>;
  /** Step ids in order, e.g. "A1 A2 B1 B2 A3 B3 A4 B4". */
  schedule: string;
  assertion: string;
  expect: string;
  teardown: string;
  isolation: "read committed" | "repeatable read" | "serializable";
}

export interface StepOutcome {
  id: string;
  sql: string;
  status: "done" | "error" | "waiting" | "skipped";
  /** It didn't finish at once: it waited (for a lock) before finishing. */
  blocked: boolean;
  waitedMs: number;
  rows?: (string | null)[][];
  columns?: string[];
  error?: string;
}

export interface RaceRun {
  at: number;
  fixture: "verified" | "not checked" | { failed: string };
  steps: StepOutcome[];
  assertion: { actual: string | null; expected: string; passed: boolean } | { error: string } | null;
  cleanup: string[];
}

export type Exec = (lane: Lane, sql: string) => Promise<{ columns: string[]; rows: (string | null)[][] }>;

/** "A1 B1 A2" → ordered [lane, index]; validated against the lanes. */
export function parseSchedule(schedule: string, lanes: Record<Lane, string[]>): { lane: Lane; index: number; id: string }[] {
  const out = schedule
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => {
      const m = /^([AB])(\d+)$/i.exec(tok);
      if (!m) throw new Error(`"${tok}" isn't a step: write steps as A1, B2…`);
      const lane = m[1].toUpperCase() as Lane;
      const index = Number(m[2]) - 1;
      if (!lanes[lane][index]?.trim()) throw new Error(`${lane}${index + 1} doesn't exist`);
      return { lane, index, id: `${lane}${index + 1}` };
    });
  for (const lane of ["A", "B"] as Lane[]) {
    const order = out.filter((s) => s.lane === lane).map((s) => s.index);
    if (order.some((v, i) => v !== i)) throw new Error(`Lane ${lane}'s steps must run in order (${lane}1, ${lane}2, …) and each once`);
  }
  return out;
}

/** The default schedule: every step of each lane, alternating. */
export function interleaved(lanes: Record<Lane, string[]>): string {
  const a = lanes.A.filter((s) => s.trim()).length;
  const b = lanes.B.filter((s) => s.trim()).length;
  const out: string[] = [];
  for (let i = 0; i < Math.max(a, b); i++) {
    if (i < a) out.push(`A${i + 1}`);
    if (i < b) out.push(`B${i + 1}`);
  }
  return out.join(" ");
}

/**
 * Runs the schedule. A step that hasn't finished after `settleMs` is marked waiting and the
 * next scheduled step (of the other lane) starts; a lane never starts a step before its
 * previous one finished. After an error the lane's transaction is aborted: its later steps
 * still run and report what the server says.
 */
export async function runSchedule(exec: Exec, steps: { lane: Lane; index: number; id: string }[], lanes: Record<Lane, string[]>, settleMs = 400, onChange?: (steps: StepOutcome[]) => void): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  const changed = () => onChange?.(outcomes.map((o) => ({ ...o })));
  const busy: Partial<Record<Lane, Promise<void>>> = {};
  for (const s of steps) {
    // The lane's previous step must finish first (it may be waiting on a lock the other lane holds).
    if (busy[s.lane]) await busy[s.lane];
    const sql = lanes[s.lane][s.index];
    const outcome: StepOutcome = { id: s.id, sql, status: "waiting", blocked: false, waitedMs: 0 };
    outcomes.push(outcome);
    changed();
    const started = performance.now();
    const done = exec(s.lane, sql).then(
      (r) => {
        outcome.status = "done";
        outcome.columns = r.columns;
        outcome.rows = r.rows;
      },
      (e: unknown) => {
        outcome.status = "error";
        outcome.error = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
      },
    ).finally(() => {
      outcome.waitedMs = Math.round(performance.now() - started);
      changed();
    });
    busy[s.lane] = done;
    const settled = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), settleMs))]);
    if (!settled) {
      outcome.blocked = true;
      changed();
    }
  }
  await Promise.all(Object.values(busy));
  return outcomes;
}

/** A starting point: the classic lost update (read, compute in the app, write back). */
export const LOST_UPDATE: RaceSpec = {
  setup: "CREATE TABLE IF NOT EXISTS onyx_race_accounts (id int PRIMARY KEY, balance int NOT NULL);\nTRUNCATE onyx_race_accounts;\nINSERT INTO onyx_race_accounts VALUES (1, 100);",
  fixtureCheck: "SELECT balance FROM onyx_race_accounts WHERE id = 1",
  fixtureExpect: "100",
  lanes: {
    A: ["BEGIN", "SELECT balance FROM onyx_race_accounts WHERE id = 1", "UPDATE onyx_race_accounts SET balance = 110 WHERE id = 1  -- app computed 100 + 10", "COMMIT"],
    B: ["BEGIN", "SELECT balance FROM onyx_race_accounts WHERE id = 1", "UPDATE onyx_race_accounts SET balance = 120 WHERE id = 1  -- app computed 100 + 20", "COMMIT"],
  },
  schedule: "A1 A2 B1 B2 A3 B3 A4 B4",
  assertion: "SELECT balance FROM onyx_race_accounts WHERE id = 1",
  expect: "130",
  teardown: "DROP TABLE IF EXISTS onyx_race_accounts;",
  isolation: "read committed",
};

/** The guarded version of the same writes (an atomic increment): replay the schedule against it. */
export const ATOMIC_FIX: Record<Lane, string[]> = {
  A: ["BEGIN", "SELECT balance FROM onyx_race_accounts WHERE id = 1", "UPDATE onyx_race_accounts SET balance = balance + 10 WHERE id = 1", "COMMIT"],
  B: ["BEGIN", "SELECT balance FROM onyx_race_accounts WHERE id = 1", "UPDATE onyx_race_accounts SET balance = balance + 20 WHERE id = 1", "COMMIT"],
};
