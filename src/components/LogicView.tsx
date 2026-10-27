import { FolderSearch, ListTree, Loader2, Play, SearchX, Sigma } from "lucide-react";
import { useState } from "react";
import { api, toError } from "../lib/ipc";
import type { Drill, MissingStep, StageReport } from "../lib/sqlLogic";
import { queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, SqlArea, Step, Text } from "./workbench";

type Mode = "stages" | "missing" | "drill";
const STATUS_TONE: Record<MissingStep["status"], "good" | "bad" | "warn" | "muted"> = { kept: "good", removed: "bad", "not-found": "bad", "beyond-limit": "warn", unknown: "muted" };

/**
 * F19 / F01 / F05: how a query turns rows into its result, why an expected row is missing,
 * and which rows produced an aggregate. Diagnostics read one snapshot and never write.
 */
export default function LogicView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [sql, setSql] = useState(tab.sql || "SELECT c.name, count(*) AS orders, sum(o.total) AS revenue\nFROM customers c JOIN orders o ON o.customer_id = c.id\nWHERE o.status = 'paid'\nGROUP BY c.name\nORDER BY revenue DESC\nLIMIT 10");
  const [mode, setMode] = useState<Mode>("stages");
  const [report, setReport] = useState<StageReport | null>(null);
  const [alias, setAlias] = useState("");
  const [key, setKey] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<MissingStep[] | null>(null);
  const [result, setResult] = useState<{ columns: string[]; rows: (string | null)[][] } | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      if (!(await useConnections.getState().connect(tab.connectionId))) throw new Error("Not connected");
      await work();
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };
  const analyze = () =>
    run(async () => {
      const r = await api.sqlStages(tab.connectionId, sql);
      setReport(r);
      if (!alias) setAlias(r.analysis.base.alias);
    });
  const sources = report ? [report.analysis.base, ...report.analysis.joins.map((j) => j.source)] : [];
  const source = sources.find((s) => s.alias === alias);
  const save = (label: string, data: unknown) => connection && useInvestigations.getState().offer({ kind: "result", label, connection: connectionRef(connection), sql, complete: true, limits: "Read from one snapshot at the time of the check; the data may have changed since the original result", data });

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">The query debugger works on PostgreSQL.</div>;
  return (
    <Page title="Query debugger" intro="A query can be valid and fast and still give the wrong answer. See how many rows (and distinct records) each step keeps, find out why an expected row isn't in the result, or see the rows behind a total. Every check reads one consistent snapshot and changes nothing.">
      <Step n={1} title="Query" right={<Button variant="primary" className="h-6 font-normal" disabled={busy} onClick={() => void analyze()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Analyze</Button>}>
        <SqlArea value={sql} onChange={(v) => { setSql(v); setReport(null); setSteps(null); setDrill(null); setResult(null); }} rows={6} />
        <p className="text-[11px] text-faint">Supported: one SELECT over tables with INNER / LEFT JOIN … ON, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT. CTEs, UNION, window functions, DISTINCT and volatile functions are reported as unsupported.</p>
        <ErrorNote error={error} />
      </Step>
      {report && (
        <>
          <div className="flex rounded-lg bg-hover p-0.5 self-start">
            {([["stages", "Stages", ListTree], ["missing", "Why is a row missing?", SearchX], ["drill", "Rows behind a total", Sigma]] as const).map(([m, label, Icon]) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`flex h-7 items-center gap-1.5 rounded-md px-3 ${mode === m ? "bg-raised font-medium text-fg shadow-sm" : "text-muted"}`}>
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          {mode === "stages" && (
            <Step title="How the query transforms rows" right={<Button className="h-6 font-normal" onClick={() => save("Query stages", report)}><FolderSearch className="size-3.5" /> Save</Button>}>
              <p className="text-[11px] text-faint">Logical steps, not the optimizer's physical plan. "Records" counts distinct {report.analysis.base.table} rows (by primary key), so a join that repeats them shows.</p>
              <table className="w-full text-[12px]">
                <thead className="text-left text-[11px] text-faint"><tr><th className="py-1">Step</th><th className="text-right">Rows</th><th className="text-right">{report.analysis.base.table} records</th><th className="text-right">Most rows per record</th></tr></thead>
                <tbody>
                  {report.stages.map((s, i) => (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="py-1.5"><div className="font-medium">{s.label}</div><div className="font-mono text-[11px] text-muted">{s.detail}</div></td>
                      <td className="text-right tabular-nums">{s.rows.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{s.entities?.toLocaleString() ?? "—"}</td>
                      <td className={`text-right tabular-nums ${(s.maxPerEntity ?? 1) > 1 ? "font-medium text-warning" : ""}`}>{s.maxPerEntity ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.predicates.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-muted">Each WHERE condition, over the joined rows</div>
                  {report.predicates.map((p) => (
                    <div key={p.text} className="flex items-center gap-2 font-mono text-[11.5px]">
                      <span className="min-w-0 flex-1 truncate">{p.text}</span>
                      <Badge tone="good">{p.trueRows} true</Badge><Badge tone="muted">{p.falseRows} false</Badge><Badge tone={p.unknownRows ? "warn" : "muted"}>{p.unknownRows} NULL</Badge>
                    </div>
                  ))}
                </div>
              )}
              {report.observations.map((o, i) => <p key={i} className="rounded-md bg-warning-soft/50 px-2.5 py-1.5">{o}</p>)}
              {report.analysis.notes.map((n, i) => <p key={`n${i}`} className="text-faint">{n}</p>)}
            </Step>
          )}
          {mode === "missing" && (
            <Step title="Why isn't this row in the result?">
              <div className="flex flex-wrap items-end gap-2">
                <Labeled label="Table"><Select value={alias} onChange={(a) => { setAlias(a); setKey({}); }} options={sources.map((s) => ({ value: s.alias, label: `${s.table} (${s.alias})` }))} className="q-field h-7 w-48 px-2" /></Labeled>
                {source?.keys.map((k) => <Labeled key={k} label={k}><Text value={key[k] ?? ""} onChange={(v) => setKey((x) => ({ ...x, [k]: v }))} mono className="w-36" /></Labeled>)}
                {source && !source.keys.length && <span className="text-warning">{source.table} has no primary key to identify a row.</span>}
                <Button variant="primary" className="h-7" disabled={busy || !source?.keys.length || source.keys.some((k) => !key[k])} onClick={() => void run(async () => setSteps(await api.sqlMissing(tab.connectionId, sql, alias, source!.keys.map((k) => [k, key[k]]))))}>Explain</Button>
                {steps && <Button className="h-7" onClick={() => save(`Missing row: ${source?.table} ${Object.values(key).join(", ")}`, steps)}><FolderSearch className="size-3.5" /> Save</Button>}
              </div>
              {steps && (
                <ol className="flex flex-col gap-1.5">
                  {steps.map((s, i) => (
                    <li key={i} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
                      <div className="flex items-center gap-2"><Badge tone={STATUS_TONE[s.status]}>{s.status.replace("-", " ")}</Badge><span className="font-mono text-[11.5px]">{s.stage}</span></div>
                      <p className="text-muted">{s.detail}</p>
                      {s.values && s.values[1].length > 0 && <RowsPreview columns={s.values[0]} rows={s.values[1]} max={5} />}
                    </li>
                  ))}
                </ol>
              )}
            </Step>
          )}
          {mode === "drill" && (
            <Step title="Which rows made this total?">
              {!report.analysis.aggregates.length ? (
                <p className="text-muted">This query has no plain COUNT / SUM / AVG / MIN / MAX columns.</p>
              ) : !result ? (
                <Button variant="primary" className="h-7 self-start" disabled={busy} onClick={() => void run(async () => setResult(await queryRows(tab.connectionId, sql, 500)))}>Run the query, then click a total</Button>
              ) : (
                <div className="max-h-64 overflow-auto rounded-lg border border-border">
                  <table className="min-w-full font-mono text-[11.5px]">
                    <thead className="sticky top-0 bg-panel text-left text-faint"><tr>{result.columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.map((r, i) => (
                        <tr key={i} className="border-t border-border">
                          {r.map((v, j) => {
                            const agg = report.analysis.aggregates.some((g) => g.output === result.columns[j]);
                            return (
                              <td key={j} className="px-2 py-0.5">
                                {agg ? <button type="button" className="text-accent underline decoration-dotted" onClick={() => void run(async () => setDrill(await api.sqlDrill(tab.connectionId, sql, Object.fromEntries(result.columns.map((c, k) => [c, r[k]])), result.columns[j])))}>{v ?? "NULL"}</button> : (v ?? "NULL")}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {drill && (
                <div className="flex flex-col gap-2">
                  <p>
                    <span className="font-mono">{drill.aggregate.text}</span> for {drill.group.length ? drill.group.map(([k, v]) => `${k} = ${v ?? "NULL"}`).join(", ") : "all rows"}: recomputed now as <span className="font-mono font-medium">{drill.recomputed ?? "NULL"}</span>
                    {result && (() => { const shown = result.rows.find((r) => drill.group.every(([k, v]) => r[result.columns.indexOf(k)] === v))?.[result.columns.indexOf(drill.aggregate.output)]; return shown !== undefined ? (shown === drill.recomputed ? <Badge tone="good">matches the result</Badge> : <Badge tone="warn">result showed {shown ?? "NULL"}: the data changed since it ran</Badge>) : null; })()}
                  </p>
                  <p className="text-muted">
                    {drill.totalRows.toLocaleString()} contributing rows{drill.distinctEntities !== null && ` from ${drill.distinctEntities.toLocaleString()} distinct ${report.analysis.base.table} records`}.
                    {drill.nullRows > 0 && ` ${drill.nullRows} have a NULL ${drill.aggregate.arg}: ${drill.aggregate.func === "count" ? "COUNT(x) skips them" : `${drill.aggregate.func.toUpperCase()} ignores them`}.`}
                    {drill.avgParts && ` AVG = ${drill.avgParts[0] ?? "NULL"} ÷ ${drill.avgParts[1]} non-NULL values.`}
                  </p>
                  {drill.repeated.length > 0 && <p className="rounded-md bg-warning-soft/50 px-2.5 py-1.5">Some {report.analysis.base.table} records contribute more than once because a join repeats them: {drill.repeated.slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(", ")}{drill.repeated.length > 5 ? "…" : ""}. Intended for per-item totals, wrong if each record should count once.</p>}
                  <RowsPreview columns={drill.columns} rows={drill.rows} max={200} />
                  {drill.capped && <p className="text-[11px] text-warning">Showing the first 1,000 rows; the totals above cover all {drill.totalRows.toLocaleString()}.</p>}
                  <Button className="h-6 self-start" onClick={() => save(`Rows behind ${drill.aggregate.text}`, drill)}><FolderSearch className="size-3.5" /> Save</Button>
                </div>
              )}
            </Step>
          )}
        </>
      )}
    </Page>
  );
}
