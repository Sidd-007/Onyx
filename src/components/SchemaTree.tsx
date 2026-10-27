import {
  Braces,
  ChevronRight,
  Eye,
  Hash,
  KeyRound,
  Layers2,
  List,
  LoaderCircle,
  Pin,
  Plus,
  SquareFunction,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatCompact } from "../lib/format";
import { api, toError, type ColumnInfo, type ConnectionConfig, type DbObject, type DbObjectKind, type ExportFormat } from "../lib/ipc";
import { quoteIdent } from "../lib/sqlSplit";
import { mongoCollection, mongoFind, redisArg, redisReadCommand } from "../lib/nosql";
import { canCreateTables } from "../lib/newTable";
import { generateSql, type Statement } from "../lib/sqlGen";
import { copyText, executeStatement, exportRows, openAndRun, openSql, openTable, openTool } from "../store/actions";
import { useConnections } from "../store/connections";
import { useDialogs } from "../store/dialogs";
import { useWorkspace } from "../store/workspace";
import { EXPORT_LABELS } from "./ResultsPanel";
import { IconButton } from "./ui";
import { useOverlays } from "../store/overlays";
import { useTabs } from "../store/tabs";
import { toast } from "../store/toasts";

/** Lazily loads a value; reloads when `deps` change. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState({ error: toError(e).message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const TABLE_KINDS: DbObjectKind[] = ["table", "partitioned-table", "foreign-table", "collection", "key"];
const GROUPS: { kind: DbObjectKind; label: string }[] = [
  { kind: "view", label: "Views" },
  { kind: "materialized-view", label: "Materialized views" },
  { kind: "function", label: "Functions" },
  { kind: "procedure", label: "Procedures" },
  { kind: "sequence", label: "Sequences" },
  { kind: "enum", label: "Enums" },
];

const ICONS: Record<DbObjectKind, LucideIcon> = {
  table: Table2,
  "partitioned-table": Table2,
  "foreign-table": Table2,
  view: Eye,
  "materialized-view": Layers2,
  function: SquareFunction,
  procedure: SquareFunction,
  sequence: Hash,
  enum: List,
  collection: Braces,
  key: KeyRound,
};

/** Clicking a Redis key or MongoDB collection opens a query for it (they have no table view). */
function openDocuments(connectionId: string, schema: string, object: DbObject) {
  if (object.kind === "key") openTool("rediskey", connectionId, schema, object.name);
  else openAndRun(connectionId, object.name, mongoFind(object.name));
}

/** One database's (or schema's) tables, flat, then views and routines in folders. */
export function EntityList({ connection, schema, filter }: { connection: ConnectionConfig; schema: string; filter: string }) {
  const connectionId = connection.id;
  const pinned = useWorkspace((s) => s.pinned);
  const version = useConnections((s) => s.schemaVersion[connectionId] ?? 0);
  const objects = useLoad(() => api.listObjects(connectionId, schema), [connectionId, schema, version]);
  if (objects.error) return <Message error>{objects.error}</Message>;
  if (!objects.data) return <Message>Loading…</Message>;

  const visible = objects.data.filter((o) => !filter || o.name.toLowerCase().includes(filter));
  const tables = visible.filter((o) => TABLE_KINDS.includes(o.kind));
  const allTables = objects.data.filter((o) => TABLE_KINDS.includes(o.kind)).length;
  const pinnedNames = new Set(pinned.filter((p) => p.connectionId === connectionId && p.schema === schema).map((p) => p.table));
  const pinnedObjects = objects.data.filter((o) => pinnedNames.has(o.name));

  return (
    <>
      {pinnedObjects.length > 0 && !filter && (
        <>
          <div className="flex h-6 items-center gap-1.5 px-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
            <Pin className="size-2.5" /> Pinned
          </div>
          {pinnedObjects.map((o) => (
            <ObjectNode key={`pin-${o.name}`} connectionId={connectionId} schema={schema} object={o} depth={0} />
          ))}
        </>
      )}
      <div className="group/header flex h-6 items-center gap-1.5 pl-2 pr-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
        {connection.engine === "redis" ? "Keys" : connection.engine === "mongodb" ? "Collections" : "Tables"}
        <span className="normal-case tabular-nums">{filter ? `${tables.length} of ${allTables}` : allTables}</span>
        <span className="flex-1" />
        {(canCreateTables(connection.engine) || connection.engine === "mongodb") && !connection.readOnly && (
          <IconButton
            title={connection.engine === "mongodb" ? "New collection" : "New table"}
            className="size-5 opacity-60 group-hover/header:opacity-100"
            onClick={() => useDialogs.getState().open({ kind: "new-table", connectionId, schema })}
          >
            <Plus className="size-3.5" />
          </IconButton>
        )}
      </div>
      {tables.map((o) => (
        <ObjectNode key={o.name} connectionId={connectionId} schema={schema} object={o} depth={0} />
      ))}
      {visible.length === 0 && <Message>{filter ? "No matches" : connection.engine === "redis" ? "No keys" : connection.engine === "mongodb" ? "No collections" : "No tables"}</Message>}
      {GROUPS.map(({ kind, label }) => {
        const items = visible.filter((o) => o.kind === kind);
        return items.length > 0 ? (
          <Group key={kind} label={label} count={items.length} forceOpen={filter !== ""}>
            {items.map((o) => (
              <ObjectNode key={`${o.name}(${o.detail ?? ""})`} connectionId={connectionId} schema={schema} object={o} depth={1} />
            ))}
          </Group>
        ) : null;
      })}
    </>
  );
}

