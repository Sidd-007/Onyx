import { ArrowUp, Check, Copy, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, toError } from "../lib/ipc";
import { useConnections } from "../store/connections";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Button, IconButton, Kbd } from "./ui";

export type AskUse = "insert" | "replace" | "run" | "chart";

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; sql: string; explanation: string }
  | { id: number; role: "error"; text: string };

const SUGGESTIONS = ["Rows added in the last 7 days", "Count rows by status", "The 10 newest rows with their related records"];

/**
 * Ask, as a chat beside the editor: natural language → SQL with Claude. Sent: the request, the
 * schema (names and types), Claude's previous answer when refining, and the editor's SQL only
 * when ticked for this chat (it can hold values from the data). Never rows. Nothing runs until
 * you pick an action on an answer.
 */
export function AskPanel({
  connectionId,
  defaultSchema,
  editorSql,
  onUse,
  onClose,
}: {
  connectionId: string;
  defaultSchema: string | null;
  editorSql(): string;
  onUse(sql: string, how: AskUse): void;
  onClose(): void;
}) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === connectionId));
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  /** The editor's SQL goes along only when ticked: it can contain values from the data. */
  const [includeEditor, setIncludeEditor] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    void api.hasApiKey().then(setHasKey, () => setHasKey(false));
    input.current?.focus();
  }, []);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);
  // The composer grows with what's typed, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [prompt]);

  const blocked: { text: string; action?: { label: string; run(): void } } | null = !connection
    ? { text: "Pick a connection for this tab first." }
    : connection.environment === "prod"
      ? { text: "Ask is off for prod connections: schema details never leave for a production database." }
      : !connection.aiEnabled
        ? { text: `Ask is off for ${connection.name}. Turn on natural-language SQL in its settings.`, action: { label: "Connection settings", run: () => useUi.getState().editConnection(connectionId) } }
        : hasKey === false
          ? { text: "Add your Anthropic API key in Settings to use Ask.", action: { label: "Open Settings", run: () => useUi.getState().showSettings() } }
          : null;

  const lastSql = [...messages].reverse().find((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant" && !!m.sql)?.sql;
  const lastAnswerId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const editorText = editorSql().trim();
  const context = lastSql ? "last answer" : includeEditor && editorText ? "editor SQL" : null;

  const send = async (text = prompt) => {
    const request = text.trim();
    if (!request || busy || blocked) return;
    setPrompt("");
    setMessages((m) => [...m, { id: nextId.current++, role: "user", text: request }]);
    setBusy(true);
    try {
      const answer = await api.aiSql(connectionId, request, lastSql ?? (includeEditor ? editorSql().trim() || null : null), defaultSchema);
      setMessages((m) => [...m, { id: nextId.current++, role: "assistant", ...answer }]);
    } catch (e) {
      setMessages((m) => [...m, { id: nextId.current++, role: "error", text: toError(e).message }]);
    }
    setBusy(false);
    input.current?.focus();
  };

  return (
    <aside
      className="q-slide-in flex w-[380px] shrink-0 flex-col border-l border-border bg-panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <span className="text-[14px] font-semibold tracking-[-0.01em]">Ask</span>
        <span className="q-label">schema · never rows</span>
        <span className="flex-1" />
        <IconButton title="New chat" disabled={!messages.length || busy} onClick={() => setMessages([])}>
          <RotateCcw className="size-3.5" />
        </IconButton>
        <IconButton title="Close" shortcut="Esc" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </header>

      <div ref={thread} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!messages.length && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <pre className="font-mono text-[12px] text-faint">{"> _"}</pre>
            <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Describe the query you want</h3>
            <p className="max-w-[280px] text-[12.5px] text-muted">
              Claude writes one statement from your tables and columns. Ask again to refine it; nothing runs until you choose.
            </p>
            {!blocked && (
              <div className="mt-3 flex w-full flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-[10px] border border-border px-3 py-2 text-left text-[12.5px] text-muted transition-colors duration-[120ms] hover:bg-hover hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-col gap-4">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-10 self-end select-text whitespace-pre-wrap rounded-[12px] border border-border bg-raised px-3 py-2 text-[12.5px]">
                {m.text}
              </div>
            ) : m.role === "error" ? (
              <p key={m.id} className="select-text whitespace-pre-wrap text-[12.5px] text-danger">
                {m.text}
              </p>
            ) : (
              <Answer key={m.id} sql={m.sql} explanation={m.explanation} latest={m.id === lastAnswerId} onUse={onUse} />
            ),
          )}
          {busy && (
            <p className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-faint">
              <LoaderCircle className="size-3 animate-spin" /> Writing
            </p>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        {blocked ? (
          <div className="flex flex-col items-start gap-2 text-[12.5px] text-muted">
            {blocked.text}
            {blocked.action && <Button onClick={blocked.action.run}>{blocked.action.label}</Button>}
          </div>
        ) : (
          <>
            <form
              className="q-field flex items-end gap-2 py-1.5 pl-3 pr-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={input}
                rows={1}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={messages.length ? "Refine it, e.g. only paid orders" : "e.g. top 10 customers by revenue this month"}
                className="min-h-[22px] min-w-0 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-[1.45] outline-none"
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={busy || !prompt.trim()}
                className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-solid text-solid-text transition-opacity duration-[120ms] hover:opacity-[.88] disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
            </form>
            {!lastSql && editorText && (
              <label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
                <input type="checkbox" checked={includeEditor} onChange={(e) => setIncludeEditor(e.target.checked)} />
                Include the editor's SQL
                <span className="text-faint">(it can contain values from your data)</span>
              </label>
            )}
            <div className="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
              <span>{context ? `Sends: request, schema, ${context}` : "Sends: request, schema"}</span>
              <span className="flex-1" />
              <Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> new line
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}

function Answer({ sql, explanation, latest, onUse }: { sql: string; explanation: string; latest: boolean; onUse(sql: string, how: AskUse): void }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(sql).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      (e) => toast(toError(e).message, "error"),
    );
  return (
    <div className="flex flex-col gap-2">
      {explanation && <p className="select-text text-[12.5px] leading-[1.5] text-fg">{explanation}</p>}
      {sql && (
        <>
          <div className="group relative rounded-[10px] border border-border bg-bg">
            <pre className="max-h-64 select-text overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">{sql}</pre>
            <IconButton title={copied ? "Copied" : "Copy SQL"} className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </IconButton>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant={latest ? "primary" : "secondary"} onClick={() => onUse(sql, "run")} title="Replace the editor's SQL with this and run it">
              Run
            </Button>
            <Button onClick={() => onUse(sql, "replace")}>Replace</Button>
            <Button variant="ghost" onClick={() => onUse(sql, "insert")}>
              Insert
            </Button>
            <Button variant="ghost" onClick={() => onUse(sql, "chart")} title="Run it and show the result as a chart">
              Run &amp; chart
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
