import { ClipboardCopy, FolderSearch, Loader2, Play, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diffContexts, DIAGNOSTIC_SQL, parseReport, reproduceStatements, resolveSql, SUPPLIED_FIELDS, unqualifiedTables, type ContextDiff, type ContextReport } from "../lib/context";
import { api, toError } from "../lib/ipc";
import { diffResults } from "../lib/resultDiff";
import { copyText, executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Button } from "./ui";

type Rows = { columns: string[]; rows: (string | null)[][] };
interface Experiment {
  applied: { sql: string; error?: string }[];
  stillDifferent: string[];
  resolved: { name: string; onyx: string; app: string }[];
  query?: { onyx: Rows | { error: string }; app: Rows | { error: string }; added: number; removed: number; same: number };
}

const show = (v: unknown) => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
const BADGE: Record<string, string> = { captured: "text-success", supplied: "text-accent", unknown: "text-faint" };

/**
 * F12: the application's execution context next to Onyx's. Differences are facts about the
 * sessions, not causes: the experiment re-runs a query under the app's settings to test one.
 */
export default function ContextView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const base = `ctx-base:${tab.id}`;
  const exp = `ctx-exp:${tab.id}`;
  const [pasted, setPasted] = useState("");
  const [supplied, setSupplied] = useState<Record<string, string>>({});
  const [onyx, setOnyx] = useState<ContextReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [sql, setSql] = useState(tab.sql || "SELECT * FROM orders LIMIT 100");
  const [experiment, setExperiment] = useState<Experiment | null>(null);

  // The sessions are this tab's own: closed with it.
  useEffect(
    () => () => {
      void api.closeTabSession(tab.connectionId, base).catch(() => {});
      void api.closeTabSession(tab.connectionId, exp).catch(() => {});
    },
    [tab.connectionId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const app = useMemo<ContextReport | { error: string } | null>(() => {
    if (!pasted.trim()) return null;
    try {
      const r = parseReport(pasted);
      for (const f of SUPPLIED_FIELDS) {
        if (supplied[f]?.trim()) {
          r.values[f] = supplied[f].trim();
          r.provenance[f] = "supplied";
        }
      }
      return r;
    } catch (e) {
      return { error: toError(e).message };
    }
  }, [pasted, supplied]);
  const appReport = app && !("error" in app) ? app : null;
  const diffs = useMemo(() => (appReport && onyx ? diffContexts(appReport, onyx) : []), [appReport, onyx]);

  const capture = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!(await useConnections.getState().connect(tab.connectionId))) throw new Error("Not connected");
      const out = await queryRows(tab.connectionId, DIAGNOSTIC_SQL, 1, base);
      setOnyx(parseReport(out.rows[0]?.[0] ?? ""));
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  const runExperiment = async () => {
    if (!appReport || !onyx) return;
    setBusy(true);
    setError(null);
    try {
      // A fresh session each time, so nothing from an earlier experiment carries over.
      await api.closeTabSession(tab.connectionId, exp).catch(() => {});
      const applied: Experiment["applied"] = [];
      for (const statement of reproduceStatements(diffs, chosen)) {
        const failed = await executeStatement(tab.connectionId, statement, exp, false);
        applied.push({ sql: statement, error: failed?.message });
        if (failed) break;
      }
      const after = parseReport((await queryRows(tab.connectionId, DIAGNOSTIC_SQL, 1, exp)).rows[0]?.[0] ?? "");
      const stillDifferent = diffContexts(appReport, after)
        .filter((d) => chosen.has(d.field) && d.different)
        .map((d) => d.field);
      const names = unqualifiedTables(sql);
      const resolved: Experiment["resolved"] = [];
      if (names.length) {
        const [q, a] = await Promise.all([queryRows(tab.connectionId, resolveSql(names), 100, base), queryRows(tab.connectionId, resolveSql(names), 100, exp)]);
        names.forEach((n, i) => resolved.push({ name: n, onyx: q.rows[i]?.[1] ?? "?", app: a.rows[i]?.[1] ?? "?" }));
      }
      const run = (session: string) => queryRows(tab.connectionId, sql, 5000, session).catch((e) => ({ error: toError(e).message }));
      const [qr, ar] = await Promise.all([run(base), run(exp)]);
      let query: Experiment["query"];
      if (sql.trim()) {
        const d = "error" in qr || "error" in ar ? null : diffResults(qr, ar, null);
        query = { onyx: qr, app: ar, added: d?.added ?? 0, removed: d?.removed ?? 0, same: d?.same ?? 0 };
      }
      setExperiment({ applied, stillDifferent, resolved, query });
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  const save = () =>
    connection &&
    useInvestigations.getState().offer({
      kind: "context",
      label: `Contexts: ${diffs.filter((d) => d.different && !d.incidental).length} differences`,
      connection: connectionRef(connection),
      sql: experiment ? sql : undefined,
      complete: diffs.every((d) => d.appProvenance !== "unknown" || !SUPPLIED_FIELDS.includes(d.field as never)),
      limits: "Driver, pool mode and parameter types are only known when supplied; prepared-statement state can't be copied between sessions",
      data: { app: appReport, onyx, differences: diffs.filter((d) => d.different), experiment },
    });

  if (connection && connection.engine !== "postgres") {
    return <div className="m-6 text-[12px] text-muted">Execution-context comparison works on PostgreSQL connections.</div>;
  }
  const shown = diffs.filter((d) => !onlyDiff || d.different || d.appProvenance === "unknown" || d.onyxProvenance === "unknown");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5 text-[12px]">
        <header>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Compare execution contexts</h2>
          <p className="text-muted">The same SQL can behave differently under another role, search_path, time zone or plan setting. Capture both sides, see what differs, then test whether a difference changes the result.</p>
        </header>

        <Step n={1} title="Capture the application's context">
          <p className="text-muted">Run this read-only query on the application's connection (same credentials, pooler and settings, e.g. psql with its DATABASE_URL, or a debug endpoint) and paste the JSON it returns.</p>
          <div className="relative">
            <pre className="max-h-40 select-text overflow-auto rounded-lg border border-border bg-raised p-2.5 font-mono text-[11px]">{DIAGNOSTIC_SQL}</pre>
            <Button className="absolute right-2 top-2 h-6" onClick={() => void copyText(DIAGNOSTIC_SQL, "Diagnostic query copied")}>
              <ClipboardCopy className="size-3.5" /> Copy
            </Button>
          </div>
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"onyx_context": 1, …}' rows={3} className="q-field w-full px-2.5 py-2 font-mono text-[11px]" />
          {app && "error" in app && <p className="text-danger">{app.error}</p>}
          <div className="grid grid-cols-4 gap-2">
            {SUPPLIED_FIELDS.map((f) => (
              <label key={f} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted">{f.replace(/_/g, " ")} (you supply)</span>
                <input value={supplied[f] ?? ""} onChange={(e) => setSupplied((s) => ({ ...s, [f]: e.target.value }))} placeholder="unknown" className="q-field h-7 px-2" />
              </label>
            ))}
          </div>
        </Step>

        <Step n={2} title="Capture Onyx's context">
          <div className="flex items-center gap-2">
            <Button variant="primary" className="h-7" disabled={busy} onClick={() => void capture()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />} Capture on {connection?.name}
            </Button>
            {onyx && <span className="text-faint">captured {onyx.capturedAt ? new Date(onyx.capturedAt).toLocaleTimeString() : ""} in a session of its own</span>}
          </div>
        </Step>

        {appReport && onyx && (
          <Step n={3} title="Differences">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only differences and unknowns
              </label>
              <span className="text-faint">A difference is a fact about the sessions, not proof it caused the problem: test it in step 4.</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full">
                <thead className="bg-panel text-left text-[11px] text-faint">
                  <tr>
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5 font-medium">Setting</th>
                    <th className="px-2 py-1.5 font-medium">Application</th>
                    <th className="px-2 py-1.5 font-medium">Onyx</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d) => (
                    <DiffRow key={d.field} d={d} chosen={chosen.has(d.field)} onChoose={(on) => setChosen((s) => { const n = new Set(s); if (on) n.add(d.field); else n.delete(d.field); return n; })} />
                  ))}
                </tbody>
              </table>
            </div>
          </Step>
        )}

        {appReport && onyx && (
          <Step n={4} title="Test: run a query under the application's settings">
            <p className="text-muted">
              The ticked settings are applied in a dedicated session ({chosen.size || "none"} ticked); your editor tabs are untouched. The query then runs in Onyx's session and in that one. Roles change with SET ROLE: if Onyx's user can't become the app's role, the server refuses, and there's no fallback to a more privileged role.
            </p>
            <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={4} className="q-field w-full px-2.5 py-2 font-mono text-[11.5px]" spellCheck={false} />
            <div className="flex gap-2">
              <Button variant="primary" className="h-7" disabled={busy} onClick={() => void runExperiment()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Run in both
              </Button>
              <Button className="h-7" onClick={save}>
                <FolderSearch className="size-3.5" /> Save to investigation
              </Button>
            </div>
            {experiment && <ExperimentResult e={experiment} />}
          </Step>
        )}
        {error && <p className="select-text rounded-lg bg-danger-soft px-3 py-2 text-danger">{error}</p>}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-4">
      <h3 className="flex items-center gap-2 text-[12.5px] font-semibold">
        <span className="font-mono text-[10.5px] text-faint">{String(n).padStart(2, "0")}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function DiffRow({ d, chosen, onChoose }: { d: ContextDiff; chosen: boolean; onChoose(on: boolean): void }) {
  return (
    <tr className={`border-t border-border ${d.different && !d.incidental ? "bg-warning-soft/40" : ""}`}>
      <td className="px-2 py-1 text-center">
        {d.different && d.reproducible && <input type="checkbox" checked={chosen} onChange={(e) => onChoose(e.target.checked)} title="Reproduce in the experiment session" />}
      </td>
      <td className="px-2 py-1 font-mono">
        {d.field}
        {d.incidental && <span className="ml-1.5 font-sans text-[10.5px] text-faint">differs between any two sessions</span>}
      </td>
      <td className="max-w-80 truncate px-2 py-1 font-mono" title={show(d.app)}>
        {show(d.app)} <span className={`font-sans text-[10px] ${BADGE[d.appProvenance]}`}>{d.appProvenance}</span>
      </td>
      <td className="max-w-80 truncate px-2 py-1 font-mono" title={show(d.onyx)}>
        {show(d.onyx)} <span className={`font-sans text-[10px] ${BADGE[d.onyxProvenance]}`}>{d.onyxProvenance}</span>
      </td>
    </tr>
  );
}

function ExperimentResult({ e }: { e: Experiment }) {
  const side = (r: Rows | { error: string }) => ("error" in r ? <span className="text-danger">{r.error}</span> : `${r.rows.length} rows`);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {e.applied.map((a, i) => (
        <div key={i} className="font-mono text-[11px]">
          <span className={a.error ? "text-danger" : "text-success"}>{a.error ? "✗" : "✓"}</span> {a.sql}
          {a.error && <span className="ml-2 font-sans text-danger">{a.error}</span>}
        </div>
      ))}
      {e.stillDifferent.length > 0 && <p className="text-warning">Not reproduced: {e.stillDifferent.join(", ")} (the session still differs from the app's).</p>}
      {e.resolved.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-muted">Tables the query names resolve to</div>
          {e.resolved.map((r) => (
            <div key={r.name} className={`font-mono text-[11px] ${r.app !== r.onyx ? "text-warning" : ""}`}>
              {r.name}: Onyx → {r.onyx} · app settings → {r.app}
              {r.app !== r.onyx && <span className="ml-2 font-sans">different objects</span>}
            </div>
          ))}
        </div>
      )}
      {e.query && (
        <p>
          Onyx's session: {side(e.query.onyx)} · app's settings: {side(e.query.app)}
          {!("error" in e.query.onyx) && !("error" in e.query.app) && (
            <span className={e.query.added + e.query.removed ? "ml-2 font-medium text-warning" : "ml-2 text-success"}>
              {e.query.added + e.query.removed ? `${e.query.added} rows only under the app's settings, ${e.query.removed} only under Onyx's` : "same rows"} (first 5,000 rows compared)
            </span>
          )}
        </p>
      )}
    </div>
  );
}
