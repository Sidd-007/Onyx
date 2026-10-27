import { Braces, ChartLine, CircleCheck, Columns2, Download, FolderSearch, GitCompare, ImageDown, LoaderCircle, PanelRight, Pin, PinOff } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { formatCount, formatDuration, plural } from "../lib/format";
import { api, toError, type ExportFormat } from "../lib/ipc";
import { shown as masked } from "../lib/privacy";
import { blobBase64, svgImage, tableImage } from "../lib/resultImage";
import type { ResultSet } from "../lib/resultSet";
import { exportRows } from "../store/actions";
import { useDialogs } from "../store/dialogs";
import { useOverlays } from "../store/overlays";
import { useRuns, type Output, type Run } from "../store/runs";
import { useSettings } from "../store/settings";
import { useConnections } from "../store/connections";
import { connectionRef, useInvestigations } from "../store/investigations";
import { toast } from "../store/toasts";
import { DocumentView, hasDocuments } from "./DocumentView";
import { ResultsGrid } from "./ResultsGrid";
import { Button, Divider, IconButton } from "./ui";

const ChartView = lazy(() => import("./ChartView"));
const ResultCompare = lazy(() => import("./ResultCompare"));

export const EXPORT_LABELS: Record<ExportFormat, string> = { csv: "CSV", json: "JSON", sql: "SQL INSERTs", xlsx: "Excel (XLSX)" };

type Mode = "grid" | "chart" | "split" | "diff";

