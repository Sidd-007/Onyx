import { Ban, LoaderCircle, OctagonX, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, toError, type ConnectionConfig } from "../lib/ipc";
import { isConnected, useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { Button, Divider, EnvBadge, IconButton } from "./ui";

interface Rows {
  columns: string[];
  rows: (string | null)[][];
}

const SQL = {
  postgres: {
    sessions: `SELECT pid, usename AS user, datname AS database, application_name AS app, client_addr AS client, state,
       wait_event_type || coalesce(': ' || wait_event, '') AS waiting,
       to_char(now() - coalesce(query_start, backend_start), 'HH24:MI:SS') AS running_for, query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
ORDER BY state = 'active' DESC, query_start`,
    locks: `SELECT l.pid, l.locktype AS type, l.mode, l.granted, coalesce(c.relname, l.relation::text) AS relation,
       array_to_string(pg_blocking_pids(l.pid), ', ') AS blocked_by
FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
WHERE l.pid <> pg_backend_pid() AND l.locktype <> 'virtualxid'
ORDER BY l.granted, l.pid`,
    cancel: (id: string) => `SELECT pg_cancel_backend(${Number(id)})`,
    terminate: (id: string) => `SELECT pg_terminate_backend(${Number(id)})`,
    idKey: "pid",
    stateKey: "state",
  },
  mysql: {
    sessions: `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state, INFO AS query
FROM information_schema.PROCESSLIST
WHERE ID <> CONNECTION_ID()
ORDER BY COMMAND = 'Sleep', TIME DESC`,
    locks: `SELECT ENGINE_TRANSACTION_ID AS trx, THREAD_ID AS thread, OBJECT_SCHEMA AS db, OBJECT_NAME AS \`table\`, INDEX_NAME AS \`index\`,
       LOCK_TYPE AS type, LOCK_MODE AS mode, LOCK_STATUS AS status
FROM performance_schema.data_locks`,
    cancel: (id: string) => `KILL QUERY ${Number(id)}`,
    terminate: (id: string) => `KILL ${Number(id)}`,
    idKey: "id",
    stateKey: "command",
  },
  clickhouse: {
    sessions: `SELECT query_id, user, address AS client, current_database AS database, round(elapsed, 1) AS seconds,
       formatReadableSize(memory_usage) AS memory, read_rows, 'running' AS state, query
FROM system.processes
WHERE query_id != queryID()
ORDER BY elapsed DESC`,
    // ClickHouse has no row locks; unfinished mutations are what blocks work.
    locks: `SELECT database, table, mutation_id, command, create_time, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE NOT is_done
ORDER BY create_time`,
    locksLabel: "mutations",
    cancel: (id: string) => `KILL QUERY WHERE query_id = '${id.replace(/[\\']/g, "\\$&")}' ASYNC`,
    terminate: (id: string) => `KILL QUERY WHERE query_id = '${id.replace(/[\\']/g, "\\$&")}' SYNC`,
    idKey: "query_id",
    stateKey: "state",
  },
  sqlserver: {
    sessions: `SELECT s.session_id, s.login_name AS [user], DB_NAME(s.database_id) AS [database], s.program_name AS app, s.host_name AS client,
       COALESCE(r.status, s.status) AS state, r.wait_type AS waiting, NULLIF(r.blocking_session_id, 0) AS blocked_by,
       CONVERT(varchar(12), DATEADD(ms, DATEDIFF(ms, COALESCE(r.start_time, s.last_request_start_time), SYSDATETIME()), 0), 114) AS running_for,
       t.text AS query
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, r.start_time`,
    locks: `SELECT l.request_session_id AS session_id, l.resource_type AS type, l.request_mode AS mode, l.request_status AS status,
       DB_NAME(l.resource_database_id) AS [database], OBJECT_NAME(p.object_id, l.resource_database_id) AS [object]
FROM sys.dm_tran_locks l
LEFT JOIN sys.partitions p ON p.hobt_id = l.resource_associated_entity_id
WHERE l.request_session_id <> @@SPID AND l.resource_type <> 'DATABASE'
ORDER BY l.request_status, l.request_session_id`,
    // SQL Server can only stop another session's query by ending the session.
    cancel: (id: string) => `KILL ${Number(id)}`,
    terminate: (id: string) => `KILL ${Number(id)}`,
    idKey: "session_id",
    stateKey: "state",
  },
};

type ActivitySql = (typeof SQL)["postgres"] & { locksLabel?: string };

/** Engines with a server activity view. */
export const hasActivity = (engine: string): engine is keyof typeof SQL => engine in SQL;

/** Live sessions and locks, with cancel and terminate. */
export default function ActivityView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const connected = useConnections((s) => isConnected(s.status[tab.connectionId]));
  if (!connection) return null;
  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-muted">
        Not connected to {connection.name}.
        <Button variant="primary" onClick={() => void useConnections.getState().connect(connection.id)}>
          Connect
        </Button>
      </div>
    );
  }
  if (!hasActivity(connection.engine)) {
    return <p className="p-6 text-center text-[12px] text-muted">Server activity is for Postgres, MySQL, SQL Server and ClickHouse.</p>;
  }
  return <Activity connection={connection} sql={SQL[connection.engine]} />;
}

