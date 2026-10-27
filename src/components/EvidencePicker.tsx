import { FolderSearch, Plus } from "lucide-react";
import { useState } from "react";
import { openTool } from "../store/actions";
import { useInvestigations } from "../store/investigations";
import { Modal } from "./Modal";
import { Button } from "./ui";

/** Where does this evidence go: an existing investigation or a new one. */
export function EvidencePicker() {
  const pending = useInvestigations((s) => s.pending);
  const list = useInvestigations((s) => s.list);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const close = () => useInvestigations.setState({ pending: null });
  const file = async (id: string | null) => {
    setBusy(true);
    const saved = await useInvestigations.getState().file(id, title || pending.label);
    setBusy(false);
    setTitle("");
    if (saved) openTool("investigation", pending.connection?.id ?? "");
  };
  return (
    <Modal onClose={close} width="max-w-md">
      <div className="flex flex-col gap-3 p-5 text-[12px]">
        <h2 className="text-[14px] font-semibold">Save to an investigation</h2>
        <p className="text-muted">
          <span className="font-medium text-fg">{pending.label}</span>
          {pending.connection && ` · ${pending.connection.name}`} · {pending.complete ? "complete" : `partial: ${pending.limits ?? "limited"}`}
        </p>
        <div className="flex gap-2">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New investigation: what are you trying to explain?" className="q-field h-7 flex-1 px-2" onKeyDown={(e) => e.key === "Enter" && void file(null)} />
          <Button variant="primary" className="h-7" disabled={busy} onClick={() => void file(null)}>
            <Plus className="size-3.5" /> New
          </Button>
        </div>
        {list.length > 0 && (
          <div className="flex max-h-64 flex-col overflow-y-auto rounded-lg border border-border">
            {list.map((i) => (
              <button key={i.id} type="button" disabled={busy} onClick={() => void file(i.id)} className="flex items-center gap-2 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-hover">
                <FolderSearch className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <span className="text-[11px] text-faint">{new Date(i.updatedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-faint">Kept on this Mac in Onyx's encrypted vault. Connections are stored as references, never with passwords.</p>
      </div>
    </Modal>
  );
}