export function ResultsPanel({ run, tabId }: { run: Run | undefined; tabId?: string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("grid");
  const [showRow, setShowRow] = useState(false);
  // MongoDB results open as documents; the grid is a click away.
  const [documents, setDocuments] = useState(true);
  const pinned = useRuns((s) => (tabId ? s.pinned[tabId] : undefined));
  const rowLimit = useSettings((s) => s.rowLimit);
  const privacy = useSettings((s) => s.privacy);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setPicked(null), [run?.id]);
  // Ask → chart: the result opens as a chart.
  useEffect(() => {
    if (run?.chart) setMode("chart");
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pinned && (mode === "split" || mode === "diff")) setMode("grid");
  }, [pinned, mode]);

  if (!run) {
    return <Centered>Run a query with ⌘↵ to see results here.</Centered>;
  }

  const { outputs } = run;
  // By default show the last result that has rows (or the last output).
  const lastRows = outputs.findLastIndex((o) => o.kind === "rows");
  const shown = picked ?? (lastRows >= 0 ? lastRows : outputs.length - 1);
  const output = outputs[shown];

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      {outputs.length > 1 && (
        <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5">
          {outputs.map((o, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPicked(i)}
              className={`h-5 shrink-0 rounded px-2 text-[11px] transition-colors duration-150 ${
                i === shown ? "bg-selected font-medium text-fg" : "text-muted hover:bg-hover"
              }`}
            >
              {i + 1}. {outputLabel(o)}
            </button>
          ))}
        </div>
      )}

      {output?.kind === "rows" && (
        <>
          <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5 text-[11px] text-muted">
            <span className="tabular-nums">
              {output.result.truncated && output.result.totalRows !== null
                ? `${formatCount(output.result.rowCount)} of ${plural(output.result.totalRows, "row")}`
                : plural(output.result.rowCount, "row")}
            </span>
            {output.result.truncated && run.status !== "running" && onlyRows(run) && tabId && (
              <>
                <Button
                  variant="ghost"
                  className="h-5"
                  title="Run the query again, keeping more rows"
                  onClick={() => void useRuns.getState().rerun(tabId, output.result.rowCount + (rowLimit || 1000))}
                >
                  Load more
                </Button>
                <Button variant="ghost" className="h-5" title="Run the query again, keeping every row" onClick={() => void useRuns.getState().rerun(tabId, null)}>
                  Fetch all
                </Button>
              </>
            )}
            <span className="flex-1" />
            {tabId && (
              <Button
                variant="ghost"
                className={`h-5 px-1.5 ${pinned ? "text-accent" : ""}`}
                title={pinned ? "Stop comparing with the pinned result" : "Keep this result, change data or SQL, run again, then see what changed"}
                onClick={() =>
                  useRuns
                    .getState()
                    .pin(tabId, pinned ? null : { result: output.result, sql: run.sql, label: `Run at ${new Date().toLocaleTimeString()}` })
                }
              >
                {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {pinned ? (pinned.result === output.result ? "Pinned: run again to compare" : "Unpin") : "Pin to compare"}
              </Button>
            )}
            {pinned && pinned.result !== output.result && (
              <>
                <Button variant="ghost" className={`h-5 px-1.5 ${mode === "diff" ? "bg-selected text-fg" : ""}`} title="What changed since the pinned result" onClick={() => setMode(mode === "diff" ? "grid" : "diff")}>
                  <GitCompare className="size-3.5" /> Changes
                </Button>
                <Button variant="ghost" className={`h-5 px-1.5 ${mode === "split" ? "bg-selected text-fg" : ""}`} title="Side by side with the pinned result" onClick={() => setMode(mode === "split" ? "grid" : "split")}>
                  <Columns2 className="size-3.5" /> Side by side
                </Button>
              </>
            )}
            <Divider />
            {hasDocuments(output.result) && (
              <IconButton title={documents ? "Show as a grid" : "Show as documents"} active={documents && mode === "grid"} onClick={() => setDocuments((v) => !v)}>
                <Braces className="size-3.5" />
              </IconButton>
            )}
            <Button variant="ghost" className={`h-5 px-1.5 ${mode === "chart" ? "bg-selected text-fg" : ""}`} title="Chart this result" onClick={() => setMode(mode === "chart" ? "grid" : "chart")}>
              <ChartLine className="size-3.5" /> Chart
            </Button>
            <IconButton
              title="Save this result to an investigation (a snapshot of up to 500 rows, with its SQL and time)"
              disabled={run.status === "running"}
              onClick={() => {
                const r = output.result;
                const keep = Math.min(r.rowCount, 500);
                const connection = useConnections.getState().saved.find((c) => c.id === run.connectionId);
                useInvestigations.getState().offer({
                  kind: "result",
                  label: `Result · ${run.sql.replace(/\s+/g, " ").slice(0, 40)}`,
                  observedAt: Date.now(),
                  connection: connection ? connectionRef(connection) : undefined,
                  sql: run.sql,
                  complete: keep === r.rowCount && !r.truncated,
                  limits: keep < r.rowCount ? `first ${keep} of ${r.rowCount} rows kept` : r.truncated ? `the run kept ${r.rowCount} rows; the query returned more` : undefined,
                  data: { columns: r.columns, rows: Array.from({ length: keep }, (_, row) => r.columns.map((_, c) => r.cell(c, row))) },
                });
              }}
            >
              <FolderSearch className="size-3.5" />
            </IconButton>
            <IconButton
              title="Result as an image"
              disabled={run.status === "running"}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const make = () => resultPng(output.result, mode === "chart" ? root.current?.querySelector<SVGSVGElement>("svg.absolute") : null, privacy);
                useOverlays.getState().openMenu(r.right - 180, r.bottom + 4, [
                  { heading: mode === "chart" ? "The chart as a PNG" : `The first ${Math.min(40, output.result.rowCount)} rows as a PNG` },
                  { label: "Copy image", onSelect: () => void copyPng(make) },
                  { label: "Save as PNG…", onSelect: () => void savePng(make, "result") },
                ]);
              }}
            >
              <ImageDown className="size-3.5" />
            </IconButton>
            <IconButton title="Row details" active={showRow} onClick={() => setShowRow((v) => !v)}>
              <PanelRight className="size-3.5" />
            </IconButton>
            <Button
              variant="ghost"
              className="h-5 px-1.5"
              disabled={run.status === "running"}
              title="Export every row of the query to a file, or copy them to another connection"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const items = (["csv", "json", "sql", "xlsx"] as ExportFormat[]).map((format) => ({
                  label: EXPORT_LABELS[format],
                  onSelect: () => void exportRows(run.connectionId, run.sql, format, "query"),
                }));
                useOverlays.getState().openMenu(r.right - 160, r.bottom + 4, [
                  { heading: "Export every row of the query" },
                  ...items,
                  "separator",
                  {
                    label: "Copy rows to a connection…",
                    onSelect: () => useDialogs.getState().open({ kind: "copy", connectionId: run.connectionId, sql: run.sql, name: "query_result" }),
                  },
                ]);
              }}
            >
              <Download className="size-3.5" /> Export
            </Button>
          </div>
          <Suspense fallback={null}>
            {mode === "chart" ? (
              <ChartView result={output.result} version={run.version} />
            ) : mode === "diff" && pinned ? (
              <ResultCompare before={pinned.result} after={output.result} />
            ) : mode === "split" && pinned ? (
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col border-r border-border">
                  <div className="h-6 shrink-0 truncate border-b border-border bg-panel px-3 text-[11px] leading-6 text-muted" data-tip={pinned.sql}>
                    Pinned · {pinned.label} · {plural(pinned.result.rowCount, "row")}
                  </div>
                  <ResultsGrid result={pinned.result} version={0} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="h-6 shrink-0 border-b border-border bg-panel px-3 text-[11px] leading-6 text-muted">Latest</div>
                  <ResultsGrid key={`${run.id}-${shown}`} result={output.result} version={run.version} />
                </div>
              </div>
            ) : documents && hasDocuments(output.result) ? (
              <DocumentView key={`${run.id}-${shown}`} result={output.result} version={run.version} run={run} tabId={tabId} />
            ) : (
              <ResultsGrid
                key={`${run.id}-${shown}`}
                result={output.result}
                version={run.version}
                showRow={showRow}
                onCloseRow={() => setShowRow(false)}
              />
            )}
          </Suspense>
        </>
      )}
      {output?.kind === "command" && (
        <Centered>
          <span className="flex items-center gap-1.5 text-fg">
            <CircleCheck className="size-4 text-success" /> Statement succeeded · {plural(output.rowsAffected, "row")}{" "}
            affected
          </span>
        </Centered>
      )}
      {!output && run.status === "running" && (
        <Centered>
          <span className="flex items-center gap-1.5">
            <LoaderCircle className="size-3.5 animate-spin" /> Running… <Elapsed since={run.startedAt} />
          </span>
        </Centered>
      )}
      {!output && run.status === "done" && <Centered>Nothing to show.</Centered>}
      {!output && run.status === "confirm" && <Centered>Waiting for your confirmation…</Centered>}

      {run.error &&
        (run.status === "cancelled" ? (
          <div className="shrink-0 border-t border-border bg-panel px-3 py-2 text-[12px] text-muted">
            {!run.cancelRequested && run.timeoutMs
              ? `Query timed out after ${formatDuration(run.timeoutMs)} (change this in Settings).`
              : "Query cancelled."}
          </div>
        ) : (
          <div className="max-h-40 shrink-0 select-text overflow-y-auto border-t border-border bg-danger-soft px-3 py-2 text-[12px]">
            <p className="font-medium text-danger">
              {run.error.message}
              {run.error.code && <span className="ml-2 font-mono text-[11px] opacity-70">{run.error.code}</span>}
            </p>
            {run.error.detail && <p className="mt-1 text-fg">{run.error.detail}</p>}
            {run.error.hint && <p className="mt-1 text-muted">Hint: {run.error.hint}</p>}
          </div>
        ))}
    </div>
  );
}

