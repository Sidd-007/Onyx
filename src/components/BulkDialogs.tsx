import { Channel } from "@tauri-apps/api/core";
import { FileUp, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createTableSql } from "../lib/createTable";
import { GENERATORS, generate, pickGenerator, random, type Generator } from "../lib/fakeData";
import { formatCount } from "../lib/format";
import {
  api,
  defaultSchemaOf,
  ENGINE_LABEL,
  toError,
  type ColumnInfo,
  type ConnectionConfig,
  type CsvPreview,
  type ForeignKeyInfo,
  type ProgressEvent,
} from "../lib/ipc";
import { quoteIdent } from "../lib/sqlSplit";
import { queryRows } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import { runJob } from "../store/jobs";
import { useDialogs, type Dialog } from "../store/dialogs";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { CopyRelatedDialog } from "./CopyRelatedDialog";
import { NewTableDialog } from "./NewTableDialog";
import { Select } from "./Select";
import { Button, EnvBadge } from "./ui";

/** Renders whichever bulk dialog is open. */
export function BulkDialogs() {
  const dialog = useDialogs((s) => s.dialog);
  const close = () => useDialogs.getState().close();
  const connection = useConnections((s) => (dialog ? s.saved.find((c) => c.id === dialog.connectionId) : undefined));
  if (!dialog || !connection) return null;
  switch (dialog.kind) {
    case "import-csv":
      return <ImportCsv dialog={dialog} connection={connection} onClose={close} />;
    case "fake-data":
      return <FakeData dialog={dialog} connection={connection} onClose={close} />;
    case "copy":
      return <CopyRows dialog={dialog} connection={connection} onClose={close} />;
    case "dump":
      return <Dump dialog={dialog} connection={connection} onClose={close} />;
    case "restore":
      return <Restore dialog={dialog} connection={connection} onClose={close} />;
    case "new-table":
      return <NewTableDialog connection={connection} schema={dialog.schema} onClose={close} />;
    case "copy-related":
      return <CopyRelatedDialog connection={connection} schema={dialog.schema} table={dialog.table} onClose={close} />;
  }
}

function useProgress() {
  const [rows, setRows] = useState(0);
  const [bytes, setBytes] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const channel = () => {
    setRows(0);
    setBytes(null);
    setLog([]);
    const ch = new Channel<ProgressEvent>();
    ch.onmessage = (m) => {
      if (m.type === "progress") {
        if (m.rows != null) setRows(m.rows);
        if (m.bytes != null) setBytes(m.bytes);
      } else setLog((l) => [...l.slice(-200), m.line]);
    };
    return ch;
  };
  return { rows, bytes, log, channel };
}

function Frame({
  title,
  connection,
  children,
  footer,
  onClose,
  busy,
}: {
  title: ReactNode;
  connection: ConnectionConfig;
  children: ReactNode;
  footer: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  return (
    <Modal onClose={() => !busy && onClose()} width="max-w-2xl">
      <div className="max-h-[70vh] overflow-y-auto p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          {title}
          <span className="flex items-center gap-1.5 text-[12px] font-normal text-muted">
            on {connection.name} <EnvBadge environment={connection.environment} />
          </span>
        </h2>
        <div className="mt-3 flex flex-col gap-3 text-[12px]">{children}</div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border bg-panel px-5 py-3">{footer}</footer>
    </Modal>
  );
}

function ProdWarning({ connection, what }: { connection: ConnectionConfig; what: string }) {
  if (connection.environment !== "prod") return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 text-danger">
      <TriangleAlert className="size-3.5 shrink-0" /> This {what} writes to a prod database.
    </p>
  );
}

const select = "q-field h-6 px-1.5 text-[12px]";

// ---- CSV import ----

