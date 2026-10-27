import { Download, FlaskConical, Loader2, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildFixture, EDGE_VERSION } from "../lib/edgeCases";
import { api, toError, type ColumnInfo } from "../lib/ipc";
import { rowAsInsert } from "../lib/rowFormat";
import { quoteIdent } from "../lib/sqlSplit";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, Step, Text } from "./workbench";
import { literal } from "../lib/filters";
import type { Engine } from "../lib/ipc";
import type { Fixture } from "../lib/edgeCases";

/** Postgres: the column type without length/precision, so the comparison can't cut a value to fit. */
const castType = (type: string) => {
  if (type.startsWith('"')) return type;
  const t = type.replace(/\(\s*\d+\s*(,\s*\d+\s*)?\)/g, "").trim();
  return t.replace(/^(character|bpchar)(?=\[|$)/, "character varying").replace(/^bit(?=\[|$)/, "bit varying");
};

/**
 * Each fixture row compared with the table, in the database's own types (so `1.50` = `1.5` and
 * JSON key order don't count, but a shortened string does). By key when the fixture sets one;
 * otherwise "a row with exactly these values exists". Postgres and MySQL; elsewhere, unchecked.
 */
async function verifyStored(
  connectionId: string,
  engine: Engine,
  target: string,
  fixture: Fixture,
  columns: ColumnInfo[],
  label: (row: number) => { column: string | null; name: string } | undefined,
): Promise<{ ok: boolean; lines: string[] }> {
  if (engine !== "postgres" && engine !== "mysql") return { ok: true, lines: [`Read-back isn't checked on ${engine}.`] };
  const q = (n: string) => quoteIdent(n, engine);
  const type = (c: string) => columns.find((x) => x.name === c)?.dataType ?? "text";
  const same = (c: string, v: string | null) => {
    if (v === null) return `${q(c)} IS NULL`;
    if (engine === "mysql") return /json/i.test(type(c)) ? `${q(c)} = CAST(${literal(v, engine)} AS JSON)` : /char|text|enum/i.test(type(c)) ? `BINARY ${q(c)} = BINARY ${literal(v, engine)}` : `${q(c)} = ${literal(v, engine)}`;
    const t = castType(type(c));
    return t === "json" ? `${q(c)}::jsonb = CAST(${literal(v, engine)} AS jsonb)` : `${q(c)} = CAST(${literal(v, engine)} AS ${t})`;
  };
  const exprs = fixture.rows.map((r) => `(SELECT count(*) FROM ${target} WHERE ${fixture.columns.map((c, i) => same(c, r[i])).join(" AND ")})`);
  const counts: string[] = [];
  for (let i = 0; i < exprs.length; i += 50) {
    const { rows } = await queryRows(connectionId, `SELECT ${exprs.slice(i, i + 50).map((e, k) => `${e} AS r${i + k}`).join(", ")}`);
    counts.push(...(rows[0] ?? []).map((v) => v ?? "0"));
  }
  const lines: string[] = [];
  const key = columns.filter((c) => c.primaryKey).map((c) => c.name);
  const keyed = key.length > 0 && key.every((k) => fixture.columns.includes(k));
  for (const [i, n] of counts.entries()) {
    if (Number(n) > 0) continue;
    const l = label(i);
    const what = `row ${i}${l ? ` (${[l.column, l.name].filter(Boolean).join(" ")})` : ""}`;
    if (!keyed) {
      lines.push(`${what}: no row with exactly these values`);
      continue;
    }
    const r = fixture.rows[i];
    const where = key.map((k) => same(k, r[fixture.columns.indexOf(k)])).join(" AND ");
    const { rows } = await queryRows(connectionId, `SELECT ${fixture.columns.map((c, k) => `CASE WHEN ${same(c, r[k])} THEN 1 ELSE 0 END, ${engine === "postgres" ? `${q(c)}::text` : q(c)}`).join(", ")} FROM ${target} WHERE ${where}`);
    const stored = rows[0];
    if (!stored) {
      lines.push(`${what}: not found by its key`);
      continue;
    }
    fixture.columns.forEach((c, k) => {
      if (stored[2 * k] !== "1") lines.push(`${what}: ${c} previewed ${JSON.stringify(r[k])}, stored ${JSON.stringify(stored[2 * k + 1])}`);
    });
  }
  return { ok: lines.length === 0, lines };
}

/** F09: schema-driven edge-case fixtures with a manifest; invalid values tested separately. */
export default function FixturesView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const engine = connection?.engine ?? "postgres";
  const [schema, setSchema] = useState(tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState(tab.table ?? "");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [refs, setRefs] = useState<Record<string, string[]>>({});
  const [unique, setUnique] = useState<string[]>([]);
  const [readback, setReadback] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [seed, setSeed] = useState("42");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejections, setRejections] = useState<{ name: string; column: string; result: string; ok: boolean }[] | null>(null);
  const q = (n: string) => quoteIdent(n, engine);
  const target = `${q(schema)}.${q(table)}`;
  const disposable = connection && connection.environment !== "prod" && !connection.readOnly;

  useEffect(() => {
    void api.listSchemas(tab.connectionId).then(setSchemas, () => {});
  }, [tab.connectionId]);
  useEffect(() => {
    void api.listObjects(tab.connectionId, schema).then((o) => setTables(o.filter((x) => x.kind === "table").map((x) => x.name)), () => {});
  }, [tab.connectionId, schema]);
  useEffect(() => {
    if (!table) return;
    setRejections(null);
    setReadback(null);
    void (async () => {
      try {
        const [cols, structure] = await Promise.all([api.listColumns(tab.connectionId, schema, table), api.tableStructure(tab.connectionId, schema, table)]);
        setColumns(cols);
        setUnique(structure.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]));
        const loaded: Record<string, string[]> = {};
        for (const fk of structure.foreignKeys.filter((f) => f.columns.length === 1)) {
          const { rows } = await queryRows(tab.connectionId, `SELECT ${q(fk.refColumns[0])} FROM ${q(fk.refSchema)}.${q(fk.refTable)} WHERE ${q(fk.refColumns[0])} IS NOT NULL ORDER BY 1 LIMIT 3`);
          loaded[fk.columns[0]] = rows.map((r) => r[0]).filter((v): v is string => v !== null);
        }
        setRefs(loaded);
      } catch (e) {
        setError(toError(e).message);
      }
    })();
  }, [tab.connectionId, schema, table]); // eslint-disable-line react-hooks/exhaustive-deps

  const fixture = useMemo(() => (columns.length ? buildFixture(columns, engine, Number(seed) || 0, refs, unique) : null), [columns, engine, seed, refs, unique]);
  const label = (row: number) => fixture?.manifest.find((m) => m.row === row);

  const insert = async () => {
    if (!fixture) return;
    setBusy("insert");
    setError(null);
    try {
      // One transaction, constraints on: either every fixture row goes in or none does.
      const n = await api.insertRows(tab.connectionId, schema, table, fixture.columns, fixture.rows);
      // Read every row back and compare it with what the preview showed.
      const check = await verifyStored(tab.connectionId, engine, target, fixture, columns, (row) => label(row));
      setReadback(check);
      toast(check.ok ? `Inserted ${n} fixture rows into ${table}; every value read back as previewed` : `Inserted ${n} rows, but some values were stored differently`, check.ok ? "success" : "error");
    } catch (e) {
      setError(`Nothing was inserted: ${toError(e).message}`);
    }
    setBusy(null);
  };

  /** Each invalid value in its own savepoint, all rolled back: does the database refuse it? */
  const testRejections = async () => {
    if (!fixture) return;
    setBusy("reject");
    setError(null);
    const session = `fixtures:${tab.id}`;
    const out: { name: string; column: string; result: string; ok: boolean }[] = [];
    try {
      const begin = await executeStatement(tab.connectionId, engine === "mysql" ? "START TRANSACTION" : "BEGIN", session, false);
      if (begin) throw new Error(begin.message);
      for (const c of fixture.invalid) {
        const row = [...fixture.rows[0]];
        row[fixture.columns.indexOf(c.column)] = c.value;
        await executeStatement(tab.connectionId, "SAVEPOINT onyx_case", session, false);
        const failed = await executeStatement(tab.connectionId, rowAsInsert(engine, target, fixture.columns, row), session, false);
        await executeStatement(tab.connectionId, "ROLLBACK TO SAVEPOINT onyx_case", session, false);
        out.push({ name: c.name, column: c.column, result: failed ? `rejected: ${failed.message}` : "ACCEPTED: the database took it", ok: !!failed });
      }
    } catch (e) {
      setError(toError(e).message);
    }
    await executeStatement(tab.connectionId, "ROLLBACK", session, false);
    await api.closeTabSession(tab.connectionId, session).catch(() => {});
    setRejections(out);
    setBusy(null);
  };

  const exportSql = async () => {
    if (!fixture) return;
    const header = [`-- Onyx edge-case fixture for ${schema}.${table}`, `-- generator v${EDGE_VERSION}, seed ${fixture.seed}: same schema + seed + version reproduce it`, ...fixture.manifest.map((m) => `-- row ${m.row}: ${m.column ?? ""} ${m.name}: ${m.why}`), ...fixture.omitted.map((o) => `-- omitted ${o.column} ${o.name}: ${o.reason}`)];
    const body = fixture.rows.map((r) => rowAsInsert(engine, target, fixture.columns, r));
    const path = await api.saveFile(`${table}_fixture_seed${fixture.seed}`, "sql", `${header.join("\n")}\n\n${body.join("\n")}\n`).catch((e) => (setError(toError(e).message), null));
    if (path) toast(`Saved ${path}`, "success");
  };

  return (
    <Page title="Edge-case fixtures" intro="Valid rows that deliberately hit the values that break code: NULL vs empty, precision limits, Unicode, daylight-saving gaps, enum values, zero/one/many related rows. Each row changes one column from a baseline and says what it tests. Constraints stay on; values the database should refuse are tested separately and never kept.">
      <Step n={1} title="Table">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Schema"><Select value={schema} onChange={(v: string) => (setSchema(v), setTable(""), setColumns([]))} options={(schemas.includes(schema) ? schemas : [schema, ...schemas]).map((s) => ({ value: s, label: s }))} className="q-field h-7 w-44 px-2" /></Labeled>
          <Labeled label="Table"><Select value={table} onChange={setTable} options={tables.map((t) => ({ value: t, label: t }))} placeholder="Pick a table" className="q-field h-7 w-56 px-2" /></Labeled>
          <Labeled label="Seed"><Text value={seed} onChange={(v) => setSeed(v.replace(/\D/g, ""))} mono className="w-24" /></Labeled>
          <span className="text-[11px] text-faint">Generator v{EDGE_VERSION}: the same schema, seed and version give the same rows.</span>
        </div>
        <ErrorNote error={error} />
      </Step>
      {fixture && (
        <Step n={2} title={`${fixture.rows.length} rows`} right={<span className="flex gap-1.5 font-normal">
          <Button className="h-6" onClick={() => void exportSql()}><Download className="size-3.5" /> Export SQL + manifest</Button>
          <Button className="h-6" disabled={!disposable || !!busy} onClick={() => void testRejections()} title={disposable ? "" : "Only on non-prod, writable connections"}>{busy === "reject" ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldAlert className="size-3.5" />} Test rejections</Button>
          <Button variant="primary" className="h-6" disabled={!disposable || !!busy} onClick={() => void insert()} title={disposable ? "" : "Only on non-prod, writable connections"}>{busy === "insert" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Insert</Button>
        </span>}>
          {!disposable && <p className="text-warning">Inserting and rejection tests run only on non-prod, writable connections. Export works anywhere.</p>}
          <RowsPreview columns={["tests", ...fixture.columns]} rows={fixture.rows.map((r, i) => [`${label(i)?.column ?? ""} ${label(i)?.name ?? ""}`.trim(), ...r])} max={200} />
          <details>
            <summary className="cursor-default text-muted">Manifest: what each row tests ({fixture.manifest.length}) and what was left out ({fixture.omitted.length})</summary>
            <ul className="mt-1 flex flex-col gap-0.5 text-[11.5px]">
              {fixture.manifest.map((m, i) => <li key={i}><span className="font-mono text-faint">{m.row >= 0 ? `row ${m.row}` : "note"}</span> <span className="font-mono">{m.column}</span> {m.name}: <span className="text-muted">{m.why}</span></li>)}
              {fixture.omitted.map((o, i) => <li key={`o${i}`} className="text-warning"><span className="font-mono">{o.column}</span> {o.name}: left out ({o.reason})</li>)}
            </ul>
          </details>
        </Step>
      )}
      {readback && (
        <Step n={3} title="Read back after inserting">
          <div className="flex items-center gap-2 text-[11.5px]">
            <Badge tone={readback.ok ? "good" : "bad"}>{readback.ok ? "exact" : "differs"}</Badge>
            {readback.ok ? "Every inserted value was read back from the table and matches the preview." : "Some stored values differ from the preview:"}
          </div>
          {readback.lines.map((l, i) => <p key={i} className="font-mono text-[11.5px] text-muted">{l}</p>)}
        </Step>
      )}
      {rejections && (
        <Step n={3} title="Values the database should refuse" right={<FlaskConical className="size-3.5 text-faint" />}>
          {rejections.map((r, i) => (
            <div key={i} className="flex items-center gap-2 text-[11.5px]">
              <Badge tone={r.ok ? "good" : "bad"}>{r.ok ? "refused" : "accepted"}</Badge>
              <span className="font-mono">{r.column}</span> {r.name}
              <span className="truncate text-muted">{r.result}</span>
            </div>
          ))}
          {rejections.some((r) => !r.ok) && <p className="text-warning">An accepted value means a constraint your code may rely on isn't enforced by the database.</p>}
          <p className="text-[11px] text-faint">Every case ran in its own savepoint inside one transaction that was rolled back: nothing was kept.</p>
        </Step>
      )}
    </Page>
  );
}
