import { ChevronRight, Copy, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { findCollection, mongoCollection, updateFor } from "../lib/nosql";
import { maskJson } from "../lib/privacy";
import { useSettings } from "../store/settings";
import type { ResultSet } from "../lib/resultSet";
import { copyText, executeStatement } from "../store/actions";
import { useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import { useRuns, type Run } from "../store/runs";
import { toast } from "../store/toasts";
import { JsonEditor } from "./JsonEditor";
import { IconButton } from "./ui";
import { prettyJson } from "../lib/jsonDiff";

/** The column MongoDB results carry each whole document in (relaxed Extended JSON). */
export const DOCUMENT_COLUMN = "$doc";
const PAGE = 200;

export const hasDocuments = (result: ResultSet) => result.columns.at(-1) === DOCUMENT_COLUMN;


/** MongoDB results as documents: pretty JSON, one card each, expanded on demand. */
export function DocumentView({ result, version, run, tabId }: { result: ResultSet; version: number; run?: Run; tabId?: string }) {
  const [shown, setShown] = useState(PAGE);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const connection = useConnections((s) => s.saved.find((c) => c.id === run?.connectionId));
  const collection = run ? findCollection(run.sql) : null;
  const editable = !!collection && !!connection && !connection.readOnly && run?.status !== "running";

  const refresh = () => tabId && run && void useRuns.getState().rerun(tabId, run.maxRows);
  const save = async (i: number, text: string | null) => {
    setEditing(null);
    if (!run || !collection || text === null) return;
    const before = JSON.parse(rows[i]) as Record<string, unknown>;
    const after = JSON.parse(text) as Record<string, unknown>;
    if (JSON.stringify(after._id) !== JSON.stringify(before._id)) return toast("The _id can't change; copy the document to make a new one", "error");
    const update = updateFor(before, after);
    if (!update) return;
    const failed = await executeStatement(run.connectionId, `${mongoCollection(collection)}.updateOne({ "_id": ${JSON.stringify(before._id)} }, ${update})`, run.session);
    if (failed) return toast(failed.message, "error");
    toast("Document saved", "success");
    refresh();
  };
  const remove = (i: number) => {
    if (!run || !collection || !connection) return;
    const id = JSON.stringify((JSON.parse(rows[i]) as Record<string, unknown>)._id);
    const statement = `${mongoCollection(collection)}.deleteOne({ "_id": ${id} })`;
    useOverlays.getState().askDanger({
      title: "Delete this document?",
      statement,
      connectionName: connection.name,
      prod: connection.environment === "prod",
      action: "Delete",
      run: async () => {
        const failed = await executeStatement(run.connectionId, statement, run.session);
        if (failed) return toast(failed.message, "error");
        toast("Document deleted", "success");
        refresh();
      },
    });
  };
  const column = result.columns.length - 1;
  const count = Math.min(shown, result.rowCount);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => Array.from({ length: count }, (_, i) => result.cell(column, i) ?? "null"), [result, column, count, version]);

  return (
    <div className="min-h-0 flex-1 select-text overflow-y-auto bg-bg p-2 font-mono text-[12px] leading-[1.6]">
      {rows.map((text, i) => {
        const open = !collapsed.has(i);
        return (
          <div key={i} className="group mb-1.5 rounded-md border border-border bg-panel">
            <div className="flex h-6 items-center gap-1 px-1.5 text-[11px] text-muted">
              <button
                type="button"
                className="flex items-center gap-1"
                onClick={() => setCollapsed((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))}
              >
                <ChevronRight className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
                <span className="tabular-nums">{i + 1}</span>
              </button>
              {!open && <span className="truncate text-faint">{text}</span>}
              <span className="flex-1" />
              <IconButton title="Copy document" className="size-5 opacity-0 group-hover:opacity-100" onClick={() => void copyText(pretty(text), "Document copied")}>
                <Copy className="size-3" />
              </IconButton>
              {editable && (
                <>
                  <IconButton title="Edit document" className="size-5 opacity-0 group-hover:opacity-100" onClick={() => setEditing(i)}>
                    <Pencil className="size-3" />
                  </IconButton>
                  <IconButton title="Delete document" className="size-5 opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => remove(i)}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </>
              )}
            </div>
            {open && <Json text={text} />}
          </div>
        );
      })}
      {editing !== null && (
        <JsonEditor column={`${collection} document`} value={rows[editing]} onCancel={() => setEditing(null)} onSave={(v) => void save(editing, v)} />
      )}
      {result.rowCount > count && (
        <button type="button" className="mx-auto my-2 block text-[12px] text-accent hover:underline" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, result.rowCount - count)} more of {result.rowCount - count}
        </button>
      )}
    </div>
  );
}

const pretty = (text: string) => prettyJson(text);

/** Pretty JSON with keys, strings, numbers and literals colored. */
function Json({ text }: { text: string }) {
  const privacy = useSettings((s) => s.privacy);
  const parts = useMemo(() => {
    const out: { text: string; className?: string }[] = [];
    let source = pretty(text);
    if (privacy) {
      try {
        source = JSON.stringify(maskJson(JSON.parse(text)), null, 2);
      } catch {
        // Not JSON: shown as it is.
      }
    }
    const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    for (let m = token.exec(source); m; m = token.exec(source)) {
      if (m.index > last) out.push({ text: source.slice(last, m.index) });
      if (m[1] && m[2]) {
        out.push({ text: m[1], className: "text-[var(--hl-type)]" });
        out.push({ text: m[2] });
      } else if (m[1]) out.push({ text: m[1], className: "text-[var(--hl-string)]" });
      else out.push({ text: m[0], className: "text-[var(--hl-number)]" });
      last = m.index + m[0].length;
    }
    out.push({ text: source.slice(last) });
    return out;
  }, [text, privacy]);
  return (
    <pre className="overflow-x-auto px-3 pb-2 whitespace-pre">
      {parts.map((p, i) => (p.className ? <span key={i} className={p.className}>{p.text}</span> : p.text))}
    </pre>
  );
}
