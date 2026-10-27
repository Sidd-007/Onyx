import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { Risk } from "../lib/ipc";
import { Modal } from "./Modal";
import { Button } from "./ui";

/** The prod guard's question: these statements will change a prod database. */
export function ConfirmRiskDialog({
  connectionName,
  risks,
  action,
  onAnswer,
  children,
}: {
  connectionName: string;
  risks: Risk[];
  action: string;
  onAnswer(approved: boolean): void;
  children?: ReactNode;
}) {
  return (
    <Modal onClose={() => onAnswer(false)}>
      <div className="flex gap-3 p-5">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            {action} on <span className="text-danger">{connectionName}</span> (prod)?
          </h2>
          <p className="mt-1 text-[12px] text-muted">Check each statement before you continue.</p>
          <ul className="mt-3 flex max-h-72 flex-col gap-2 overflow-y-auto">
            {risks.map((r, i) => (
              <li key={i} className="rounded-md border border-border bg-bg p-2.5">
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-danger">{r.reason}</p>
                <pre className="mt-1 select-text whitespace-pre-wrap break-words font-mono text-[12px]">{r.statement}</pre>
              </li>
            ))}
          </ul>
          {children}
        </div>
      </div>
      <footer className="flex justify-end gap-2 border-t border-border bg-panel px-5 py-3">
        <Button onClick={() => onAnswer(false)} autoFocus>
          Cancel
        </Button>
        <Button variant="destructive" onClick={() => onAnswer(true)}>
          {action} on prod
        </Button>
      </footer>
    </Modal>
  );
}
