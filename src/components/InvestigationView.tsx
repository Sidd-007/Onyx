import { ChevronRight, Copy, Download, FileSearch, FolderSearch, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CERTAINTY_LABEL, exportInvestigation, newId, type Certainty, type Evidence, type Investigation } from "../lib/investigation";
import { api, toError } from "../lib/ipc";
import { useInvestigations } from "../store/investigations";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

const TINT: Record<Certainty, string> = {
  observed: "bg-success-soft text-success",
  derived: "bg-accent-soft text-accent",
  hypothesis: "bg-warning-soft text-warning",
  unknown: "bg-hover text-muted",
  partial: "bg-warning-soft text-warning",
};

/** Investigations: a question, its scope, the evidence gathered, and findings that cite it. */
export default function InvestigationView({ tab }: { tab: QueryTab }) {
  void tab;
  const list = useInvestigations((s) => s.list);
  const current = useInvestigations((s) => s.current);
  const [exporting, setExporting] = useState(false);
  const { open, edit: change, create } = useInvestigations.getState();

  useEffect(() => {
    void useInvestigations.getState().refresh();
    // Unsaved edits are saved when the tab closes.
    return () => void useInvestigations.getState().flush();
  }, []);
  useEffect(() => {
    if (!current && list[0]) void open(list[0].id);
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-[12px] font-medium">
          Investigations
          <span className="flex-1" />
          <IconButton title="New investigation" className="size-6" onClick={() => void create()}>
            <Plus className="size-3.5" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => void open(i.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${current?.id === i.id ? "bg-selected" : "hover:bg-hover"}`}
            >
              <FolderSearch className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
            </button>
          ))}
          {!list.length && <p className="p-3 text-[11.5px] text-faint">None yet. Use “Save to investigation” on a result, a comparison or a context report, or start one with +.</p>}
        </div>
      </aside>
      {!current ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
          <FileSearch className="mr-2 size-4" /> Pick or start an investigation.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
            <div className="flex items-center gap-2">
              <input value={current.title} onChange={(e) => change({ ...current, title: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[17px] font-semibold outline-none" />
              <Button className="h-6" onClick={() => setExporting(true)}>
                <Download className="size-3.5" /> Export
              </Button>
              <IconButton
                title="Delete investigation"
                className="size-6"
                onClick={() =>
                  useOverlays.getState().askDanger({
                    title: `Delete “${current.title}”?`,
                    statement: `${current.evidence.length} pieces of evidence and ${current.findings.length} findings`,
                    connectionName: "this Mac",
                    prod: false,
                    action: "Delete",
                    run: () => useInvestigations.getState().remove(current.id),
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
            <Section title="Question">
              <textarea
                value={current.question}
                onChange={(e) => change({ ...current, question: e.target.value })}
                placeholder="What are you trying to explain? e.g. Why does customer 42 not see their paid order?"
                rows={2}
                className="q-field w-full resize-none px-2.5 py-2 text-[12.5px]"
              />
            </Section>
            <Section title="Scope">
              <div className="flex flex-wrap gap-1.5">
                {current.scope.connections.map((c) => (
                  <span key={c.id} className="rounded-md bg-hover px-2 py-0.5 text-[11.5px]">
                    {c.name} <span className="text-faint">· {c.engine} · {c.environment}</span>
                  </span>
                ))}
                {!current.scope.connections.length && <span className="text-[11.5px] text-faint">Connections join the scope as evidence is added.</span>}
              </div>
              <input
                value={current.scope.notes}
                onChange={(e) => change({ ...current, scope: { ...current.scope, notes: e.target.value } })}
                placeholder="Tenant, records, time window…"
                className="q-field mt-2 h-7 w-full px-2.5 text-[12px]"
              />
            </Section>
            <Section title={`Evidence (${current.evidence.length})`}>
              <div className="flex flex-col gap-2">
                {current.evidence.map((e) => (
                  <EvidenceCard key={e.id} evidence={e} onRemove={() => change({ ...current, evidence: current.evidence.filter((x) => x.id !== e.id), findings: current.findings.map((f) => ({ ...f, evidence: f.evidence.filter((id) => id !== e.id) })) })} />
                ))}
                {!current.evidence.length && <p className="text-[11.5px] text-faint">Nothing captured yet.</p>}
              </div>
            </Section>
            <Section title="Findings">
              <div className="flex flex-col gap-2">
                {current.findings.map((f, i) => (
                  <div key={f.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-2.5">
                    <div className="flex items-start gap-2">
                      <Select
                        value={f.certainty}
                        onChange={(certainty: Certainty) => change({ ...current, findings: current.findings.map((x, j) => (j === i ? { ...x, certainty } : x)) })}
                        options={(Object.keys(CERTAINTY_LABEL) as Certainty[]).map((c) => ({ value: c, label: CERTAINTY_LABEL[c] }))}
                        className={`h-6 shrink-0 rounded-md px-1.5 text-[11px] font-medium ${TINT[f.certainty]}`}
                      />
                      <textarea
                        value={f.text}
                        onChange={(e) => change({ ...current, findings: current.findings.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                        rows={2}
                        placeholder="What the evidence shows (or what you suspect, as a hypothesis)"
                        className="min-w-0 flex-1 resize-none bg-transparent text-[12.5px] outline-none"
                      />
                      <IconButton title="Remove finding" className="size-5" onClick={() => change({ ...current, findings: current.findings.filter((_, j) => j !== i) })}>
                        <Trash2 className="size-3" />
                      </IconButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-[11px]">
                      <span className="text-faint">Rests on:</span>
                      {current.evidence.map((e) => {
                        const on = f.evidence.includes(e.id);
                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => change({ ...current, findings: current.findings.map((x, j) => (j === i ? { ...x, evidence: on ? x.evidence.filter((id) => id !== e.id) : [...x.evidence, e.id] } : x)) })}
                            className={`rounded px-1.5 py-0.5 ${on ? "bg-accent-soft text-accent" : "bg-hover text-muted"}`}
                          >
                            {e.label}
                          </button>
                        );
                      })}
                      {f.certainty !== "hypothesis" && f.certainty !== "unknown" && !f.evidence.length && <span className="text-warning">· cite the evidence this rests on</span>}
                    </div>
                  </div>
                ))}
                <Button variant="ghost" className="h-6 self-start" onClick={() => change({ ...current, findings: [...current.findings, { id: newId(), text: "", certainty: "hypothesis", evidence: [] }] })}>
                  <Plus className="size-3.5" /> Add finding
                </Button>
              </div>
            </Section>
          </div>
        </div>
      )}
      {exporting && current && <ExportDialog investigation={current} onClose={() => setExporting(false)} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{title}</h3>
      {children}
    </section>
  );
}

function EvidenceCard({ evidence: e, onRemove }: { evidence: Evidence; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const data = e.data as { columns?: string[]; rows?: (string | null)[][] } | null;
  return (
    <div className="rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="font-medium">{e.label}</span>
          <span className="truncate text-[11px] text-faint">
            {e.kind} · {e.connection ? `${e.connection.name} (${e.connection.environment}) · ` : ""}
            {new Date(e.observedAt).toLocaleString()}
          </span>
        </button>
        <span className={`shrink-0 rounded px-1.5 text-[10.5px] font-medium ${e.complete ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`} title={e.limits}>
          {e.complete ? "complete" : "partial"}
        </span>
        <IconButton title="Remove from the investigation" className="size-5" onClick={onRemove}>
          <Trash2 className="size-3" />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2 text-[11.5px]">
          {e.limits && <p className="text-warning">Limits: {e.limits}</p>}
          {e.sql && <pre className="max-h-32 select-text overflow-auto rounded bg-raised px-2 py-1.5 font-mono text-[11px]">{e.sql}</pre>}
          {data?.columns && data.rows ? (
            <div className="max-h-64 overflow-auto rounded border border-border">
              <table className="min-w-full font-mono text-[11px]">
                <thead className="sticky top-0 bg-panel text-left text-faint">
                  <tr>{data.columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {r.map((v, j) => <td key={j} className={`max-w-60 truncate px-2 py-0.5 ${v === null ? "italic text-faint" : ""}`}>{v ?? "NULL"}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <pre className="max-h-64 select-text overflow-auto rounded bg-raised px-2 py-1.5 font-mono text-[11px]">{JSON.stringify(e.data, null, 2)?.slice(0, 20_000)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ExportDialog({ investigation, onClose }: { investigation: Investigation; onClose(): void }) {
  const [includeData, setIncludeData] = useState(false);
  const text = exportInvestigation(investigation, includeData);
  return (
    <Modal onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-3 p-5 text-[12px]">
        <h2 className="text-[14px] font-semibold">Export “{investigation.title}”</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} />
          Include evidence data (rows, reports). They can contain customer data: masking in the grid isn't removed from them.
        </label>
        <pre className="max-h-80 select-text overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px]">{text.slice(0, 40_000)}</pre>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => void navigator.clipboard.writeText(text).then(() => toast("Investigation copied as JSON", "success"), (e) => toast(toError(e).message, "error"))}>
            <Copy className="size-3.5" /> Copy JSON
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              void api.saveFile(investigation.title.replace(/[^\w-]+/g, "_").slice(0, 60) || "investigation", "json", text).then(
                (p) => {
                  if (p) toast(`Saved ${p}`, "success");
                  onClose();
                },
                (e) => toast(toError(e).message, "error"),
              )
            }
          >
            Save file…
          </Button>
        </div>
      </div>
    </Modal>
  );
}
