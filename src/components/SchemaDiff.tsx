import { ArrowRight, Copy, Download, FileCode, FilePlus2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, defaultSchemaOf, ENGINE_LABEL, toError, type ConnectionConfig } from "../lib/ipc";
import { MIGRATIONS_DIR, newVersion, scriptOf } from "../lib/migrations";
import { diffSchemas, type SchemaDiffResult } from "../lib/schemaDiff";
import { useIde } from "../store/ide";
import { copyText, openSql, openTool } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Button, EnvBadge, IconButton } from "./ui";
import { Select } from "./Select";

interface Pick {
  connectionId: string;
  schema: string;
}

const STATUS = {
  added: { mark: "+", label: "only in source", tint: "text-success" },
  removed: { mark: "−", label: "only in target", tint: "text-danger" },
  changed: { mark: "~", label: "differs", tint: "text-warning" },
};

/** Compares two schemas (any two connections) and writes the SQL that makes the target match. */
export default function SchemaDiff({ tab }: { tab: QueryTab }) {
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const connected = saved.filter((c) => isConnected(status[c.id]));
  const home = saved.find((c) => c.id === tab.connectionId);
  const [source, setSource] = useState<Pick>({
    connectionId: tab.connectionId,
    schema: useUi.getState().sidebarSchema[tab.connectionId] ?? (home ? defaultSchemaOf(home) : ""),
  });
  const [target, setTarget] = useState<Pick>(() => {
    const other = connected.find((c) => c.id !== tab.connectionId && c.engine === home?.engine) ?? home;
    return { connectionId: other?.id ?? tab.connectionId, schema: other ? defaultSchemaOf(other) : "" };
  });
  const [result, setResult] = useState<SchemaDiffResult | null>(null);
  /** The reverse (target back to how it was), for a migration's down file. */
  const [down, setDown] = useState("");
  const workspace = useIde((s) => s.listing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceConn = saved.find((c) => c.id === source.connectionId);
  const targetConn = saved.find((c) => c.id === target.connectionId);

  const compare = async () => {
    if (!sourceConn || !targetConn) return;
    setBusy(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([
        api.schemaSnapshot(source.connectionId, source.schema),
        api.schemaSnapshot(target.connectionId, target.schema),
      ]);
      setResult(
        diffSchemas(
          { engine: sourceConn.engine, schema: source.schema, tables: a },
          { engine: targetConn.engine, schema: target.schema, tables: b },
        ),
      );
      const reverse = diffSchemas(
        { engine: targetConn.engine, schema: target.schema, tables: b },
        { engine: targetConn.engine, schema: target.schema, tables: a },
      ).sql;
      setDown(
        (sourceConn.engine !== targetConn.engine ? `-- ${ENGINE_LABEL[sourceConn.engine]} types: check this file by hand.\n` : "") + scriptOf(reverse),
      );
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };

  const sql = result ? scriptOf(result.sql) : "";

  /** Writes migrations/<version>.up.sql and .down.sql in the IDE folder, then shows them against the target. */
  const saveMigration = async () => {
    const version = newVersion(`sync ${target.schema}`);
    try {
      for (const [file, text] of [
        [`${MIGRATIONS_DIR}/${version}.up.sql`, sql],
        [`${MIGRATIONS_DIR}/${version}.down.sql`, down || "-- Nothing to undo\n"],
      ]) {
        await api.workspaceCreate(file, false);
        await api.workspaceWrite(file, text);
      }
      await useIde.getState().refresh();
      toast(`Saved ${MIGRATIONS_DIR}/${version}`, "success");
      openTool("migrations", target.connectionId);
    } catch (e) {
      toast(toError(e).message, "error");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[12px]">
        <Side label="Source (what it should look like)" value={source} onChange={setSource} connections={connected} />
        <ArrowRight className="size-3.5 text-faint" />
        <Side label="Target (to change)" value={target} onChange={setTarget} connections={connected} />
        <Button variant="primary" disabled={busy || !source.schema || !target.schema} onClick={() => void compare()}>
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null} Compare
        </Button>
      </div>
      {sourceConn && targetConn && sourceConn.engine !== targetConn.engine && (
        <p className="shrink-0 border-b border-border bg-panel px-3 py-1.5 text-[11.5px] text-muted">
          {ENGINE_LABEL[sourceConn.engine]} → {ENGINE_LABEL[targetConn.engine]}: types are translated and defaults left out. Check the SQL before running it.
        </p>
      )}
      {error && <p className="shrink-0 select-text bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</p>}
      {!result ? (
        <p className="p-8 text-center text-[12px] text-muted">
          Pick two schemas and compare. Nothing runs on either database; you get the SQL to review.
        </p>
      ) : result.tables.length === 0 ? (
        <p className="p-8 text-center text-[12px] text-muted">The schemas match.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 overflow-y-auto border-r border-border p-2">
            {result.tables.map((t) => (
              <div key={t.name} className="rounded-md px-2 py-1.5 hover:bg-hover">
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className={`w-3 font-mono font-semibold ${STATUS[t.status].tint}`}>{STATUS[t.status].mark}</span>
                  <span className="truncate font-medium">{t.name}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-faint">{STATUS[t.status].label}</span>
                </div>
                {t.notes.map((n, i) => (
                  <div key={i} className="truncate pl-4.5 font-mono text-[11px] text-muted" data-tip={n}>
                    {n}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5 text-[11.5px] text-muted">
              Migration for <span className="font-medium text-fg">{targetConn?.name}</span> · {target.schema}
              {targetConn && <EnvBadge environment={targetConn.environment} />}
              <span className="flex-1" />
              <IconButton title="Copy SQL" disabled={!sql} onClick={() => void copyText(sql, "Migration copied")}>
                <Copy className="size-3.5" />
              </IconButton>
              <IconButton
                title="Save as .sql"
                disabled={!sql}
                onClick={() =>
                  void api.saveFile(`migrate_${target.schema}`, "sql", sql).then((p) => p && toast(`Saved ${p}`, "success"), (e) => toast(toError(e).message, "error"))
                }
              >
                <Download className="size-3.5" />
              </IconButton>
              <IconButton
                title={workspace ? "Save as a migration (up and down files in the IDE folder's migrations/)" : "Save as a migration: open a folder in IDE mode first"}
                disabled={!sql || !workspace}
                onClick={() => void saveMigration()}
              >
                <FilePlus2 className="size-3.5" />
              </IconButton>
              <IconButton
                title="Open in a query tab on the target (nothing runs until you do)"
                disabled={!sql}
                onClick={() => openSql(sql, target.connectionId, { title: `Migrate ${target.schema}` })}
              >
                <FileCode className="size-3.5" />
              </IconButton>
            </div>
            <pre className="min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
              {sql || "-- Nothing to change: only views or comments differ."}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Side({
  label,
  value,
  onChange,
  connections,
}: {
  label: string;
  value: Pick;
  onChange(p: Pick): void;
  connections: ConnectionConfig[];
}) {
  const [schemas, setSchemas] = useState<string[]>([]);
  useEffect(() => {
    void api.listSchemas(value.connectionId).then(setSchemas, () => setSchemas([]));
  }, [value.connectionId]);
  return (
    <span className="flex items-center gap-1" data-tip={label}>
      <Select
        value={value.connectionId}
        onChange={(id) => {
          const c = connections.find((x) => x.id === id);
          onChange({ connectionId: id, schema: c ? defaultSchemaOf(c) : "" });
        }}
        options={connections.map((c) => ({ value: c.id, label: c.name }))}
        className="h-6 max-w-44 rounded-md bg-hover px-1.5"
      />
      <Select
        value={value.schema}
        placeholder="schema"
        onChange={(schema) => onChange({ ...value, schema })}
        options={schemas.map((s) => ({ value: s, label: s }))}
        className="h-6 max-w-40 rounded-md bg-hover px-1.5"
      />
    </span>
  );
}
