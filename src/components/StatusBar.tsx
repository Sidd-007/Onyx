import { EyeOff, LoaderCircle } from "lucide-react";
import { togglePrivacy, useSettings } from "../store/settings";
import { ENGINE_LABEL } from "../lib/ipc";
import { formatCount, formatDuration } from "../lib/format";
import { useConnections } from "../store/connections";
import { useJobs } from "../store/jobs";
import { useRuns } from "../store/runs";
import type { QueryTab } from "../store/tabs";
import { Elapsed } from "./ResultsPanel";
import { EnvBadge } from "./ui";

/** One quiet line: which connection, and how the last run went. Details on hover. */
export function StatusBar({ tab }: { tab: QueryTab | null }) {
  const connection = useConnections((s) => (tab ? s.saved.find((c) => c.id === tab.connectionId) : undefined));
  const status = useConnections((s) => (tab ? s.status[tab.connectionId] : undefined));
  const run = useRuns((s) => (tab ? s.runs[tab.id] : undefined));
  const txOpen = useConnections((s) => (tab ? !!s.txOpen[tab.id] : false));
  const privacy = useSettings((s) => s.privacy);
  const rows = run?.outputs.reduce((n, o) => n + (o.kind === "rows" ? o.result.rowCount : 0), 0) ?? 0;

  const details = connection
    ? [
        `${connection.user}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`,
        connection.ssh && `via SSH ${connection.ssh.user}@${connection.ssh.host}`,
        connection.folder && `folder ${connection.folder}`,
        status?.state === "connected" && `${ENGINE_LABEL[connection.engine]} ${status.serverVersion}`,
        connection.readOnly && "read-only",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return (
    <footer
      className="flex h-[26px] shrink-0 items-center gap-3 border-t bg-panel px-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint"
      style={{ borderTopColor: connection?.environment === "prod" ? "var(--danger)" : "var(--border)" }}
    >
      {connection ? (
        <span className="flex items-center gap-1.5" data-tip={details}>
          <span className={`size-1.5 rounded-full ${connection.environment === "prod" ? "bg-danger" : "bg-fg"}`} />
          <span className="text-muted">{connection.name}</span>
          {connection.database && <span className="text-faint">{connection.database}</span>}
          <EnvBadge environment={connection.environment} />
        </span>
      ) : (
        <span className="lowercase tracking-normal">
          onyx<span className="q-caret">_</span>
        </span>
      )}
      {txOpen && (
        <span className="text-fg" data-tip="This tab has a manual transaction open: commit or roll back in its toolbar">
          TRANSACTION
        </span>
      )}
      <span className="flex-1" />
      {privacy && (
        <button
          type="button"
          onClick={togglePrivacy}
          data-tip="Personal data is masked (⇧⌘P to show it)"
          className="flex items-center gap-1 text-fg"
        >
          <EyeOff className="size-3" /> PRIVACY
        </button>
      )}
      <Jobs />
      {run && (
        <span className="tabular-nums">
          {run.status === "running" ? (
            <>
              {formatCount(rows)} rows · <Elapsed since={run.startedAt} />
            </>
          ) : (
            <>
              {run.status === "error" && <span className="text-danger">error · </span>}
              {run.status === "cancelled" && "cancelled · "}
              {formatCount(rows)} rows · {formatDuration(run.elapsedMs ?? 0)}
            </>
          )}
        </span>
      )}
    </footer>
  );
}

/** Background work (exports, dumps): a spinner with what's running; details on hover. */
function Jobs() {
  const jobs = useJobs((s) => s.jobs);
  if (!jobs.length) return null;
  const line = (j: (typeof jobs)[number]) =>
    [j.title, j.detail, j.rows != null && `${formatCount(j.rows)} rows`, j.bytes != null && `${(j.bytes / 1024 / 1024).toFixed(1)} MB`]
      .filter(Boolean)
      .join(" · ");
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted" data-tip={jobs.map(line).join("\n")}>
      <LoaderCircle className="size-3 shrink-0 animate-spin" />
      <span className="truncate">{jobs.length === 1 ? line(jobs[0]) : `${jobs.length} tasks running`}</span>
    </span>
  );
}