/** The chart (when showing) or the first rows, as a PNG. Privacy mode masks the grid's values. */
function resultPng(result: ResultSet, chart: SVGSVGElement | null | undefined, privacy: boolean): Promise<Blob> {
  if (chart) return svgImage(chart);
  return tableImage(result.columns, result.rowCount, (c, r) => masked(result.columns[c], result.cell(c, r), privacy), `Onyx · ${new Date().toLocaleString()}`);
}

async function copyPng(make: () => Promise<Blob>) {
  try {
    // A promise keeps the click's permission to write to the clipboard while the image draws.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": make() })]);
    toast("Copied the image", "success");
  } catch (e) {
    toast(`Couldn't copy the image: ${toError(e).message}`, "error");
  }
}

async function savePng(make: () => Promise<Blob>, name: string) {
  try {
    const path = await api.saveFile(name, "png", await blobBase64(await make()), true);
    if (path) toast(`Saved ${path}`, "success");
  } catch (e) {
    toast(toError(e).message, "error");
  }
}

/** Load more re-runs the SQL: only offer it when the run returned rows and changed nothing. */
function onlyRows(run: Run): boolean {
  return run.outputs.every((o) => o.kind === "rows");
}

function outputLabel(o: Output): string {
  return o.kind === "rows" ? plural(o.result.rowCount, "row") : `${plural(o.rowsAffected, "row")} affected`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center text-[12px] text-muted">{children}</div>;
}

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatDuration(now - since)}</span>;
}
