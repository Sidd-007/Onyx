import { ChevronRight, GitBranch, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, toError, type GitStatus } from "../lib/ipc";
import { baseName, useIde } from "../store/ide";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Button, IconButton } from "./ui";

type File = GitStatus["files"][number];

const LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", "?": "untracked" };
const TINT: Record<string, string> = { M: "text-warning", A: "text-success", "?": "text-success", D: "text-danger", U: "text-danger", R: "text-accent" };

/** IDE mode's source control: the workspace folder's git changes, staging and commits. */
export function GitPanel() {
  const listing = useIde((s) => s.listing);
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.gitStatus());
    } catch {
      setStatus(null);
    }
  }, []);
  // Files change as you type (autosave) and outside Onyx: refresh on listing changes, focus, and every few seconds while open.
  useEffect(() => {
    void load();
  }, [load, listing]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void load(), 5000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [open, load]);

  if (!listing || status === null || status === undefined) return null;

  const staged = status.files.filter((f) => f.index !== " " && f.index !== "?");
  const changed = status.files.filter((f) => f.worktree !== " ");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast(toError(e).message, "error");
    }
    setBusy(false);
    await load();
  };
  const show = async (f: File, isStaged: boolean) => {
    try {
      setDiff({ path: f.path, text: await api.gitDiff(f.path, isStaged) });
    } catch (e) {
      toast(toError(e).message, "error");
    }
  };
  const commit = () =>
    act(async () => {
      const summary = await api.gitCommit(message);
      setMessage("");
      toast(summary || "Committed", "success");
    });

  const row = (f: File, isStaged: boolean) => {
    const code = isStaged ? f.index : f.worktree === "?" ? "?" : f.worktree;
    return (
      <div key={`${isStaged}:${f.path}`} className="group flex h-6 items-center gap-1.5 rounded-md pl-5 pr-1 text-[12px] hover:bg-hover" title={`${f.path} · ${LABEL[code] ?? code}`}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => void show(f, isStaged)}>
          <span className="truncate">{baseName(f.path)}</span>
          <span className="truncate text-[10.5px] text-faint">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
        </button>
        <IconButton
          title={isStaged ? "Unstage" : "Stage"}
          className="hidden size-5 group-hover:inline-flex"
          disabled={busy}
          onClick={() => void act(() => (isStaged ? api.gitUnstage([f.path]) : api.gitStage([f.path])))}
        >
          {isStaged ? <Minus className="size-3" /> : <Plus className="size-3" />}
        </IconButton>
        <span className={`w-3 shrink-0 text-center font-mono text-[11px] ${TINT[code] ?? "text-muted"}`}>{code === "?" ? "U" : code}</span>
      </div>
    );
  };

  return (
    <div className="flex max-h-[45%] shrink-0 flex-col border-t border-border">
      <div className="flex h-8 shrink-0 items-center gap-1 px-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap px-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
          <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          Source control
          {status.files.length > 0 && <span className="font-mono text-[10px] text-faint">{status.files.length}</span>}
        </button>
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] text-faint" data-tip={status.ahead || status.behind ? `${status.ahead} ahead, ${status.behind} behind` : undefined}>
          <GitBranch className="size-3 shrink-0" />
          {status.branch ?? "detached"}
          {status.ahead > 0 && ` ↑${status.ahead}`}
          {status.behind > 0 && ` ↓${status.behind}`}
        </span>
        <IconButton title="Refresh" className="size-5" onClick={() => void load()}>
          <RefreshCw className="size-3" />
        </IconButton>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          <div className="mb-1.5 flex flex-col gap-1">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey && staged.length && message.trim()) {
                  e.preventDefault();
                  void commit();
                }
              }}
              placeholder="Commit message (⌘↵)"
              rows={2}
              className="q-field resize-none px-2 py-1 text-[12px]"
            />
            <div className="flex gap-1">
              <Button variant="primary" className="h-6 flex-1" disabled={busy || !staged.length || !message.trim()} onClick={() => void commit()}>
                Commit {staged.length ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
              </Button>
              <Button variant="ghost" className="h-6" disabled={busy || !changed.length} onClick={() => void act(() => api.gitStage(changed.map((f) => f.path)))}>
                Stage all
              </Button>
            </div>
          </div>
          {!status.files.length && <p className="px-2 py-1 text-[11.5px] text-faint">No changes.</p>}
          {staged.length > 0 && <div className="px-1 pt-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">Staged</div>}
          {staged.map((f) => row(f, true))}
          {changed.length > 0 && <div className="px-1 pt-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">Changes</div>}
          {changed.map((f) => row(f, false))}
        </div>
      )}
      {diff && (
        <Modal onClose={() => setDiff(null)}>
          <div className="flex max-h-[80vh] w-[760px] max-w-[90vw] flex-col">
            <div className="flex h-10 shrink-0 items-center border-b border-border px-4 text-[12.5px] font-medium">{diff.path}</div>
            <pre className="min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
              {diff.text ? (
                diff.text.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "bg-success/10 text-success"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "bg-danger/10 text-danger"
                          : line.startsWith("@@")
                            ? "text-accent"
                            : "text-muted"
                    }
                  >
                    {line || " "}
                  </div>
                ))
              ) : (
                <span className="text-faint">No differences.</span>
              )}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
