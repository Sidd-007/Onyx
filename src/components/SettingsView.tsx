import { CircleCheck, CircleDashed, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, toError, type ToolStatus } from "../lib/ipc";
import { DEFAULT_SETTINGS, useSettings } from "../store/settings";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Button, IconButton } from "./ui";
import { Select } from "./Select";

const ROW_LIMITS = [100, 500, 1000, 5000, 10000, 0];
const TIMEOUTS = [0, 10, 30, 60, 300, 900];

export function SettingsView() {
  const s = useSettings();
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    void api.toolStatus().then(setTools, () => {});
    void api.hasApiKey().then(setHasKey, () => setHasKey(false));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useUi.getState().showTabs();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const saveKey = async (value: string) => {
    try {
      await api.setApiKey(value);
      setHasKey(value.trim() !== "");
      setKey("");
      toast(value ? "API key saved in the vault" : "API key removed", "success");
    } catch (e) {
      toast(toError(e).message, "error");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-7 px-6 py-10">
        <header className="flex items-center">
          <h1 className="flex-1 text-lg font-semibold tracking-tight">Settings</h1>
          <IconButton title="Close" shortcut="Esc" onClick={() => useUi.getState().showTabs()}>
            <X className="size-4" />
          </IconButton>
        </header>

        <Section title="Appearance">
          <Row label="Sidebar">
            <Segmented
              value={s.sidebarSide}
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
              onChange={(sidebarSide: "left" | "right") => s.set({ sidebarSide })}
            />
          </Row>
          <Row label="Interface size">
            <NumberSelect
              value={s.uiScale}
              options={[0.9, 1, 1.1, 1.2, 1.25].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }))}
              onChange={(uiScale) => s.set({ uiScale })}
            />
          </Row>
          <Row label="Editor and grid font">
            <NumberSelect
              value={s.fontSize}
              options={[11, 12, 13, 14, 15, 16].map((v) => ({ value: v, label: `${v} px` }))}
              onChange={(fontSize) => s.set({ fontSize })}
            />
          </Row>
        </Section>

        <Section title="Queries">
          <Row label="Rows kept per result" hint="More load with “Load more” or “Fetch all”.">
            <NumberSelect
              value={s.rowLimit}
              options={ROW_LIMITS.map((v) => ({ value: v, label: v ? v.toLocaleString() : "No limit" }))}
              onChange={(rowLimit) => s.set({ rowLimit })}
            />
          </Row>
          <Row label="Query timeout" hint="Cancels the query on the server.">
            <NumberSelect
              value={s.queryTimeoutSec}
              options={TIMEOUTS.map((v) => ({ value: v, label: v === 0 ? "None" : v < 60 ? `${v} s` : `${v / 60} min` }))}
              onChange={(queryTimeoutSec) => s.set({ queryTimeoutSec })}
            />
          </Row>
          <Row label="History for prod connections">
            <Check checked={s.prodHistory} onChange={(prodHistory) => s.set({ prodHistory })}>
              Record queries run on prod
            </Check>
          </Row>
        </Section>

        <Section title="Editor">
          <Row label="Vim keys">
            <Check checked={s.vim} onChange={(vim) => s.set({ vim })}>
              Vim mode in query editors
            </Check>
          </Row>
        </Section>

        <Section title="Natural-language SQL">
          <p className="px-4 py-2.5 text-[12px] text-muted">
            Write SQL from a description (⇧⌘I) with Claude. Only schema names and types are sent, never rows, and only
            for connections where you turned it on. Prod connections are always excluded.
          </p>
          <Row label="Anthropic API key">
            {hasKey ? (
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[12px] text-success">
                  <CircleCheck className="size-3.5" /> Saved in the vault
                </span>
                <Button variant="danger" onClick={() => void saveKey("")}>
                  Remove
                </Button>
              </span>
            ) : (
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (key.trim()) void saveKey(key.trim());
                }}
              >
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-ant-…"
                  className="q-field h-7 w-56 px-2 text-[12px]"
                />
                <Button variant="primary" type="submit" disabled={!key.trim()}>
                  Save
                </Button>
              </form>
            )}
          </Row>
        </Section>

        <Section title="Command-line tools">
          <p className="px-4 py-2.5 text-[12px] text-muted">Dump, restore and DuckDB use these when they're installed.</p>
          {(
            [
              ["pgDump", "pg_dump, psql", "brew install postgresql"],
              ["mysqldump", "mysqldump, mysql", "brew install mysql-client"],
              ["sqlite3", "sqlite3", "included with macOS"],
              ["duckdb", "duckdb", "brew install duckdb"],
            ] as const
          ).map(([k, name, install]) => (
            <Row key={k} label={name}>
              {tools?.[k] ? (
                <span className="flex items-center gap-1 text-[12px] text-success">
                  <CircleCheck className="size-3.5" /> Installed
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[12px] text-muted">
                  <CircleDashed className="size-3.5" />
                  <code className="select-text font-mono text-[11.5px]">{install}</code>
                </span>
              )}
            </Row>
          ))}
        </Section>

        <footer className="border-t border-border pt-4">
          <Button variant="ghost" onClick={() => s.set(DEFAULT_SETTINGS)}>
            Reset to defaults
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">{title}</h2>
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-panel">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-4 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px]">{label}</div>
        {hint && <div className="text-[11.5px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function NumberSelect<T extends number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return <Select value={value} options={options} onChange={onChange} className="q-field h-7 min-w-28 px-2 text-[12px]" />;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="q-switch" />
      {children}
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="q-seg">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