function Activity({ connection, sql }: { connection: ConnectionConfig; sql: ActivitySql }) {
  const [view, setView] = useState<"sessions" | "locks">("sessions");
  const [data, setData] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [hideIdle, setHideIdle] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.adminQuery(connection.id, view === "sessions" ? sql.sessions : sql.locks));
      setError(null);
    } catch (e) {
      setError(toError(e).message);
    }
    setLoading(false);
  }, [connection.id, view, sql]);

  useEffect(() => {
    setData(null);
    void load();
    if (!live) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load, live]);

  const kill = (id: string, how: "cancel" | "terminate") => {
    const statement = how === "cancel" ? sql.cancel(id) : sql.terminate(id);
    useOverlays.getState().askDanger({
      title: how === "cancel" ? `Cancel the query in session ${id}?` : `End session ${id}?`,
      statement,
      connectionName: connection.name,
      prod: connection.environment === "prod",
      action: how === "cancel" ? "Cancel query" : "End session",
      run: async () => {
        try {
          await api.adminQuery(connection.id, statement, true);
          toast(how === "cancel" ? `Cancelled the query in session ${id}` : `Ended session ${id}`, "success");
          await load();
        } catch (e) {
          toast(toError(e).message, "error");
        }
      },
    });
  };

  const idIndex = data?.columns.indexOf(sql.idKey) ?? -1;
  const stateIndex = data?.columns.indexOf(sql.stateKey) ?? -1;
  const rows = (data?.rows ?? []).filter(
    (r) => view !== "sessions" || !hideIdle || !/^(idle|sleep|sleeping)$/i.test(r[stateIndex] ?? ""),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-[12px]">
        <div className="flex gap-0.5 rounded-md bg-hover p-0.5">
          {(["sessions", "locks"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`h-5 rounded px-2 capitalize ${view === v ? "bg-raised font-medium shadow-sm" : "text-muted"}`}
            >
              {v === "locks" ? (sql.locksLabel ?? v) : v}
            </button>
          ))}
        </div>
        {view === "sessions" && (
          <label className="ml-2 flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} className="" />
            Hide idle
          </label>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
          {connection.name} <EnvBadge environment={connection.environment} />
        </span>
        <Divider />
        <IconButton title={live ? "Pause auto-refresh" : "Refresh every 3 s"} active={live} onClick={() => setLive((v) => !v)}>
          {live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconButton>
        <IconButton title="Refresh" onClick={() => void load()}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </IconButton>
      </div>
      {error && <p className="shrink-0 select-text border-b border-border bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</p>}
      <div className="min-h-0 flex-1 select-text overflow-auto">
        {!data && !error && (
          <div className="flex justify-center p-6 text-muted">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        )}
        {data && (
          <table className="min-w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-panel text-[11px] text-faint">
              <tr>
                {view === "sessions" && <th className="w-16 px-2 py-1.5" />}
                {data.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="group border-t border-border hover:bg-hover">
                  {view === "sessions" && (
                    <td className="px-1.5 py-1">
                      {idIndex >= 0 && r[idIndex] && (
                        <span className="invisible flex gap-0.5 group-hover:visible">
                          <IconButton className="size-5" title="Cancel its query" onClick={() => kill(r[idIndex]!, "cancel")}>
                            <Ban className="size-3" />
                          </IconButton>
                          <IconButton className="size-5 hover:text-danger" title="End the session" onClick={() => kill(r[idIndex]!, "terminate")}>
                            <OctagonX className="size-3 text-danger" />
                          </IconButton>
                        </span>
                      )}
                    </td>
                  )}
                  {r.map((v, c) => (
                    <td
                      key={c}
                      className={`max-w-[28rem] truncate whitespace-nowrap px-2 py-1 ${data.columns[c] === "query" ? "font-mono text-[11.5px]" : ""}`}
                      data-tip={v && v.length > 60 ? v : undefined}
                    >
                      {v === null ? <span className="text-faint">—</span> : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && rows.length === 0 && <p className="p-6 text-center text-[12px] text-muted">Nothing {view === "sessions" ? "running" : "locked"} right now.</p>}
      </div>
    </div>
  );
}
