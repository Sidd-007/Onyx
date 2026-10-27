import { FileJson, FolderSearch, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { coverage, groupQueries, parseTrace, replayable, type Span, type Trace } from "../lib/trace";
import { openSql } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button } from "./ui";
import { Badge, ErrorNote, Page, SqlArea, Step } from "./workbench";

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`);

/** F16: an application request's trace, read as database work. Importing never runs anything. */
export default function TraceView({ tab }: { tab: QueryTab }) {
  const saved = useConnections((s) => s.saved);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Span | null>(null);
  const [target, setTarget] = useState(tab.connectionId);
  const parsed = useMemo<Trace | { error: string } | null>(() => {
    if (!text.trim()) return null;
    try {
      return parseTrace(text);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);
  const trace = parsed && !("error" in parsed) ? parsed : null;
  const groups = trace ? groupQueries(trace) : [];
  const db = trace?.spans.filter((s) => s.db) ?? [];
  const cov = coverage(db);
  const total = trace ? Math.max(...trace.spans.map((s) => s.end)) : 0;
  const root = trace?.spans.find((s) => !s.parent);

  const load = (file: File) => void file.text().then(setText);
  return (
    <Page title="Request trace" intro="Open an application request's trace (OpenTelemetry OTLP/JSON) to see its database work: the timeline, repeated query shapes (N+1), and the exact statement of any span, ready to open in an editor. Nothing in the file is run or connected to automatically.">
      <Step n={1} title="Trace">
        <div className="flex items-center gap-2">
          <label className="q-field flex h-7 cursor-default items-center gap-1.5 px-2.5">
            <FileJson className="size-3.5" /> Choose a .json file…
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          </label>
          <span className="text-faint">or paste it below</span>
        </div>
        <SqlArea value={text} onChange={setText} rows={3} placeholder='{"resourceSpans": [ … ]} or {"spans": [ … ]}' />
        <ErrorNote error={parsed && "error" in parsed ? parsed.error : null} />
        {trace && (trace.orphans.length > 0 || trace.problems.length > 0) && (
          <p className="text-warning">Partial trace: {trace.orphans.length} spans point at parents that aren't in the file{trace.problems.length ? `; ${trace.problems.join("; ")}` : ""}.</p>
        )}
      </Step>
      {trace && (
        <>
          <Step n={2} title="Timeline">
            <p className="text-muted">
              {root ? `${root.name}: ${ms(root.end - root.start)} wall time. ` : ""}
              {db.length} database spans: {ms(cov.unionMs)} with at least one query running{cov.sumMs > cov.unionMs + 0.05 ? ` (they overlap: adding them up would say ${ms(cov.sumMs)})` : ""}.
            </p>
            <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {trace.spans.slice(0, 500).map((s) => (
                <button key={s.id} type="button" onClick={() => setPicked(s)} className={`flex items-center gap-2 rounded px-1 text-left text-[11px] ${picked?.id === s.id ? "bg-selected" : "hover:bg-hover"}`}>
                  <span className="w-48 shrink-0 truncate font-mono">{s.db ? s.db.query.slice(0, 40) : s.name}</span>
                  <span className="relative h-3 flex-1">
                    <span className={`absolute top-0 h-3 rounded-sm ${s.db ? "bg-accent" : "bg-border-strong"}`} style={{ left: `${(s.start / Math.max(total, 0.001)) * 100}%`, width: `${Math.max(0.4, ((s.end - s.start) / Math.max(total, 0.001)) * 100)}%` }} />
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-faint">{ms(s.end - s.start)}</span>
                </button>
              ))}
            </div>
          </Step>
          <Step n={3} title="Query shapes">
            {groups.map((g) => (
              <div key={g.shape} className="flex items-center gap-2 border-t border-border py-1 text-[11.5px] first:border-0">
                <span className="w-10 shrink-0 text-right font-medium tabular-nums">{g.spans.length}×</span>
                <span className="min-w-0 flex-1 truncate font-mono" title={g.shape}>{g.shape}</span>
                {g.repeatedUnder && <Badge tone="warn">N+1: {g.repeatedUnder.count}× under one parent</Badge>}
                <span className="w-20 shrink-0 text-right tabular-nums text-muted">{ms(g.totalMs)}</span>
              </div>
            ))}
          </Step>
          {picked && (
            <Step n={4} title={picked.db ? "Database span" : picked.name}>
              {picked.db ? (
                <>
                  <p className="text-muted">{picked.db.system}{picked.db.namespace ? ` · ${picked.db.namespace}` : ""} · {ms(picked.end - picked.start)} · span {picked.id}</p>
                  <pre className="select-text whitespace-pre-wrap rounded-lg bg-raised p-2.5 font-mono text-[11.5px]">{picked.db.query}</pre>
                  {Object.keys(picked.db.params).length > 0 && <p className="font-mono text-[11px]">Parameters: {Object.entries(picked.db.params).map(([k, v]) => `${k} = ${v}`).join(", ")}</p>}
                  {(() => {
                    const r = replayable(picked);
                    return r.ok ? null : <p className="text-warning">Can't replay exactly: no value for {r.missing.join(", ")} was captured. The query opens as written; fill in the values yourself.</p>;
                  })()}
                  <div className="flex items-center gap-2">
                    <span className="text-muted">Open on</span>
                    <Select value={target} onChange={setTarget} options={saved.filter((c) => c.engine !== "redis").map((c) => ({ value: c.id, label: c.name, hint: c.environment }))} className="q-field h-7 w-56 px-2" />
                    <Button className="h-7" onClick={() => openSql(`-- From trace span ${picked.id} (${picked.name}); parameters: ${JSON.stringify(picked.db!.params)}\n${picked.db!.query}`, target, { title: "From trace" })}><SquareTerminal className="size-3.5" /> Open in an editor (doesn't run)</Button>
                    <Button className="h-7" onClick={() => { const c = saved.find((x) => x.id === target); useInvestigations.getState().offer({ kind: "result", label: `Trace span ${picked.name}`, connection: c ? connectionRef(c) : undefined, sql: picked.db!.query, complete: replayable(picked).ok, limits: replayable(picked).ok ? undefined : "parameter values weren't captured", data: { span: picked, groups: groups.map((g) => ({ shape: g.shape, count: g.spans.length, totalMs: g.totalMs, repeatedUnder: g.repeatedUnder })) } }); }}><FolderSearch className="size-3.5" /> Save</Button>
                  </div>
                </>
              ) : (
                <pre className="select-text font-mono text-[11px]">{JSON.stringify(picked.attrs, null, 2)}</pre>
              )}
            </Step>
          )}
        </>
      )}
    </Page>
  );
}
