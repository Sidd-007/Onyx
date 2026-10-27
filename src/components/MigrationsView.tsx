import { CircleCheck, CircleDashed, FileCode, FolderOpen, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, toError } from "../lib/ipc";
import { migrationFiles, type MigrationFile } from "../lib/migrations";
import { useConnections } from "../store/connections";
import { useIde } from "../store/ide";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { Button, EnvBadge, IconButton } from "./ui";

/**
 * The IDE folder's migrations/ files against one connection: which are applied (its
 * onyx_migrations table), apply the pending ones in order, roll back the last.
 */
export default function MigrationsView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const listing = useIde((s) => s.listing);
  const files = useMemo(() => migrationFiles(listing?.entries.filter((e) => !e.dir).map((e) => e.path) ?? []), [listing]);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (!(await useConnections.getState().connect(tab.connectionId))) return;
      setApplied(await api.migrationStatus(tab.connectionId));
      setError(null);
    } catch (e) {
      setError(toError(e).message);
    }
  }, [tab.connectionId]);
  useEffect(() => {
    void load();
    void useIde.getState().refresh();
  }, [load]);

  const done = new Set(applied ?? []);
  const pending = files.filter((f) => !done.has(f.version));
  const last = [...files].reverse().find((f) => done.has(f.version));

  const run = async (files: MigrationFile[], up: boolean) => {
    if (!connection || !files.length) return;
    const texts = await Promise.all(files.map((f) => api.workspaceRead(up ? f.up : f.down!)));
    useOverlays.getState().askDanger({
      title: up ? `Apply ${files.length === 1 ? files[0].version : `${files.length} migrations`}?` : `Roll back ${files[0].version}?`,
      statement: texts.map((t, i) => `-- ${files[i].version}\n${t.trim()}`).join("\n\n").slice(0, 4000),
      connectionName: connection.name,
      prod: connection.environment === "prod",
      action: up ? "Apply" : "Roll back",
      run: async () => {
        for (const [i, f] of files.entries()) {
          setBusy(f.version);
          try {
            const n = await api.applyMigration(tab.connectionId, f.version, texts[i], up, true);
            toast(`${up ? "Applied" : "Rolled back"} ${f.version} (${n} statement${n === 1 ? "" : "s"})`, "success");
          } catch (e) {
            toast(`${f.version}: ${toError(e).message}`, "error");
            break;
          }
        }
        setBusy(null);
        await load();
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Button variant="primary" className="h-6" disabled={!pending.length || !!busy || applied === null} onClick={() => void run(pending, true)}>
          Apply {pending.length || ""} pending
        </Button>
        <Button variant="ghost" className="h-6" disabled={!last?.down || !!busy} onClick={() => last && void run([last], false)}>
          <Undo2 className="size-3.5" /> Roll back last
        </Button>
        <span className="text-muted">on {connection?.name}</span>
        {connection && <EnvBadge environment={connection.environment} />}
        <span className="flex-1" />
        <span className="text-[11px] text-faint">Recorded in its onyx_migrations table</span>
        <IconButton title="Refresh" className="size-6" onClick={() => void Promise.all([load(), useIde.getState().refresh()])}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}
        {!listing ? (
          <div className="mx-auto mt-10 max-w-md text-center text-[12px] text-muted">
            <FolderOpen className="mx-auto mb-2 size-5 text-faint" />
            Migrations live in your IDE folder's migrations/. Open a folder (IDE mode), then save one from Compare schemas.
            <div className="mt-3">
              <Button variant="primary" onClick={() => void useIde.getState().openFolder()}>
                Open folder…
              </Button>
            </div>
          </div>
        ) : !files.length ? (
          <div className="mx-auto mt-10 max-w-md text-center text-[12px] text-muted">
            No migrations yet. Compare schemas and use "Save as migration", or add <code className="font-mono">migrations/&lt;version&gt;_name.up.sql</code> (and .down.sql) files.
          </div>
        ) : (
          <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-border">
            {files.map((f) => {
              const isDone = done.has(f.version);
              return (
                <div key={f.version} className="flex items-center gap-3 border-b border-border px-3 py-2 text-[12px] last:border-0">
                  {busy === f.version ? (
                    <Loader2 className="size-4 animate-spin text-accent" />
                  ) : isDone ? (
                    <CircleCheck className="size-4 text-success" />
                  ) : (
                    <CircleDashed className="size-4 text-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{f.version}</span>
                  <span className={`text-[11px] ${isDone ? "text-success" : "text-faint"}`}>{applied === null ? "" : isDone ? "applied" : "pending"}</span>
                  {!f.down && <span className="text-[11px] text-faint">no down file</span>}
                  <IconButton title="Open the up file" className="size-6" onClick={() => void useIde.getState().openFile(f.up)}>
                    <FileCode className="size-3.5" />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
