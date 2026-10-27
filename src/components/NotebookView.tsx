import { ArrowDown, ArrowUp, FileText, Play, Plus, SquareCode, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, ENGINE_LABEL, toError } from "../lib/ipc";
import { markdown, newCell, parseNotebook, serializeNotebook, type Block, type Cell, type Inline } from "../lib/notebook";
import { useConnections } from "../store/connections";
import { useIde } from "../store/ide";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import { useTabs, type QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { ConfirmRiskDialog } from "./ConfirmRiskDialog";
import { ResultsPanel } from "./ResultsPanel";
import { Select } from "./Select";
import { SqlEditor } from "./SqlEditor";
import { Button, IconButton } from "./ui";

const runKey = (tabId: string, cellId: string) => `${tabId}:${cellId}`;

/**
 * A notebook (.qnb in the IDE folder): SQL cells with their results, and markdown notes.
 * Every SQL cell runs on the tab's own session, so temp tables and variables carry between cells.
 */
export default function NotebookView({ tab }: { tab: QueryTab }) {
  const [cells, setCells] = useState<Cell[]>(() => parseNotebook(tab.sql).cells);
  const [editingMd, setEditingMd] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const saved = useConnections((s) => s.saved);
  const connection = saved.find((c) => c.id === tab.connectionId);
  const runs = useRuns((s) => s.runs);
  const settings = useSettings();

  // Save to the file shortly after each change.
  const timer = useRef<number>(undefined);
  const lastSaved = useRef(serializeNotebook({ version: 1, cells }));
  useEffect(() => {
    const text = serializeNotebook({ version: 1, cells });
    if (text === lastSaved.current) return;
    lastSaved.current = text;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      useTabs.getState().update(tab.id, { sql: text });
      if (tab.filePath) void api.workspaceWrite(tab.filePath, text).catch((e) => toast(`Couldn't save ${tab.filePath}: ${toError(e).message}`, "error"));
    }, 400);
  }, [cells]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (id: string, source: string) => setCells((cs) => cs.map((c) => (c.id === id ? { ...c, source } : c)));
  const insert = (at: number, type: Cell["type"]) => {
    const cell = newCell(type);
    setCells((cs) => [...cs.slice(0, at), cell, ...cs.slice(at)]);
    if (type === "md") setEditingMd(cell.id);
  };
  const move = (i: number, by: number) =>
    setCells((cs) => {
      const j = i + by;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (id: string) => {
    setCells((cs) => (cs.length > 1 ? cs.filter((c) => c.id !== id) : cs));
    useRuns.getState().clear(runKey(tab.id, id));
  };

  const runCell = async (cell: Cell) => {
    if (!cell.source.trim() || !tab.connectionId) return;
    await useRuns.getState().start(runKey(tab.id, cell.id), tab.connectionId, cell.source, 0, { session: tab.id, maxRows: settings.rowLimit || null });
  };
  const runAll = async () => {
    setRunningAll(true);
    try {
      for (const cell of cells) {
        if (cell.type !== "sql" || !cell.source.trim()) continue;
        await runCell(cell);
        const status = useRuns.getState().runs[runKey(tab.id, cell.id)]?.status;
        if (status !== "done") break;
      }
    } finally {
      setRunningAll(false);
    }
  };

  const asking = cells.map((c) => ({ cell: c, run: runs[runKey(tab.id, c.id)] })).find((x) => x.run?.status === "confirm" && x.run.risks);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Button variant="primary" className="h-6" onClick={() => void runAll()} disabled={runningAll || !tab.connectionId}>
          <Play className="size-3 fill-current" /> Run all
        </Button>
        <Select
          value={tab.connectionId}
          onChange={(id) => {
            useTabs.getState().update(tab.id, { connectionId: id });
            if (tab.filePath) useIde.getState().rememberConnection(tab.filePath, id);
            void useConnections.getState().connect(id);
          }}
          options={saved.map((c) => ({ value: c.id, label: c.name, hint: ENGINE_LABEL[c.engine] }))}
          placeholder="Pick a connection"
          className="h-6 max-w-56 rounded-md px-1.5 hover:bg-hover"
        />
        <span className="flex-1" />
        {tab.filePath && <span className="truncate text-[11px] text-faint">{tab.filePath}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-5xl flex-col">
          {cells.map((cell, i) => {
            const run = runs[runKey(tab.id, cell.id)];
            return (
              <Fragment key={cell.id}>
                <AddBar onAdd={(type) => insert(i, type)} />
                <div className="group relative rounded-xl border border-border bg-panel">
                  <div className="absolute -top-3 right-2 z-10 hidden items-center gap-0.5 rounded-lg border border-border bg-raised p-0.5 shadow-sm group-hover:flex">
                    <IconButton title="Move up" className="size-5" onClick={() => move(i, -1)}>
                      <ArrowUp className="size-3" />
                    </IconButton>
                    <IconButton title="Move down" className="size-5" onClick={() => move(i, 1)}>
                      <ArrowDown className="size-3" />
                    </IconButton>
                    <IconButton title="Delete cell" className="size-5" onClick={() => remove(cell.id)}>
                      <Trash2 className="size-3" />
                    </IconButton>
                  </div>
                  {cell.type === "sql" ? (
                    <>
                      <div className="flex items-start">
                        <button
                          type="button"
                          aria-label="Run cell"
                          data-tip="Run this cell"
                          data-shortcut="⌘↵"
                          onClick={() => void runCell(cell)}
                          disabled={run?.status === "running"}
                          className="m-2 inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] text-muted hover:bg-accent-soft hover:text-accent"
                        >
                          <Play className={`size-3 ${run?.status === "running" ? "animate-pulse" : ""} fill-current`} />
                        </button>
                        <div className="min-w-0 flex-1 py-1 pr-2" style={{ height: Math.min(22, Math.max(2, cell.source.split("\n").length)) * 20 + 20 }}>
                          <SqlEditor
                            initialValue={cell.source}
                            onChange={(s) => patch(cell.id, s)}
                            onRun={() => void runCell(cell)}
                            engine={connection?.engine ?? "postgres"}
                            fontSize={settings.fontSize}
                            vim={settings.vim}
                          />
                        </div>
                      </div>
                      {run && (
                        <div className="flex h-72 flex-col overflow-hidden rounded-b-xl border-t border-border">
                          <ResultsPanel run={run} tabId={runKey(tab.id, cell.id)} />
                        </div>
                      )}
                    </>
                  ) : editingMd === cell.id || !cell.source.trim() ? (
                    <textarea
                      autoFocus={editingMd === cell.id}
                      value={cell.source}
                      onChange={(e) => patch(cell.id, e.target.value)}
                      onBlur={() => setEditingMd(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.shiftKey))) {
                          e.preventDefault();
                          setEditingMd(null);
                        }
                      }}
                      placeholder="Write notes in Markdown (⇧↵ to finish)"
                      rows={Math.max(3, cell.source.split("\n").length + 1)}
                      className="block w-full resize-none rounded-xl bg-transparent px-4 py-3 font-mono text-[12.5px] outline-none"
                    />
                  ) : (
                    <div className="cursor-text px-4 py-3 text-[13px] leading-relaxed" onDoubleClick={() => setEditingMd(cell.id)} data-tip="Double-click to edit">
                      <Markdown blocks={markdown(cell.source)} />
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
          <AddBar always onAdd={(type) => insert(cells.length, type)} />
        </div>
      </div>
      {asking && connection && (
        <ConfirmRiskDialog
          connectionName={connection.name}
          risks={asking.run!.risks!}
          action="Run"
          onAnswer={(approved) => useRuns.getState().confirm(runKey(tab.id, asking.cell.id), approved)}
        />
      )}
    </div>
  );
}

function AddBar({ onAdd, always }: { onAdd(type: Cell["type"]): void; always?: boolean }) {
  return (
    <div className={`group/add flex h-6 items-center justify-center gap-1 ${always ? "mt-1" : ""}`}>
      <div className={`flex items-center gap-1 ${always ? "" : "opacity-0 transition-opacity group-hover/add:opacity-100"}`}>
        <Button variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={() => onAdd("sql")}>
          <Plus className="size-3" />
          <SquareCode className="size-3" /> SQL
        </Button>
        <Button variant="ghost" className="h-5 px-1.5 text-[11px]" onClick={() => onAdd("md")}>
          <Plus className="size-3" />
          <FileText className="size-3" /> Note
        </Button>
      </div>
    </div>
  );
}

function Inlines({ parts }: { parts: Inline[] }) {
  return parts.map((p, i) =>
    p.kind === "code" ? (
      <code key={i} className="rounded bg-raised px-1 font-mono text-[12px]">
        {p.text}
      </code>
    ) : p.kind === "bold" ? (
      <strong key={i}>{p.text}</strong>
    ) : p.kind === "italic" ? (
      <em key={i}>{p.text}</em>
    ) : p.kind === "link" ? (
      <span key={i} className="text-accent underline" data-tip={p.href}>
        {p.text}
      </span>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}

function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <div key={i} className={b.level === 1 ? "text-[19px] font-semibold" : b.level === 2 ? "text-[16px] font-semibold" : "text-[14px] font-semibold"}>
                <Inlines parts={b.inline} />
              </div>
            );
          case "paragraph":
            return (
              <p key={i}>
                <Inlines parts={b.inline} />
              </p>
            );
          case "list": {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List key={i} className={`${b.ordered ? "list-decimal" : "list-disc"} pl-5`}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines parts={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-lg bg-raised px-3 py-2 font-mono text-[12px]">
                {b.text}
              </pre>
            );
          case "rule":
            return <hr key={i} className="border-border" />;
        }
      })}
    </div>
  );
}
