import { CircleCheck, CircleX, FolderSearch, Loader2, Play, Plus, ShieldQuestion, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, toError } from "../lib/ipc";
import { asIdentity, classify, evidenceSql, passes, policiesSql, policyApplies, readEvidence, type Expectation, type Outcome, type RoleEvidence } from "../lib/rls";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, SqlArea, Step, Text } from "./workbench";

interface Case {
  id: string;
  name: string;
  role: string;
  claims: string;
  sql: string;
  expect: Expectation;
}

/** Saved test cases: no credentials, no tokens, just a role name and claims. */
const useCases = create<{ cases: Case[]; set(cases: Case[]): void }>()(persist((set) => ({ cases: [], set: (cases) => set({ cases }) }), { name: "onyx.rls-cases" }));

const EXPECT_LABEL: Record<Expectation["kind"], string> = { allow: "sees at least N rows", exact: "sees exactly N rows", "deny-rows": "sees no rows", "deny-privilege": "has no SELECT grant" };

/** F14: what an identity can see, the catalog evidence for why, and saved allow/deny tests. */
export default function RlsView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const cases = useCases((s) => s.cases);
  const [schema, setSchema] = useState(tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public");
  const [table, setTable] = useState(tab.table ?? "");
  const [tables, setTables] = useState<string[]>([]);
  const [roles, setRoles] = useState("authenticated, anon");
  const [evidence, setEvidence] = useState<{ roles: RoleEvidence[]; policies: { columns: string[]; rows: (string | null)[][] }; login: string } | null>(null);
  const [results, setResults] = useState<Record<string, { outcome: Outcome; sample?: { columns: string[]; rows: (string | null)[][] }; cleaned: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = `rls:${tab.id}`;
  useEffect(() => () => void api.closeTabSession(tab.connectionId, session).catch(() => {}), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void api.listObjects(tab.connectionId, schema).then((o) => setTables(o.filter((x) => x.kind === "table").map((x) => x.name)), () => {});
  }, [tab.connectionId, schema]);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      const names = roles.split(",").map((r) => r.trim()).filter(Boolean);
      const [ev, pol, me] = await Promise.all([queryRows(tab.connectionId, evidenceSql(schema, table, names), 100), queryRows(tab.connectionId, policiesSql(schema, table), 100), queryRows(tab.connectionId, "SELECT current_user", 1)]);
      const found = ev.rows.map((r) => readEvidence(ev.columns, r));
      const missing = names.filter((n) => !found.some((f) => f.role === n));
      if (missing.length) setError(`No such role: ${missing.join(", ")}`);
      setEvidence({ roles: found, policies: pol, login: me.rows[0]?.[0] ?? "?" });
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  /** Runs one case as its identity: a transaction that's always rolled back, then a check that it was. */
  const runCase = async (c: Case) => {
    let outcome: Outcome;
    let sample: { columns: string[]; rows: (string | null)[][] } | undefined;
    try {
      for (const s of asIdentity(c.role, c.claims)) {
        const failed = await executeStatement(tab.connectionId, s, session, false);
        if (failed) throw new Error(`${s}: ${failed.message}`);
      }
      const body = c.sql.trim().replace(/;\s*$/, "");
      try {
        const n = await queryRows(tab.connectionId, `SELECT count(*) FROM (${body}) onyx_visible`, 1, session);
        sample = await queryRows(tab.connectionId, `SELECT * FROM (${body}) onyx_visible LIMIT 20`, 20, session);
        outcome = classify(null, Number(n.rows[0]?.[0] ?? 0));
      } catch (e) {
        outcome = classify(toError(e).message, null);
      }
    } catch (e) {
      outcome = { kind: "error", message: toError(e).message };
    }
    await executeStatement(tab.connectionId, "ROLLBACK", session, false);
    // The identity must not leak into anything else run on this session.
    const after = await queryRows(tab.connectionId, "SELECT current_user", 1, session).catch(() => null);
    const cleaned = !!after && after.rows[0]?.[0] === evidence?.login;
    setResults((r) => ({ ...r, [c.id]: { outcome, sample, cleaned } }));
  };

  const runAll = async () => {
    setBusy(true);
    for (const c of cases) await runCase(c);
    setBusy(false);
  };
  const update = (i: number, p: Partial<Case>) => useCases.getState().set(cases.map((c, j) => (j === i ? { ...c, ...p } : c)));

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">The permissions debugger works on PostgreSQL (and Supabase).</div>;
  return (
    <Page title="Permissions and row visibility" intro="Why does a query return rows for you but none for the app's user? See the grants and row-level-security policies for a table, then run the query as each identity (with Supabase JWT claims if you use them) inside a transaction that's always rolled back. Only what that identity may see is shown.">
      <Step n={1} title="Table and identities">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Schema"><Text value={schema} onChange={setSchema} mono className="w-32" /></Labeled>
          <Labeled label="Table"><Select value={table} onChange={setTable} options={tables.map((t) => ({ value: t, label: t }))} placeholder="Pick a table" className="q-field h-7 w-52 px-2" /></Labeled>
          <Labeled label="Roles to check (comma-separated)"><Text value={roles} onChange={setRoles} mono className="w-72" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !table} onClick={() => void inspect()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldQuestion className="size-3.5" />} Inspect</Button>
        </div>
        <ErrorNote error={error} />
      </Step>
      {evidence && (
        <Step n={2} title="Evidence">
          {evidence.roles.some((r) => r.role === evidence.login) || true ? (
            <p className="text-muted">Onyx is signed in as <span className="font-mono">{evidence.login}</span>. {evidence.roles[0] && (evidence.roles[0].rlsEnabled ? `Row-level security is ON${evidence.roles[0].rlsForced ? " and FORCEd (owners too)" : ""}.` : "Row-level security is OFF for this table.")}</p>
          ) : null}
          <table className="w-full text-[11.5px]">
            <thead className="text-left text-[11px] text-faint"><tr><th className="py-1">Role</th><th>SELECT grant</th><th>Policies apply?</th><th>Onyx can test as it</th></tr></thead>
            <tbody>
              {evidence.roles.map((r) => {
                const p = policyApplies(r);
                return (
                  <tr key={r.role} className="border-t border-border align-top">
                    <td className="py-1 font-mono">{r.role}</td>
                    <td>{r.canSelect ? <Badge tone="good">granted</Badge> : <Badge tone="bad">no grant</Badge>}</td>
                    <td className="max-w-96 pr-2">{p.applies ? <Badge tone="accent">yes</Badge> : <Badge tone="warn">bypassed</Badge>} <span className="text-muted">{p.why}</span></td>
                    <td>{r.onyxCanBecome ? <Badge tone="good">yes</Badge> : <span className="text-warning">no: {evidence.login} isn't a member, so tests as {r.role} will be refused (never run as a stronger role)</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {evidence.policies.rows.length ? <RowsPreview columns={evidence.policies.columns} rows={evidence.policies.rows} /> : <p className="text-muted">No policies on this table{evidence.roles[0]?.rlsEnabled ? ": with RLS on, that means no rows are visible to roles it applies to." : "."}</p>}
          <p className="text-[11px] text-faint">Several permissive policies combine with OR, restrictive ones with AND; functions inside policies can't be explained here. The tests below show the actual outcome.</p>
        </Step>
      )}
      <Step n={3} title="Tests" right={<span className="flex gap-1.5 font-normal"><Button className="h-6" onClick={() => useCases.getState().set([...cases, { id: crypto.randomUUID(), name: "", role: "authenticated", claims: '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', sql: `SELECT * FROM ${schema}.${table || "orders"}`, expect: { kind: "allow", n: 1 } }])}><Plus className="size-3.5" /> Case</Button><Button variant="primary" className="h-6" disabled={busy || !cases.length || !evidence} onClick={() => void runAll()}><Play className="size-3.5 fill-current" /> Run all</Button></span>}>
        {!evidence && <p className="text-faint">Inspect a table first (it tells Onyx who it's signed in as, to check each test cleans up).</p>}
        {cases.map((c, i) => {
          const r = results[c.id];
          const ok = r ? passes(c.expect, r.outcome) : null;
          return (
            <div key={c.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
              <div className="flex flex-wrap items-end gap-2">
                <Labeled label="Name"><Text value={c.name} onChange={(name) => update(i, { name })} className="w-44" placeholder="owner sees own orders" /></Labeled>
                <Labeled label="As role"><Text value={c.role} onChange={(role) => update(i, { role })} mono className="w-36" /></Labeled>
                <Labeled label="Expect it" className="w-44"><Select value={c.expect.kind} onChange={(kind: Expectation["kind"]) => update(i, { expect: { ...c.expect, kind } })} options={(Object.keys(EXPECT_LABEL) as Expectation["kind"][]).map((k) => ({ value: k, label: EXPECT_LABEL[k] }))} className="q-field h-7 px-2" /></Labeled>
                {(c.expect.kind === "allow" || c.expect.kind === "exact") && <Labeled label="N"><Text value={String(c.expect.n)} onChange={(v) => update(i, { expect: { ...c.expect, n: Number(v.replace(/\D/g, "")) || 0 } })} mono className="w-16" /></Labeled>}
                <span className="flex-1" />
                {r && (ok ? <Badge tone="good"><CircleCheck className="mr-1 inline size-3" />pass</Badge> : <Badge tone="bad"><CircleX className="mr-1 inline size-3" />fail</Badge>)}
                <IconButton title="Remove" className="size-6" onClick={() => useCases.getState().set(cases.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton>
              </div>
              <Labeled label="Supabase JWT claims (optional JSON; set for this transaction only)"><Text value={c.claims} onChange={(claims) => update(i, { claims })} mono /></Labeled>
              <SqlArea value={c.sql} onChange={(sql) => update(i, { sql })} rows={2} />
              {r && (
                <div className="flex flex-col gap-1">
                  <p className={r.outcome.kind === "rows" ? "" : "text-danger"}>
                    {r.outcome.kind === "rows" ? `Sees ${r.outcome.count} row${r.outcome.count === 1 ? "" : "s"}.` : r.outcome.kind === "no-privilege" ? `No privilege: ${r.outcome.message} (not the same as seeing zero rows).` : r.outcome.message}
                    {!r.cleaned && <span className="ml-2 text-warning">Couldn't confirm the session went back to {evidence?.login}.</span>}
                  </p>
                  {r.sample && r.sample.rows.length > 0 && <RowsPreview columns={r.sample.columns} rows={r.sample.rows} max={5} />}
                </div>
              )}
            </div>
          );
        })}
        {Object.keys(results).length > 0 && connection && (
          <Button className="h-7 self-start" onClick={() => useInvestigations.getState().offer({ kind: "result", label: `Permissions: ${schema}.${table}`, connection: connectionRef(connection), complete: true, limits: "Tests show what these identities see now on this database; they don't prove isolation across APIs, storage or app code", data: { evidence, cases, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { outcome: v.outcome, cleaned: v.cleaned }])) } })}>
            <FolderSearch className="size-3.5" /> Save to investigation
          </Button>
        )}
      </Step>
    </Page>
  );
}
