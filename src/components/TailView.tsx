import { Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { literal } from "../lib/filters";
import { api, toError, type StructureColumn } from "../lib/ipc";
import { shown } from "../lib/privacy";
import { pageSql } from "../lib/sqlGen";
import { quoteIdent } from "../lib/sqlSplit";
import { useConnections } from "../store/connections";
import { useSettings } from "../store/settings";
import type { QueryTab } from "../store/tabs";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

const KEEP = 1000;
const INTERVALS = [1, 2, 5, 10, 30];
type Row = { values: (string | null)[]; at: number };

/** Ordering candidates: an integer primary key, then time columns. */
function candidates(columns: StructureColumn[]) {
  const pk = columns.filter((c) => c.primaryKey);
  const intPk = pk.length === 1 && /int|serial|number|numeric/i.test(pk[0].dataType) ? [pk[0].name] : [];
  const times = columns.filter((c) => /timestamp|datetime|date/i.test(c.dataType) || /_(at|on|time)$/i.test(c.name)).map((c) => c.name);
  return [...new Set([...intPk, ...times, ...pk.map((c) => c.name)])];
}

/** Live tail: new rows of a table as they arrive (polls by an increasing column). Reads only. */
export default function TailView({ tab }: { tab: QueryTab }) {
  const engine = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId)?.engine) ?? "postgres";
  const privacy = useSettings((s) => s.privacy);
  const schema = tab.schema ?? "";
  const table = tab.table ?? "";
  const [columns, setColumns] = useState<StructureColumn[]>([]);
  const [by, setBy] = useState<string | null>(null);
  const [every, setEvery] = useState(2);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastPoll, setLastPoll] = useState<number | null>(null);
  const last = useRef<string | null>(null);
  // The first poll shows the latest rows; later ones only what's new.
  const started = useRef(false);
  const options = useMemo(() => candidates(columns), [columns]);

  useEffect(() => {
    void api.tableStructure(tab.connectionId, schema, table).then(
      (s) => {
        setColumns(s.columns);
        setBy((b) => b ?? candidates(s.columns)[0] ?? null);
      },
      (e) => setError(toError(e).message),
    );
  }, [tab.connectionId, schema, table]);

  useEffect(() => {
    if (!by || paused) return;
    const q = (n: string) => quoteIdent(n, engine);
    const from = `${q(schema)}.${q(table)}`;
    const where = (extra: string | null) => [applied.trim() && `(${applied.trim()})`, extra].filter(Boolean).join(" AND ");
    let live = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const first = !started.current;
        const cond = where(last.current === null ? null : `${q(by)} > ${literal(last.current, engine)}`);
        const sql = pageSql(engine, `SELECT * FROM ${from}${cond ? ` WHERE ${cond}` : ""} ORDER BY ${q(by)} ${first ? "DESC" : "ASC"}`, true, first ? 50 : 500, 0);
        const out = await api.adminQuery(tab.connectionId, sql);
        if (!live) return;
        setError(null);
        setNames(out.columns);
        const idx = out.columns.indexOf(by);
        const fresh = first ? [...out.rows].reverse() : out.rows;
        started.current = true;
        if (fresh.length) {
          last.current = fresh[fresh.length - 1][idx] ?? last.current;
          const at = first ? 0 : Date.now();
          setRows((r) => [...fresh.map((values) => ({ values, at })).reverse(), ...r].slice(0, KEEP));
        }
        setLastPoll(Date.now());
      } catch (e) {
        if (live) setError(toError(e).message);
      }
      if (live) timer = window.setTimeout(() => void poll(), every * 1000);
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [by, paused, every, applied, tab.connectionId, schema, table, engine]);

  const restart = (next: () => void) => {
    last.current = null;
    started.current = false;
    setRows([]);
    next();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Button variant={paused ? "primary" : "ghost"} className="h-6" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play className="size-3 fill-current" /> : <Pause className="size-3" />} {paused ? "Resume" : "Pause"}
        </Button>
        <span className="text-muted">New rows by</span>
        <Select
          value={by ?? ""}
          onChange={(v) => restart(() => setBy(v || null))}
          options={options.map((o) => ({ value: o, label: o }))}
          placeholder="Pick a column"
          className="h-6 rounded-md px-1.5 hover:bg-hover"
        />
        <span className="text-muted">every</span>
        <Select value={every} onChange={setEvery} options={INTERVALS.map((s) => ({ value: s, label: `${s} s` }))} className="h-6 rounded-md px-1.5 hover:bg-hover" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && restart(() => setApplied(filter))}
          placeholder="WHERE … (Enter)"
          spellCheck={false}
          className="q-field h-6 min-w-0 max-w-72 flex-1 px-2 font-mono text-[11.5px]"
        />
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[11px] text-faint">
          {!paused && by && <span className="size-1.5 animate-pulse rounded-full bg-success" />}
          {rows.length} rows{lastPoll ? ` · checked ${new Date(lastPoll).toLocaleTimeString()}` : ""}
        </span>
        <IconButton title="Clear" className="size-6" onClick={() => setRows([])}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      {error && <div className="border-b border-border px-3 py-1.5 text-[12px] text-danger">{error}</div>}
      {!by && columns.length > 0 ? (
        <div className="m-6 text-[12px] text-muted">This table has no increasing column (an integer key or a timestamp) to follow.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-[11.5px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr>
                {names.map((n) => (
                  <th key={n} className={`border-b border-border px-2.5 py-1.5 text-left font-sans text-[11px] font-medium ${n === by ? "text-accent" : "text-muted"}`}>
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.at}:${i}:${r.values[names.indexOf(by ?? "")]}`} className={r.at && Date.now() - r.at < 4000 ? "tail-new" : ""}>
                  {r.values.map((v, j) => (
                    <td key={j} className={`max-w-80 truncate border-b border-border px-2.5 py-1 ${v === null ? "text-faint italic" : ""}`}>
                      {shown(names[j], v, privacy) ?? "NULL"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
