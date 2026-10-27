import { ArrowRight, Copy, FileCode, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diffRows, syncSql, type DataDiff as Diff, type Row } from "../lib/dataDiff";
import { api, defaultSchemaOf, toError } from "../lib/ipc";
import { quoteIdent } from "../lib/sqlSplit";
import { copyText, openSql, queryRows } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button } from "./ui";

/** Rows read from each side; bigger tables are compared on their first rows by key. */
const CAP = 200_000;
const SHOWN = 500;

interface Side {
  connectionId: string;
  schema: string;
  table: string;
}

function useList<T>(load: () => Promise<T[]> | null, deps: unknown[]): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let live = true;
    const p = load();
    if (!p) return setItems([]);
    p.then((v) => live && setItems(v), () => live && setItems([]));
    return () => {
      live = false;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return items;
}

/** Picks connection, schema and table. */
function SidePicker({ label, side, onChange }: { label: string; side: Side; onChange(side: Side): void }) {
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const connected = saved.filter((c) => isConnected(status[c.id]) && c.engine !== "redis" && c.engine !== "mongodb");
  const schemas = useList(() => (side.connectionId ? api.listSchemas(side.connectionId) : null), [side.connectionId]);
  const tables = useList(
    () => (side.connectionId && side.schema ? api.listObjects(side.connectionId, side.schema).then((o) => o.filter((x) => x.kind === "table").map((x) => x.name)) : null),
    [side.connectionId, side.schema],
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{label}</span>
      <div className="flex gap-1">
        <Select
          value={side.connectionId}
          placeholder="connection"
          onChange={(id) => {
            const c = saved.find((x) => x.id === id);
            onChange({ connectionId: id, schema: c ? useUi.getState().sidebarSchema[id] ?? defaultSchemaOf(c) : "", table: side.table });
          }}
          options={connected.map((c) => ({ value: c.id, label: c.name }))}
          className="q-field h-7 w-40 px-2 text-[12px]"
        />
        <Select value={side.schema} placeholder="schema" onChange={(schema) => onChange({ ...side, schema })} options={schemas.map((s) => ({ value: s, label: s }))} className="q-field h-7 w-32 px-2 text-[12px]" />
        <Select value={side.table} placeholder="table" onChange={(table) => onChange({ ...side, table })} options={tables.map((t) => ({ value: t, label: t }))} className="q-field h-7 min-w-0 flex-1 px-2 font-mono text-[12px]" />
      </div>
    </div>
  );
}

