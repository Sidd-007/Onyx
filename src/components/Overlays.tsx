import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useOverlays } from "../store/overlays";
import { BulkDialogs } from "./BulkDialogs";
import { EvidencePicker } from "./EvidencePicker";
import { JsonExplorer } from "./JsonExplorer";
import { ContextMenu } from "./ContextMenu";
import { Modal } from "./Modal";
import { Toasts } from "./Toasts";
import { TooltipLayer } from "./TooltipLayer";
import { Button } from "./ui";

/** App-wide context menu, destructive-action confirmation and toasts. */
export function Overlays() {
  const menu = useOverlays((s) => s.menu);
  const danger = useOverlays((s) => s.danger);
  const [running, setRunning] = useState(false);
  const close = () => !running && useOverlays.getState().closeDanger();

  return (
    <>
      <ContextMenu menu={menu} onClose={() => useOverlays.getState().closeMenu()} />
      <BulkDialogs />
      <EvidencePicker />
      <JsonExplorer />
      {danger && (
        <Modal onClose={close}>
          <div className="flex gap-3 p-5">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{danger.title}</h2>
              {danger.detail && <p className="mt-1 text-[12px] text-muted">{danger.detail}</p>}
              <p className="mt-1 text-[12px] text-muted">
                On <span className={danger.prod ? "font-medium text-danger" : "font-medium text-fg"}>{danger.connectionName}</span>
                {danger.prod && " (prod)"}. This can't be undone.
              </p>
              <pre className="mt-3 select-text whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2.5 font-mono text-[12px]">
                {danger.statement}
              </pre>
            </div>
          </div>
          <footer className="flex justify-end gap-2 border-t border-border bg-panel px-5 py-3">
            <Button onClick={close} autoFocus>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={running}
              onClick={async () => {
                setRunning(true);
                await danger.run();
                setRunning(false);
                useOverlays.getState().closeDanger();
              }}
            >
              {running ? "Running…" : danger.action}
            </Button>
          </footer>
        </Modal>
      )}
      <Toasts />
      <TooltipLayer />
    </>
  );
}
