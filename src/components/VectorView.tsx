import { FolderSearch, Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api, toError } from "../lib/ipc";
import { eligibleSql, filteredOut, neighborsSql, recall, settingSql, toNeighbors, type Metric, type Neighbor, type VectorQuery } from "../lib/vector";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, Step, Text } from "./workbench";

interface Trial {
  setting: string;
  approx: Neighbor[];
  ms: number;
  r: ReturnType<typeof recall>;
}

/** F17: an approximate vector search against the exact answer, under several settings. */
export default function VectorView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [v, setV] = useState<VectorQuery>({ schema: tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public", table: tab.table ?? "", idColumn: "id", column: "embedding", metric: "cosine", query: "", fromRow: true, filter: "", k: 10 });
  const [setting, setSetting] = useState("hnsw.ef_search");
  const [values, setValues] = useState("40, 100, 200");
  const [env, setEnv] = useState<{ version: string | null; indexes: string[] } | null>(null);
  const [out, setOut] = useState<{ exact: Neighbor[]; eligible: number; filtered: Neighbor[]; exactMs: number; trials: Trial[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = `vector:${tab.id}`;
  const set = (p: Partial<VectorQuery>) => setV((x) => ({ ...x, ...p }));
  useEffect(() => () => void api.closeTabSession(tab.connectionId, session).catch(() => {}), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void queryRows(tab.connectionId, "SELECT extversion FROM pg_extension WHERE extname = 'vector'", 1).then((r) => setEnv((e) => ({ version: r.rows[0]?.[0] ?? null, indexes: e?.indexes ?? [] })), () => setEnv({ version: null, indexes: [] }));
  }, [tab.connectionId]);

  /** Everything in one read-only transaction: same snapshot, settings that end with it. */
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const idx = await queryRows(tab.connectionId, `SELECT indexdef FROM pg_indexes WHERE schemaname = '${v.schema.replace(/'/g, "''")}' AND tablename = '${v.table.replace(/'/g, "''")}' AND (indexdef ILIKE '%hnsw%' OR indexdef ILIKE '%ivfflat%')`, 20);
      setEnv((e) => ({ version: e?.version ?? null, indexes: idx.rows.map((r) => r[0] ?? "") }));
      const run = async (sql: string) => {
        const failed = await executeStatement(tab.connectionId, sql, session, false);
        if (failed) throw new Error(failed.message);
      };
      await run("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const eligible = Number((await queryRows(tab.connectionId, eligibleSql(v), 1, session)).rows[0]?.[0] ?? 0);
        // The reference: an exact scan (indexes off for this transaction only).
        await run("SET LOCAL enable_indexscan = off");
        await run("SET LOCAL enable_bitmapscan = off");
        const t0 = performance.now();
        const exact = toNeighbors((await queryRows(tab.connectionId, neighborsSql(v, v.k * 2, true), v.k * 2, session)).rows);
        const exactMs = performance.now() - t0;
        const unfiltered = toNeighbors((await queryRows(tab.connectionId, neighborsSql(v, v.k, false), v.k, session)).rows);
        const eligibleIds = new Set(exact.map((n) => n.id));
        const near = unfiltered.filter((n) => n.distance <= (exact[Math.min(v.k, exact.length) - 1]?.distance ?? Infinity));
        await run("SET LOCAL enable_indexscan = on");
        await run("SET LOCAL enable_bitmapscan = on");
        const trials: Trial[] = [];
        for (const value of values.split(",").map((x) => x.trim()).filter(Boolean)) {
          await run(settingSql(setting, value));
          const t = performance.now();
          const approx = toNeighbors((await queryRows(tab.connectionId, neighborsSql(v, v.k, true), v.k, session)).rows);
          trials.push({ setting: `${setting} = ${value}`, approx, ms: performance.now() - t, r: recall(exact, approx, v.k, eligible) });
        }
        setOut({ exact: exact.slice(0, v.k), eligible, filtered: filteredOut(near, eligibleIds), exactMs, trials });
      } finally {
        await executeStatement(tab.connectionId, "ROLLBACK", session, false);
      }
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">The vector-search debugger works on PostgreSQL with pgvector.</div>;
  return (
    <Page title="Vector search" intro="An approximate (HNSW / IVFFlat) search can return fewer good neighbors than it should, especially with a filter. Compare it with the exact answer under the same metric, filter and snapshot, and see what different search settings give you in recall and time. This measures the index against exact search; it can't judge whether the embeddings mean what you want.">
      {env && !env.version && <p className="rounded-lg bg-warning-soft px-3 py-2 text-warning">The pgvector extension isn't installed in this database.</p>}
      <Step n={1} title="Query">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Schema"><Text value={v.schema} onChange={(schema) => set({ schema })} mono className="w-28" /></Labeled>
          <Labeled label="Table"><Text value={v.table} onChange={(table) => set({ table })} mono className="w-40" /></Labeled>
          <Labeled label="Id column"><Text value={v.idColumn} onChange={(idColumn) => set({ idColumn })} mono className="w-24" /></Labeled>
          <Labeled label="Vector column"><Text value={v.column} onChange={(column) => set({ column })} mono className="w-32" /></Labeled>
          <Labeled label="Distance"><Select value={v.metric} onChange={(metric: Metric) => set({ metric })} options={[{ value: "cosine", label: "cosine <=>" }, { value: "l2", label: "L2 <->" }, { value: "ip", label: "inner product <#>" }]} className="q-field h-7 w-40 px-2" /></Labeled>
          <Labeled label="k"><Text value={String(v.k)} onChange={(x) => set({ k: Math.max(1, Math.min(1000, Number(x.replace(/\D/g, "")) || 1)) })} mono className="w-16" /></Labeled>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Query vector">
            <div className="flex items-center gap-2">
              <Select value={v.fromRow ? "row" : "literal"} onChange={(m) => set({ fromRow: m === "row" })} options={[{ value: "row", label: "from the row with id" }, { value: "literal", label: "this vector" }]} className="q-field h-7 w-44 px-2" />
              <Text value={v.query} onChange={(query) => set({ query })} mono className="w-80" placeholder={v.fromRow ? "42" : "[0.12, -0.3, …]"} />
            </div>
          </Labeled>
          <Labeled label="Filter (WHERE, optional)"><Text value={v.filter} onChange={(filter) => set({ filter })} mono className="w-72" placeholder="lang = 'en' AND deleted_at IS NULL" /></Labeled>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Setting to vary"><Select value={setting} onChange={setSetting} options={["hnsw.ef_search", "hnsw.iterative_scan", "ivfflat.probes", "ivfflat.iterative_scan"].map((s) => ({ value: s, label: s }))} className="q-field h-7 w-48 px-2" /></Labeled>
          <Labeled label="Values (comma-separated)"><Text value={values} onChange={setValues} mono className="w-56" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !v.table || !v.query.trim() || env?.version === null} onClick={() => void go()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Compare</Button>
        </div>
        <ErrorNote error={error} />
      </Step>
      {out && (
        <Step n={2} title="Approximate vs exact" right={connection && <Button className="h-6 font-normal" onClick={() => useInvestigations.getState().offer({ kind: "result", label: `Vector search on ${v.table}`, connection: connectionRef(connection), complete: true, limits: "Recall against exact search over the eligible rows in one snapshot; not a judgement of relevance", data: { query: v, env, ...out } })}><FolderSearch className="size-3.5" /> Save</Button>}>
          <p className="text-muted">
            {out.eligible.toLocaleString()} rows pass the filter; the exact top {Math.min(v.k, out.eligible)} took {out.exactMs.toFixed(0)} ms (round trip). pgvector {env?.version ?? "?"}{env?.indexes.length ? ` · ${env.indexes.join(" · ")}` : " · no vector index on this table (the 'approximate' runs are exact too)"}.
          </p>
          {out.eligible < v.k && <p className="text-warning">Only {out.eligible} rows are eligible: fewer than k, so at most {out.eligible} can come back.</p>}
          <table className="w-full text-[12px]">
            <thead className="text-left text-[11px] text-faint"><tr><th className="py-1">Setting</th><th className="text-right">Recall</th><th className="text-right">Returned</th><th className="text-right">Time</th><th className="pl-3">Missed neighbors</th></tr></thead>
            <tbody>
              {out.trials.map((t) => (
                <tr key={t.setting} className="border-t border-border align-top">
                  <td className="py-1 font-mono">{t.setting}</td>
                  <td className="text-right font-medium tabular-nums">{(t.r.recall * 100).toFixed(0)}%</td>
                  <td className="text-right tabular-nums">{t.approx.length}</td>
                  <td className="text-right tabular-nums">{t.ms.toFixed(0)} ms</td>
                  <td className="pl-3 font-mono text-[11px] text-muted">{t.r.missed.length ? t.r.missed.map((m) => `${m.id} (${m.distance.toFixed(4)})`).join(", ") : "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {out.trials.some((t) => t.r.tiesAtCut > 1) && <p className="text-[11px] text-faint">Several rows tie at the k-th distance: any of them counts as correct.</p>}
          {out.filtered.length > 0 && <p><Badge tone="muted">filtered out</Badge> {out.filtered.length} rows are as close as the k-th neighbor but fail the filter ({out.filtered.slice(0, 5).map((f) => f.id).join(", ")}): the filter removed them, not the index.</p>}
        </Step>
      )}
    </Page>
  );
}
