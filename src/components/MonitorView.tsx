import { Play, Square } from "lucide-react";
import { useEffect } from "react";
import { useRuns } from "../store/runs";
import type { QueryTab } from "../store/tabs";
import { ResultsPanel } from "./ResultsPanel";
import { Button } from "./ui";

/** Redis MONITOR: every command the server runs, live, until stopped. */
export default function MonitorView({ tab }: { tab: QueryTab }) {
  const run = useRuns((s) => s.runs[tab.id]);
  const running = run?.status === "running";
  // No row limit: it streams until stopped. Not in history.
  const start = () => void useRuns.getState().start(tab.id, tab.connectionId, "MONITOR", 0, { session: tab.id, maxRows: null, record: false, timeoutMs: null });
  const stop = () => void useRuns.getState().cancel(tab.id);
  useEffect(() => {
    start();
    return stop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-[12px]">
        {running ? (
          <>
            <span className="size-2 animate-pulse rounded-full bg-danger" />
            <span className="text-muted">Watching every command on the server</span>
            <Button className="ml-2" onClick={stop}>
              <Square className="size-3 fill-current" /> Stop
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={start}>
            <Play className="size-3 fill-current" /> Watch again
          </Button>
        )}
        <span className="flex-1" />
        <span className="text-faint">MONITOR slows a busy server a little; stop it when you're done.</span>
      </div>
      <ResultsPanel run={run} tabId={tab.id} />
    </div>
  );
}
