import { Play, Plus, X } from "lucide-react";
import { useRef } from "react";
import { ENGINE_LABEL } from "../lib/ipc";
import { isConnected, useConnections } from "../store/connections";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import { useTabs, type QueryTab } from "../store/tabs";
import { ResultsPanel } from "./ResultsPanel";
import { Select } from "./Select";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Button, IconButton } from "./ui";

const ALIASES = ["pg", "my", "db", "a", "b", "c", "d"];

/**
 * A query across connections: each gets an alias, and tables are named `alias.table` or
 * `alias.schema.table`. Onyx reads those tables (up to 200,000 rows each) into an
 * in-memory SQLite database and runs the query there (SQLite's SQL).
 */
export default function CrossDbView({ tab }: { tab: QueryTab }) {
  const editor = useRef<SqlEditorHandle>(null);
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const run = useRuns((s) => s.runs[tab.id]);
  const settings = useSettings();
  const sources = tab.sources ?? [{ alias: "db", connectionId: tab.connectionId }];
  const usable = saved.filter((c) => c.engine !== "redis" && c.engine !== "mongodb");

  const setSources = (next: typeof sources) => useTabs.getState().update(tab.id, { sources: next });
  const execute = () => {
    const sql = editor.current?.target("current")?.sql ?? "";
    if (!sql.trim() || run?.status === "running") return;
    void useRuns.getState().start(tab.id, sources[0]?.connectionId ?? tab.connectionId, sql, 0, {
      federated: sources,
      record: false,
      maxRows: settings.rowLimit || null,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <button
          type="button"
          aria-label="Run"
          data-tip="Run the selection or the statement under the cursor"
          data-shortcut="⌘↵"
          onClick={execute}
          className="q-primary inline-flex size-6 items-center justify-center rounded-[7px]"
        >
          <Play className="size-3 fill-current" />
        </button>
        <span className="ml-1 text-muted">Sources</span>
        {sources.map((s, i) => (
          <span key={i} className="flex items-center gap-1 rounded-lg border border-border bg-raised py-0.5 pl-1 pr-0.5">
            <input
              value={s.alias}
              onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, alias: e.target.value.replace(/\W/g, "") } : x)))}
              className="h-5 w-12 rounded bg-input px-1 font-mono text-[11.5px] text-accent outline-none"
              spellCheck={false}
            />
            <span className="text-faint">=</span>
            <Select
              value={s.connectionId}
              onChange={(connectionId) => setSources(sources.map((x, j) => (j === i ? { ...x, connectionId } : x)))}
              options={usable.map((c) => ({ value: c.id, label: c.name, hint: `${ENGINE_LABEL[c.engine]}${isConnected(status[c.id]) ? "" : " · not connected"}` }))}
              className="h-5 max-w-40 rounded px-1 text-[11.5px] hover:bg-hover"
            />
            {sources.length > 1 && (
              <IconButton title="Remove" className="size-4" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                <X className="size-3" />
              </IconButton>
            )}
          </span>
        ))}
        <Button
          variant="ghost"
          className="h-6"
          onClick={() => setSources([...sources, { alias: ALIASES.find((a) => !sources.some((s) => s.alias === a)) ?? `s${sources.length}`, connectionId: usable[0]?.id ?? tab.connectionId }])}
        >
          <Plus className="size-3.5" /> Add
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-faint">e.g. SELECT … FROM {sources[0]?.alias ?? "db"}.users u JOIN {sources[1]?.alias ?? "db"}.orders o ON …</span>
      </div>
      <div className="h-56 shrink-0 border-b border-border">
        <SqlEditor
          ref={editor}
          initialValue={tab.sql}
          onChange={(sql) => useTabs.getState().update(tab.id, { sql })}
          onRun={execute}
          engine="sqlite"
          fontSize={settings.fontSize}
          vim={settings.vim}
        />
      </div>
      <ResultsPanel run={run} tabId={tab.id} />
    </div>
  );
}
