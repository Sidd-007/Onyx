import { RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, toError, type JournalEntry } from "../lib/ipc";
import { timeAgo } from "../lib/time";
import { useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { changedTarget } from "../store/dataChanges";
import { toast } from "../store/toasts";
import { Button, IconButton } from "./ui";

/** The change journal: every UPDATE / DELETE Onyx ran on this connection, with Undo. */
export default function ChangesView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listChanges(tab.connectionId));
      setError(null);
    } catch (e) {
      setError(toError(e).message);
    }
  }, [tab.connectionId]);
  useEffect(() => void load(), [load]);

  const undo = (e: JournalEntry) =>
    useOverlays.getState().askDanger({
      title: `Undo this change to ${e.target}?`,
      statement: (e.reverse ?? "").split(";\n").slice(0, 20).join(";\n") + ((e.reverse ?? "").split(";\n").length > 20 ? "\n…" : ""),
      connectionName: connection?.name ?? "",
      prod: connection?.environment === "prod",
      action: "Undo",
      run: async () => {
        try {
          await api.undoChange(tab.connectionId, e.id, true);
          toast(`Undid the change to ${e.target}`, "success");
          changedTarget(tab.connectionId, e.target, "undone");
          await load();
        } catch (err) {
          toast(toError(err).message, "error");
        }
      },
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-[12px]">
        <span className="text-muted">Updates and deletes Onyx ran here, with the rows they changed. Undo puts those rows back.</span>
        <span className="flex-1" />
        <IconButton title="Refresh" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}
        {entries?.length === 0 && <p className="p-6 text-center text-[12px] text-muted">No changes yet.</p>}
        <div className="flex flex-col gap-1.5">
          {entries?.map((e) => (
            <div key={e.id} className={`rounded-xl border border-border bg-panel px-3 py-2 ${e.undoneAt ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2 text-[12px]">
                <span className="font-medium">{e.target || "—"}</span>
                <span className="text-faint">
                  {timeAgo(e.at)} · {e.rows.toLocaleString()} row{e.rows === 1 ? "" : "s"}
                </span>
                {e.undoneAt && <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">undone</span>}
                <span className="flex-1" />
                {e.reverse && !e.undoneAt && !connection?.readOnly && (
                  <Button onClick={() => undo(e)}>
                    <RotateCcw className="size-3.5" /> Undo
                  </Button>
                )}
                {!e.reverse && e.note && <span className="text-[11px] text-faint">{e.note}</span>}
              </div>
              <button type="button" className="mt-1 block w-full text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <pre className={`select-text font-mono text-[11.5px] text-muted ${open === e.id ? "whitespace-pre-wrap" : "truncate"}`}>{e.statement}</pre>
              </button>
              {open === e.id && e.reverse && (
                <pre className="mt-1.5 max-h-48 select-text overflow-auto rounded-lg bg-bg px-2 py-1.5 font-mono text-[11px] text-faint">{e.reverse}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
