import { Check, Copy, KeyRound, LoaderCircle, Pencil, Plus, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { changeSql, FK_ACTIONS, mysqlDefaultSql, type ColumnDef, type FkAction, type SchemaChange } from "../lib/ddl";
import { formatCompact } from "../lib/format";
import { api, toError, type Engine, type TableStructure } from "../lib/ipc";
import { copyText, executeStatement, openTable } from "../store/actions";
import { useConnections } from "../store/connections";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

/**
 * Columns, indexes, foreign keys, incoming relations and DDL — editable. Changes are
 * staged, shown as SQL for review, then applied.
 */
export function StructureView({ connectionId, schema, table }: { connectionId: string; schema: string; table: string }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === connectionId));
  const connected = useConnections((s) => s.status[connectionId]?.state === "connected");
  const engine: Engine = connection?.engine ?? "postgres";
  // The structure editor writes ALTER TABLE for these; other engines change their schema in SQL.
  const editable = connected && !connection?.readOnly && ["postgres", "mysql", "sqlite", "duckdb"].includes(engine);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [changes, setChanges] = useState<SchemaChange[]>([]);
  const [review, setReview] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    api.tableStructure(connectionId, schema, table).then(
      (s) => live && setStructure(s),
      (e) => live && setError(toError(e).message),
    );
    return () => {
      live = false;
    };
  }, [connectionId, schema, table, connected, reloads]);

  // Columns as the editor holds them (MySQL defaults turned back into SQL).
  const original: ColumnDef[] = useMemo(
    () =>
      (structure?.columns ?? []).map((c) => ({
        name: c.name,
        type: c.dataType,
        nullable: c.nullable,
        default: engine === "mysql" ? mysqlDefaultSql(c.default, c.extra) : c.default,
        extra: c.extra,
        comment: c.comment,
      })),
    [structure, engine],
  );

  if (!connected) return <p className="p-4 text-[12px] text-muted">Connect to see this table's structure.</p>;
  if (error) return <p className="p-4 text-[12px] text-danger">{error}</p>;
  if (!structure) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    );
  }

  const add = (change: SchemaChange) => setChanges((cs) => [...cs, change]);
  const remove = (match: (c: SchemaChange) => boolean) => setChanges((cs) => cs.filter((c) => !match(c)));
  const columnNames = original.map((c) => c.name);
  let statements: string[] = [];
  let problem: string | null = null;
  try {
    statements = changes.flatMap((c) => changeSql(engine, schema, table, c));
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 p-4 pb-20">
          <ColumnsSection
            engine={engine}
            original={original}
            primary={new Set(structure.columns.filter((c) => c.primaryKey).map((c) => c.name))}
            changes={changes}
            editable={editable}
            onAdd={add}
            onRemove={remove}
          />
          <IndexesSection
            table={table}
            structure={structure}
            columnNames={columnNames}
            changes={changes}
            editable={editable}
            onAdd={add}
            onRemove={remove}
          />
          <ForeignKeysSection
            connectionId={connectionId}
            schema={schema}
            table={table}
            structure={structure}
            columnNames={columnNames}
            changes={changes}
            editable={editable}
            onAdd={add}
            onRemove={remove}
          />
          <Section title="Referenced by" count={structure.referencedBy.length}>
            {structure.referencedBy.length ? (
              <Table headers={["Table", "Columns", "Points at", "Constraint"]}>
                {structure.referencedBy.map((r) => (
                  <tr key={`${r.schema}.${r.table}.${r.name}`} className="border-t border-border">
                    <Td>
                      <button type="button" className="font-mono text-accent hover:underline" onClick={() => openTable(connectionId, r.schema, r.table)}>
                        {r.schema === schema ? r.table : `${r.schema}.${r.table}`}
                      </button>
                    </Td>
                    <Td mono muted>{r.columns.join(", ")}</Td>
                    <Td mono muted>{r.refColumns.join(", ")}</Td>
                    <Td muted>{r.name}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No other table points at this one.</Empty>
            )}
          </Section>
          <Section title="Constraints" count={structure.checks.length}>
            {structure.checks.length ? (
              <Table headers={["Name", "Kind", "Definition"]}>
                {structure.checks.map((c) => (
                  <tr key={c.name} className="border-t border-border">
                    <Td strong>{c.name}</Td>
                    <Td muted>{c.kind}</Td>
                    <Td mono muted>{c.definition}</Td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No CHECK or UNIQUE constraints besides the keys and indexes above.</Empty>
            )}
          </Section>
          <Section title="Triggers" count={structure.triggers.length}>
            {structure.triggers.length ? (
              <Table headers={["Name", "When", "Definition", ""]}>
                {structure.triggers.map((t) => (
                  <tr key={t.name} className="group border-t border-border">
                    <Td strong>{t.name}</Td>
                    <Td muted>{t.timing}</Td>
                    <Td mono muted>
                      <span className="line-clamp-3 whitespace-pre-wrap">{t.definition}</span>
                    </Td>
                    <td className="w-10 pr-2 text-right">
                      <span className="invisible inline-flex group-hover:visible">
                        <IconButton className="size-5" title="Copy definition" onClick={() => void copyText(t.definition, "Trigger copied")}>
                          <Copy className="size-3" />
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No triggers.</Empty>
            )}
          </Section>
          <Section
            title="DDL"
            action={
              <IconButton title="Copy CREATE statement" onClick={() => void copyText(structure.ddl, "CREATE statement copied")}>
                <Copy className="size-3.5" />
              </IconButton>
            }
          >
            <pre className="select-text overflow-x-auto rounded-lg border border-border bg-panel p-3 font-mono text-[11.5px] leading-relaxed">
              {structure.ddl}
            </pre>
          </Section>
        </div>
      </div>

      {changes.length > 0 && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-raised py-1 pl-3.5 pr-1 shadow-xl">
          <span className="text-[12px] font-medium">
            {changes.length} schema change{changes.length === 1 ? "" : "s"}
          </span>
          {problem && (
            <span className="flex max-w-80 items-center gap-1 text-[11.5px] text-danger" data-tip={problem}>
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="truncate">{problem}</span>
            </span>
          )}
          <Button variant="ghost" onClick={() => setChanges([])}>
            Discard
          </Button>
          <Button variant="primary" className="rounded-full" disabled={!!problem} onClick={() => setReview(true)}>
            Review & apply
          </Button>
        </div>
      )}

      {review && connection && (
        <ApplyDialog
          engine={engine}
          prod={connection.environment === "prod"}
          connectionName={connection.name}
          statements={statements}
          onCancel={() => setReview(false)}
          onApply={async () => {
            const result = await applyStatements(connectionId, engine, statements);
            if (result.error) return result;
            toast(`Applied ${statements.length} statement${statements.length === 1 ? "" : "s"} to ${table}`, "success");
            setReview(false);
            setChanges([]);
            setStructure(null);
            setReloads((n) => n + 1);
            await useConnections.getState().refreshSchema(connectionId);
            return result;
          }}
        />
      )}
    </div>
  );
}

/** Postgres, SQLite and DuckDB run them as one transaction; MySQL commits each DDL statement on its own. */
async function applyStatements(connectionId: string, engine: Engine, statements: string[]) {
  if (engine !== "mysql") {
    if (engine === "sqlite" || engine === "duckdb") {
      const error = await executeStatement(connectionId, `BEGIN;\n${statements.map((s) => `${s};`).join("\n")}\nCOMMIT;`);
      if (error) await executeStatement(connectionId, "ROLLBACK");
      return { applied: error ? 0 : statements.length, error: error?.message ?? null };
    }
    const error = await executeStatement(connectionId, statements.map((s) => `${s};`).join("\n"));
    return { applied: error ? 0 : statements.length, error: error?.message ?? null };
  }
  for (let i = 0; i < statements.length; i++) {
    const error = await executeStatement(connectionId, statements[i]);
    if (error) return { applied: i, error: `Statement ${i + 1} failed: ${error.message}` };
  }
  return { applied: statements.length, error: null };
}

function ApplyDialog(props: {
  engine: Engine;
  prod: boolean;
  connectionName: string;
  statements: string[];
  onCancel(): void;
  onApply(): Promise<{ applied: number; error: string | null }>;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ applied: number; error: string | null } | null>(null);
  return (
    <Modal onClose={() => !running && props.onCancel()} width="max-w-2xl">
      <div className="p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          {props.prod && <TriangleAlert className="size-4 text-danger" />}
          Apply schema changes on <span className={props.prod ? "text-danger" : ""}>{props.connectionName}</span>
          {props.prod && <span className="text-danger">(prod)</span>}
        </h2>
        <p className="mt-1 text-[12px] text-muted">
          {props.engine !== "mysql"
            ? "These run in one transaction: if one fails, none are applied."
            : "MySQL commits each schema statement on its own: if one fails, the ones before it stay applied."}
        </p>
        <pre className="mt-3 max-h-80 select-text overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[11.5px] leading-relaxed">
          {props.statements.map((s) => `${s};`).join("\n")}
        </pre>
        {result?.error && (
          <p className="mt-3 select-text text-[12px] text-danger">
            {result.error}
            {props.engine === "mysql" && result.applied > 0 && ` (${result.applied} applied before it.)`}
          </p>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border bg-panel px-5 py-3">
        <Button onClick={props.onCancel} disabled={running} autoFocus>
          Cancel
        </Button>
        <Button
          variant={props.prod ? "destructive" : "primary"}
          disabled={running || !props.statements.length}
          onClick={async () => {
            setRunning(true);
            setResult(await props.onApply());
            setRunning(false);
          }}
        >
          {running ? "Applying…" : `Apply ${props.statements.length} statement${props.statements.length === 1 ? "" : "s"}`}
        </Button>
      </footer>
    </Modal>
  );
}

// ---- Columns ----

type ChangeProps = {
  changes: SchemaChange[];
  editable: boolean;
  onAdd(change: SchemaChange): void;
  onRemove(match: (c: SchemaChange) => boolean): void;
};

function ColumnsSection({
  engine,
  original,
  primary,
  changes,
  editable,
  onAdd,
  onRemove,
}: ChangeProps & { engine: Engine; original: ColumnDef[]; primary: Set<string> }) {
  const [editing, setEditing] = useState<{ from: ColumnDef | null; draft: ColumnDef } | null>(null);
  const altered = (name: string) => changes.find((c) => c.kind === "alterColumn" && c.from.name === name) as
    | Extract<SchemaChange, { kind: "alterColumn" }>
    | undefined;
  const dropped = (name: string) => changes.some((c) => c.kind === "dropColumn" && c.name === name);
  const added = changes.filter((c): c is Extract<SchemaChange, { kind: "addColumn" }> => c.kind === "addColumn");

  const save = () => {
    if (!editing || !editing.draft.name.trim() || !editing.draft.type.trim()) return;
    const draft = { ...editing.draft, name: editing.draft.name.trim() };
    if (editing.from) {
      onRemove((c) => c.kind === "alterColumn" && c.from.name === editing.from!.name);
      const same = JSON.stringify({ ...draft, extra: null, comment: null }) === JSON.stringify({ ...editing.from, extra: null, comment: null });
      if (!same) onAdd({ kind: "alterColumn", from: editing.from, to: { ...draft, extra: editing.from.extra, comment: editing.from.comment } });
    } else {
      onAdd({ kind: "addColumn", column: draft });
    }
    setEditing(null);
  };

  const row = (c: ColumnDef, state: "added" | "altered" | "dropped" | null, actions: ReactNode, pk = false) => (
    <tr key={`${state}-${c.name}`} className={`group border-t border-border ${ROW_TINT[state ?? "none"]}`}>
      <td className="w-6 pl-2">{pk && <KeyRound className="size-3 text-warning" />}</td>
      <Td strong strike={state === "dropped"}>{c.name}</Td>
      <Td mono muted>{c.type}</Td>
      <Td>{c.nullable ? "yes" : <span className="text-muted">no</span>}</Td>
      <Td mono muted>{c.default ?? <span className="text-faint">—</span>}</Td>
      <Td muted>{c.extra ?? ""}</Td>
      <td className="w-16 pr-2 text-right">
        <span className="invisible inline-flex group-hover:visible">{actions}</span>
      </td>
    </tr>
  );

  return (
    <Section
      title="Columns"
      count={original.length}
      action={
        editable && (
          <Button
            variant="ghost"
            onClick={() =>
              setEditing({ from: null, draft: { name: "", type: engine === "mysql" ? "varchar(255)" : "text", nullable: true, default: null } })
            }
          >
            <Plus className="size-3" /> Column
          </Button>
        )
      }
    >
      <Table headers={["", "Name", "Type", "Nullable", "Default", "Extra", ""]}>
        {original.map((c) => {
          if (editing?.from?.name === c.name) return <ColumnEditor key={c.name} draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} onSave={save} onCancel={() => setEditing(null)} />;
          const change = altered(c.name);
          const isDropped = dropped(c.name);
          const shown = change ? change.to : c;
          return row(
            shown,
            isDropped ? "dropped" : change ? "altered" : null,
            editable && (
              <>
                {isDropped || change ? (
                  <IconButton
                    className="size-5"
                    title="Undo"
                    onClick={() => onRemove((x) => (x.kind === "dropColumn" && x.name === c.name) || (x.kind === "alterColumn" && x.from.name === c.name))}
                  >
                    <RotateCcw className="size-3" />
                  </IconButton>
                ) : null}
                {!isDropped && (
                  <IconButton className="size-5" title="Edit column" onClick={() => setEditing({ from: c, draft: { ...(change ? change.to : c) } })}>
                    <Pencil className="size-3" />
                  </IconButton>
                )}
                {!isDropped && !primary.has(c.name) && (
                  <IconButton className="size-5 hover:text-danger" title="Drop column" onClick={() => onAdd({ kind: "dropColumn", name: c.name })}>
                    <Trash2 className="size-3" />
                  </IconButton>
                )}
              </>
            ),
            primary.has(c.name),
          );
        })}
        {added.map((a) =>
          row(
            a.column,
            "added",
            <IconButton className="size-5" title="Remove" onClick={() => onRemove((x) => x === a)}>
              <X className="size-3" />
            </IconButton>,
          ),
        )}
        {editing && !editing.from && (
          <ColumnEditor draft={editing.draft} onChange={(d) => setEditing({ ...editing, draft: d })} onSave={save} onCancel={() => setEditing(null)} />
        )}
      </Table>
    </Section>
  );
}

function ColumnEditor({ draft, onChange, onSave, onCancel }: { draft: ColumnDef; onChange(d: ColumnDef): void; onSave(): void; onCancel(): void }) {
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onSave();
    if (e.key === "Escape") onCancel();
  };
  return (
    <tr className="border-t border-border bg-selected">
      <td />
      <td className="px-2 py-1">
        <input autoFocus value={draft.name} placeholder="name" onKeyDown={keys} onChange={(e) => onChange({ ...draft, name: e.target.value })} className={INPUT} />
      </td>
      <td className="px-2 py-1">
        <input value={draft.type} placeholder="type" onKeyDown={keys} onChange={(e) => onChange({ ...draft, type: e.target.value })} className={`${INPUT} font-mono`} />
      </td>
      <td className="px-3 py-1">
        <input type="checkbox" checked={draft.nullable} onChange={(e) => onChange({ ...draft, nullable: e.target.checked })} className="" />
      </td>
      <td className="px-2 py-1">
        <input
          value={draft.default ?? ""}
          placeholder="default (SQL)"
          onKeyDown={keys}
          onChange={(e) => onChange({ ...draft, default: e.target.value || null })}
          className={`${INPUT} font-mono`}
        />
      </td>
      <td />
      <td className="pr-2 text-right">
        <span className="inline-flex">
          <IconButton className="size-5 text-success" title="Keep this change" shortcut="↵" onClick={onSave}>
            <Check className="size-3.5" />
          </IconButton>
          <IconButton className="size-5" title="Cancel" shortcut="Esc" onClick={onCancel}>
            <X className="size-3.5" />
          </IconButton>
        </span>
      </td>
    </tr>
  );
}

// ---- Indexes ----

function IndexesSection({
  table,
  structure,
  columnNames,
  changes,
  editable,
  onAdd,
  onRemove,
}: ChangeProps & { table: string; structure: TableStructure; columnNames: string[] }) {
  const [draft, setDraft] = useState<{ name: string; named: boolean; columns: string[]; unique: boolean } | null>(null);
  const dropped = (name: string) => changes.some((c) => c.kind === "dropIndex" && c.name === name);
  const added = changes.filter((c): c is Extract<SchemaChange, { kind: "addIndex" }> => c.kind === "addIndex");
  const autoName = (cols: string[]) => `${table}_${cols.join("_") || "new"}_idx`.slice(0, 60);

  const toggleColumn = (c: string) =>
    setDraft((d) => {
      if (!d) return d;
      const columns = d.columns.includes(c) ? d.columns.filter((x) => x !== c) : [...d.columns, c];
      return { ...d, columns, name: d.named ? d.name : autoName(columns) };
    });

  return (
    <Section
      title="Indexes"
      count={structure.indexes.length}
      action={
        editable && !draft && (
          <Button variant="ghost" onClick={() => setDraft({ name: autoName([]), named: false, columns: [], unique: false })}>
            <Plus className="size-3" /> Index
          </Button>
        )
      }
    >
      <Table headers={["Name", "Columns", "Kind", "Size", "Used", ""]}>
        {structure.indexes.map((i) => (
          <tr key={i.name} className={`group border-t border-border ${dropped(i.name) ? ROW_TINT.dropped : ""}`}>
            <Td strong strike={dropped(i.name)}>{i.name}</Td>
            <Td mono muted>{i.columns.join(", ") || "(expression)"}</Td>
            <Td muted>{i.primary ? "primary key" : i.unique ? "unique" : "index"}</Td>
            <Td muted>{i.sizeBytes !== null ? formatBytes(i.sizeBytes) : "—"}</Td>
            <Td muted>
              {i.scans === null ? (
                "—"
              ) : i.scans === 0 && !i.primary && !i.unique ? (
                <span
                  className="rounded bg-danger-soft px-1 text-[10.5px] font-medium text-danger"
                  data-tip="No scans since statistics were last reset: it costs writes and space without speeding up reads"
                >
                  unused
                </span>
              ) : (
                `${formatCompact(i.scans)} scans`
              )}
            </Td>
            <td className="w-12 pr-2 text-right">
              {editable && !i.primary && (
                <span className="invisible inline-flex group-hover:visible">
                  {dropped(i.name) ? (
                    <IconButton className="size-5" title="Undo" onClick={() => onRemove((c) => c.kind === "dropIndex" && c.name === i.name)}>
                      <RotateCcw className="size-3" />
                    </IconButton>
                  ) : (
                    <IconButton className="size-5 hover:text-danger" title="Drop index" onClick={() => onAdd({ kind: "dropIndex", name: i.name })}>
                      <Trash2 className="size-3" />
                    </IconButton>
                  )}
                </span>
              )}
            </td>
          </tr>
        ))}
        {added.map((a) => (
          <tr key={a.name} className={`group border-t border-border ${ROW_TINT.added}`}>
            <Td strong>{a.name}</Td>
            <Td mono muted>{a.columns.join(", ")}</Td>
            <Td muted>{a.unique ? "unique" : "index"}</Td>
            <Td muted>new</Td>
            <Td muted>—</Td>
            <td className="w-12 pr-2 text-right">
              <IconButton className="size-5" title="Remove" onClick={() => onRemove((c) => c === a)}>
                <X className="size-3" />
              </IconButton>
            </td>
          </tr>
        ))}
        {draft && (
          <tr className="border-t border-border bg-selected">
            <td className="px-2 py-1.5 align-top">
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value, named: true })}
                className={INPUT}
                placeholder="index name"
              />
            </td>
            <td className="px-2 py-1.5" colSpan={4}>
              <div className="flex flex-wrap items-center gap-1">
                {columnNames.map((c) => {
                  const order = draft.columns.indexOf(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleColumn(c)}
                      className={`h-5 rounded px-1.5 font-mono text-[11px] ${order >= 0 ? "bg-accent text-accent-fg" : "bg-hover text-muted hover:text-fg"}`}
                    >
                      {order >= 0 && <span className="mr-1 opacity-70">{order + 1}</span>}
                      {c}
                    </button>
                  );
                })}
                <label className="ml-2 flex items-center gap-1 text-[11.5px] text-muted">
                  <input type="checkbox" checked={draft.unique} onChange={(e) => setDraft({ ...draft, unique: e.target.checked })} className="" />
                  unique
                </label>
              </div>
            </td>
            <td className="pr-2 text-right align-top">
              <span className="inline-flex">
                <IconButton
                  className="size-5 text-success"
                  title="Keep this index"
                  disabled={!draft.columns.length || !draft.name.trim()}
                  onClick={() => {
                    onAdd({ kind: "addIndex", name: draft.name.trim(), columns: draft.columns, unique: draft.unique });
                    setDraft(null);
                  }}
                >
                  <Check className="size-3.5" />
                </IconButton>
                <IconButton className="size-5" title="Cancel" onClick={() => setDraft(null)}>
                  <X className="size-3.5" />
                </IconButton>
              </span>
            </td>
          </tr>
        )}
      </Table>
    </Section>
  );
}

// ---- Foreign keys ----

function ForeignKeysSection({
  connectionId,
  schema,
  table,
  structure,
  columnNames,
  changes,
  editable,
  onAdd,
  onRemove,
}: ChangeProps & { connectionId: string; schema: string; table: string; structure: TableStructure; columnNames: string[] }) {
  type Columns = (string | { label: string })[];
  const raw = useConnections((s) => s.completion[connectionId]) as Record<string, Record<string, Columns>> | undefined;
  const namespace = useMemo(
    () =>
      raw &&
      Object.fromEntries(
        Object.entries(raw).map(([s, tables]) => [
          s,
          Object.fromEntries(Object.entries(tables).map(([t, cols]) => [t, cols.map((c) => (typeof c === "string" ? c : c.label))])),
        ]),
      ),
    [raw],
  );
  type Draft = { name: string; column: string; refSchema: string; refTable: string; refColumn: string; onDelete: FkAction; onUpdate: FkAction };
  const [draft, setDraft] = useState<Draft | null>(null);
  const dropped = (name: string) => changes.some((c) => c.kind === "dropForeignKey" && c.name === name);
  const added = changes.filter((c): c is Extract<SchemaChange, { kind: "addForeignKey" }> => c.kind === "addForeignKey");
  const targets = Object.entries(namespace ?? {}).flatMap(([s, tables]) => Object.keys(tables).map((t) => ({ schema: s, table: t })));
  const refColumns = draft ? (namespace?.[draft.refSchema]?.[draft.refTable] ?? []) : [];

  const start = () => {
    const column = columnNames.find((c) => c.endsWith("_id")) ?? columnNames[0] ?? "";
    const first = targets.find((t) => t.schema === schema && t.table !== table) ?? targets[0];
    setDraft({
      name: `fk_${table}_${column}`.slice(0, 60),
      column,
      refSchema: first?.schema ?? schema,
      refTable: first?.table ?? "",
      refColumn: namespace?.[first?.schema ?? ""]?.[first?.table ?? ""]?.[0] ?? "id",
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
    });
  };

  return (
    <Section
      title="Foreign keys"
      count={structure.foreignKeys.length}
      action={
        editable && !draft && (
          <Button variant="ghost" onClick={start}>
            <Plus className="size-3" /> Foreign key
          </Button>
        )
      }
    >
      <Table headers={["Name", "Column", "References", "On delete", "On update", ""]}>
        {structure.foreignKeys.map((f) => (
          <tr key={f.name} className={`group border-t border-border ${dropped(f.name) ? ROW_TINT.dropped : ""}`}>
            <Td strong strike={dropped(f.name)}>{f.name}</Td>
            <Td mono muted>{f.columns.join(", ")}</Td>
            <Td>
              <button type="button" className="font-mono text-accent hover:underline" onClick={() => openTable(connectionId, f.refSchema, f.refTable)}>
                {f.refTable}({f.refColumns.join(", ")})
              </button>
            </Td>
            <Td muted>{f.onDelete}</Td>
            <Td muted>{f.onUpdate}</Td>
            <td className="w-12 pr-2 text-right">
              {editable && (
                <span className="invisible inline-flex group-hover:visible">
                  {dropped(f.name) ? (
                    <IconButton className="size-5" title="Undo" onClick={() => onRemove((c) => c.kind === "dropForeignKey" && c.name === f.name)}>
                      <RotateCcw className="size-3" />
                    </IconButton>
                  ) : (
                    <IconButton className="size-5 hover:text-danger" title="Drop foreign key" onClick={() => onAdd({ kind: "dropForeignKey", name: f.name })}>
                      <Trash2 className="size-3" />
                    </IconButton>
                  )}
                </span>
              )}
            </td>
          </tr>
        ))}
        {added.map((a) => (
          <tr key={a.name} className={`border-t border-border ${ROW_TINT.added}`}>
            <Td strong>{a.name}</Td>
            <Td mono muted>{a.columns.join(", ")}</Td>
            <Td mono>{a.refTable}({a.refColumns.join(", ")})</Td>
            <Td muted>{a.onDelete}</Td>
            <Td muted>{a.onUpdate}</Td>
            <td className="w-12 pr-2 text-right">
              <IconButton className="size-5" title="Remove" onClick={() => onRemove((c) => c === a)}>
                <X className="size-3" />
              </IconButton>
            </td>
          </tr>
        ))}
        {draft && (
          <tr className="border-t border-border bg-selected">
            <td className="px-2 py-1">
              <input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={INPUT} />
            </td>
            <td className="px-2 py-1">
              <Select value={draft.column} onChange={(column) => setDraft({ ...draft, column })} options={columnNames.map((c) => ({ value: c, label: c }))} className={INPUT} />
            </td>
            <td className="px-2 py-1">
              <div className="flex gap-1">
                <Select<string>
                  value={`${draft.refSchema}.${draft.refTable}`}
                  onChange={(v) => {
                    const [s, ...t] = v.split(".");
                    const name = t.join(".");
                    setDraft({ ...draft, refSchema: s, refTable: name, refColumn: namespace?.[s]?.[name]?.[0] ?? "" });
                  }}
                  options={targets.map((t) => ({ value: `${t.schema}.${t.table}`, label: t.schema === schema ? t.table : `${t.schema}.${t.table}` }))}
                  className={INPUT}
                />
                <Select value={draft.refColumn} onChange={(refColumn) => setDraft({ ...draft, refColumn })} options={refColumns.map((c) => ({ value: c, label: c }))} className={INPUT} />
              </div>
            </td>
            <td className="px-2 py-1">
              <Select value={draft.onDelete} onChange={(onDelete: FkAction) => setDraft({ ...draft, onDelete })} options={FK_ACTIONS.map((a) => ({ value: a, label: a }))} className={INPUT} />
            </td>
            <td className="px-2 py-1">
              <Select value={draft.onUpdate} onChange={(onUpdate: FkAction) => setDraft({ ...draft, onUpdate })} options={FK_ACTIONS.map((a) => ({ value: a, label: a }))} className={INPUT} />
            </td>
            <td className="pr-2 text-right">
              <span className="inline-flex">
                <IconButton
                  className="size-5 text-success"
                  title="Keep this foreign key"
                  disabled={!draft.name.trim() || !draft.refTable || !draft.refColumn}
                  onClick={() => {
                    onAdd({
                      kind: "addForeignKey",
                      name: draft.name.trim(),
                      columns: [draft.column],
                      refSchema: draft.refSchema,
                      refTable: draft.refTable,
                      refColumns: [draft.refColumn],
                      onDelete: draft.onDelete,
                      onUpdate: draft.onUpdate,
                    });
                    setDraft(null);
                  }}
                >
                  <Check className="size-3.5" />
                </IconButton>
                <IconButton className="size-5" title="Cancel" onClick={() => setDraft(null)}>
                  <X className="size-3.5" />
                </IconButton>
              </span>
            </td>
          </tr>
        )}
      </Table>
      {!structure.foreignKeys.length && !added.length && !draft && <Empty>No foreign keys.</Empty>}
    </Section>
  );
}

// ---- Layout bits ----

const ROW_TINT: Record<"added" | "altered" | "dropped" | "none", string> = {
  added: "bg-selected",
  altered: "bg-hover",
  dropped: "bg-danger-soft text-muted line-through",
  none: "",
};

const INPUT =
  "q-field h-6 w-full min-w-0 px-1.5 text-[12px]";

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <header className="mb-1.5 flex h-6 items-center gap-2">
        <h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{title}</h3>
        {count !== undefined && <span className="text-[10.5px] tabular-nums text-faint">{count}</span>}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full select-text text-left text-[12px]">
        <thead className="bg-panel text-[11px] text-faint">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, mono, muted, strong, strike }: { children: ReactNode; mono?: boolean; muted?: boolean; strong?: boolean; strike?: boolean }) {
  return (
    <td
      className={`px-3 py-1.5 align-top ${mono ? "font-mono text-[11.5px] [overflow-wrap:anywhere]" : ""} ${muted ? "text-muted" : ""} ${strong ? "font-medium" : ""} ${
        strike ? "line-through" : ""
      }`}
    >
      {children}
    </td>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-faint">{children}</p>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
