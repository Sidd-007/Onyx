import { useEffect, useState } from "react";
import { ConnectionDot } from "./ui";
import { formatCount, formatDuration } from "../lib/format";
import { api, type HistoryEntry } from "../lib/ipc";
import { timeAgo } from "../lib/time";
import { openSql } from "../store/actions";
import { useConnections } from "../store/connections";
import { useLibrary } from "../store/library";

/** Every query run from an editor, newest first. Click one to open it in a new tab. */
export function HistoryPanel({ search }: { search: string }) {
  const version = useLibrary((s) => s.historyVersion);
  const connections = useConnections((s) => s.saved);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => void api.listHistory(search.trim() || undefined).then((e) => live && setEntries(e), () => live && setEntries([])),
      search ? 150 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [search, version]);

  if (!entries) return null;
  if (!entries.length) {
    return <p className="px-2 py-1 text-[12px] text-faint">{search ? "No matches." : "Queries you run show up here."}</p>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const connection = connections.find((c) => c.id === entry.connectionId);
        return (
          <button
            key={entry.id}
            type="button"
            title={entry.sql}
            onClick={() => openSql(entry.sql, connection ? entry.connectionId : null)}
            className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="line-clamp-2 break-all font-mono text-[11.5px] text-fg">{entry.sql.trim()}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-faint">
              {connection && <ConnectionDot environment={connection.environment} />}
              <span className="truncate">{connection?.name ?? "deleted connection"}</span>·<span>{timeAgo(entry.executedAt)}</span>·
              <span>{formatDuration(entry.durationMs)}</span>
              {entry.error ? (
                <span className="truncate text-danger" title={entry.error}>
                  · error
                </span>
              ) : (
                <span>· {formatCount(entry.rowCount)} rows</span>
              )}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={async () => {
          if (!confirmClear) return setConfirmClear(true);
          await api.clearHistory();
          setConfirmClear(false);
          useLibrary.getState().historyChanged();
        }}
        onBlur={() => setConfirmClear(false)}
        className={`mt-2 self-start rounded px-2 py-1 text-[11.5px] ${confirmClear ? "bg-danger-soft text-danger" : "text-faint hover:text-danger"}`}
      >
        {confirmClear ? "Click again to clear all history" : "Clear history"}
      </button>
    </div>
  );
}
