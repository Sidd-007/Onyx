import { FolderSearch, Loader2, Play, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { collectionEqual, diffCollection, diffFields, suggestBusinessKey, type CollectionDiff, type FieldDiff, type Rows } from "../lib/entityDiff";
import { literal } from "../lib/filters";
import { api, toError, type TableStructure } from "../lib/ipc";
import { keyIssue } from "../lib/resultDiff";
import { pageSql } from "../lib/sqlGen";
import { quoteIdent } from "../lib/sqlSplit";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button } from "./ui";

const CAP = 200;

interface Loaded {
  root: { columns: string[]; working: (string | null)[]; failing: (string | null)[] };
  parents: { relation: string; working: Rows; failing: Rows }[];
  children: { relation: string; table: string; working: Rows; failing: Rows; linking: string[]; pk: string[] }[];
}

/** F02: a working and a failing entity side by side, with their related rows matched by business key. */
export default function EntityDiffView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const engine = connection?.engine ?? "postgres";
  const [schema] = useState(tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState(tab.table ?? "");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [working, setWorking] = useState("");
  const [failing, setFailing] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [keys, setKeys] = useState<Record<string, string | null>>({});
  const [unignored, setUnignored] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listObjects(tab.connectionId, schema).then((o) => setTables(o.filter((x) => x.kind === "table").map((x) => x.name)), () => {});
  }, [tab.connectionId, schema]);
  useEffect(() => {
    setStructure(null);
    if (table) void api.tableStructure(tab.connectionId, schema, table).then(setStructure, (e) => setError(toError(e).message));
  }, [tab.connectionId, schema, table]);

  const q = (n: string) => quoteIdent(n, engine);
  const from = (s: string, t: string) => `${q(s)}.${q(t)}`;
  const eq = (cols: string[], vals: (string | null)[]) => cols.map((c, i) => (vals[i] === null ? `${q(c)} IS NULL` : `${q(c)} = ${literal(vals[i]!, engine)}`)).join(" AND ");
  const rows = (s: string, t: string, where: string, limit: number) => api.adminQuery(tab.connectionId, pageSql(engine, `SELECT * FROM ${from(s, t)} WHERE ${where}`, false, limit, 0));
  const pk = structure?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];

  const compare = async () => {
    if (!structure || pk.length !== 1) return;
    setBusy(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([rows(schema, table, eq(pk, [working]), 1), rows(schema, table, eq(pk, [failing]), 1)]);
      if (!a.rows.length || !b.rows.length) throw new Error(`No ${table} row with ${pk[0]} = ${!a.rows.length ? working : failing}`);
      const val = (r: Rows, c: string) => r.rows[0][r.columns.indexOf(c)] ?? null;
      const parents = await Promise.all(
        structure.foreignKeys.map(async (fk) => {
          const get = (r: Rows) => (fk.columns.every((c) => val(r, c) !== null) ? rows(fk.refSchema, fk.refTable, eq(fk.refColumns, fk.columns.map((c) => val(r, c))), 1) : Promise.resolve({ columns: [], rows: [] }));
          const [pa, pb] = await Promise.all([get(a), get(b)]);
          return { relation: `${fk.columns.join(", ")} → ${fk.refTable}`, working: pa, failing: pb };
        }),
      );
      const children = await Promise.all(
        structure.referencedBy.map(async (r) => {
          const [ca, cb, childStructure] = await Promise.all([
            rows(r.schema, r.table, eq(r.columns, r.refColumns.map((c) => val(a, c))), CAP),
            rows(r.schema, r.table, eq(r.columns, r.refColumns.map((c) => val(b, c))), CAP),
            api.tableStructure(tab.connectionId, r.schema, r.table).catch(() => null),
          ]);
          return { relation: `${r.table}.${r.columns.join(", ")}`, table: r.table, working: ca, failing: cb, linking: r.columns, pk: childStructure?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [] };
        }),
      );
      const next: Loaded = { root: { columns: a.columns, working: a.rows[0], failing: b.rows[0] }, parents, children };
      setLoaded(next);
      setKeys(Object.fromEntries(children.map((c) => [c.relation, suggestBusinessKey(c.working, c.failing, new Set([...c.pk, ...c.linking]))])));
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  const ignoredFor = (c: Loaded["children"][number]) => new Set([...c.pk, ...c.linking].filter((x) => !unignored.has(`${c.relation}:${x}`)));
  const rootFields = loaded ? diffFields(loaded.root.columns, loaded.root.working, loaded.root.failing, new Set(pk)) : [];
  const collections: CollectionDiff[] = loaded ? loaded.children.map((c) => diffCollection(c.relation, c.table, c.working, c.failing, CAP, keys[c.relation] ?? null, ignoredFor(c))) : [];

  const save = () =>
    connection &&
    useInvestigations.getState().offer({
      kind: "comparison",
      label: `${table} ${working} vs ${failing}`,
      connection: connectionRef(connection),
      complete: !collections.some((c) => c.partial),
      limits: collections.some((c) => c.partial) ? `related collections capped at ${CAP} rows: counts are lower bounds` : undefined,
      data: { table, working, failing, root: rootFields, parents: loaded?.parents.map((p) => ({ relation: p.relation, fields: p.working.rows[0] && p.failing.rows[0] ? diffFields(p.working.columns, p.working.rows[0], p.failing.rows[0], new Set()) : null })), collections },
    });

  if (connection && ["redis", "mongodb"].includes(engine)) return <div className="m-6 text-[12px] text-muted">Entity comparison works on SQL connections.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5 text-[12px]">
        <header>
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Compare a working and a failing entity</h2>
          <p className="text-muted">One customer works and another doesn't. Compare the two rows and everything they're related to, with related rows matched by a business key (like a plan code), not by ids that always differ.</p>
        </header>
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-panel p-3">
          <label className="flex flex-col gap-1">
            <span className="q-label">Table ({schema})</span>
            <Select value={table} onChange={setTable} options={tables.map((t) => ({ value: t, label: t }))} placeholder="Pick a table" className="q-field h-7 w-56 px-2" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-success">Working {pk[0] ?? "key"}</span>
            <input value={working} onChange={(e) => setWorking(e.target.value)} className="q-field h-7 w-36 px-2 font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-danger">Failing {pk[0] ?? "key"}</span>
            <input value={failing} onChange={(e) => setFailing(e.target.value)} className="q-field h-7 w-36 px-2 font-mono" />
          </label>
          <Button variant="primary" className="h-7" disabled={busy || !structure || pk.length !== 1 || !working || !failing} onClick={() => void compare()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Compare
          </Button>
          {loaded && (
            <Button className="h-7" onClick={save}>
              <FolderSearch className="size-3.5" /> Save to investigation
            </Button>
          )}
          {structure && pk.length !== 1 && <span className="text-warning">This table needs a single-column primary key.</span>}
        </div>
        {error && <p className="select-text rounded-lg bg-danger-soft px-3 py-2 text-danger">{error}</p>}
        {loaded && (
          <>
            <Card title={`${table} itself`} status={rootFields.length ? `${rootFields.length} fields differ` : "same (besides its key)"} good={!rootFields.length}>
              <Fields fields={rootFields} />
            </Card>
            {loaded.parents.map((p) => {
              const a = p.working.rows[0];
              const b = p.failing.rows[0];
              const fields = a && b ? diffFields(p.working.columns, a, b, new Set()) : [];
              const status = !a && !b ? "neither has one" : !a || !b ? `missing for the ${!a ? "working" : "failing"} entity` : a.join() === b.join() ? "the same row (shared)" : `${fields.length} fields differ`;
              return (
                <Card key={p.relation} title={`Parent: ${p.relation}`} status={status} good={!!a && !!b && !fields.length}>
                  <Fields fields={fields} />
                </Card>
              );
            })}
            {collections.map((d) => {
              const child = loaded.children.find((c) => c.relation === d.relation)!;
              const ignored = [...child.pk, ...child.linking];
              const equalNow = collectionEqual(d);
              const status = d.ambiguity ? "can't pair rows" : equalNow ? "same" : `${d.working}${d.partial && d.working >= CAP ? "+" : ""} vs ${d.failing}${d.partial && d.failing >= CAP ? "+" : ""} rows · ${d.onlyWorking.length} only working, ${d.onlyFailing.length} only failing, ${d.changed.length} changed`;
              return (
                <Card key={d.relation} title={`Related: ${d.relation}`} status={d.partial ? `${status} · partial (first ${CAP})` : status} good={equalNow}>
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <span className="text-muted">Match rows by</span>
                    <Select
                      value={keys[d.relation] ?? ""}
                      onChange={(v) => setKeys((k) => ({ ...k, [d.relation]: v || null }))}
                      options={[{ value: "", label: "whole row" }, ...d.columns.filter((c) => !ignored.includes(c)).map((c) => ({ value: c, label: c, hint: keyIssue(child.working, c, "working") ?? keyIssue(child.failing, c, "failing") ? "not unique" : "unique" }))]}
                      className="h-6 rounded-md bg-hover px-1.5"
                    />
                    <span className="text-muted">Expected to differ:</span>
                    {ignored.map((c) => {
                      const id = `${d.relation}:${c}`;
                      const on = !unignored.has(id);
                      return (
                        <button key={c} type="button" onClick={() => setUnignored((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })} className={`rounded px-1.5 py-0.5 font-mono ${on ? "bg-hover text-muted line-through" : "bg-accent-soft text-accent"}`} title={on ? "Ignored (a surrogate key or the link to the entity): click to compare it" : "Compared: click to ignore"}>
                          {c}
                        </button>
                      );
                    })}
                  </div>
                  {d.ambiguity && (
                    <p className="flex items-center gap-1.5 text-warning">
                      <TriangleAlert className="size-3.5" /> {d.ambiguity}: rows would be paired wrongly, so they're listed instead. Pick a unique column.
                    </p>
                  )}
                  {d.onlyWorking.length + d.onlyFailing.length > 0 && <RowsTable columns={d.columns} groups={[["only the working entity has", d.onlyWorking, "text-success"], ["only the failing entity has", d.onlyFailing, "text-danger"]]} />}
                  {d.changed.map((c) => (
                    <div key={c.key}>
                      <div className="font-mono text-[11.5px]">
                        {d.key} = {c.key}
                      </div>
                      <Fields fields={c.fields} />
                    </div>
                  ))}
                </Card>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function Card({ title, status, good, children }: { title: string; status: string; good: boolean; children?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold">{title}</h3>
        <span className={`rounded px-1.5 text-[11px] ${good ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{status}</span>
      </div>
      {children}
    </section>
  );
}

function Fields({ fields }: { fields: FieldDiff[] }) {
  if (!fields.length) return null;
  return (
    <table className="w-full font-mono text-[11.5px]">
      <thead className="text-left text-[11px] text-faint">
        <tr>
          <th className="w-48 py-1 font-sans font-medium">Field</th>
          <th className="py-1 font-sans font-medium text-success">Working</th>
          <th className="py-1 font-sans font-medium text-danger">Failing</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.column} className="border-t border-border align-top">
            <td className="py-1 pr-2">{f.column}</td>
            <td className="max-w-80 truncate py-1 pr-2" title={f.working ?? "NULL"}>{f.working ?? <span className="italic text-faint">NULL</span>}</td>
            <td className="max-w-80 truncate py-1" title={f.failing ?? "NULL"}>
              {f.failing ?? <span className="italic text-faint">NULL</span>}
              {f.json && <div className="font-sans text-[10.5px] text-muted">JSON: {f.json.join(", ")}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowsTable({ columns, groups }: { columns: string[]; groups: [string, (string | null)[][], string][] }) {
  return (
    <div className="max-h-64 overflow-auto rounded border border-border">
      <table className="min-w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-panel text-left text-faint">
          <tr>
            <th className="px-2 py-1" />
            {columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap(([label, rows, tint]) =>
            rows.slice(0, 50).map((r, i) => (
              <tr key={`${label}${i}`} className="border-t border-border">
                <td className={`whitespace-nowrap px-2 py-0.5 font-sans ${tint}`}>{i === 0 ? label : ""}</td>
                {r.map((v, j) => <td key={j} className="max-w-48 truncate px-2 py-0.5">{v ?? "NULL"}</td>)}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