function Group({
  label,
  count,
  forceOpen,
  children,
}: {
  label: string;
  count: number;
  forceOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen;
  return (
    <>
      <Row
        depth={0}
        label={<span className="text-muted">{label}</span>}
        trailing={count}
        expanded={expanded}
        onToggle={() => setOpen(!open)}
      />
      {expanded && children}
    </>
  );
}

function ObjectNode({
  connectionId,
  schema,
  object,
  depth,
}: {
  connectionId: string;
  schema: string;
  object: DbObject;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const browsable = !["function", "procedure", "sequence", "enum"].includes(object.kind);
  const documents = object.kind === "key" || object.kind === "collection";
  const label =
    object.detail != null && object.kind !== "key" ? (
      <>
        {object.name}
        <span className="text-faint">({object.detail})</span>
      </>
    ) : (
      object.name
    );

  return (
    <>
      <Row
        depth={depth}
        icon={ICONS[object.kind]}
        label={label}
        title={
          browsable
            ? `${schema}.${object.name}${object.estimatedRows != null ? ` · ≈ ${formatCompact(object.estimatedRows)} rows` : ""}`
            : undefined
        }
        trailing={
          object.kind === "key" ? (object.detail ?? undefined) : object.estimatedRows != null && object.estimatedRows > 0 ? formatCompact(object.estimatedRows) : undefined
        }
        expanded={browsable && object.kind !== "key" ? open : undefined}
        onToggle={browsable && object.kind !== "key" ? () => setOpen(!open) : undefined}
        onClick={documents ? () => openDocuments(connectionId, schema, object) : browsable ? () => openTable(connectionId, schema, object.name) : undefined}
        onContextMenu={(e) => objectMenu(e, connectionId, schema, object)}
      />
      {open && <Columns connectionId={connectionId} schema={schema} table={object.name} depth={depth + 1} />}
    </>
  );
}

function Columns(props: { connectionId: string; schema: string; table: string; depth: number }) {
  const columns = useLoad(
    () => api.listColumns(props.connectionId, props.schema, props.table),
    [props.connectionId, props.schema, props.table],
  );
  if (columns.error) return <Message error depth={props.depth}>{columns.error}</Message>;
  if (!columns.data) return <Message depth={props.depth}>Loading…</Message>;
  return (
    <>
      {columns.data.map((c: ColumnInfo) => (
        <Row
          key={c.name}
          depth={props.depth}
          label={
            <span className="flex items-center gap-1">
              {c.primaryKey && <KeyRound className="size-3 shrink-0 text-fg" />}
              <span className={c.primaryKey ? "font-medium" : ""}>{c.name}</span>
            </span>
          }
          title={`${c.dataType}${c.nullable ? "" : " not null"}${c.default ? ` default ${c.default}` : ""}`}
          trailing={<span className="font-mono text-[11px]">{c.dataType}</span>}
        />
      ))}
    </>
  );
}

function Row({
  depth,
  icon: Icon,
  label,
  trailing,
  title,
  expanded,
  onToggle,
  onClick,
  onContextMenu,
}: {
  depth: number;
  icon?: LucideIcon;
  label: ReactNode;
  trailing?: ReactNode;
  title?: string;
  expanded?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="group flex h-[24px] items-center gap-1 rounded-[6px] pr-2 text-[12.5px] text-muted transition-colors duration-[120ms] hover:bg-hover hover:text-fg"
      style={{ paddingLeft: 4 + depth * 14 }}
      title={title}
      onClick={onClick ?? onToggle}
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault();
          onContextMenu(e);
        })
      }
    >
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        onClick={(e) => {
          if (onToggle && onClick) {
            e.stopPropagation();
            onToggle();
          }
        }}
      >
        {expanded !== undefined && (
          <ChevronRight
            className={`size-3 text-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </span>
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing != null && <span className="ml-2 max-w-[45%] truncate text-right font-mono text-[10.5px] text-faint">{trailing}</span>}
    </div>
  );
}

function Message({ children, error, depth = 1 }: { children: ReactNode; error?: boolean; depth?: number }) {
  return (
    <div
      className={`flex items-center gap-1.5 py-1 text-[12px] ${error ? "text-danger" : "text-faint"}`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {!error && children === "Loading…" && <LoaderCircle className="size-3 animate-spin" />}
      {children}
    </div>
  );
}

/** Right-click on a table, view or routine: Beekeeper's entity menu. */
function objectMenu(e: React.MouseEvent, connectionId: string, schema: string, object: DbObject) {
  const connection = useConnections.getState().saved.find((c) => c.id === connectionId);
  if (!connection) return;
  const engine = connection.engine;
  const name = `${quoteIdent(schema, engine)}.${quoteIdent(object.name, engine)}`;
  const isTable = ["table", "partitioned-table", "foreign-table"].includes(object.kind);
  const isView = object.kind === "view" || object.kind === "materialized-view";
  const { openMenu, askDanger } = useOverlays.getState();

  const dangerous = (verb: "Truncate" | "Drop", statement: string) =>
    askDanger({
      title: `${verb} ${object.name}?`,
      statement,
      connectionName: connection.name,
      prod: connection.environment === "prod",
      action: verb,
      run: async () => {
        const error = await executeStatement(connectionId, statement);
        if (error) return toast(error.message, "error");
        toast(`${verb === "Drop" ? "Dropped" : "Truncated"} ${object.name}`, "success");
        if (verb === "Drop") useTabs.getState().closeTable(connectionId, schema, object.name);
        await useConnections.getState().refreshSchema(connectionId);
      },
    });

  if (object.kind === "key" || object.kind === "collection") {
    const key = object.kind === "key";
    const remove = key ? `DEL ${redisArg(object.name)}` : `${mongoCollection(object.name)}.drop()`;
    return openMenu(e.clientX, e.clientY, [
      { label: key ? "Open" : "Find documents", onSelect: () => openDocuments(connectionId, schema, object) },
      ...(key ? [{ label: "Run read command", onSelect: () => openAndRun(connectionId, object.name, redisReadCommand(object.name, object.detail)) }] : []),
      ...(!key ? [{ label: "View structure", onSelect: () => openTable(connectionId, schema, object.name, "structure") }] : []),
      "separator",
      { label: "Copy name", onSelect: () => void copyText(object.name, "Name copied") },
      ...(!connection.readOnly
        ? [
            "separator" as const,
            {
              label: key ? "Delete key…" : "Drop collection…",
              danger: true,
              onSelect: () =>
                askDanger({
                  title: `${key ? "Delete" : "Drop"} ${object.name}?`,
                  statement: remove,
                  connectionName: connection.name,
                  prod: connection.environment === "prod",
                  action: key ? "Delete" : "Drop",
                  run: async () => {
                    const error = await executeStatement(connectionId, remove);
                    if (error) return toast(error.message, "error");
                    toast(`${key ? "Deleted" : "Dropped"} ${object.name}`, "success");
                    await useConnections.getState().refreshSchema(connectionId);
                  },
                }),
            },
          ]
        : []),
    ]);
  }
  if (!isTable && !isView) {
    return openMenu(e.clientX, e.clientY, [
      ...(object.kind === "enum" && object.detail ? [{ heading: object.detail }] : []),
      { label: "Copy name", onSelect: () => void copyText(object.name, "Name copied") },
    ]);
  }
  const ref = { connectionId, schema, table: object.name };
  const pinned = useWorkspace.getState().isPinned(ref);
  const writable = isTable && !connection.readOnly;
  const generate = (kind: Statement) => async () => {
    try {
      const columns = await api.listColumns(connectionId, schema, object.name);
      openSql(generateSql(kind, engine, schema, object.name, columns), connectionId, { title: `${kind.toUpperCase()} ${object.name}` });
    } catch (err) {
      toast(toError(err).message, "error");
    }
  };
  openMenu(e.clientX, e.clientY, [
    { label: "View data", onSelect: () => openTable(connectionId, schema, object.name, "data") },
    { label: "View structure", onSelect: () => openTable(connectionId, schema, object.name, "structure") },
    ...(isTable && engine !== "mongodb" && engine !== "redis" ? [{ label: "Live tail", onSelect: () => openTool("tail", connectionId, schema, object.name) }] : []),
    ...(isTable && engine !== "mongodb" && engine !== "redis" ? [{ label: "Compare two rows (working vs failing)…", onSelect: () => openTool("entitydiff", connectionId, schema, object.name) }] : []),
    ...(isTable ? [{ label: "Find in code…", onSelect: () => openTool("code", connectionId, schema, object.name) }] : []),
    ...(isTable && engine !== "mongodb" && engine !== "redis" ? [{ label: "Edge-case fixtures…", onSelect: () => openTool("fixtures", connectionId, schema, object.name) }] : []),
    ...(isTable && engine === "postgres" ? [{ label: "Who can see its rows…", onSelect: () => openTool("rls", connectionId, schema, object.name) }] : []),
    ...(isTable && engine === "postgres" && writable ? [{ label: "Backfill / bulk repair…", onSelect: () => openTool("backfill", connectionId, schema, object.name) }] : []),
    { label: pinned ? "Unpin" : "Pin to top", onSelect: () => useWorkspace.getState().togglePin(ref) },
    "separator",
    { heading: "Generate SQL" },
    { label: "SELECT", onSelect: () => void generate("select")() },
    ...(isTable
      ? [
          { label: "INSERT", onSelect: () => void generate("insert")() },
          { label: "UPDATE", onSelect: () => void generate("update")() },
          { label: "DELETE", onSelect: () => void generate("delete")() },
        ]
      : []),
    "separator",
    { heading: "Data" },
    ...(["csv", "json", "sql", "xlsx"] as ExportFormat[]).map((format) => ({
      label: `Export as ${EXPORT_LABELS[format]}…`,
      onSelect: () => void exportRows(connectionId, `SELECT * FROM ${name}`, format, object.name),
    })),
    ...(writable
      ? [
          { label: "Import CSV…", onSelect: () => useDialogs.getState().open({ kind: "import-csv", connectionId, schema, table: object.name }) },
          ...(connection.environment !== "prod"
            ? [{ label: "Generate test rows…", onSelect: () => useDialogs.getState().open({ kind: "fake-data", connectionId, schema, table: object.name }) }]
            : []),
        ]
      : []),
    ...(isTable
      ? [{ label: "Copy with related rows…", onSelect: () => useDialogs.getState().open({ kind: "copy-related", connectionId, schema, table: object.name }) }]
      : []),
    {
      label: "Copy to a connection…",
      onSelect: () =>
        useDialogs.getState().open({ kind: "copy", connectionId, sql: `SELECT * FROM ${name}`, name: object.name, schema, table: object.name }),
    },
    { label: "Show in ER diagram", onSelect: () => openTool("er", connectionId, schema) },
    { label: "Compare data with another connection…", onSelect: () => openTool("datadiff", connectionId, schema, object.name) },
    "separator",
    { label: "Copy name", onSelect: () => void copyText(object.name, "Name copied") },
    { label: "Copy qualified name", onSelect: () => void copyText(name, "Name copied") },
    "separator",
    ...(isTable
      ? [{ label: "Truncate table…", danger: true, onSelect: () => dangerous("Truncate", `TRUNCATE TABLE ${name}`) }]
      : []),
    {
      label: isView ? `Drop ${object.kind === "view" ? "view" : "materialized view"}…` : "Drop table…",
      danger: true,
      onSelect: () =>
        dangerous("Drop", `DROP ${isView ? (object.kind === "view" ? "VIEW" : "MATERIALIZED VIEW") : "TABLE"} ${name}`),
    },
  ]);
}
