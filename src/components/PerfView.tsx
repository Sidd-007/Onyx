import { FolderSearch, Gauge, Loader2, Square, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, toError } from "../lib/ipc";
import { executeSql, fmt, parseParams, prepareSql, readPlan, sameMultiset, stats, verdict, type Stats } from "../lib/perf";
import { readOnly } from "../lib/transactions";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, SqlArea, Step, Text } from "./workbench";

const SETTINGS = ["server_version", "work_mem", "random_page_cost", "effective_cache_size", "jit", "plan_cache_mode", "enable_seqscan", "max_parallel_workers_per_gather"];
const ROW_CAP = 50_000;

interface SetResult {
  values: string[];
  plans: { base: ReturnType<typeof readPlan>; cand: ReturnType<typeof readPlan> };
  base: number[];
  cand: number[];
  results: { same: boolean; onlyA: number; onlyB: number; capped: boolean } | null;
}

/** F06: a candidate query against a baseline, as prepared statements with typed parameters. */
export default function PerfView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [base, setBase] = useState(tab.sql || "SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20");
  const [cand, setCand] = useState("");
  const [types, setTypes] = useState("int");
  const [sets, setSets] = useState("42\n7");
  const [warmups, setWarmups] = useState("2");
  const [trials, setTrials] = useState("10");
  const [results, setResults] = useState<SetResult[]>([]);
  const [context, setContext] = useState<{ before: Record<string, string>; after: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const session = `perf:${tab.id}`;
  useEffect(() => () => void api.closeTabSession(tab.connectionId, session).catch(() => {}), []); // eslint-disable-line react-hooks/exhaustive-deps

  const settings = async () => Object.fromEntries((await queryRows(tab.connectionId, `SELECT name, setting FROM pg_settings WHERE name IN (${SETTINGS.map((s) => `'${s}'`).join(", ")}) ORDER BY name`, 50, session)).rows.map((r) => [r[0] ?? "", r[1] ?? ""]));

  const go = async (measure: boolean) => {
    setBusy(measure ? "measure" : "plans");
    setError(null);
    setPartial(false);
    stop.current = false;
    try {
      if (!readOnly(base) || !readOnly(cand)) throw new Error("Experiments compare reads (SELECT / WITH) only");
      if (!cand.trim()) throw new Error("Write the candidate query (the rewrite you want to try)");
      if (measure && connection?.environment === "prod") throw new Error("Measured runs execute both queries repeatedly: not on prod. Estimated plans are fine there.");
      const p = parseParams(types, sets);
      if (!(await useConnections.getState().connect(tab.connectionId))) throw new Error("Not connected");
      await api.closeTabSession(tab.connectionId, session).catch(() => {});
      for (const [name, sql] of [["onyx_base", base], ["onyx_cand", cand]] as const) {
        const failed = await executeStatement(tab.connectionId, prepareSql(name, p.types, sql), session, false);
        if (failed) throw new Error(`${name === "onyx_base" ? "Baseline" : "Candidate"}: ${failed.message}`);
      }
      const before = await settings();
      const out: SetResult[] = [];
      for (const values of p.sets) {
        const plan = async (name: string, analyze: boolean) => readPlan((await queryRows(tab.connectionId, `EXPLAIN (${analyze ? "ANALYZE, " : ""}FORMAT JSON) ${executeSql(name, values)}`, 1, session)).rows[0]?.[0] ?? "[]");
        const r: SetResult = { values, plans: { base: await plan("onyx_base", false), cand: await plan("onyx_cand", false) }, base: [], cand: [], results: null };
        out.push(r);
        setResults([...out]);
        if (!measure) continue;
        const fetch = (name: string) => queryRows(tab.connectionId, executeSql(name, values), ROW_CAP + 1, session);
        // One session, one statement at a time.
        const a = await fetch("onyx_base");
        const b = await fetch("onyx_cand");
        const capped = a.rows.length > ROW_CAP || b.rows.length > ROW_CAP;
        r.results = { ...sameMultiset(a.rows.slice(0, ROW_CAP), b.rows.slice(0, ROW_CAP)), capped };
        for (let i = 0; i < (Number(warmups) || 0); i++) {
          await plan("onyx_base", true);
          await plan("onyx_cand", true);
        }
        // Alternate the order (A B, B A…) so neither always runs on a warmer cache.
        for (let i = 0; i < Math.min(200, Number(trials) || 0); i++) {
          if (stop.current) break;
          for (const name of i % 2 ? ["onyx_cand", "onyx_base"] : ["onyx_base", "onyx_cand"]) {
            const ms = (await plan(name, true)).executionMs;
            if (ms !== null) (name === "onyx_base" ? r.base : r.cand).push(ms);
          }
          setResults([...out]);
        }
        if (stop.current) {
          setPartial(true);
          break;
        }
      }
      setContext({ before, after: await settings() });
      setResults([...out]);
    } catch (e) {
      setError(toError(e).message);
    }
    await executeStatement(tab.connectionId, "DEALLOCATE ALL", session, false);
    setBusy(null);
  };

  const changedSettings = context ? Object.keys(context.before).filter((k) => context.before[k] !== context.after[k]) : [];
  const row = (label: string, s: Stats | null) => (s ? <span>{label}: median <b>{fmt(s.median)}</b> · middle half {fmt(s.q1)}–{fmt(s.q3)} · range {fmt(s.min)}–{fmt(s.max)} · {s.n} runs</span> : <span className="text-faint">{label}: not measured</span>);

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">Performance experiments work on PostgreSQL.</div>;
  return (
    <Page title="Query performance experiment" intro="Is a rewrite (or a new index) really faster, and does it still return the same rows? Both queries run as prepared statements with typed parameters, the way your application runs them. Times are the server's execution time; a speedup is only claimed when the results match and the runs don't overlap.">
      <div className="grid grid-cols-2 gap-3">
        <Step n={1} title="Baseline"><SqlArea value={base} onChange={setBase} rows={6} /></Step>
        <Step n={2} title="Candidate"><SqlArea value={cand} onChange={setCand} rows={6} placeholder="The rewrite, using the same $1, $2… parameters" /></Step>
      </div>
      <Step n={3} title="Parameters and runs">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Parameter types ($1, $2…)"><Text value={types} onChange={setTypes} mono className="w-56" placeholder="int, text" /></Labeled>
          <Labeled label="Warm-up runs (not counted)"><Text value={warmups} onChange={setWarmups} mono className="w-20" /></Labeled>
          <Labeled label="Measured runs each"><Text value={trials} onChange={setTrials} mono className="w-20" /></Labeled>
        </div>
        <Labeled label="Parameter sets: one per line, values separated by |"><SqlArea value={sets} onChange={setSets} rows={3} /></Labeled>
        <div className="flex gap-2">
          <Button className="h-7" disabled={!!busy} onClick={() => void go(false)}>{busy === "plans" ? <Loader2 className="size-3.5 animate-spin" /> : <Gauge className="size-3.5" />} Estimated plans</Button>
          <Button variant="primary" className="h-7" disabled={!!busy || connection?.environment === "prod"} onClick={() => void go(true)} title={connection?.environment === "prod" ? "Not on prod" : ""}>{busy === "measure" ? <Loader2 className="size-3.5 animate-spin" /> : <Timer className="size-3.5" />} Measure</Button>
          {busy && <Button variant="ghost" className="h-7" onClick={() => (stop.current = true)}><Square className="size-3 fill-current" /> Stop (keeps what's measured)</Button>}
        </div>
        <ErrorNote error={error} />
      </Step>
      {results.length > 0 && (
        <Step n={4} title={`Results${partial ? " (stopped: partial)" : ""}`} right={connection && <Button className="h-6 font-normal" onClick={() => useInvestigations.getState().offer({ kind: "result", label: "Performance experiment", connection: connectionRef(connection), sql: `-- baseline\n${base}\n-- candidate\n${cand}`, complete: !partial, limits: "Server execution time on this database and data; one dataset doesn't prove equivalence for all inputs", data: { types, sets, warmups, trials, results, context } })}><FolderSearch className="size-3.5" /> Save</Button>}>
          {changedSettings.length > 0 && <p className="text-warning">Settings changed during the experiment ({changedSettings.join(", ")}): the runs may not be comparable.</p>}
          {results.map((r, i) => {
            const b = stats(r.base);
            const c = stats(r.cand);
            const v = verdict(b, c, r.results ? r.results.same : null);
            return (
              <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 font-medium">
                  Parameters: <span className="font-mono">{r.values.join(" | ") || "(none)"}</span>
                  <Badge tone={v.kind === "faster" ? "good" : v.kind === "different-results" || v.kind === "slower" ? "bad" : "muted"}>{v.kind.replace(/-/g, " ")}</Badge>
                </div>
                <p>{v.text}</p>
                {r.results && <p className="text-muted">Rows: {r.results.same ? "the same" : `${r.results.onlyA} only in the baseline, ${r.results.onlyB} only in the candidate`}{r.results.capped ? ` (first ${ROW_CAP.toLocaleString()} compared: partial)` : ""}</p>}
                <div className="flex flex-col gap-0.5 text-[11.5px]">{row("Baseline", b)}{row("Candidate", c)}</div>
                <div className="grid grid-cols-2 gap-3 font-mono text-[11px] text-muted">
                  {([["Baseline plan", r.plans.base], ["Candidate plan", r.plans.cand]] as const).map(([label, p]) => (
                    <div key={label}><div className="font-sans font-medium text-fg">{label} · cost {p.cost ?? "?"}</div>{p.nodes.slice(0, 8).map((n, j) => <div key={j} style={{ paddingLeft: Math.min(j, 6) * 8 }}>{n}</div>)}</div>
                  ))}
                </div>
              </div>
            );
          })}
          {context && <p className="text-[11px] text-faint">Context: {Object.entries(context.after).map(([k, v]) => `${k}=${v}`).join(" · ")}. Times exclude network transfer and rendering.</p>}
        </Step>
      )}
    </Page>
  );
}
