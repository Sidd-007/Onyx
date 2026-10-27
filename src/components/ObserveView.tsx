import { Camera, FolderSearch, Loader2, Plus, Radar, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, toError } from "../lib/ipc";
import { changed, compareSnapshots, SELECTOR_CAP, snapshotBegin, type Selector, type Snapshot } from "../lib/observe";
import { pageSql } from "../lib/sqlGen";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, SqlArea, Step, Text } from "./workbench";

/** F03: capture chosen rows before and after an action in the application. */
export default function ObserveView({ tab }: { tab: QueryTab }) {
  const saved = useConnections((s) => s.saved);
  const sqlConns = saved.filter((c) => c.engine !== "redis" && c.engine !== "mongodb");
  const [selectors, setSelectors] = useState<Selector[]>([{ id: crypto.randomUUID(), connectionId: tab.connectionId, label: "orders of customer 42", sql: "SELECT * FROM orders WHERE customer_id = 42", key: "id" }]);
  const [before, setBefore] = useState<Snapshot | null>(null);
  const [after, setAfter] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollSecs, setPollSecs] = useState("30");
  const stop = useRef(false);
  const session = (c: string) => `observe:${c}:${tab.id}`;
  useEffect(() => () => { stop.current = true; for (const c of new Set(selectors.map((s) => s.connectionId))) void api.closeTabSession(c, session(c)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** One snapshot: per connection, every selector inside one consistent read-only transaction. */
  const capture = async (): Promise<Snapshot> => {
    const results: Snapshot["results"] = {};
    const byConn = new Map<string, Selector[]>();
    for (const s of selectors) byConn.set(s.connectionId, [...(byConn.get(s.connectionId) ?? []), s]);
    for (const [c, list] of byConn) {
      const conn = saved.find((x) => x.id === c);
      if (!conn || !(await useConnections.getState().connect(c))) {
        list.forEach((s) => (results[s.id] = { error: "Not connected" }));
        continue;
      }
      const begin = snapshotBegin(conn.engine);
      if (begin) {
        const failed = await executeStatement(c, begin, session(c), false);
        if (failed) throw new Error(`${conn.name}: ${failed.message}`);
      }
      for (const s of list) {
        try {
          const out = await queryRows(c, pageSql(conn.engine, `SELECT * FROM (${s.sql.trim().replace(/;\s*$/, "")}) onyx_observed`, false, SELECTOR_CAP + 1, 0), SELECTOR_CAP + 1, session(c));
          results[s.id] = { columns: out.columns, rows: out.rows.slice(0, SELECTOR_CAP), truncated: out.rows.length > SELECTOR_CAP };
        } catch (e) {
          results[s.id] = { error: toError(e).message };
        }
      }
      if (begin) await executeStatement(c, "COMMIT", session(c), false);
    }
    return { at: Date.now(), results };
  };

  const take = async (which: "before" | "after" | "poll") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "before") {
        setBefore(await capture());
        setAfter(null);
      } else if (which === "after") setAfter(await capture());
      else {
        // Bounded polling: capture until something changes or the budget runs out.
        stop.current = false;
        const until = Date.now() + (Number(pollSecs) || 30) * 1000;
        for (;;) {
          const snap = await capture();
          setAfter(snap);
          if (changed(compareSnapshots(selectors, before!, snap)) || Date.now() > until || stop.current) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(null);
  };

  const changes = before && after ? compareSnapshots(selectors, before, after) : null;
  const update = (i: number, p: Partial<Selector>) => setSelectors((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Page title="Before and after an action" intro="Choose the rows that matter, capture them, do the thing in your app (click the button, call the endpoint), then capture again. Each database is read in one consistent read-only snapshot; changes are what was observed during the interval, not proof your action made them (a background job could have).">
      <Step n={1} title="What to watch">
        {selectors.map((s, i) => (
          <div key={s.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
            <div className="flex items-end gap-2">
              <Labeled label="Label"><Text value={s.label} onChange={(label) => update(i, { label })} className="w-56" /></Labeled>
              <Labeled label="Connection">
                <Select value={s.connectionId} onChange={(connectionId) => update(i, { connectionId })} options={sqlConns.map((c) => ({ value: c.id, label: c.name }))} className="q-field h-7 w-52 px-2" />
              </Labeled>
              <Labeled label="Row identity column"><Text value={s.key} onChange={(key) => update(i, { key })} mono className="w-32" /></Labeled>
              <span className="flex-1" />
              <IconButton title="Remove" className="size-6" onClick={() => setSelectors((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton>
            </div>
            <SqlArea value={s.sql} onChange={(sql) => update(i, { sql })} rows={2} placeholder="SELECT … WHERE customer_id = 42 (new rows matching it show up too)" />
          </div>
        ))}
        <Button variant="ghost" className="h-6 self-start" onClick={() => setSelectors((x) => [...x, { id: crypto.randomUUID(), connectionId: tab.connectionId, label: "", sql: "", key: "id" }])}><Plus className="size-3.5" /> Selector</Button>
        <p className="text-[11px] text-faint">Each selector is capped at {SELECTOR_CAP.toLocaleString()} rows; a capped capture is marked partial.</p>
      </Step>
      <Step n={2} title="Capture">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" className="h-7" disabled={!!busy} onClick={() => void take("before")}>{busy === "before" ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />} Capture baseline</Button>
          <span className="text-muted">then do the action in your app, then</span>
          <Button className="h-7" disabled={!before || !!busy} onClick={() => void take("after")}>{busy === "after" ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />} Capture after</Button>
          <span className="text-muted">or</span>
          <Button className="h-7" disabled={!before || !!busy} onClick={() => void take("poll")}>{busy === "poll" ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />} Watch until something changes</Button>
          <Text value={pollSecs} onChange={setPollSecs} mono className="w-14" />
          <span className="text-faint">s max</span>
          {busy === "poll" && <Button variant="ghost" className="h-7" onClick={() => (stop.current = true)}>Stop</Button>}
        </div>
        {before && <p className="text-faint">Baseline at {new Date(before.at).toLocaleTimeString()}{after ? ` · after at ${new Date(after.at).toLocaleTimeString()} (${((after.at - before.at) / 1000).toFixed(1)} s later)` : ""}</p>}
        <ErrorNote error={error} />
      </Step>
      {changes && (
        <Step n={3} title="Observed during the interval" right={<Button className="h-6 font-normal" onClick={() => { const c = saved.find((x) => x.id === selectors[0]?.connectionId); useInvestigations.getState().offer({ kind: "comparison", label: `Before/after: ${changes.map((x) => x.selector.label).join(", ")}`, connection: c ? connectionRef(c) : undefined, complete: !changes.some((x) => x.partial), limits: "Changes that happened and reverted between the two captures can't be seen; nothing here proves which request made a change", data: { selectors, before, after, changes } }); }}><FolderSearch className="size-3.5" /> Save to investigation</Button>}>
          <p className="text-[11px] text-faint">A change that happened and was undone between the two captures can't be seen.</p>
          {changes.map((c) => (
            <div key={c.selector.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-medium">
                {c.selector.label || c.selector.sql.slice(0, 40)}
                {c.error ? <Badge tone="bad">{c.error}</Badge> : c.diff && c.diff.added + c.diff.removed + c.diff.changed === 0 ? <Badge tone="muted">no change</Badge> : <Badge tone="warn">{c.diff!.added} new · {c.diff!.removed} gone · {c.diff!.changed} changed</Badge>}
                {c.partial && <Badge tone="warn">partial (capped)</Badge>}
                {c.diff?.keyProblem && <Badge tone="warn">{c.diff.keyProblem}</Badge>}
              </div>
              {c.diff && c.diff.rows.length > 0 && (
                <RowsPreview
                  columns={["", ...c.diff.columns]}
                  rows={c.diff.rows.map((r) => [r.kind === "added" ? "+ new" : r.kind === "removed" ? "− gone" : "~ changed", ...(r.kind === "changed" ? r.row.map((v, j) => (r.changed.has(j) ? `${r.before[j] ?? "NULL"} → ${v ?? "NULL"}` : v)) : r.row)])}
                  tint={(i) => (c.diff!.rows[i].kind === "added" ? "bg-success-soft/40" : c.diff!.rows[i].kind === "removed" ? "bg-danger-soft/40" : "bg-warning-soft/40")}
                />
              )}
            </div>
          ))}
        </Step>
      )}
    </Page>
  );
}
