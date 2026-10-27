import { Building2, FolderSearch, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { literal } from "../lib/filters";
import { api, toError } from "../lib/ipc";
import { pageSql } from "../lib/sqlGen";
import { quoteIdent } from "../lib/sqlSplit";
import { queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Button, IconButton } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, SqlArea, Step, Text } from "./workbench";
import { vaultStorage } from "../lib/vaultStorage";

interface Recipe {
  name: string;
  schema: string;
  /** The column naming the tenant in every scoped table (tenant_id, org_id…). */
  column: string;
  templates: { name: string; sql: string }[];
}

const useRecipes = create<{ recipes: Recipe[]; save(r: Recipe): void }>()(persist((set) => ({ recipes: [], save: (r) => set((s) => ({ recipes: [...s.recipes.filter((x) => x.name !== r.name), r] })) }), { name: "onyx.tenant-recipes", storage: vaultStorage }));

/**
 * F10: one tenant's data, consistently scoped. Tables with the tenant column are browsed with
 * it bound; tables without it are shown as shared (unscoped). Arbitrary SQL is never rewritten
 * to add a tenant filter, and the database's own access rules still apply. Reads only.
 */
export default function TenantView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const engine = connection?.engine ?? "postgres";
  const recipes = useRecipes((s) => s.recipes);
  const [r, setR] = useState<Recipe>(recipes[0] ?? { name: "default", schema: useUi.getState().sidebarSchema[tab.connectionId] ?? "public", column: "tenant_id", templates: [{ name: "Recent orders", sql: "SELECT * FROM orders WHERE tenant_id = :tenant ORDER BY id DESC LIMIT 50" }] });
  const [tenant, setTenant] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [tables, setTables] = useState<{ name: string; scoped: boolean; count?: number | string }[]>([]);
  const [view, setView] = useState<{ title: string; tenant: string; columns: string[]; rows: (string | null)[][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = (n: string) => quoteIdent(n, engine);
  const bind = (sql: string, t: string) => sql.replace(/:tenant\b/g, literal(t, engine));

  useEffect(() => {
    void api.completionTables(tab.connectionId).then((all) => setTables(all.filter((t) => t.schema === r.schema).map((t) => ({ name: t.name, scoped: t.columns.includes(r.column) }))), () => {});
  }, [tab.connectionId, r.schema, r.column]);

  /** Switching tenant is explicit: live views are cleared; saved evidence keeps its own tenant. */
  const open = async () => {
    if (!tenant.trim()) return;
    setBusy(true);
    setError(null);
    setActive(tenant.trim());
    setView(null);
    try {
      const counted = await Promise.all(tables.map(async (t) => (t.scoped ? { ...t, count: (await queryRows(tab.connectionId, `SELECT count(*) FROM ${q(r.schema)}.${q(t.name)} WHERE ${q(r.column)} = ${literal(tenant.trim(), engine)}`, 1).catch((e) => ({ rows: [[`error: ${toError(e).message}`]] }))).rows[0]?.[0] ?? "?" } : { ...t, count: undefined })));
      setTables(counted);
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };
  const browse = async (name: string) => {
    if (!active) return;
    const out = await queryRows(tab.connectionId, pageSql(engine, `SELECT * FROM ${q(r.schema)}.${q(name)} WHERE ${q(r.column)} = ${literal(active, engine)}`, false, 200, 0), 200).catch((e) => (setError(toError(e).message), null));
    if (out) setView({ title: name, tenant: active, ...out });
  };
  const runTemplate = async (t: Recipe["templates"][number]) => {
    if (!active) return;
    if (!/:tenant\b/.test(t.sql)) return setError(`“${t.name}” doesn't use :tenant: it would run unscoped. Add the tenant parameter.`);
    const out = await queryRows(tab.connectionId, bind(t.sql, active), 1000).catch((e) => (setError(toError(e).message), null));
    if (out) setView({ title: t.name, tenant: active, ...out });
  };
  const set = (p: Partial<Recipe>) => setR((x) => ({ ...x, ...p }));

  return (
    <Page title="Tenant workspace" intro="Investigate one customer's data without re-typing their id or drifting into another tenant's rows. Tables that have the tenant column are browsed with it bound; tables that don't are listed as shared. This is a convenience for reading, not tenant isolation: the database's own permissions still decide what's visible." actions={active && <Badge tone="accent"><Building2 className="mr-1 inline size-3" />tenant {active}</Badge>}>
      <Step n={1} title="Recipe" right={<Button variant="ghost" className="h-6 font-normal" onClick={() => useRecipes.getState().save(r)}>Save recipe</Button>}>
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Name"><Text value={r.name} onChange={(name) => set({ name })} className="w-40" /></Labeled>
          <Labeled label="Schema"><Text value={r.schema} onChange={(schema) => set({ schema })} mono className="w-32" /></Labeled>
          <Labeled label="Tenant column (in each scoped table)"><Text value={r.column} onChange={(column) => set({ column })} mono className="w-40" /></Labeled>
          {recipes.length > 0 && <span className="text-faint">Saved: {recipes.map((x) => <button key={x.name} type="button" className="mr-1 text-accent" onClick={() => setR(x)}>{x.name}</button>)}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-muted">Approved queries (use :tenant; it's bound as a value, the SQL isn't rewritten)</span>
          {r.templates.map((t, i) => (
            <div key={i} className="flex items-start gap-2">
              <Text value={t.name} onChange={(name) => set({ templates: r.templates.map((x, j) => (j === i ? { ...x, name } : x)) })} className="w-40" />
              <div className="flex-1"><SqlArea value={t.sql} onChange={(sql) => set({ templates: r.templates.map((x, j) => (j === i ? { ...x, sql } : x)) })} rows={1} /></div>
              <IconButton title="Remove" className="size-7" onClick={() => set({ templates: r.templates.filter((_, j) => j !== i) })}><Trash2 className="size-3.5" /></IconButton>
            </div>
          ))}
          <Button variant="ghost" className="h-6 self-start" onClick={() => set({ templates: [...r.templates, { name: "", sql: "SELECT * FROM … WHERE tenant_id = :tenant" }] })}><Plus className="size-3.5" /> Query</Button>
        </div>
      </Step>
      <Step n={2} title="Tenant">
        <div className="flex items-end gap-2">
          <Labeled label={`${r.column} value`}><Text value={tenant} onChange={setTenant} mono className="w-56" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !tenant.trim()} onClick={() => void open()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Building2 className="size-3.5" />} {active ? "Switch to this tenant" : "Open"}</Button>
        </div>
        <ErrorNote error={error} />
      </Step>
      {active && (
        <Step n={3} title={`Data for tenant ${active}`}>
          <div className="grid grid-cols-3 gap-1.5">
            {tables.map((t) => (
              <button key={t.name} type="button" disabled={!t.scoped} onClick={() => void browse(t.name)} className={`flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-left ${t.scoped ? "hover:bg-hover" : "opacity-60"}`} title={t.scoped ? "" : `No ${r.column} column: shared by every tenant (not scoped)`}>
                <span className="truncate font-mono text-[11.5px]">{t.name}</span>
                {t.scoped ? <span className="text-[11px] tabular-nums text-muted">{t.count}</span> : <Badge tone="muted">shared</Badge>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {r.templates.map((t) => <Button key={t.name} className="h-6" onClick={() => void runTemplate(t)}><Play className="size-3 fill-current" /> {t.name || "query"}</Button>)}
          </div>
          {view && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2"><span className="font-medium">{view.title}</span><Badge tone="accent">tenant {view.tenant}</Badge><span className="flex-1" />{connection && <Button className="h-6" onClick={() => useInvestigations.getState().offer({ kind: "result", label: `${view.title} · tenant ${view.tenant}`, connection: connectionRef(connection), complete: view.rows.length < 200, limits: view.rows.length >= 200 ? "first 200 rows" : undefined, data: { tenant: view.tenant, columns: view.columns, rows: view.rows } })}><FolderSearch className="size-3.5" /> Save</Button>}</div>
              <RowsPreview columns={view.columns} rows={view.rows} max={200} />
            </div>
          )}
        </Step>
      )}
    </Page>
  );
}