function ImportCsv({ dialog, connection, onClose }: { dialog: Extract<Dialog, { kind: "import-csv" }>; connection: ConnectionConfig; onClose(): void }) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [delimiter, setDelimiter] = useState(",");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress();

  useEffect(() => {
    void api.listColumns(dialog.connectionId, dialog.schema, dialog.table).then(setColumns, (e) => setError(toError(e).message));
  }, [dialog]);

  const choose = async () => {
    const path = await api.pickFile("Choose a CSV file", ["csv", "tsv", "txt"]).catch(() => null);
    if (!path) return;
    try {
      const p = await api.csvPreview(path);
      setPreview(p);
      setDelimiter(p.delimiter);
      // Match CSV headers to columns by name, ignoring case and punctuation.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      setMapping(p.headers.map((h) => columns.find((c) => norm(c.name) === norm(h))?.name ?? null));
      setError(null);
    } catch (e) {
      setError(toError(e).message);
    }
  };

  const run = async () => {
    if (!preview) return;
    setRunning(true);
    setError(null);
    try {
      const n = await api.importCsv(
        dialog.connectionId,
        dialog.schema,
        dialog.table,
        { path: preview.path, delimiter, hasHeader, mapping, emptyAsNull },
        connection.environment === "prod",
        progress.channel(),
      );
      toast(`Imported ${formatCount(n)} rows into ${dialog.table}`, "success");
      await useConnections.getState().refreshSchema(dialog.connectionId);
      onClose();
    } catch (e) {
      setError(toError(e).message);
      setRunning(false);
    }
  };

  const mapped = mapping.filter(Boolean).length;
  const pct = preview && progress.bytes ? Math.min(100, Math.round((progress.bytes / preview.sizeBytes) * 100)) : null;

  return (
    <Frame
      title={`Import CSV into ${dialog.table}`}
      connection={connection}
      onClose={onClose}
      busy={running}
      footer={
        <>
          {running && (
            <span className="mr-auto flex items-center gap-1.5 text-[12px] text-muted">
              <LoaderCircle className="size-3.5 animate-spin" /> {formatCount(progress.rows)} rows{pct !== null ? ` · ${pct}%` : ""}
            </span>
          )}
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant={connection.environment === "prod" ? "destructive" : "primary"} disabled={!preview || !mapped || running} onClick={() => void run()}>
            Import
          </Button>
        </>
      }
    >
      <p className="text-muted">Rows go in batches inside one transaction: if any row fails, nothing is imported.</p>
      <ProdWarning connection={connection} what="import" />
      <div className="flex items-center gap-2">
        <Button onClick={() => void choose()}>
          <FileUp className="size-3.5" /> {preview ? "Choose another file" : "Choose a CSV file"}
        </Button>
        {preview && (
          <span className="truncate font-mono text-[11.5px] text-muted" data-tip={preview.path}>
            {preview.path.split("/").pop()} · {(preview.sizeBytes / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
      </div>
      {preview && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-muted">
            <label className="flex items-center gap-1.5">
              Delimiter
              <input value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className={`${select} w-10 text-center font-mono`} />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} className="" />
              First row is a header
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} className="" />
              Empty fields are NULL
            </label>
          </div>
          <table className="w-full text-left">
            <thead className="text-[11px] text-faint">
              <tr>
                <th className="py-1 font-medium">CSV column</th>
                <th className="py-1 font-medium">Sample</th>
                <th className="py-1 font-medium">Goes into</th>
              </tr>
            </thead>
            <tbody>
              {preview.headers.map((h, i) => {
                const target = columns.find((c) => c.name === mapping[i]);
                return (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-3 font-medium">{hasHeader ? h || `column ${i + 1}` : `column ${i + 1}`}</td>
                    <td className="max-w-48 truncate py-1 pr-3 font-mono text-[11px] text-muted">
                      {(hasHeader ? preview.rows : [preview.headers, ...preview.rows]).slice(0, 3).map((r) => r[i] ?? "").join(" · ")}
                    </td>
                    <td className="py-1">
                      <Select
                        value={mapping[i] ?? ""}
                        onChange={(name) => setMapping((m) => m.map((v, j) => (j === i ? name || null : v)))}
                        options={[{ value: "", label: "Skip" }, ...columns.map((c) => ({ value: c.name, label: c.name, hint: c.dataType }))]}
                        className={`${select} inline-flex w-48`}
                      />
                      {target && <span className="ml-2 font-mono text-[10.5px] text-faint">{target.dataType}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {error && <p className="select-text text-danger">{error}</p>}
    </Frame>
  );
}

// ---- Generated test rows ----

function FakeData({ dialog, connection, onClose }: { dialog: Extract<Dialog, { kind: "fake-data" }>; connection: ConnectionConfig; onClose(): void }) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [fks, setFks] = useState<Map<string, ForeignKeyInfo>>(new Map());
  const [refs, setRefs] = useState<Record<string, string[]>>({});
  const [gens, setGens] = useState<Record<string, Generator>>({});
  const [count, setCount] = useState(100);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = connection.engine;

  useEffect(() => {
    void (async () => {
      try {
        const [cols, structure] = await Promise.all([
          api.listColumns(dialog.connectionId, dialog.schema, dialog.table),
          api.tableStructure(dialog.connectionId, dialog.schema, dialog.table),
        ]);
        const keys = new Map(structure.foreignKeys.filter((f) => f.columns.length === 1).map((f) => [f.columns[0], f]));
        setColumns(cols);
        setFks(keys);
        setGens(Object.fromEntries(cols.map((c) => [c.name, pickGenerator(c, keys.has(c.name))])));
        // Existing values for foreign keys, so generated rows point at real rows.
        const loaded: Record<string, string[]> = {};
        for (const [column, fk] of keys) {
          const q = (n: string) => quoteIdent(n, engine);
          const { rows } = await queryRows(
            dialog.connectionId,
            `SELECT DISTINCT ${q(fk.refColumns[0])} FROM ${q(fk.refSchema)}.${q(fk.refTable)} WHERE ${q(fk.refColumns[0])} IS NOT NULL LIMIT 1000`,
          );
          loaded[column] = rows.map((r) => r[0]).filter((v): v is string => v !== null);
        }
        setRefs(loaded);
      } catch (e) {
        setError(toError(e).message);
      }
    })();
  }, [dialog, engine]);

  const included = columns.filter((c) => gens[c.name] && gens[c.name] !== "skip");
  const rows = useMemo(() => {
    const r = random(seed);
    return Array.from({ length: Math.min(count, 100_000) }, (_, n) => included.map((c) => generate(gens[c.name], c, n, r, refs[c.name])));
  }, [included, gens, count, seed, refs]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const n = await api.insertRows(dialog.connectionId, dialog.schema, dialog.table, included.map((c) => c.name), rows);
      toast(`Inserted ${formatCount(n)} generated rows into ${dialog.table}`, "success");
      await useConnections.getState().refreshSchema(dialog.connectionId);
      onClose();
    } catch (e) {
      setError(toError(e).message);
      setRunning(false);
    }
  };

  const missingRefs = [...fks.keys()].filter((c) => gens[c] === "reference" && refs[c] && refs[c].length === 0);

  return (
    <Frame
      title={`Generate test rows for ${dialog.table}`}
      connection={connection}
      onClose={onClose}
      busy={running}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>
            Shuffle
          </Button>
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!included.length || running || count < 1} onClick={() => void run()}>
            {running ? "Inserting…" : `Insert ${formatCount(Math.min(count, 100_000))} rows`}
          </Button>
        </>
      }
    >
      <p className="text-muted">Made-up values, guessed from each column's name and type. One transaction; never on prod.</p>
      <label className="flex items-center gap-2 text-muted">
        Rows
        <input
          value={count}
          inputMode="numeric"
          onChange={(e) => setCount(Math.min(100_000, Number(e.target.value.replace(/\D/g, "")) || 0))}
          className={`${select} w-24`}
        />
        <span className="text-faint">up to 100,000</span>
      </label>
      <table className="w-full text-left">
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-t border-border">
              <td className="py-1 pr-3 font-medium">
                {c.name}
                <span className="ml-1.5 font-mono text-[10.5px] text-faint">{c.dataType}</span>
              </td>
              <td className="py-1 pr-3">
                <Select
                  value={gens[c.name] ?? "skip"}
                  onChange={(v: Generator) => setGens((g) => ({ ...g, [c.name]: v }))}
                  options={GENERATORS.filter((g) => g.value !== "reference" || fks.has(c.name)).map((g) => ({ value: g.value, label: g.label }))}
                  className={`${select} inline-flex w-44`}
                />
              </td>
              <td className="max-w-56 truncate py-1 font-mono text-[11px] text-muted">
                {gens[c.name] === "skip" ? "" : rows.slice(0, 3).map((r) => r[included.indexOf(c)] ?? "NULL").join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missingRefs.length > 0 && (
        <p className="text-danger">
          {missingRefs.join(", ")}: the referenced table is empty, so these would be NULL. Add rows there first.
        </p>
      )}
      {error && <p className="select-text text-danger">{error}</p>}
    </Frame>
  );
}

// ---- Copy rows to a connection ----

function CopyRows({ dialog, connection, onClose }: { dialog: Extract<Dialog, { kind: "copy" }>; connection: ConnectionConfig; onClose(): void }) {
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const targets = saved.filter((c) => isConnected(status[c.id]) && !c.readOnly);
  const [targetId, setTargetId] = useState(targets.find((c) => c.id !== connection.id)?.id ?? targets[0]?.id ?? "");
  const target = saved.find((c) => c.id === targetId);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [existing, setExisting] = useState<string[]>([]);
  const [table, setTable] = useState(dialog.name.replace(/\W+/g, "_"));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress();

  useEffect(() => {
    if (!target) return;
    void api.listSchemas(target.id).then((list) => {
      setSchemas(list);
      const preferred = defaultSchemaOf(target);
      setSchema(list.includes(preferred) ? preferred : (list[0] ?? ""));
    }, () => {});
  }, [target]);
  useEffect(() => {
    if (!target || !schema) return;
    void api.listObjects(target.id, schema).then((o) => setExisting(o.filter((x) => x.kind === "table").map((x) => x.name)), () => {});
  }, [target, schema]);

  const appending = existing.includes(table);
  const sameTable = target?.id === connection.id && schema === dialog.schema && table === dialog.table;

  const run = async () => {
    if (!target) return;
    setRunning(true);
    setError(null);
    try {
      let createSql: string | null = null;
      if (!appending) {
        const columns =
          dialog.table && dialog.schema
            ? (await api.listColumns(connection.id, dialog.schema, dialog.table)).map((c) => ({ name: c.name, dataType: c.dataType }))
            : (await queryRows(connection.id, `SELECT * FROM (${dialog.sql.replace(/;\s*$/, "")}) q LIMIT 0`)).columns.map((name) => ({ name }));
        createSql = createTableSql(target.engine, schema, table, columns, connection.engine);
      }
      const n = await api.copyRows({
        sourceId: connection.id,
        sql: dialog.sql.replace(/;\s*$/, ""),
        targetId: target.id,
        schema,
        table,
        columns: null,
        createSql,
        confirmed: target.environment === "prod",
        onProgress: progress.channel(),
      });
      toast(`Copied ${formatCount(n)} rows to ${target.name} · ${schema}.${table}`, "success");
      await useConnections.getState().refreshSchema(target.id);
      onClose();
    } catch (e) {
      setError(toError(e).message);
      setRunning(false);
    }
  };

  return (
    <Frame
      title={`Copy ${dialog.name}`}
      connection={connection}
      onClose={onClose}
      busy={running}
      footer={
        <>
          {running && (
            <span className="mr-auto flex items-center gap-1.5 text-muted">
              <LoaderCircle className="size-3.5 animate-spin" /> {formatCount(progress.rows)} rows copied
            </span>
          )}
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button
            variant={target?.environment === "prod" ? "destructive" : "primary"}
            disabled={!target || !schema || !table.trim() || running || sameTable}
            onClick={() => void run()}
          >
            {appending ? "Append rows" : "Create table and copy"}
          </Button>
        </>
      }
    >
      <p className="text-muted">Rows stream into the target in one transaction. Only connected, writable connections are listed.</p>
      {target && <ProdWarning connection={target} what="copy" />}
      <div className="grid grid-cols-[110px_1fr] items-center gap-2">
        <span className="text-muted">To connection</span>
        <Select
          value={targetId}
          onChange={setTargetId}
          options={targets.map((c) => ({ value: c.id, label: c.name, hint: ENGINE_LABEL[c.engine] }))}
          className={`${select} w-64`}
        />
        <span className="text-muted">Schema</span>
        <Select value={schema} onChange={setSchema} options={schemas.map((s) => ({ value: s, label: s }))} className={`${select} w-64`} />
        <span className="text-muted">Table</span>
        <span className="flex items-center gap-2">
          <input value={table} onChange={(e) => setTable(e.target.value)} list="copy-tables" className={`${select} w-56 font-mono`} />
          <datalist id="copy-tables">
            {existing.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="text-faint">{appending ? "exists: rows are appended (column names must match)" : "new table"}</span>
        </span>
      </div>
      {sameTable && <p className="text-danger">That's the same table.</p>}
      {error && <p className="select-text text-danger">{error}</p>}
    </Frame>
  );
}

// ---- Dump and restore ----

function ToolLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <pre className="max-h-40 select-text overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[10.5px] leading-relaxed text-muted">
      {lines.slice(-60).join("\n")}
    </pre>
  );
}

function Dump({ dialog, connection, onClose }: { dialog: Extract<Dialog, { kind: "dump" }>; connection: ConnectionConfig; onClose(): void }) {
  const [scope, setScope] = useState<"schema" | "all">(connection.engine === "postgres" ? "schema" : "all");
  const [format, setFormat] = useState<"plain" | "custom">("plain");
  const scoped = connection.engine === "postgres" || connection.engine === "mysql";

  // The dump runs in the background (status bar); a toast says when it's saved.
  const run = () => {
    const schema = connection.engine === "mysql" ? (dialog.schema ?? null) : scope === "schema" && scoped ? (dialog.schema ?? null) : null;
    void runJob(`Dump ${schema ?? connection.database ?? connection.name}`, async (job) => {
      const result = await api.dumpDatabase(connection.id, schema, format, job.progress());
      return result && `Saved ${(result.bytes / 1024 / 1024).toFixed(1)} MB to ${result.path}`;
    });
    onClose();
  };

  return (
    <Frame
      title="Dump database"
      connection={connection}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-faint">Runs in the background; you can keep working.</span>
          <Button onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={run}>
            Choose file and dump
          </Button>
        </>
      }
    >
      <p className="text-muted">
        Runs {connection.engine === "postgres" ? "pg_dump" : connection.engine === "mysql" ? "mysqldump" : "sqlite3 .dump"} with this
        connection's settings{connection.ssh ? ", through its SSH tunnel" : ""}. Reading only: nothing in the database changes.
      </p>
      {connection.engine === "postgres" && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "schema"} onChange={() => setScope("schema")} className="" />
            Schema <span className="font-mono">{dialog.schema}</span> only
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} className="" />
            The whole database <span className="font-mono">{connection.database}</span>
          </label>
          <label className="mt-1 flex items-center gap-2 text-muted">
            Format
            <Select
              value={format}
              onChange={(v: "plain" | "custom") => setFormat(v)}
              options={[
                { value: "plain", label: "Plain SQL (.sql)" },
                { value: "custom", label: "Custom (.dump, for pg_restore)" },
              ]}
              className={select}
            />
          </label>
        </div>
      )}
      {connection.engine === "mysql" && (
        <p>
          Database <span className="font-mono">{dialog.schema || connection.database}</span>, with routines, triggers and events.
        </p>
      )}
    </Frame>
  );
}

