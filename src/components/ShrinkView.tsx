import { Channel } from "@tauri-apps/api/core";
import { Download, FolderSearch, Loader2, Minimize2, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, toError, type ShrinkSpec } from "../lib/ipc";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, SqlArea, Step, Text } from "./workbench";

type Result = Awaited<ReturnType<typeof api.shrinkRun>>;

/** F18: reduce a failing example to fewer rows that still fail, in a scratch copy. */
export default function ShrinkView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [spec, setSpec] = useState<ShrinkSpec>({ schema: tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public", tables: [], query: "SELECT count(*) FROM orders WHERE total < 0", other: "", expect: "0", rowCap: 10_000, maxTrials: 400, maxSeconds: 60 });
  const [all, setAll] = useState<string[]>([]);
  const [mode, setMode] = useState<"expect" | "other">("expect");
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run] = useState(() => crypto.randomUUID());
  const set = (p: Partial<ShrinkSpec>) => setSpec((s) => ({ ...s, ...p }));
  useEffect(() => {
    void api.listObjects(tab.connectionId, spec.schema).then((o) => setAll(o.filter((x) => x.kind === "table").map((x) => x.name)), () => {});
  }, [tab.connectionId, spec.schema]);

  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setLog([]);
    const channel = new Channel<{ type: string; line: string }>();
    channel.onmessage = (m) => m.type === "log" && setLog((l) => [...l.slice(-50), m.line]);
    try {
      setResult(await api.shrinkRun(tab.connectionId, run, mode === "expect" ? { ...spec, other: "" } : spec, true, channel as never));
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };
  const exportSql = async () => {
    if (!result) return;
    try {
      const text = await api.shrinkExport(tab.connectionId, result.scratch, spec);
      const path = await api.saveFile("reproducer", "sql", `${text}\n`);
      if (path) toast(`Saved ${path}`, "success");
    } catch (e) {
      setError(toError(e).message);
    }
  };

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">Shrinking works on PostgreSQL.</div>;
  if (connection?.environment === "prod") return <div className="m-6 text-[12px] text-danger">Shrinking copies data into scratch schemas, so it doesn't run on prod connections. Copy the failing data to a local database first (Copy with related rows helps).</div>;
  return (
    <Page title="Shrink a failing example" intro="A bug that only shows on a big dataset is hard to reason about. Onyx copies the tables (with their constraints and foreign keys) into a scratch schema, then removes rows chunk by chunk, keeping a removal only if the failure still happens. The source isn't touched. The result is smaller, and checked again from a clean copy; it's not claimed to be minimal.">
      <Step n={1} title="The failure">
        <Labeled label="Tables the query uses (copied to the scratch schema)">
          <div className="flex flex-wrap gap-1">
            {all.map((t) => {
              const on = spec.tables.includes(t);
              return <button key={t} type="button" onClick={() => set({ tables: on ? spec.tables.filter((x) => x !== t) : [...spec.tables, t] })} className={`rounded px-2 py-0.5 font-mono text-[11.5px] ${on ? "bg-accent-soft text-accent" : "bg-hover text-muted"}`}>{t}</button>;
            })}
          </div>
        </Labeled>
        <Labeled label="Query (write table names without a schema: it runs against the copy)"><SqlArea value={spec.query} onChange={(query) => set({ query })} rows={3} /></Labeled>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "expect"} onChange={() => setMode("expect")} /> It fails when its first value isn't</label>
          <Text value={spec.expect} onChange={(expect) => set({ expect })} mono className="w-28" />
          <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "other"} onChange={() => setMode("other")} /> It fails when its rows differ from another query's</label>
        </div>
        {mode === "other" && <SqlArea value={spec.other} onChange={(other) => set({ other })} rows={3} placeholder="The query that should give the same rows" />}
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Rows copied per table (max)"><Text value={String(spec.rowCap)} onChange={(v) => set({ rowCap: Number(v.replace(/\D/g, "")) || 1 })} mono className="w-24" /></Labeled>
          <Labeled label="Trial budget"><Text value={String(spec.maxTrials)} onChange={(v) => set({ maxTrials: Number(v.replace(/\D/g, "")) || 1 })} mono className="w-20" /></Labeled>
          <Labeled label="Time budget (s)"><Text value={String(spec.maxSeconds)} onChange={(v) => set({ maxSeconds: Number(v.replace(/\D/g, "")) || 1 })} mono className="w-20" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !spec.tables.length || connection?.readOnly} onClick={() => void go()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Minimize2 className="size-3.5" />} Shrink</Button>
          {busy && <Button variant="ghost" className="h-7" onClick={() => void api.shrinkStop(run)}><Square className="size-3 fill-current" /> Stop (keeps the last verified state)</Button>}
        </div>
        {log.length > 0 && <pre className="max-h-32 overflow-y-auto rounded-lg bg-raised p-2 font-mono text-[11px] text-muted">{log.join("\n")}</pre>}
        <ErrorNote error={error} />
      </Step>
      {result && (
        <Step n={2} title="Smaller reproducer" right={<span className="flex gap-1.5 font-normal">
          <Button className="h-6" onClick={() => void exportSql()}><Download className="size-3.5" /> Export SQL</Button>
          {connection && <Button className="h-6" onClick={() => useInvestigations.getState().offer({ kind: "result", label: "Smaller reproducer", connection: connectionRef(connection), sql: spec.query, complete: result.verifiedClean, limits: "smaller, not proven minimal; data reduction only", data: { spec, result } })}><FolderSearch className="size-3.5" /> Save</Button>}
          <Button variant="ghost" className="h-6" onClick={() => void api.shrinkDrop(tab.connectionId, result.scratch).then(() => { toast(`Dropped ${result.scratch}`, "success"); setResult(null); }, (e) => setError(toError(e).message))}><Trash2 className="size-3.5" /> Drop the scratch schema</Button>
        </span>}>
          <p>
            {result.verifiedClean ? <Badge tone="good">fails again from a clean copy</Badge> : <Badge tone="bad">didn't reproduce from a clean copy</Badge>} {result.trials} trials in {result.seconds.toFixed(1)} s{result.stopped ? " (stopped)" : ""}. Kept in <span className="font-mono">{result.scratch}</span> on {connection?.name}.
          </p>
          <table className="w-64 text-[12px]">
            <tbody>{result.tables.map(([t, a, b]) => <tr key={t} className="border-t border-border"><td className="py-1 font-mono">{t}</td><td className="text-right tabular-nums text-muted">{a.toLocaleString()}</td><td className="px-2 text-faint">→</td><td className="text-right font-medium tabular-nums">{b.toLocaleString()}</td></tr>)}</tbody>
          </table>
          {result.notes.map((n, i) => <p key={i} className="text-warning">{n}</p>)}
        </Step>
      )}
    </Page>
  );
}