/** Compares a table's rows on two connections and writes the SQL that syncs the target. */
export default function DataDiff({ tab }: { tab: QueryTab }) {
  const saved = useConnections((s) => s.saved);
  const home = saved.find((c) => c.id === tab.connectionId);
  const homeSchema = useUi.getState().sidebarSchema[tab.connectionId] ?? (home ? defaultSchemaOf(home) : "");
  const [source, setSource] = useState<Side>({ connectionId: tab.connectionId, schema: tab.schema ?? homeSchema, table: tab.table ?? "" });
  const [target, setTarget] = useState<Side>({ connectionId: "", schema: "", table: tab.table ?? "" });
  const [keys, setKeys] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"changed" | "added" | "removed">("changed");
  const [deletes, setDeletes] = useState(false);

  // The source table's columns; its primary key is the default match key.
  useEffect(() => {
    if (!source.connectionId || !source.schema || !source.table) return setColumns([]);
    let live = true;
    api.listColumns(source.connectionId, source.schema, source.table).then(
      (cols) => {
        if (!live) return;
        setColumns(cols.map((c) => c.name));
        setKeys(cols.filter((c) => c.primaryKey).map((c) => c.name));
      },
      () => live && setColumns([]),
    );
    return () => {
      live = false;
    };
  }, [source.connectionId, source.schema, source.table]);

  const engineOf = (id: string) => saved.find((c) => c.id === id)?.engine ?? "postgres";
  const select = (side: Side) => {
    const engine = engineOf(side.connectionId);
    const q = (n: string) => quoteIdent(n, engine);
    const order = keys.map(q).join(", ");
    const from = `${q(side.schema)}.${q(side.table)}`;
    return engine === "sqlserver" ? `SELECT TOP ${CAP + 1} * FROM ${from} ORDER BY ${order}` : `SELECT * FROM ${from} ORDER BY ${order} LIMIT ${CAP + 1}`;
  };

  const compare = async () => {
    setBusy(true);
    setError(null);
    setDiff(null);
    try {
      // Reads only, on both sides.
      const [a, b] = await Promise.all([queryRows(source.connectionId, select(source), CAP + 1), queryRows(target.connectionId, select(target), CAP + 1)]);
      setTruncated(a.rows.length > CAP || b.rows.length > CAP);
      const d = diffRows({ columns: a.columns, rows: a.rows.slice(0, CAP) }, { columns: b.columns, rows: b.rows.slice(0, CAP) }, keys);
      setDiff(d);
      setView(d.changed.length ? "changed" : d.added.length ? "added" : "removed");
    } catch (e) {
      setError(e instanceof Error ? e.message : toError(e).message);
    }
    setBusy(false);
  };

  const sql = useMemo(
    () => (diff ? syncSql(diff, engineOf(target.connectionId), target.schema, target.table, { deletes }) : ""),
    [diff, target, deletes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ready = source.table && target.connectionId && target.table && keys.length > 0;
  const rows: { row: Row; changed?: number[]; before?: Row }[] = !diff
    ? []
    : view === "added"
      ? diff.added.map((row) => ({ row }))
      : view === "removed"
        ? diff.removed.map((row) => ({ row }))
        : diff.changed.map((c) => ({ row: c.source, before: c.target, changed: c.changed }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-border bg-panel px-4 py-3">
        <div className="flex items-end gap-3">
          <SidePicker label="Source (read)" side={source} onChange={setSource} />
          <ArrowRight className="mb-2 size-4 shrink-0 text-faint" />
          <SidePicker label="Target (gets the sync SQL)" side={target} onChange={setTarget} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11.5px] text-muted">Match rows by</span>
          {columns.map((c) => {
            const on = keys.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => setKeys((k) => (on ? k.filter((x) => x !== c) : [...k, c]))}
                className={`h-6 rounded-md px-2 font-mono text-[11.5px] ${on ? "bg-accent text-accent-fg" : "bg-input text-muted hover:text-fg"}`}
              >
                {c}
              </button>
            );
          })}
          <span className="flex-1" />
          <Button variant="primary" className="h-7" disabled={!ready || busy} onClick={() => void compare()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null} Compare rows
          </Button>
        </div>
      </div>

      {error && <p className="m-4 select-text rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}
      {!diff && !error && (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
          Pick a table on two connections and the columns that identify a row (the primary key by default).
        </div>
      )}
      {diff && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12px]">
            {(
              [
                ["changed", `~ ${diff.changed.length.toLocaleString()} changed`, "text-warning"],
                ["added", `+ ${diff.added.length.toLocaleString()} only in source`, "text-success"],
                ["removed", `− ${diff.removed.length.toLocaleString()} only in target`, "text-danger"],
              ] as const
            ).map(([v, label, tint]) => (
              <button key={v} type="button" onClick={() => setView(v)} className={`h-6 rounded-md px-2 ${view === v ? `bg-selected font-medium ${tint}` : "text-muted hover:bg-hover"}`}>
                {label}
              </button>
            ))}
            <span className="text-faint">· {diff.same.toLocaleString()} identical</span>
            {truncated && <span className="text-warning">· compared the first {CAP.toLocaleString()} rows by key</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full select-text border-collapse font-mono text-[11.5px]">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr>
                  {diff.columns.map((c) => (
                    <th key={c} className={`whitespace-nowrap border-b border-border px-3 py-1.5 font-medium ${diff.keyColumns.includes(c) ? "text-accent" : ""}`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, SHOWN).map((r, i) => (
                  <tr key={i} className="border-b border-border hover:bg-hover">
                    {r.row.map((v, c) => (
                      <td key={c} className={`max-w-72 truncate px-3 py-1 ${r.changed?.includes(c) ? "bg-warning-soft" : ""}`}>
                        {r.changed?.includes(c) && (
                          <span className="mr-1.5 text-danger line-through opacity-70">{r.before?.[c] ?? "NULL"}</span>
                        )}
                        {v === null ? <span className="text-faint">NULL</span> : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > SHOWN && <p className="px-4 py-2 text-[11.5px] text-faint">Showing {SHOWN} of {rows.length.toLocaleString()}; the sync SQL covers all of them.</p>}
            {rows.length === 0 && <p className="px-4 py-6 text-center text-[12px] text-muted">Nothing here.</p>}
          </div>
          <footer className="flex items-center gap-2 border-t border-border bg-panel px-4 py-2.5 text-[12px]">
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" checked={deletes} onChange={(e) => setDeletes(e.target.checked)} />
              Delete rows that are only in the target
            </label>
            <span className="flex-1" />
            <span className="text-faint">{sql ? `${sql.split("\n").length.toLocaleString()} statements` : "In sync"}</span>
            <Button disabled={!sql} onClick={() => void copyText(sql, "Sync SQL copied")}>
              <Copy className="size-3.5" /> Copy SQL
            </Button>
            <Button
              variant="primary"
              disabled={!sql}
              title="Opens the statements on the target connection; nothing runs until you run it there"
              onClick={() => openSql(sql, target.connectionId, { title: `Sync ${target.table}` })}
            >
              <FileCode className="size-3.5" /> Open sync SQL
            </Button>
          </footer>
        </>
      )}
    </div>
  );
}
