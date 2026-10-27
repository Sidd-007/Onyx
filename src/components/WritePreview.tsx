import { Eye, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { api, toError, type WritePreview as Preview } from "../lib/ipc";
import { Button } from "./ui";

/**
 * "Preview the changes" for a prod UPDATE / DELETE: Onyx runs it in a transaction that's
 * rolled back and shows the rows before and after.
 */
export function WritePreview({ connectionId, sql }: { connectionId: string; sql: string }) {
  const [state, setState] = useState<{ busy: boolean; preview?: Preview | null; error?: string }>({ busy: false });
  const load = async () => {
    setState({ busy: true });
    try {
      setState({ busy: false, preview: await api.previewWrite(connectionId, sql) });
    } catch (e) {
      setState({ busy: false, error: toError(e).message });
    }
  };
  if (!state.preview && state.preview !== null) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={() => void load()} disabled={state.busy}>
          {state.busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />} Preview the changes
        </Button>
        <span className="text-[11px] text-faint">Runs it in a transaction that's rolled back.</span>
        {state.error && <span className="text-[11.5px] text-danger">{state.error}</span>}
      </div>
    );
  }
  if (state.preview === null) {
    return <p className="mt-3 text-[11.5px] text-faint">No preview for this statement (one UPDATE or DELETE on a single table can be previewed).</p>;
  }
  const p = state.preview;
  const changed = (r: number, c: number) => p.update && p.after[r] && p.after[r][c] !== p.before[r][c];
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <p className="text-[12px]">
        <span className="font-medium">{p.total.toLocaleString()}</span> row{p.total === 1 ? "" : "s"} of {p.target} {p.update ? "change" : "go away"}
        {p.total > p.before.length && <span className="text-faint"> (first {p.before.length.toLocaleString()} shown)</span>}
      </p>
      <div className="max-h-64 overflow-auto rounded-lg border border-border">
        <table className="w-full select-text border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-panel text-left text-muted">
            <tr>
              {p.columns.map((c) => (
                <th key={c} className={`whitespace-nowrap border-b border-border px-2 py-1 font-medium ${p.keyColumns.includes(c) ? "text-accent" : ""}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.before.map((row, r) => (
              <tr key={r} className={`border-b border-border ${p.update ? "" : "bg-danger-soft"}`}>
                {row.map((v, c) => (
                  <td key={c} className={`max-w-56 truncate px-2 py-1 ${changed(r, c) ? "bg-warning-soft" : ""}`}>
                    {changed(r, c) ? (
                      <>
                        <span className="text-danger line-through opacity-70">{v ?? "NULL"}</span> <span>{p.after[r][c] ?? "NULL"}</span>
                      </>
                    ) : (
                      (v ?? <span className="text-faint">NULL</span>)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10.5px] text-faint">Nothing was kept. Sequences and triggers with outside effects may still have run.</p>
    </div>
  );
}
