import { FolderSearch, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { compare, conclude, keyFor, type CacheFormat, type CacheMapping, type CacheRead, type Observation } from "../lib/cacheCheck";
import { literal } from "../lib/filters";
import { toError } from "../lib/ipc";
import { redisArg } from "../lib/nosql";
import { queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";
import { Badge, ErrorNote, Labeled, Page, SqlArea, Step, Text } from "./workbench";

/** Mappings are configuration (no data): kept per device. */
const useMappings = create<{ mappings: (CacheMapping & { redisId: string; redisDb: string })[]; save(m: CacheMapping & { redisId: string; redisDb: string }): void }>()(
  persist((set) => ({ mappings: [], save: (m) => set((s) => ({ mappings: [...s.mappings.filter((x) => x.name !== m.name), m] })) }), { name: "onyx.cache-mappings" }),
);

const BLANK: CacheMapping = { name: "user", sql: "SELECT * FROM users WHERE id = :id", keyTemplate: "user:{id}", format: "json", fields: [{ column: "email", field: "email", compare: "text" }], versionColumn: "", versionField: "", windowMs: 3000 };

/** F15: the database row and its cached copy, compared field by field, re-checked within a window. */
export default function CacheView({ tab }: { tab: QueryTab }) {
  const saved = useConnections((s) => s.saved);
  const pg = saved.find((c) => c.id === tab.connectionId);
  const redisConns = saved.filter((c) => c.engine === "redis");
  const mappings = useMappings((s) => s.mappings);
  const [m, setM] = useState<CacheMapping>(BLANK);
  const [redisId, setRedisId] = useState(redisConns[0]?.id ?? "");
  const [redisDb, setRedisDb] = useState("0");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [obs, setObs] = useState<Observation[] | null>(null);
  const set = (p: Partial<CacheMapping>) => setM((x) => ({ ...x, ...p }));

  const readDb = async () => {
    const sql = m.sql.replace(/:id\b/g, literal(id, pg!.engine));
    const out = await queryRows(pg!.id, sql, 2, null);
    if (out.rows.length > 1) throw new Error("The selector returned more than one row: it must pick exactly one");
    return out.rows[0] ? Object.fromEntries(out.columns.map((c, i) => [c, out.rows[0][i]])) : null;
  };
  const readCache = async (): Promise<CacheRead> => {
    const k = redisArg(keyFor(m.keyTemplate, id));
    const cmd = async (c: string) => (await queryRows(redisId, `SELECT ${Number(redisDb) || 0}\n${c}`, 10_000, null)).rows;
    const type = (await cmd(`TYPE ${k}`))[0]?.[0] ?? "none";
    const at = Date.now();
    if (type === "none") return { state: "absent", at };
    const pttl = Number((await cmd(`PTTL ${k}`))[0]?.[0] ?? -1);
    const ttlMs = pttl >= 0 ? pttl : null;
    if (m.format === "hash") {
      if (type !== "hash") return { state: "wrong-type", type, at };
      const rows = await cmd(`HGETALL ${k}`);
      if (!rows.length) return { state: "expired-between-reads", at };
      return { state: "value", raw: Object.fromEntries(rows.map((r) => [r[0] ?? "", r[1] ?? ""])), ttlMs, at };
    }
    if (type !== "string") return { state: "wrong-type", type, at };
    const v = (await cmd(`GET ${k}`))[0]?.[0] ?? null;
    if (v === null) return { state: "expired-between-reads", at };
    return { state: "value", raw: v, ttlMs, at };
  };

  const check = async () => {
    if (!pg || !redisId || !id.trim()) return;
    setBusy(true);
    setError(null);
    setObs(null);
    try {
      for (const c of [pg.id, redisId]) if (!(await useConnections.getState().connect(c))) throw new Error("Not connected");
      const out: Observation[] = [];
      const start = Date.now();
      // Re-read both sides until they agree or the window is used up (bounded polling).
      for (;;) {
        const dbRow = await readDb();
        const dbAt = Date.now();
        const read = await readCache();
        const verdict = compare(m, dbRow, read);
        out.push({ dbAt, cacheAt: read.at, verdict });
        setObs([...out]);
        if (verdict.state === "agree" || verdict.state === "no-db-row" || Date.now() - start >= m.windowMs || out.length >= 40) break;
        await new Promise((r) => setTimeout(r, Math.max(150, m.windowMs / 10)));
      }
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  const finding = obs ? conclude(obs, m.windowMs) : null;
  const last = obs?.[obs.length - 1];

  if (pg && !["postgres", "mysql", "sqlite", "sqlserver", "duckdb", "clickhouse"].includes(pg.engine)) return <div className="m-6 text-[12px] text-muted">Open this from the SQL connection whose rows are cached.</div>;
  return (
    <Page title="Database ↔ Redis consistency" intro="Is the cached copy of a row the same as the database? Map the row to its Redis key and fields, then check: both sides are read and timed, and re-checked within a window so a propagation delay isn't mistaken for a stale cache. Reads only.">
      <Step n={1} title="Mapping" right={mappings.length ? <Select<string> value="" placeholder="Saved mappings" onChange={(name) => { const x = mappings.find((y) => y.name === name); if (x) { setM(x); setRedisId(x.redisId); setRedisDb(x.redisDb); } }} options={mappings.map((x) => ({ value: x.name, label: x.name }))} className="h-6 rounded-md bg-hover px-1.5 text-[11.5px] font-normal" /> : undefined}>
        <div className="grid grid-cols-4 gap-2">
          <Labeled label="Name"><Text value={m.name} onChange={(name) => set({ name })} /></Labeled>
          <Labeled label="Redis connection">
            <Select value={redisId} onChange={setRedisId} options={redisConns.map((c) => ({ value: c.id, label: c.name }))} placeholder="Add a Redis connection" className="q-field h-7 px-2" />
          </Labeled>
          <Labeled label="Redis database"><Text value={redisDb} onChange={setRedisDb} mono /></Labeled>
          <Labeled label="Recheck window (ms)"><Text value={String(m.windowMs)} onChange={(v) => set({ windowMs: Math.min(60_000, Number(v.replace(/\D/g, "")) || 0) })} mono /></Labeled>
        </div>
        <Labeled label={`Row selector on ${pg?.name ?? "this connection"} (one row; :id is the entity id)`}><SqlArea value={m.sql} onChange={(sql) => set({ sql })} rows={2} /></Labeled>
        <div className="grid grid-cols-4 gap-2">
          <Labeled label="Key template ({id})" className="col-span-2"><Text value={m.keyTemplate} onChange={(keyTemplate) => set({ keyTemplate })} mono /></Labeled>
          <Labeled label="Stored as">
            <Select value={m.format} onChange={(format: CacheFormat) => set({ format })} options={[{ value: "json", label: "JSON string" }, { value: "hash", label: "Hash" }, { value: "string", label: "Plain string" }]} className="q-field h-7 px-2" />
          </Labeled>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Fields (database column ↔ cache {m.format === "hash" ? "hash field" : m.format === "json" ? "JSON path" : "value"})</span>
          {m.fields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <Text value={f.column} onChange={(column) => set({ fields: m.fields.map((x, j) => (j === i ? { ...x, column } : x)) })} placeholder="column" mono className="w-48" />
              <span className="text-faint">↔</span>
              <Text value={f.field} onChange={(field) => set({ fields: m.fields.map((x, j) => (j === i ? { ...x, field } : x)) })} placeholder={m.format === "json" ? "path.to.value" : "field"} mono className="w-48" />
              <Select value={f.compare} onChange={(compare: typeof f.compare) => set({ fields: m.fields.map((x, j) => (j === i ? { ...x, compare } : x)) })} options={(["text", "number", "boolean", "json"] as const).map((c) => ({ value: c, label: `as ${c}` }))} className="q-field h-7 w-28 px-2" />
              <IconButton title="Remove" className="size-6" onClick={() => set({ fields: m.fields.filter((_, j) => j !== i) })}><Trash2 className="size-3" /></IconButton>
            </div>
          ))}
          <Button variant="ghost" className="h-6 self-start" onClick={() => set({ fields: [...m.fields, { column: "", field: "", compare: "text" }] })}><Plus className="size-3.5" /> Field</Button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Labeled label="Version column (optional)"><Text value={m.versionColumn} onChange={(versionColumn) => set({ versionColumn })} placeholder="version / updated_at" mono /></Labeled>
          <Labeled label="…and its cache field"><Text value={m.versionField} onChange={(versionField) => set({ versionField })} mono /></Labeled>
          <div className="col-span-2 flex items-end">
            <Button className="h-7" onClick={() => useMappings.getState().save({ ...m, redisId, redisDb })}>Save mapping</Button>
          </div>
        </div>
      </Step>
      <Step n={2} title="Check an entity">
        <div className="flex items-end gap-2">
          <Labeled label="Entity id"><Text value={id} onChange={setId} mono className="w-48" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !pg || !redisId || !id.trim()} onClick={() => void check()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Check
          </Button>
          {obs && pg && (
            <Button className="h-7" onClick={() => useInvestigations.getState().offer({ kind: "comparison", label: `Cache ${keyFor(m.keyTemplate, id)}: ${finding?.kind}`, connection: connectionRef(pg), sql: m.sql, complete: finding?.kind !== "inconclusive", limits: "Each side read separately (not one atomic snapshot); TTL is remaining lifetime, not age", data: { mapping: m, observations: obs, finding } })}>
              <FolderSearch className="size-3.5" /> Save to investigation
            </Button>
          )}
        </div>
        <ErrorNote error={error} />
        {finding && (
          <p className="font-medium">
            <Badge tone={finding.kind === "agree" || finding.kind === "converged" ? "good" : finding.kind === "persistent" ? "bad" : "warn"}>{finding.kind}</Badge> {finding.text}
          </p>
        )}
        {last && (
          <>
            {last.verdict.state !== "agree" && last.verdict.state !== "differ" && <p className="text-warning">{STATE_TEXT[last.verdict.state]}</p>}
            {last.verdict.version && (
              <p className="text-muted">
                Version: database {last.verdict.version.db ?? "?"} · cache {last.verdict.version.cache ?? "?"} → {last.verdict.version.relation === "db-newer" ? "the cache holds an older version" : last.verdict.version.relation === "cache-newer" ? "the cache is newer than the database (a write not committed, or rolled back?)" : last.verdict.version.relation}
              </p>
            )}
            {last.verdict.fields.length > 0 && (
              <table className="w-full font-mono text-[11.5px]">
                <thead className="text-left font-sans text-[11px] text-faint"><tr><th className="py-1">Column ↔ field</th><th>Database</th><th>Cache</th><th /></tr></thead>
                <tbody>
                  {last.verdict.fields.map((f) => (
                    <tr key={f.column} className="border-t border-border">
                      <td className="py-1">{f.column} ↔ {f.field}</td>
                      <td>{f.db ?? <i className="text-faint">NULL</i>}</td>
                      <td>{f.cache === undefined ? <i className="text-faint">(not there)</i> : (f.cache ?? <i className="text-faint">null</i>)}</td>
                      <td className="font-sans"><Badge tone={f.status === "same" ? "good" : "warn"}>{f.status}</Badge>{f.detail && <span className="ml-1 text-danger">{f.detail}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-faint">
              {obs!.length} observation{obs!.length === 1 ? "" : "s"} over {obs!.length > 1 ? obs![obs!.length - 1].cacheAt - obs![0].cacheAt : 0} ms. Each pair is two separate reads (database at one time, Redis a few ms later), not one atomic snapshot.
            </p>
          </>
        )}
      </Step>
    </Page>
  );
}

const STATE_TEXT: Record<string, string> = {
  "no-cache-entry": "There's no cache entry for this key (absent, or it expired between Onyx's reads). Not the same as a stale value.",
  "no-db-row": "The selector found no database row for this id.",
  "decode-error": "The cached value couldn't be decoded as JSON: that's a format problem, not a missing entry.",
  "wrong-type": "The key exists but isn't the type the mapping expects.",
};
