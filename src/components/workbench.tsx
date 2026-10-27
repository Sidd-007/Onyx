/** Building blocks shared by the investigation tools: a page, numbered steps, labelled fields, a rows preview. */
import type { ReactNode } from "react";

export function Page({ title, intro, actions, children }: { title: string; intro: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6 text-[12.5px]">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h2>
            <p className="mt-1 max-w-3xl text-muted">{intro}</p>
          </div>
          {actions}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Step({ n, title, children, right }: { n?: number; title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[12px] border border-border p-4">
      <h3 className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">
        {n !== undefined && <span className="font-mono text-[10.5px] font-medium text-faint">{String(n).padStart(2, "0")}</span>}
        <span className="flex-1">{title}</span>
        {right}
      </h3>
      {children}
    </section>
  );
}

export function Labeled({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="q-label">{label}</span>
      {children}
    </label>
  );
}

export function Text({ value, onChange, placeholder, mono, className = "" }: { value: string; onChange(v: string): void; placeholder?: string; mono?: boolean; className?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} className={`q-field h-7 px-[9px] ${mono ? "font-mono text-[11.5px]" : ""} ${className}`} />;
}

export function SqlArea({ value, onChange, rows = 3, placeholder }: { value: string; onChange(v: string): void; rows?: number; placeholder?: string }) {
  return <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} spellCheck={false} className="q-field w-full resize-y px-2.5 py-2 font-mono text-[11.5px]" />;
}

export function RowsPreview({ columns, rows, max = 50, tint }: { columns: string[]; rows: (string | null)[][]; max?: number; tint?: (row: number) => string }) {
  return (
    <div className="max-h-72 overflow-auto rounded-[10px] border border-border">
      <table className="min-w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-panel text-left">
          <tr>{columns.map((c, i) => <th key={i} className="q-label whitespace-nowrap px-2 py-1.5">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} className={`border-t border-border ${tint?.(i) ?? ""}`}>
              {r.map((v, j) => <td key={j} className={`max-w-64 truncate px-2 py-0.5 ${v === null ? "italic text-faint" : ""}`} title={v ?? "NULL"}>{v ?? "NULL"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <p className="px-2 py-1 text-[11px] text-faint">…{rows.length - max} more rows</p>}
    </div>
  );
}

/** A status word: mono uppercase, no colour but red for a failure. */
export const Badge = ({ tone, children }: { tone: "good" | "bad" | "warn" | "muted" | "accent"; children: ReactNode }) => (
  <span className={`shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.1em] ${{ good: "text-fg", bad: "text-danger", warn: "text-muted", muted: "text-faint", accent: "text-fg" }[tone]}`}>{children}</span>
);

export const ErrorNote = ({ error }: { error: string | null }) => (error ? <p className="select-text whitespace-pre-wrap rounded-[10px] border border-danger/30 px-3 py-2 text-danger">{error}</p> : null);
