import { ChevronRight, Copy, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { slowest, type Plan, type PlanNode } from "../lib/explain";
import { formatCount, formatDuration } from "../lib/format";
import { copyText } from "../store/actions";
import { Button, IconButton } from "./ui";

/** A query plan as a tree: time of its own per step, rows estimated vs actual, warnings. */
export function ExplainView({ plan, sql, onClose }: { plan: Plan; sql: string; onClose(): void }) {
  const [showRaw, setShowRaw] = useState(false);
  const worst = slowest(plan.nodes);
  const total = plan.nodes.reduce((sum, n) => sum + (n.totalMs ?? n.cost ?? 0), 0) || 1;
  const warnings = countWarnings(plan.nodes);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border pl-3 pr-1.5 text-[11px] text-muted">
        <span className="font-medium text-fg">{plan.analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
        {plan.planningMs !== null && <span>planning {formatDuration(plan.planningMs)}</span>}
        {plan.executionMs !== null && <span>execution {formatDuration(plan.executionMs)}</span>}
        {warnings > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <TriangleAlert className="size-3" /> {warnings} to look at
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-faint" data-tip={sql}>
          {sql.replace(/\s+/g, " ")}
        </span>
        {plan.raw && plan.text === null && (
          <Button variant="ghost" className="h-5" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Tree" : "Raw plan"}
          </Button>
        )}
        {plan.raw && (
          <Button variant="ghost" className="h-5" onClick={() => void copyText(plan.raw!, "Plan copied")}>
            <Copy className="size-3" /> Copy
          </Button>
        )}
        <IconButton title="Back to results" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {plan.problem && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-warning-soft px-3 py-1.5 text-[12px] text-warning">
          <TriangleAlert className="size-3.5 shrink-0" /> {plan.problem}
        </div>
      )}
      <div className="min-h-0 flex-1 select-text overflow-auto p-2 font-mono text-[11.5px]">
        {plan.text !== null || showRaw ? (
          <pre className="whitespace-pre p-2 leading-snug">{plan.text ?? plan.raw}</pre>
        ) : (
          plan.nodes.map((n, i) => <Node key={i} node={n} depth={0} total={total} worst={worst} analyzed={plan.analyzed} />)
        )}
      </div>
    </div>
  );
}

function countWarnings(nodes: PlanNode[]): number {
  return nodes.reduce((sum, n) => sum + n.warnings.length + countWarnings(n.children), 0);
}

function Node({ node, depth, total, worst, analyzed }: { node: PlanNode; depth: number; total: number; worst: PlanNode | null; analyzed: boolean }) {
  const [open, setOpen] = useState(true);
  const share = analyzed ? (node.selfMs ?? 0) / total : 0;
  const isWorst = node === worst && (node.selfMs ?? node.cost ?? 0) > 0;
  return (
    <div>
      <div
        className={`group flex items-start gap-1.5 rounded-md py-1 pr-2 hover:bg-hover ${isWorst ? "bg-danger-soft" : ""}`}
        style={{ paddingLeft: 4 + depth * 18 }}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center text-faint ${node.children.length ? "" : "invisible"}`}
        >
          <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate ${isWorst ? "font-semibold text-danger" : "font-medium text-fg"}`}>{node.label}</span>
            {isWorst && <span className="shrink-0 text-[10px] font-sans font-medium uppercase text-danger">{analyzed ? "slowest" : "costliest"}</span>}
          </div>
          {node.detail.map((d, i) => (
            <div key={i} className="truncate text-[11px] text-muted" data-tip={d}>
              {d}
            </div>
          ))}
          {node.warnings.map((w, i) => (
            <div key={i} className="flex items-center gap-1 font-sans text-[11px] text-warning">
              <TriangleAlert className="size-3 shrink-0" /> {w}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5 text-[11px] tabular-nums text-muted">
          {node.estimatedRows !== null && (
            <span data-tip="Estimated rows">
              est {formatCount(node.estimatedRows)}
            </span>
          )}
          {node.actualRows !== null && (
            <span className="text-fg" data-tip={node.loops && node.loops > 1 ? `${node.loops} loops` : "Actual rows"}>
              {formatCount(node.actualRows)} rows
            </span>
          )}
          {node.cost !== null && !analyzed && <span data-tip="Planner cost">cost {formatCount(Math.round(node.cost))}</span>}
          {analyzed && node.selfMs !== null && (
            <span className="flex w-28 items-center gap-1.5" data-tip={`${formatDuration(node.totalMs ?? 0)} including steps below`}>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
              </span>
              {formatDuration(node.selfMs)}
            </span>
          )}
        </div>
      </div>
      {open && node.children.map((c, i) => <Node key={i} node={c} depth={depth + 1} total={total} worst={worst} analyzed={analyzed} />)}
    </div>
  );
}
