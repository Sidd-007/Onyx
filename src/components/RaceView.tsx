import { CircleCheck, CircleX, FlaskConical, FolderSearch, Hourglass, Loader2, Play, Plus, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, toError } from "../lib/ipc";
import { ATOMIC_FIX, interleaved, LOST_UPDATE, parseSchedule, runSchedule, type Lane, type RaceRun, type RaceSpec } from "../lib/race";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

const LOCK_TIMEOUT = "5s";
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7).toString(16);

/**
 * F13: reproduce a race between two transactions with an explicit step order, check the
 * result, then replay the same order against a fix. Runs on two sessions of its own, only
 * on non-prod connections.
 */
export default function RaceView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [spec, setSpec] = useState<RaceSpec>(LOST_UPDATE);
  const [run, setRun] = useState<RaceRun | null>(null);
  /** The steps as they run (waiting ones show live). */
  const [live, setLive] = useState<RaceRun["steps"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = (s: "A" | "B" | "ctl") => `race:${s}:${tab.id}`;
  const close = () => Promise.all((["A", "B", "ctl"] as const).map((s) => api.closeTabSession(tab.connectionId, session(s)).catch(() => {})));
  useEffect(() => () => void close(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<RaceSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const setStep = (lane: Lane, i: number, sql: string) => set({ lanes: { ...spec.lanes, [lane]: spec.lanes[lane].map((x, j) => (j === i ? sql : x)) } });

  const go = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    setRun(null);
    const at = Date.now();
    const cleanup: string[] = [];
    try {
      const steps = parseSchedule(spec.schedule, spec.lanes);
      if (!(await useConnections.getState().connect(connection.id))) throw new Error("Not connected");
      await close();
      // Reset the fixture: teardown, then setup, then check it.
      for (const sql of [spec.teardown, spec.setup].filter((s) => s.trim())) {
        const failed = await executeStatement(connection.id, sql, session("ctl"), false);
        if (failed) throw new Error(`Fixture: ${failed.message}`);
      }
      let fixture: RaceRun["fixture"] = "not checked";
      if (spec.fixtureCheck.trim()) {
        const value = (await queryRows(connection.id, spec.fixtureCheck, 1, session("ctl"))).rows[0]?.[0] ?? null;
        fixture = value === spec.fixtureExpect.trim() ? "verified" : { failed: `expected ${spec.fixtureExpect}, got ${value ?? "NULL"}` };
        if (fixture !== "verified") throw new Error(`The fixture wasn't reset: ${fixture.failed}`);
      }
      for (const lane of ["A", "B"] as const) {
        for (const sql of [`SET lock_timeout = '${LOCK_TIMEOUT}'`, `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${spec.isolation.toUpperCase()}`]) {
          const failed = await executeStatement(connection.id, sql, session(lane), false);
          if (failed) throw new Error(`Lane ${lane}: ${failed.message}`);
        }
      }
      const outcomes = await runSchedule((lane, sql) => queryRows(connection.id, sql, 100, session(lane)), steps, spec.lanes, 400, setLive);
      // Whatever a lane left open is rolled back; the sessions close.
      for (const lane of ["A", "B"] as const) {
        const failed = await executeStatement(connection.id, "ROLLBACK", session(lane), false);
        cleanup.push(failed ? `${lane}: ${failed.message}` : `${lane}: rolled back anything left open`);
      }
      let assertion: RaceRun["assertion"] = null;
      if (spec.assertion.trim()) {
        try {
          const actual = (await queryRows(connection.id, spec.assertion, 1, session("ctl"))).rows[0]?.[0] ?? null;
          assertion = { actual, expected: spec.expect.trim(), passed: actual === spec.expect.trim() };
        } catch (e) {
          assertion = { error: toError(e).message };
        }
      }
      setRun({ at, fixture, steps: outcomes, assertion, cleanup });
      setLive(null);
    } catch (e) {
      setError(toError(e).message);
    } finally {
      await close();
      setBusy(false);
      setLive(null);
    }
  };

  const save = () =>
    connection &&
    run &&
    useInvestigations.getState().offer({
      kind: "race",
      label: `Race: ${run.assertion && "passed" in run.assertion ? (run.assertion.passed ? "assertion passed" : "assertion failed") : "run"} (rev ${hash(JSON.stringify(spec.lanes))})`,
      connection: connectionRef(connection),
      sql: (["A", "B"] as const).map((l) => `-- lane ${l}\n${spec.lanes[l].join(";\n")}`).join("\n\n"),
      complete: true,
      limits: "Controls the order of SQL statements, not every event inside the server; passing this schedule doesn't prove other schedules are safe",
      data: { spec, revision: hash(JSON.stringify(spec.lanes)), run },
    });

  if (connection?.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">The race lab runs on PostgreSQL connections.</div>;
  if (connection.environment === "prod") return <div className="m-6 text-[12px] text-danger">The race lab doesn't run on prod connections: it creates and resets fixture data. Use a local or disposable database.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5 text-[12px]">
        <header className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 size-5 text-accent" />
          <div className="flex-1">
            <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Race lab</h2>
            <p className="text-muted">Two transactions on two sessions of their own, steps run in the order you set. A step that waits for a lock shows as waiting while the other lane goes on (locks time out after {LOCK_TIMEOUT}).</p>
          </div>
          <Button className="h-7" onClick={() => setSpec(LOST_UPDATE)}>Lost-update example</Button>
          <Button className="h-7" onClick={() => set({ lanes: ATOMIC_FIX })}>
            <Wand2 className="size-3.5" /> Try the atomic fix
          </Button>
        </header>
        {connection.environment === "staging" && <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">This is a staging connection: setup and teardown run there. Prefer a local or disposable database.</p>}

        <details className="rounded-xl border border-border bg-panel p-3" open>
          <summary className="cursor-default font-semibold">Fixture (reset before every run)</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Area label="Teardown, then setup run first" value={spec.teardown} onChange={(teardown) => set({ teardown })} rows={2} />
            <Area label="Setup" value={spec.setup} onChange={(setup) => set({ setup })} rows={3} />
            <Area label="Check the reset (a query returning one value)" value={spec.fixtureCheck} onChange={(fixtureCheck) => set({ fixtureCheck })} rows={1} />
            <label className="flex flex-col gap-1">
              <span className="q-label">…must equal</span>
              <input value={spec.fixtureExpect} onChange={(e) => set({ fixtureExpect: e.target.value })} className="q-field h-7 px-2 font-mono" />
            </label>
          </div>
        </details>

        <div className="grid grid-cols-2 gap-3">
          {(["A", "B"] as const).map((lane) => (
            <section key={lane} className="flex flex-col gap-1.5 rounded-xl border border-border bg-panel p-3">
              <h3 className="font-semibold">Transaction {lane}</h3>
              {spec.lanes[lane].map((sql, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-7 shrink-0 font-mono text-[11px] text-faint">{lane}{i + 1}</span>
                  <input value={sql} onChange={(e) => setStep(lane, i, e.target.value)} className="q-field h-7 min-w-0 flex-1 px-2 font-mono text-[11.5px]" spellCheck={false} />
                  <IconButton title="Remove step" className="size-6" onClick={() => set({ lanes: { ...spec.lanes, [lane]: spec.lanes[lane].filter((_, j) => j !== i) } })}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </div>
              ))}
              <Button variant="ghost" className="h-6 self-start" onClick={() => set({ lanes: { ...spec.lanes, [lane]: [...spec.lanes[lane], ""] } })}>
                <Plus className="size-3.5" /> Step
              </Button>
            </section>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-panel p-3">
          <label className="flex min-w-80 flex-1 flex-col gap-1">
            <span className="q-label">Order</span>
            <div className="flex gap-1.5">
              <input value={spec.schedule} onChange={(e) => set({ schedule: e.target.value })} className="q-field h-7 flex-1 px-2 font-mono" />
              <Button className="h-7" onClick={() => set({ schedule: interleaved(spec.lanes) })}>
                Interleave
              </Button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="q-label">Isolation</span>
            <Select value={spec.isolation} onChange={(isolation) => set({ isolation })} options={(["read committed", "repeatable read", "serializable"] as const).map((v) => ({ value: v, label: v }))} className="q-field h-7 w-40 px-2" />
          </label>
          <label className="flex min-w-72 flex-1 flex-col gap-1">
            <span className="q-label">Afterwards, this query…</span>
            <input value={spec.assertion} onChange={(e) => set({ assertion: e.target.value })} className="q-field h-7 px-2 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="q-label">…must return</span>
            <input value={spec.expect} onChange={(e) => set({ expect: e.target.value })} className="q-field h-7 w-24 px-2 font-mono" />
          </label>
          <Button variant="primary" className="h-7" disabled={busy} onClick={() => void go()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Run
          </Button>
        </div>

        {error && <p className="select-text rounded-lg bg-danger-soft px-3 py-2 text-danger">{error}</p>}
        {live && !run && (
          <section className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-3">
            <h3 className="flex items-center gap-2 font-semibold"><Loader2 className="size-3.5 animate-spin text-accent" /> Running…</h3>
            <StepTable steps={live} />
          </section>
        )}
        {run && (
          <section className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-3">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">Run at {new Date(run.at).toLocaleTimeString()}</h3>
              <span className="text-faint">fixture {typeof run.fixture === "string" ? run.fixture : "failed"}</span>
              <span className="flex-1" />
              {run.assertion && "passed" in run.assertion && (
                <span className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${run.assertion.passed ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>
                  {run.assertion.passed ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
                  {run.assertion.passed ? "Assertion passed" : `Assertion failed: got ${run.assertion.actual ?? "NULL"}, expected ${run.assertion.expected}`}
                </span>
              )}
              {run.assertion && "error" in run.assertion && <span className="text-danger">Assertion query failed: {run.assertion.error}</span>}
              <Button className="h-6" onClick={save}>
                <FolderSearch className="size-3.5" /> Save to investigation
              </Button>
            </div>
            <StepTable steps={run.steps} />
            <p className="text-[11px] text-faint">Cleanup: {run.cleanup.join(" · ")}. This shows one order of statements; passing it doesn't prove every order is safe.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function StepTable({ steps }: { steps: RaceRun["steps"] }) {
  return (
    <table className="w-full table-fixed font-mono text-[11.5px]">
      <thead className="text-left font-sans text-[11px] text-faint">
        <tr>
          <th className="w-8 py-1">#</th>
          <th className="w-1/2 py-1">Transaction A</th>
          <th className="w-1/2 py-1">Transaction B</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => {
          const cell = (
            <div className={s.status === "error" ? "text-danger" : ""}>
              <span className="text-faint">{s.id}</span> {s.sql}
              <div className="font-sans text-[11px]">
                {s.status === "waiting" ? (
                  <span className={`inline-flex items-center gap-1 ${s.blocked ? "text-warning" : "text-muted"}`}>
                    {s.blocked ? <><Hourglass className="size-3 animate-pulse" /> waiting for a lock…</> : <><Loader2 className="size-3 animate-spin" /> running…</>}
                  </span>
                ) : (
                  <>
                    {s.blocked && (
                      <span className="mr-2 inline-flex items-center gap-1 text-warning">
                        <Hourglass className="size-3" /> waited {s.waitedMs} ms for a lock
                      </span>
                    )}
                    {s.status === "error" ? s.error : s.rows?.length ? `→ ${s.rows.slice(0, 3).map((r) => r.join(", ")).join(" | ")}` : "ok"}
                  </>
                )}
              </div>
            </div>
          );
          return (
            <tr key={i} className="border-t border-border align-top">
              <td className="py-1 text-faint">{i + 1}</td>
              <td className="truncate py-1 pr-3">{s.id.startsWith("A") ? cell : null}</td>
              <td className="truncate py-1">{s.id.startsWith("B") ? cell : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Area({ label, value, onChange, rows }: { label: string; value: string; onChange(v: string): void; rows: number }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="q-label">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="q-field resize-y px-2 py-1.5 font-mono text-[11.5px]" spellCheck={false} />
    </label>
  );
}
