import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  Clock,
  FastForward,
  FileCode,
  GitBranch,
  Gauge,
  Lock,
  Play,
  Sparkles,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { registerTab } from "../lib/editors";
import { canExplain, explainSql, isReadQuery, parsePlan, type Plan } from "../lib/explain";
import { hasTransactions } from "../lib/transactions";
import { formatDuration, plural } from "../lib/format";
import { api, defaultSchemaOf, ENGINE_LABEL, isSqlEngine, toError, type HistoryEntry } from "../lib/ipc";
import { beginSql, transactionEffect } from "../lib/transactions";
import { substitute, variableNames } from "../lib/variables";
import { executeStatement, queryRows, applySidebarDatabase } from "../store/actions";
import { useConnections } from "../store/connections";
import { useIde } from "../store/ide";
import { useLibrary } from "../store/library";
import { useOverlays } from "../store/overlays";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import { useTabs, type QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { ConfirmRiskDialog } from "./ConfirmRiskDialog";
import { WritePreview } from "./WritePreview";
import { ExplainView } from "./ExplainView";
import { AskPanel } from "./AskPanel";
import { Modal } from "./Modal";
import { ResultsPanel } from "./ResultsPanel";
import { SqlEditor, type RunMode, type SqlEditorHandle } from "./SqlEditor";
import { Button, Divider, EnvBadge, IconButton, ConnectionDot } from "./ui";

type Values = Record<string, { value: string; raw: boolean }>;

export function QueryTabView({ tab }: { tab: QueryTab }) {
  const editor = useRef<SqlEditorHandle>(null);
  const run = useRuns((s) => s.runs[tab.id]);
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const schema = useConnections((s) => s.completion[tab.connectionId]);
  const foreignKeys = useConnections((s) => s.foreignKeys[tab.connectionId]);
  const txOpen = useConnections((s) => !!s.txOpen[tab.id]);
  const settings = useSettings();
  const resultsHidden = useUi((s) => s.resultsHidden);
  const [editorHeight, setEditorHeight] = useState(240);
  const [panelHeight, setPanelHeight] = useState(280);
  const ide = useIde((s) => s.enabled);
  const [naming, setNaming] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ plan: Plan; sql: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [askVars, setAskVars] = useState<{ sql: string; offset: number; names: string[] } | null>(null);
  const [values, setValues] = useState<Values>({});
  const [aiOpen, setAiOpen] = useState(false);
  const running = run?.status === "running";
  const prod = connection?.environment === "prod";
  const engine = connection?.engine ?? "postgres";
  // A MySQL connection without a database works in the one picked in the sidebar.
  const sidebarSchema = useUi((s) => s.sidebarSchema[tab.connectionId]);
  const defaultSchema = connection ? defaultSchemaOf(connection) || sidebarSchema || undefined : undefined;

  // Persist SQL shortly after typing stops.
  const saveTimer = useRef<number>(undefined);
  const onChange = (sql: string) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => useTabs.getState().update(tab.id, { sql }), 300);
    if (tab.filePath) scheduleWrite(sql);
  };

  // IDE mode: a file tab saves to its file as you type.
  const [fileState, setFileState] = useState<"saved" | "pending" | "error">("saved");
  const pendingWrite = useRef<{ timer: number; sql: string } | null>(null);
  const filePath = useRef(tab.filePath);
  filePath.current = tab.filePath;
  const writeFile = async (sql: string) => {
    const path = filePath.current;
    if (!path) return;
    try {
      await api.workspaceWrite(path, sql);
      if (!pendingWrite.current) setFileState("saved");
    } catch (e) {
      setFileState("error");
      toast(`Couldn't save ${path}: ${toError(e).message}`, "error");
    }
  };
  const cancelWrite = () => {
    if (pendingWrite.current) window.clearTimeout(pendingWrite.current.timer);
    pendingWrite.current = null;
  };
  const flushWrite = () => {
    const pending = pendingWrite.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingWrite.current = null;
    void writeFile(pending.sql);
  };
  const scheduleWrite = (sql: string) => {
    if (pendingWrite.current) window.clearTimeout(pendingWrite.current.timer);
    pendingWrite.current = { sql, timer: window.setTimeout(flushWrite, 500) };
    setFileState("pending");
  };
  // Write what's pending when the tab closes; show the file as it is on disk when it opens.
  useEffect(() => {
    if (tab.filePath) {
      void api.workspaceRead(tab.filePath).then(
        (disk) => {
          if (!pendingWrite.current && editor.current && disk !== editor.current.getValue()) {
            editor.current.insert(disk, true);
            // Loading isn't an edit: drop the write the insert scheduled.
            cancelWrite();
            setFileState("saved");
          }
        },
        () => {},
      );
    }
    return flushWrite;
  }, [tab.filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Which connection this tab runs on. A tab with an open transaction keeps its own. */
  const pickConnection = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { saved, txOpen } = useConnections.getState();
    useOverlays.getState().openMenu(r.left, r.bottom + 4, [
      { heading: "Run this tab on" },
      ...saved.map((c) => ({
        label: `${c.id === tab.connectionId ? "✓ " : ""}${c.name}`,
        hint: ENGINE_LABEL[c.engine] ?? c.engine,
        onSelect: () => {
          if (c.id === tab.connectionId) return;
          if (txOpen[tab.id]) return toast("Commit or roll back this tab's transaction first", "error");
          if (tab.connectionId) void api.closeTabSession(tab.connectionId, tab.id).catch(() => {});
          useTabs.getState().update(tab.id, { connectionId: c.id });
          if (tab.filePath) useIde.getState().rememberConnection(tab.filePath, c.id);
          void useConnections.getState().connect(c.id);
        },
      })),
    ]);
  };

  /** Ask → chart: the next run's result opens as a chart. */
  const chartNext = useRef(false);
  const runSql = async (sql: string, offset: number) => {
    setPlan(null);
    editor.current?.clearError();
    await applySidebarDatabase(tab.connectionId, tab.id);
    await useRuns.getState().start(tab.id, tab.connectionId, sql, offset, {
      record: !prod || settings.prodHistory,
      maxRows: settings.rowLimit || null,
      // Each query tab has its own session: its transactions and SETs stay here.
      session: tab.id,
      chart: chartNext.current,
    });
    chartNext.current = false;
    const done = useRuns.getState().runs[tab.id];
    // Track BEGIN / COMMIT typed by hand too.
    const effect = done && done.status !== "confirm" ? transactionEffect(sql, engine) : null;
    if (effect) useConnections.getState().setTxOpen(tab.id, effect === "begin" && done?.status === "done" ? tab.connectionId : null);
  };

  const execute = (mode: RunMode) => {
    if (!connection) return toast("Choose a connection for this tab first (top right)", "error");
    const target = editor.current?.target(mode);
    if (!target || useRuns.getState().runs[tab.id]?.status === "running") return;
    // :name variables are SQL's; Mongo's { key: value } and Redis arguments would look like them.
    const names = isSqlEngine(engine) ? variableNames(target.sql) : [];
    if (names.length) return setAskVars({ ...target, names });
    // The same write again, after its last run lost the connection mid-flight: it may already have happened.
    const last = useRuns.getState().runs[tab.id];
    if (last?.outcomeUnknown && last.sql.trim() === target.sql.trim()) {
      return useOverlays.getState().askDanger({
        title: "This statement may already have run",
        statement: target.sql,
        connectionName: connection.name,
        prod: connection.environment === "prod",
        action: "Run it again",
        detail: "Its last run lost the connection before the server answered, so Onyx can't tell whether it changed anything. Check the data first (a SELECT), then run it again only if it didn't.",
        run: () => runSql(target.sql, target.offset),
      });
    }
    void runSql(target.sql, target.offset);
  };

  const explain = async (analyze: boolean) => {
    const target = editor.current?.target("current");
    if (!target || explaining) return;
    if (!canExplain(engine)) return toast(`Query plans aren't available for ${ENGINE_LABEL[engine]}`, "error");
    if (variableNames(target.sql).length) return toast("Run it once to fill in its :variables, then explain", "error");
    if (analyze && !isReadQuery(target.sql)) return toast("EXPLAIN ANALYZE runs the statement, so it's only offered for queries", "error");
    setExplaining(true);
    try {
      if (!(await useConnections.getState().connect(tab.connectionId))) throw toError("Not connected");
      await applySidebarDatabase(tab.connectionId, tab.id);
      const { columns, rows } = await queryRows(tab.connectionId, explainSql(engine, target.sql, analyze), 100_000, tab.id);
      setPlan({ plan: parsePlan(engine, columns, rows, analyze && engine !== "sqlite"), sql: target.sql });
      if (useUi.getState().resultsHidden) useUi.getState().toggleResults();
    } catch (e) {
      toast(toError(e).message, "error");
    } finally {
      setExplaining(false);
    }
  };

  /** ⌘S: update the saved query, or ask for a name the first time. */
  const save = async (name?: string) => {
    const sql = editor.current?.getValue() ?? tab.sql;
    if (tab.filePath) {
      cancelWrite();
      await writeFile(sql);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
      return;
    }
    const id = tab.savedQueryId ?? crypto.randomUUID();
    const finalName = name ?? tab.title;
    if (!tab.savedQueryId && name === undefined) return setNaming(true);
    try {
      await useLibrary.getState().save({ id, name: finalName, sql, connectionId: tab.connectionId, updatedAt: 0 });
      useTabs.getState().update(tab.id, { sql, savedQueryId: id, title: finalName.split("/").pop() || finalName });
      setNaming(false);
      setSaveError(null);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setSaveError(toError(e).message);
    }
  };

  const transaction = async (action: "begin" | "commit" | "rollback") => {
    const sql = action === "begin" ? beginSql(engine) : action.toUpperCase();
    const error = await executeStatement(tab.connectionId, sql, tab.id);
    if (error) return toast(error.message, "error");
    useConnections.getState().setTxOpen(tab.id, action === "begin" ? tab.connectionId : null);
    toast(action === "begin" ? "Transaction started: changes stay invisible to others until you commit" : action === "commit" ? "Committed" : "Rolled back", "success");
  };

  useEffect(() =>
    registerTab(tab.id, {
      run: execute,
      format: () => editor.current?.format(),
      save: () => void save(),
      explain: (analyze) => void explain(analyze),
      askAi: () => setAiOpen(true),
    }),
  );

  // Point at the error in the editor.
  const error = run?.error;
  useEffect(() => {
    if (error?.position != null && run) editor.current?.showError(run.sqlOffset + error.position - 1, error.message);
  }, [error, run?.sqlOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  const startResize = (e: React.MouseEvent) => {
    const startY = e.clientY;
    const startHeight = editorHeight;
    const move = (ev: MouseEvent) => setEditorHeight(Math.max(80, startHeight + ev.clientY - startY));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const explainMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    useOverlays.getState().openMenu(r.left, r.bottom + 4, [
      { label: "Explain", hint: "⌘E", onSelect: () => void explain(false) },
      ...(engine !== "sqlite" ? [{ label: engine === "clickhouse" ? "Explain pipeline" : "Explain analyze (runs the query)", onSelect: () => void explain(true) }] : []),
    ]);
  };

  // IDE mode, like Cursor: the editor fills the tab and the toolbar heads a results panel at the
  // bottom, which ✕ closes. `order` moves them without remounting the editor.
  const results = !resultsHidden && (!ide || !!run || !!plan);
  const clearResults = () => {
    setPlan(null);
    editor.current?.clearError();
    useRuns.getState().clear(tab.id);
  };
  const startPanelResize = (e: React.MouseEvent) => {
    const startY = e.clientY;
    const startHeight = panelHeight;
    const move = (ev: MouseEvent) => setPanelHeight(Math.max(80, startHeight - (ev.clientY - startY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const toolbar = (
    <div
      className={`flex h-9 shrink-0 items-center gap-0.5 px-1.5 ${ide ? "order-3 border-t border-border bg-panel" : "border-b border-border"}`}
    >
      <button
        type="button"
        aria-label="Run"
        data-tip="Run the selection or the statement under the cursor"
        data-shortcut="⌘↵"
        disabled={running}
        onClick={() => execute("current")}
        className="q-primary inline-flex size-6 items-center justify-center rounded-[7px] transition duration-100 disabled:opacity-40"
      >
        <Play className="size-3 fill-current" />
      </button>
      <IconButton title="Run all" shortcut="⇧⌘↵" disabled={running} onClick={() => execute("all")}>
        <FastForward className="size-3.5" />
      </IconButton>
      {running && (
        <IconButton title="Cancel query" shortcut="⌘." onClick={() => void useRuns.getState().cancel(tab.id)} className="text-danger hover:text-danger">
          <Square className="size-3 fill-current" />
        </IconButton>
      )}
      <Button variant="ghost" className="h-6 px-1.5" title="How the database runs this query (⌘E)" disabled={explaining || !canExplain(engine)} onClick={explainMenu}>
        <Gauge className={`size-3.5 ${explaining ? "animate-pulse" : ""}`} /> Explain
      </Button>
      <Divider />
      <IconButton title="Format SQL" shortcut="⇧⌘F" disabled={!isSqlEngine(engine)} onClick={() => editor.current?.format()}>
        <WandSparkles className="size-3.5" />
      </IconButton>
      <Button variant="ghost" className={`h-6 px-1.5 ${aiOpen ? "bg-selected text-fg" : ""}`} title="Write SQL from a description (⇧⌘I)" onClick={() => setAiOpen((v) => !v)}>
        <Sparkles className="size-3.5" /> Ask
      </Button>
      {tab.filePath ? (
        <span
          className={`flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] ${fileState === "error" ? "text-danger" : savedFlash ? "text-success" : "text-muted"}`}
          data-tip={`${tab.filePath}\nSaved to the file as you type (⌘S saves now)`}
        >
          <FileCode className="size-3.5" />
          <span className="max-w-64 truncate">{tab.filePath}</span>
          <span className="text-faint">{fileState === "pending" ? "· Saving…" : fileState === "error" ? "· Not saved" : savedFlash ? "· Saved" : ""}</span>
        </span>
      ) : naming ? (
        <SaveName
          initial={tab.title.startsWith("Query ") ? "" : tab.title}
          error={saveError}
          onSave={(name) => void save(name)}
          onCancel={() => {
            setNaming(false);
            setSaveError(null);
          }}
        />
      ) : (
        <IconButton
          title={savedFlash ? "Saved" : tab.savedQueryId ? "Update saved query" : "Save query"}
          shortcut="⌘S"
          onClick={() => void save()}
          className={savedFlash ? "text-success" : ""}
        >
          {tab.savedQueryId ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />}
        </IconButton>
      )}
      {tab.savedQueryId && <Timings sql={() => editor.current?.getValue() ?? tab.sql} />}
      {hasTransactions(engine) && (
        <>
          <Divider />
          {txOpen ? (
            <span className="flex h-5 items-center gap-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-fg">
              <GitBranch className="size-3" /> In a transaction
            </span>
          ) : (
            <Button variant="ghost" className="h-6 px-1.5" title="Changes wait for Commit or Roll back, and other tabs don't see them until then" onClick={() => void transaction("begin")}>
              <GitBranch className="size-3.5" /> Begin transaction
            </Button>
          )}
        </>
      )}
      <span className="flex-1" />
      {(run || plan) && (
        <IconButton title="Clear the result" disabled={running} onClick={clearResults}>
          <X className="size-3.5" />
        </IconButton>
      )}
      {connection ? (
        <button
          type="button"
          onClick={pickConnection}
          className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-muted hover:bg-hover"
          data-tip={`${connection.user}@${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}\nClick to run this tab on another connection`}
        >
          <ConnectionDot environment={connection.environment} />
          {connection.name}
          {engine === "mysql" && !connection.database.trim() && sidebarSchema && <span className="text-faint">· {sidebarSchema}</span>}
          {connection.readOnly && <Lock className="size-3 text-faint" />}
          <EnvBadge environment={connection.environment} />
          <ChevronDown className="size-3 text-faint" />
        </button>
      ) : (
        <Button variant="primary" className="h-6" onClick={pickConnection}>
          Choose connection <ChevronDown className="size-3" />
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {prod && <div className="h-0.5 shrink-0 bg-danger" title="Prod connection" />}
        {toolbar}
        {txOpen && (
          <div className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px]">
            <GitBranch className="size-3.5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-warning">Transaction open on {connection?.name ?? "this connection"}.</span>{" "}
              <span className="text-muted">Changes so far are only visible in this tab, and locks are held until you end it.</span>
            </span>
            <Button variant="primary" className="h-6" onClick={() => void transaction("commit")}>
              Commit
            </Button>
            <Button className="h-6 text-danger" onClick={() => void transaction("rollback")}>
              Roll back
            </Button>
          </div>
        )}


        <div
          style={resultsHidden || ide ? undefined : { height: editorHeight }}
          className={resultsHidden || ide ? "order-1 min-h-0 flex-1" : "shrink-0"}
        >
          <SqlEditor
            ref={editor}
            initialValue={tab.sql}
            onChange={onChange}
            onRun={execute}
            onExplain={canExplain(engine) ? () => void explain(false) : undefined}
            engine={engine}
            schema={schema}
            defaultSchema={defaultSchema}
            foreignKeys={foreignKeys}
            fontSize={settings.fontSize}
            vim={settings.vim}
          />
        </div>

        {results && (
          <>
            <div
              onMouseDown={ide ? startPanelResize : startResize}
              className={`h-1.5 shrink-0 cursor-row-resize border-t border-border bg-panel transition-colors duration-150 hover:bg-accent-soft ${ide ? "order-2" : ""}`}
            />
            <div className={ide ? "order-4 flex min-h-0 shrink-0 flex-col" : "flex min-h-0 flex-1 flex-col"} style={ide ? { height: panelHeight } : undefined}>
              {plan ? <ExplainView plan={plan.plan} sql={plan.sql} onClose={() => setPlan(null)} /> : <ResultsPanel run={run} tabId={tab.id} />}
            </div>
          </>
        )}

        {run?.status === "confirm" && run.risks && connection && (
          <ConfirmRiskDialog
            connectionName={connection.name}
            risks={run.risks}
            action="Run"
            onAnswer={(approved) => useRuns.getState().confirm(tab.id, approved)}
          >
            {run.risks.some((r) => r.reason === "changes rows on prod") && <WritePreview connectionId={tab.connectionId} sql={run.sql} />}
          </ConfirmRiskDialog>
        )}

        {askVars && (
          <VariablesDialog
            names={askVars.names}
            values={values}
            onCancel={() => setAskVars(null)}
            onRun={(filled) => {
              setValues((v) => ({ ...v, ...filled }));
              setAskVars(null);
              void runSql(substitute(askVars.sql, filled, engine), askVars.offset);
            }}
          />
        )}
      </div>
      {aiOpen && (
        <AskPanel
          connectionId={tab.connectionId}
          defaultSchema={defaultSchema ?? null}
          editorSql={() => editor.current?.getValue() ?? ""}
          onClose={() => {
            setAiOpen(false);
            editor.current?.focus?.();
          }}
          onUse={(sql, how) => {
            editor.current?.insert(sql, how !== "insert");
            if (how === "chart") chartNext.current = true;
            if (how === "run" || how === "chart") window.setTimeout(() => execute("all"));
          }}
        />
      )}
    </div>
  );
}

/** Values for the query's `:variables`, remembered per tab. */
function VariablesDialog({
  names,
  values,
  onRun,
  onCancel,
}: {
  names: string[];
  values: Values;
  onRun(values: Values): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<Values>(() => Object.fromEntries(names.map((n) => [n, values[n] ?? { value: "", raw: false }])));
  return (
    <Modal onClose={onCancel} width="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRun(draft);
        }}
      >
        <div className="p-5">
          <h2 className="font-semibold">Query variables</h2>
          <p className="mt-1 text-[12px] text-muted">
            Numbers, NULL, true and false go in as they are; anything else is quoted. Tick SQL to insert an expression like now().
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {names.map((n, i) => (
              <label key={n} className="flex items-center gap-2 text-[12px]">
                <span className="w-28 truncate font-mono text-muted">:{n}</span>
                <input
                  autoFocus={i === 0}
                  value={draft[n].value}
                  onChange={(e) => setDraft((d) => ({ ...d, [n]: { ...d[n], value: e.target.value } }))}
                  className="q-field h-7 min-w-0 flex-1 px-2 font-mono text-[12px]"
                />
                <span className="flex items-center gap-1 text-[11px] text-faint">
                  <input
                    type="checkbox"
                    checked={draft[n].raw}
                    onChange={(e) => setDraft((d) => ({ ...d, [n]: { ...d[n], raw: e.target.checked } }))}
                    className=""
                  />
                  SQL
                </span>
              </label>
            ))}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-border bg-panel px-5 py-3">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit">
            Run
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

/** A saved query's earlier runs, to spot it getting slower. */
function Timings({ sql }: { sql(): string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setRuns(null);
    void api.queryTimings(sql()).then(setRuns, () => setRuns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const max = Math.max(1, ...(runs ?? []).map((r) => r.durationMs));
  return (
    <span className="relative">
      <IconButton title="Timing history" active={open} onClick={() => setOpen((v) => !v)}>
        <Clock className="size-3.5" />
      </IconButton>
      {open && (
        <div
          className="absolute left-0 top-7 z-30 w-80 rounded-lg border border-border bg-raised p-2 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="px-1 pb-1.5 text-[11px] font-medium text-muted">Runs of this exact query</div>
          {runs === null && <p className="px-1 py-2 text-[12px] text-faint">Loading…</p>}
          {runs?.length === 0 && <p className="px-1 py-2 text-[12px] text-faint">No runs recorded yet.</p>}
          <div className="max-h-64 overflow-y-auto">
            {runs?.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-1 py-0.5 text-[11px] tabular-nums">
                <span className="w-24 shrink-0 text-faint">{new Date(r.executedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
                  <span className={`block h-full rounded-full ${r.error ? "bg-danger" : "bg-accent"}`} style={{ width: `${(r.durationMs / max) * 100}%` }} />
                </span>
                <span className="w-16 shrink-0 text-right">{formatDuration(r.durationMs)}</span>
                <span className="w-16 shrink-0 truncate text-right text-faint">{r.error ? "error" : plural(r.rowCount, "row")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

function SaveName({
  initial,
  error,
  onSave,
  onCancel,
}: {
  initial: string;
  error: string | null;
  onSave(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="folder/name"
        title={error ?? "Use / to put it in a folder, e.g. reports/daily signups"}
        className={`q-field h-6 w-52 px-2 text-[12px] ${error ? "!border-danger" : ""}`}
      />
      <Button variant="primary" type="submit" disabled={!name.trim()}>
        Save
      </Button>
      <Button onClick={onCancel}>Cancel</Button>
    </form>
  );
}
