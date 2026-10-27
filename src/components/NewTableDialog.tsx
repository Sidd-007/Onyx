import { ChevronDown, GripVertical, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ENGINE_LABEL, type ConnectionConfig } from "../lib/ipc";
import {
  createTableStatements,
  hasAutoIncrement,
  hasForeignKeys,
  newColumn,
  problems,
  starterColumns,
  TYPE_SUGGESTIONS,
  type NewColumn,
  type NewForeignKey,
  type NewIndex,
} from "../lib/newTable";
import { executeStatement, openSql, openTable } from "../store/actions";
import { useConnections } from "../store/connections";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button, EnvBadge, IconButton } from "./ui";

const GRID = "grid grid-cols-[16px_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_40px_40px_40px_44px_24px] items-center gap-x-2";

/** Design a new table: columns, types, keys; see the CREATE TABLE as you go, then run it. */
export function NewTableDialog({ connection, schema, onClose }: { connection: ConnectionConfig; schema: string; onClose(): void }) {
  const engine = connection.engine;
  const mongo = engine === "mongodb";
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<NewColumn[]>(() => starterColumns(engine));
  const [indexes, setIndexes] = useState<NewIndex[]>([]);
  const [foreignKeys, setForeignKeys] = useState<NewForeignKey[]>([]);
  const [creating, setCreating] = useState(false);
  // Tables a foreign key can point at, from the completion catalog.
  type Columns = (string | { label: string })[];
  const catalog = useConnections((s) => s.completion[connection.id]) as Record<string, Record<string, Columns>> | undefined;
  const targets = useMemo(
    () =>
      Object.entries(catalog ?? {}).flatMap(([s, tables]) =>
        Object.entries(tables).map(([t, cols]) => ({ schema: s, table: t, columns: cols.map((c) => (typeof c === "string" ? c : c.label)) })),
      ),
    [catalog],
  );
  const columnNames = columns.map((c) => c.name.trim()).filter(Boolean);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusId = useRef<string | null>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const issue = mongo ? (name.trim() ? null : "Name the collection") : problems(engine, name, columns);
  const statements = useMemo(
    () =>
      mongo
        ? [`db.createCollection(${JSON.stringify(name.trim() || "collection")})`]
        : createTableStatements(engine, schema, name || "new_table", columns, indexes, foreignKeys),
    [mongo, engine, schema, name, columns, indexes, foreignKeys],
  );
  const sql = statements.map((s) => (mongo ? s : `${s};`)).join("\n\n");

  const update = (id: string, patch: Partial<NewColumn>) =>
    setColumns((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        // A key is never NULL; auto-increment implies the key (except where a sequence does it).
        if (patch.primaryKey) next.nullable = false;
        if (patch.autoIncrement && engine !== "postgres" && engine !== "duckdb") next.primaryKey = true;
        if (next.autoIncrement) next.nullable = false;
        return next;
      }),
    );
  const addColumn = () => {
    const c = newColumn();
    focusId.current = c.id;
    setColumns((cs) => [...cs, c]);
  };
  const move = (from: number, to: number) =>
    setColumns((cs) => {
      if (to < 0 || to >= cs.length) return cs;
      const copy = [...cs];
      const [c] = copy.splice(from, 1);
      copy.splice(to, 0, c);
      return copy;
    });

  const create = async () => {
    if (issue || creating || connection.readOnly) return;
    setCreating(true);
    setError(null);
    const failed = await executeStatement(connection.id, mongo ? statements[0] : `${statements.join(";\n")};`);
    setCreating(false);
    if (failed) return setError(failed.message);
    toast(`Created ${name.trim()}`, "success");
    await useConnections.getState().refreshSchema(connection.id);
    onClose();
    if (!mongo) openTable(connection.id, schema, name.trim(), "structure");
  };

  const suggestions = (TYPE_SUGGESTIONS[engine] ?? []).map((t) => ({ value: t, label: t }));
  const auto = hasAutoIncrement(engine);

  return (
    <Modal onClose={() => !creating && onClose()} width="max-w-4xl">
      <div
        className="flex max-h-[76vh] flex-col"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            void create();
          }
        }}
      >
        <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
          <h2 className="font-semibold">{mongo ? "New collection" : "New table"}</h2>
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            in <span className="font-mono text-fg">{schema}</span> on {connection.name} · {ENGINE_LABEL[engine]}
            <EnvBadge environment={connection.environment} />
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-[12px]">
          <label className="flex flex-col gap-1.5">
            <span className="q-label">{mongo ? "Collection name" : "Table name"}</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={mongo ? "events" : "orders"}
              spellCheck={false}
              className="q-field h-8 w-72 px-2.5 font-mono text-[12.5px]"
            />
          </label>

          {!mongo && (
            <div className="flex flex-col gap-1.5">
              <div className={`${GRID} px-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint`}>
                <span />
                <span>Column</span>
                <span>Type</span>
                <span>Default</span>
                <span className="text-center" data-tip="Primary key">Key</span>
                <span className="text-center" data-tip="Allows NULL">Null</span>
                <span className="text-center" data-tip={auto ? "Auto-increment" : "ClickHouse has no auto-increment"}>Auto</span>
                <span className="text-center">Unique</span>
                <span />
              </div>
              {columns.map((c, i) => (
                <div key={c.id} className={`${GRID} group rounded-lg px-1 py-1 hover:bg-hover`}>
                  <span className="flex flex-col items-center text-faint">
                    <button type="button" aria-label="Move up" className="h-2.5 leading-none hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)}>
                      ▴
                    </button>
                    <GripVertical className="size-3 opacity-0 group-hover:opacity-60" />
                    <button type="button" aria-label="Move down" className="h-2.5 leading-none hover:text-fg disabled:opacity-30" disabled={i === columns.length - 1} onClick={() => move(i, i + 1)}>
                      ▾
                    </button>
                  </span>
                  <span className="relative flex items-center">
                    {c.primaryKey && <KeyRound className="pointer-events-none absolute left-2 size-3 text-warning" />}
                    <input
                      ref={(el) => {
                        if (el && focusId.current === c.id) {
                          el.focus();
                          focusId.current = null;
                        }
                      }}
                      value={c.name}
                      placeholder="column_name"
                      spellCheck={false}
                      onChange={(e) => update(c.id, { name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.metaKey && i === columns.length - 1) addColumn();
                      }}
                      className={`q-field h-7 w-full px-2 font-mono text-[12px] ${c.primaryKey ? "pl-6" : ""}`}
                    />
                  </span>
                  <span className="relative flex items-center">
                    <input
                      value={c.type}
                      placeholder="type"
                      spellCheck={false}
                      onChange={(e) => update(c.id, { type: e.target.value })}
                      className="q-field h-7 w-full pl-2 pr-7 font-mono text-[12px]"
                    />
                    <span className="absolute right-0.5 flex">
                      <Select value={c.type} options={suggestions} onChange={(type) => update(c.id, { type })} title="Common types" className="h-6 rounded-md px-1 text-faint hover:bg-hover hover:text-fg">
                        <ChevronDown className="size-3.5" />
                      </Select>
                    </span>
                  </span>
                  <input
                    value={c.default}
                    placeholder={c.autoIncrement ? "auto" : "none"}
                    disabled={c.autoIncrement}
                    spellCheck={false}
                    onChange={(e) => update(c.id, { default: e.target.value })}
                    className="q-field h-7 w-full px-2 font-mono text-[12px] disabled:opacity-40"
                    data-tip="SQL: 'text', 0, now()"
                  />
                  <span className="flex justify-center">
                    <input type="checkbox" checked={c.primaryKey} onChange={(e) => update(c.id, { primaryKey: e.target.checked })} aria-label="Primary key" />
                  </span>
                  <span className="flex justify-center">
                    <input type="checkbox" checked={c.nullable} disabled={c.primaryKey || c.autoIncrement} onChange={(e) => update(c.id, { nullable: e.target.checked })} aria-label="Allows NULL" />
                  </span>
                  <span className="flex justify-center">
                    <input type="checkbox" checked={c.autoIncrement} disabled={!auto} onChange={(e) => update(c.id, { autoIncrement: e.target.checked })} aria-label="Auto-increment" />
                  </span>
                  <span className="flex justify-center">
                    <input type="checkbox" checked={c.unique} disabled={c.primaryKey || engine === "clickhouse"} onChange={(e) => update(c.id, { unique: e.target.checked })} aria-label="Unique" />
                  </span>
                  <IconButton title="Remove column" className="size-6 opacity-0 group-hover:opacity-100" onClick={() => setColumns((cs) => cs.filter((x) => x.id !== c.id))}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button variant="ghost" className="h-7" onClick={addColumn}>
                  <Plus className="size-3.5" /> Add column
                </Button>
              </div>
            </div>
          )}

          {!mongo && engine !== "clickhouse" && (
            <div className="grid grid-cols-2 gap-4">
              <section className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium text-muted">Indexes</span>
                {indexes.map((ix) => (
                  <div key={ix.id} className="group flex flex-wrap items-center gap-1 rounded-lg border border-border bg-panel p-1.5">
                    {columnNames.map((c) => {
                      const on = ix.columns.includes(c);
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() =>
                            setIndexes((all) => all.map((x) => (x.id !== ix.id ? x : { ...x, columns: on ? x.columns.filter((y) => y !== c) : [...x.columns, c] })))
                          }
                          className={`h-5 rounded-md px-1.5 font-mono text-[11px] ${on ? "bg-accent text-accent-fg" : "bg-input text-muted hover:text-fg"}`}
                        >
                          {on && ix.columns.length > 1 ? `${ix.columns.indexOf(c) + 1}·` : ""}
                          {c}
                        </button>
                      );
                    })}
                    <span className="flex-1" />
                    <label className="flex items-center gap-1 text-[11px] text-muted">
                      <input type="checkbox" checked={ix.unique} onChange={(e) => setIndexes((all) => all.map((x) => (x.id === ix.id ? { ...x, unique: e.target.checked } : x)))} />
                      unique
                    </label>
                    <IconButton title="Remove index" className="size-5" onClick={() => setIndexes((all) => all.filter((x) => x.id !== ix.id))}>
                      <Trash2 className="size-3" />
                    </IconButton>
                  </div>
                ))}
                <div>
                  <Button variant="ghost" className="h-7" disabled={!columnNames.length} onClick={() => setIndexes((all) => [...all, { id: crypto.randomUUID(), columns: [], unique: false }])}>
                    <Plus className="size-3.5" /> Add index
                  </Button>
                </div>
              </section>
              {hasForeignKeys(engine) && (
                <section className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-muted">Foreign keys</span>
                  {foreignKeys.map((fk) => {
                    const target = targets.find((t) => t.schema === fk.refSchema && t.table === fk.refTable);
                    const set = (patch: Partial<NewForeignKey>) => setForeignKeys((all) => all.map((x) => (x.id === fk.id ? { ...x, ...patch } : x)));
                    return (
                      <div key={fk.id} className="flex items-center gap-1 rounded-lg border border-border bg-panel p-1.5 text-[11.5px]">
                        <Select value={fk.column} placeholder="column" onChange={(column) => set({ column })} options={columnNames.map((c) => ({ value: c, label: c }))} className="q-field h-6 w-24 px-1.5 font-mono text-[11.5px]" />
                        <span className="text-faint">→</span>
                        <Select<string>
                          value={`${fk.refSchema}.${fk.refTable}`}
                          placeholder="table"
                          onChange={(v) => {
                            const t = targets.find((x) => `${x.schema}.${x.table}` === v);
                            if (t) set({ refSchema: t.schema, refTable: t.table, refColumn: t.columns.includes("id") ? "id" : (t.columns[0] ?? "") });
                          }}
                          options={targets.map((t) => ({ value: `${t.schema}.${t.table}`, label: t.schema === schema ? t.table : `${t.schema}.${t.table}` }))}
                          className="q-field h-6 min-w-0 flex-1 px-1.5 font-mono text-[11.5px]"
                        />
                        <Select value={fk.refColumn} placeholder="column" onChange={(refColumn) => set({ refColumn })} options={(target?.columns ?? []).map((c) => ({ value: c, label: c }))} className="q-field h-6 w-20 px-1.5 font-mono text-[11.5px]" />
                        {engine !== "duckdb" && (
                          <Select
                            value={fk.onDelete}
                            title="On delete"
                            onChange={(onDelete) => set({ onDelete })}
                            options={(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL"] as const).map((a) => ({ value: a, label: a.toLowerCase() }))}
                            className="q-field h-6 w-24 px-1.5 text-[11px]"
                          />
                        )}
                        <IconButton title="Remove foreign key" className="size-5" onClick={() => setForeignKeys((all) => all.filter((x) => x.id !== fk.id))}>
                          <Trash2 className="size-3" />
                        </IconButton>
                      </div>
                    );
                  })}
                  <div>
                    <Button
                      variant="ghost"
                      className="h-7"
                      disabled={!columnNames.length || !targets.length}
                      title={targets.length ? undefined : "No tables to point at yet"}
                      onClick={() =>
                        setForeignKeys((all) => [
                          ...all,
                          { id: crypto.randomUUID(), column: columnNames.find((c) => c.endsWith("_id")) ?? columnNames[0], refSchema: "", refTable: "", refColumn: "", onDelete: "NO ACTION" },
                        ])
                      }
                    >
                      <Plus className="size-3.5" /> Add foreign key
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium text-muted">{mongo ? "Command" : "SQL"}</span>
            <pre className="max-h-48 select-text overflow-auto rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-fg">{sql}</pre>
          </div>
          {error && <p className="select-text rounded-lg bg-danger-soft px-3 py-2 text-danger">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-border bg-panel px-5 py-3">
          <span className="mr-auto text-[11.5px] text-faint">
            {connection.readOnly ? "This connection is read-only." : (issue ?? "⌘↵ creates the table")}
          </span>
          <Button onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onClose();
              openSql(sql, connection.id, { title: `CREATE ${name.trim() || "table"}` });
            }}
          >
            Open in editor
          </Button>
          <Button variant="primary" disabled={!!issue || creating || connection.readOnly} onClick={() => void create()}>
            {creating ? "Creating…" : mongo ? "Create collection" : "Create table"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