function Restore({ dialog, connection, onClose }: { dialog: Extract<Dialog, { kind: "restore" }>; connection: ConnectionConfig; onClose(): void }) {
  const [path, setPath] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress();
  const prod = connection.environment === "prod";

  const run = async () => {
    if (!path) return;
    setRunning(true);
    setError(null);
    try {
      await api.restoreDatabase(connection.id, path, connection.engine === "mysql" ? (dialog.schema ?? null) : null, prod, progress.channel());
      setDone(true);
      toast(`Restored ${path.split("/").pop()}`, "success");
      await useConnections.getState().refreshSchema(connection.id);
    } catch (e) {
      setError(toError(e).message);
    }
    setRunning(false);
  };

  return (
    <Frame
      title="Restore from a dump"
      connection={connection}
      onClose={onClose}
      busy={running}
      footer={
        <>
          {running && (
            <span className="mr-auto flex items-center gap-1.5 text-muted">
              <LoaderCircle className="size-3.5 animate-spin" /> Restoring…
            </span>
          )}
          <Button onClick={onClose} disabled={running}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button variant="destructive" disabled={!path || running} onClick={() => void run()}>
              Restore into {connection.name}
            </Button>
          )}
        </>
      }
    >
      <p className="flex items-start gap-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 text-danger">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        A dump runs its own statements, which can drop and replace tables and data in{" "}
        {connection.engine === "mysql" ? `database ${dialog.schema || connection.database}` : connection.database}. Check the file first.
      </p>
      <div className="flex items-center gap-2">
        <Button
          onClick={() =>
            void api
              .pickFile("Choose a dump file", ["sql", "dump", "backup", "txt"])
              .then((p) => p && setPath(p))
              .catch(() => {})
          }
        >
          <FileUp className="size-3.5" /> {path ? "Choose another file" : "Choose a dump file"}
        </Button>
        {path && <span className="truncate font-mono text-[11.5px] text-muted">{path}</span>}
      </div>
      <ToolLog lines={progress.log} />
      {error && <p className="select-text whitespace-pre-wrap text-danger">{error}</p>}
    </Frame>
  );
}
