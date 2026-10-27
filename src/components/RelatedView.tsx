import { ArrowLeft, ArrowRight, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { literal } from "../lib/filters";
import { api, toError, type StructureColumn, type TableStructure } from "../lib/ipc";
import { shown } from "../lib/privacy";
import { pageSql } from "../lib/sqlGen";
import { quoteIdent } from "../lib/sqlSplit";
import { useConnections } from "../store/connections";
import { useSettings } from "../store/settings";
import { useTabs, type QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { IconButton } from "./ui";

type Rows = { columns: string[]; rows: (string | null)[][] };
type Center = { schema: string; table: string; where: string };
type Card = { label: string; schema: string; table: string; where: string; rows: Rows; more: boolean; keyOf(row: (string | null)[]): string | null };

const CHILD_ROWS = 8;

/**
 * One row in the middle, the rows it points at (its foreign keys) on the left, and the rows
 * that point at it on the right. Click any row to move to it. Reads only.
 */
export default function RelatedView({ tab }: { tab: QueryTab }) {
  const engine = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId)?.engine) ?? "postgres";
  const privacy = useSettings((s) => s.privacy);
  const center: Center = { schema: tab.schema ?? "", table: tab.table ?? "", where: tab.filter ?? "" };
  const [history, setHistory] = useState<Center[]>([]);
  const [state, setState] = useState<{ row: Rows | null; parents: Card[]; children: Card[]; error?: string } | null>(null);

  const q = (n: string) => quoteIdent(n, engine);
  const from = (schema: string, table: string) => (schema ? `${q(schema)}.${q(table)}` : q(table));
  const eq = (columns: string[], values: (string | null)[]) => columns.map((c, i) => (values[i] === null ? `${q(c)} IS NULL` : `${q(c)} = ${literal(values[i]!, engine)}`)).join(" AND ");
  const select = (schema: string, table: string, where: string, limit: number) => pageSql(engine, `SELECT * FROM ${from(schema, table)} WHERE ${where}`, false, limit, 0);
  const keyColumns = (cols: StructureColumn[], all: string[]) => {
    const pk = cols.filter((c) => c.primaryKey).map((c) => c.name);
    return pk.length ? pk : all;
  };
  const keyFn = (columns: string[], key: string[]) => (row: (string | null)[]) => {
    const idx = key.map((k) => columns.indexOf(k));
    return idx.some((i) => i < 0) ? null : eq(key, idx.map((i) => row[i]));
  };

  useEffect(() => {
    if (!center.table || !center.where) return;
    let live = true;
    setState(null);
    void (async () => {
      try {
        const id = tab.connectionId;
        const structure: TableStructure = await api.tableStructure(id, center.schema, center.table);
        const row = await api.adminQuery(id, select(center.schema, center.table, center.where, 1));
        if (!row.rows.length) {
          if (live) setState({ row: null, parents: [], children: [] });
          return;
        }
        const values = row.rows[0];
        const valueOf = (c: string) => values[row.columns.indexOf(c)] ?? null;
        const parents = await Promise.all(
          structure.foreignKeys
            .filter((fk) => fk.columns.every((c) => valueOf(c) !== null))
            .map(async (fk): Promise<Card | null> => {
              const where = eq(fk.refColumns, fk.columns.map(valueOf));
              const rows = await api.adminQuery(id, select(fk.refSchema, fk.refTable, where, 1)).catch(() => null);
              if (!rows?.rows.length) return null;
              return { label: `${fk.columns.join(", ")} →`, schema: fk.refSchema, table: fk.refTable, where, rows, more: false, keyOf: () => where };
            }),
        );
        const children = await Promise.all(
          structure.referencedBy
            .filter((r) => r.refColumns.every((c) => valueOf(c) !== null))
            .map(async (r): Promise<Card | null> => {
              const where = eq(r.columns, r.refColumns.map(valueOf));
              const [rows, cols] = await Promise.all([
                api.adminQuery(id, select(r.schema, r.table, where, CHILD_ROWS + 1)).catch(() => null),
                api.tableStructure(id, r.schema, r.table).then((s) => s.columns, () => [] as StructureColumn[]),
              ]);
              if (!rows?.rows.length) return null;
              const more = rows.rows.length > CHILD_ROWS;
              return {
                label: `← ${r.columns.join(", ")}`,
                schema: r.schema,
                table: r.table,
                where,
                rows: { columns: rows.columns, rows: rows.rows.slice(0, CHILD_ROWS) },
                more,
                keyOf: keyFn(rows.columns, keyColumns(cols, rows.columns)),
              };
            }),
        );
        if (live) setState({ row, parents: parents.filter((c): c is Card => !!c), children: children.filter((c): c is Card => !!c) });
      } catch (e) {
        if (live) setState({ row: null, parents: [], children: [], error: toError(e).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [tab.connectionId, center.schema, center.table, center.where]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (next: Center, back = false) => {
    if (!back) setHistory((h) => [...h, center]);
    useTabs.getState().update(tab.id, { schema: next.schema, table: next.table, filter: next.where, title: `Related · ${next.table}` });
  };
  const openTable = (schema: string, table: string, where: string) => {
    useUi.getState().showTabs();
    useTabs.getState().openTable(tab.connectionId, schema, table, "data", where);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <IconButton
          title="Back"
          disabled={!history.length}
          onClick={() => {
            const prev = history[history.length - 1];
            setHistory((h) => h.slice(0, -1));
            if (prev) go(prev, true);
          }}
        >
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <span className="font-medium">{center.table}</span>
        <code className="truncate font-mono text-[11px] text-muted">WHERE {center.where}</code>
        <span className="flex-1" />
        <span className="text-[11px] text-faint">Click a row to move to it</span>
      </div>
      {!state ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : state.error ? (
        <div className="m-4 text-[12px] text-danger">{state.error}</div>
      ) : !state.row ? (
        <div className="m-4 text-[12px] text-muted">That row isn't there any more.</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(0,1.2fr)_1fr] gap-4 overflow-y-auto p-4">
          <Column title="References" empty="No foreign keys from this row">
            {state.parents.map((c) => (
              <RowCard key={c.label + c.table} card={c} privacy={privacy} onPick={(where) => go({ schema: c.schema, table: c.table, where })} onOpen={() => openTable(c.schema, c.table, c.where)} />
            ))}
          </Column>
          <Column title="This row">
            <div className="rounded-xl border border-accent bg-panel shadow-sm">
              <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] font-medium">
                <KeyRound className="size-3.5 text-accent" /> {center.table}
                <span className="flex-1" />
                <IconButton title="Open in the table" className="size-5" onClick={() => openTable(center.schema, center.table, center.where)}>
                  <ExternalLink className="size-3" />
                </IconButton>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
                {state.row.columns.map((c, i) => (
                  <Field key={c} name={c} value={state.row!.rows[0][i]} privacy={privacy} />
                ))}
              </dl>
            </div>
          </Column>
          <Column title="Referenced by" empty="Nothing points at this row">
            {state.children.map((c) => (
              <RowCard key={c.label + c.table} card={c} privacy={privacy} onPick={(where) => go({ schema: c.schema, table: c.table, where })} onOpen={() => openTable(c.schema, c.table, c.where)} />
            ))}
          </Column>
        </div>
      )}
    </div>
  );
}

function Column({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode }) {
  const list = Array.isArray(children) ? children : [children];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{title}</div>
      {list.length ? children : <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">{empty}</div>}
    </div>
  );
}

function Field({ name, value, privacy }: { name: string; value: string | null; privacy: boolean }) {
  const text = shown(name, value, privacy);
  return (
    <>
      <dt className="truncate text-muted">{name}</dt>
      <dd className={`truncate font-mono text-[11.5px] ${value === null ? "text-faint italic" : ""}`} title={text ?? "NULL"}>
        {text ?? "NULL"}
      </dd>
    </>
  );
}

function RowCard({ card, privacy, onPick, onOpen }: { card: Card; privacy: boolean; onPick(where: string): void; onOpen(): void }) {
  const preview = card.rows.columns.slice(0, 4);
  return (
    <div className="rounded-xl border border-border bg-panel">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[12px]">
        <span className="font-medium">{card.table}</span>
        <span className="truncate text-[11px] text-faint">{card.label}</span>
        <span className="flex-1" />
        <IconButton title="Open these rows in the table" className="size-5" onClick={onOpen}>
          <ExternalLink className="size-3" />
        </IconButton>
      </div>
      <div className="flex flex-col py-1">
        {card.rows.rows.map((row, i) => {
          const where = card.keyOf(row);
          return (
            <button
              key={i}
              type="button"
              disabled={!where}
              onClick={() => where && onPick(where)}
              className="group flex items-center gap-2 px-3 py-1 text-left text-[11.5px] hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {preview.map((c, j) => (
                  <span key={c} className="mr-2">
                    <span className="text-faint">{c}=</span>
                    {shown(c, row[j], privacy) ?? "NULL"}
                  </span>
                ))}
              </span>
              <ArrowRight className="size-3 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
            </button>
          );
        })}
        {card.more && <div className="px-3 py-1 text-[11px] text-faint">More rows: open in the table</div>}
      </div>
    </div>
  );
}
