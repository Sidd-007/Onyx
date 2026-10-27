import { Copy, Lightbulb, Loader2, Play, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { isRead, mysqlScans, postgresScans, suggest, type Scan, type Suggestion } from "../lib/advisor";
import { api, defaultSchemaOf, toError } from "../lib/ipc";
import { copyText, openSql } from "../store/actions";
import { useConnections } from "../store/connections";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

type Checked = { sql: string; maxMs: number; runs: number; status: "ok" | "skipped" | "error"; note?: string; scans: Scan[] };

const THRESHOLDS = [100, 250, 500, 1000, 5000];
const short = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * Index advisor (Postgres, MySQL): EXPLAINs the slowest reads in this connection's history
 * (without running them) and suggests indexes for tables they scan in full.
 */
export default function AdvisorView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const sidebarSchema = useUi((s) => s.sidebarSchema[tab.connectionId]);
  const [minMs, setMinMs] = useState(250);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Checked[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const engine = connection?.engine ?? "postgres";

  const analyze = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await useConnections.getState().connect(connection.id))) return;
      const slow = await api.slowQueries(connection.id, minMs);
      const results: Checked[] = [];
      for (const q of slow) {
        if (!isRead(q.sql)) {
          results.push({ ...q, status: "skipped", note: "not a single SELECT", scans: [] });
          continue;
        }
        const sql = q.sql.trim().replace(/;\s*$/, "");
        try {
          const explain = engine === "mysql" ? `EXPLAIN FORMAT=JSON ${sql}` : `EXPLAIN (FORMAT JSON, VERBOSE) ${sql}`;
          const out = await api.adminQuery(connection.id, explain);
          const plan = JSON.parse(out.rows[0]?.[0] ?? "null");
          results.push({ ...q, status: "ok", scans: engine === "mysql" ? mysqlScans(plan) : postgresScans(plan) });
        } catch (e) {
          results.push({ ...q, status: "error", note: toError(e).message, scans: [] });
        }
      }
      // Existing indexes of every scanned table.
      const fallback = defaultSchemaOf(connection) || sidebarSchema || (engine === "postgres" ? "public" : "");
      // and their size (a plan without ANALYZE only estimates the rows a scan returns).
      const tables = new Map<string, string[][]>();
      const sizes = new Map<string, Map<string, number>>();
      for (const s of results.flatMap((r) => r.scans)) {
        const schema = s.schema ?? fallback;
        if (!sizes.has(schema)) {
          const objects = await api.listObjects(connection.id, schema).catch(() => []);
          sizes.set(schema, new Map(objects.map((o) => [o.name, o.estimatedRows ?? 0])));
        }
        s.rows = Math.max(s.rows, sizes.get(schema)?.get(s.table) ?? 0);
        const key = `${schema}.${s.table}`;
        if (tables.has(key)) continue;
        const structure = await api.tableStructure(connection.id, schema, s.table).catch(() => null);
        tables.set(key, structure?.indexes.map((i) => i.columns) ?? []);
      }
      setChecked(results);
      setSuggestions(suggest(engine, results.filter((r) => r.status === "ok"), (schema, table) => tables.get(`${schema ?? fallback}.${table}`) ?? []));
    } catch (e) {
      setError(toError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (connection && engine !== "postgres" && engine !== "mysql") {
    return <div className="m-6 text-[12px] text-muted">The index advisor reads Postgres and MySQL plans.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Button variant="primary" className="h-6" onClick={() => void analyze()} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3 fill-current" />} Analyze
        </Button>
        <span className="text-muted">queries in history slower than</span>
        <Select value={minMs} onChange={setMinMs} options={THRESHOLDS.map((ms) => ({ value: ms, label: ms >= 1000 ? `${ms / 1000} s` : `${ms} ms` }))} className="h-6 rounded-md px-1.5 hover:bg-hover" />
        <span className="flex-1" />
        <span className="text-[11px] text-faint">Plans only (EXPLAIN without ANALYZE): nothing is run or changed</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 text-[12px] text-danger">{error}</div>}
        {!checked ? (
          <div className="mx-auto mt-10 max-w-md text-center text-[12px] text-muted">
            <Lightbulb className="mx-auto mb-2 size-5 text-faint" />
            Run your app's queries from Onyx for a while, then Analyze: slow reads that scan whole tables get an index suggestion.
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">Suggested indexes</h3>
              {!suggestions.length ? (
                <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">
                  No full scans worth an index in {checked.length} slow {checked.length === 1 ? "query" : "queries"}.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {suggestions.map((s) => (
                    <div key={s.sql} className="rounded-xl border border-border bg-panel p-3">
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-medium">{s.table}</span>
                        <span className="text-muted">({s.columns.join(", ")})</span>
                        <span className="text-faint">
                          · scans ~{s.rows.toLocaleString()} rows · helps {s.queries.length} {s.queries.length === 1 ? "query" : "queries"}
                        </span>
                        <span className="flex-1" />
                        <IconButton title="Copy SQL" className="size-6" onClick={() => void copyText(s.sql, "Copied")}>
                          <Copy className="size-3.5" />
                        </IconButton>
                        <IconButton title="Open in an editor (review, then run it yourself)" className="size-6" onClick={() => openSql(s.sql, tab.connectionId)}>
                          <SquareTerminal className="size-3.5" />
                        </IconButton>
                      </div>
                      <code className="mt-2 block rounded-lg bg-raised px-2 py-1.5 font-mono text-[11.5px]">{s.sql}</code>
                      <ul className="mt-2 flex flex-col gap-0.5">
                        {s.queries.slice(0, 3).map((q) => (
                          <li key={q} className="truncate font-mono text-[11px] text-muted" title={q}>
                            {short(q)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">Slow queries checked</h3>
              <div className="overflow-hidden rounded-xl border border-border">
                {checked.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11.5px] last:border-0">
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted">{Math.round(c.maxMs).toLocaleString()} ms</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={c.sql}>
                      {short(c.sql)}
                    </span>
                    <span className={`shrink-0 truncate text-[11px] ${c.status === "error" ? "text-danger" : "text-faint"}`} title={c.note}>
                      {c.status === "ok" ? (c.scans.length ? `${c.scans.length} full scan${c.scans.length > 1 ? "s" : ""}` : "uses indexes") : c.status === "skipped" ? c.note : "couldn't explain"}
                    </span>
                  </div>
                ))}
                {!checked.length && <div className="px-3 py-3 text-center text-[12px] text-muted">No queries in history slower than {minMs} ms.</div>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
