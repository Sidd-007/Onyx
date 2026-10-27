import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { vim } from "@replit/codemirror-vim";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { format as formatSql } from "sql-formatter";
import type { Engine, ForeignKeyRef } from "../lib/ipc";
import { joinConditions } from "../lib/joinHints";
import { snippets } from "../lib/snippets";
import { statementAt } from "../lib/sqlSplit";

export type RunMode = "current" | "all";

export interface SqlEditorHandle {
  /** The SQL to run: the selection, the statement under the cursor, or everything. */
  target(mode: RunMode): { sql: string; offset: number } | null;
  getValue(): string;
  showError(position: number, message: string): void;
  clearError(): void;
  format(): void;
  focus(): void;
  /** Replaces the selection (or inserts at the cursor); `all` replaces the whole text. */
  insert(text: string, all?: boolean): void;
}

interface Props {
  initialValue: string;
  onChange(value: string): void;
  onRun(mode: RunMode): void;
  /** Shows the selection's query plan (offered next to Run when text is selected). */
  onExplain?(): void;
  engine: Engine;
  schema?: SQLNamespace;
  /** Where unqualified table names resolve: "public", or the MySQL database. */
  defaultSchema?: string;
  /** For JOIN … ON suggestions. */
  foreignKeys?: ForeignKeyRef[];
  fontSize?: number;
  vim?: boolean;
}

const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

/** The editors' look, shared with the JSON cell editor. */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none", paddingLeft: "4px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selected) !important" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-foldGutter span": { color: "var(--faint)" },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    border: "1px solid var(--line-strong)",
    borderRadius: "10px",
    overflow: "hidden",
    boxShadow: "var(--shadow)",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: MONO, fontSize: "12.5px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--solid)", color: "var(--solid-text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": { color: "var(--solid-text)", opacity: 0.6 },
  ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
    textUnderlineOffset: "3px",
  },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--selected)", outline: "1px solid var(--line-strong)" },
  ".cm-tooltip.cm-selection-actions": { display: "flex", gap: "2px", padding: "3px", borderRadius: "8px", fontFamily: "inherit" },
  ".cm-selection-actions button": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "24px",
    padding: "0 8px",
    borderRadius: "5px",
    fontSize: "12px",
    color: "var(--fg)",
    cursor: "default",
  },
  ".cm-selection-actions button:hover": { backgroundColor: "var(--hover)" },
  ".cm-selection-actions button.primary": { color: "var(--text)", fontWeight: "600" },
  ".cm-selection-actions kbd": { fontFamily: MONO, fontSize: "10.5px", color: "var(--faint)", border: "none", padding: 0 },
});

const setDragging = StateEffect.define<boolean>();
const setFocused = StateEffect.define<boolean>();

/** Whether the mouse is down selecting, and whether the editor has focus. */
const pointerState = StateField.define<{ dragging: boolean; focused: boolean }>({
  create: () => ({ dragging: false, focused: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDragging)) value = { ...value, dragging: e.value };
      if (e.is(setFocused)) value = { ...value, focused: e.value };
    }
    return value;
  },
});

/** A small Run / Explain bar under selected SQL, once the mouse is let go. */
function selectionActions(actions: () => { run(): void; explain?(): void }) {
  const compute = (state: EditorState): readonly Tooltip[] => {
    const selection = state.selection.main;
    const { dragging, focused } = state.field(pointerState);
    if (selection.empty || dragging || !focused || state.selection.ranges.length > 1) return [];
    if (!state.sliceDoc(selection.from, selection.to).trim()) return [];
    return [
      {
        pos: selection.to,
        above: false,
        arrow: false,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-selection-actions";
          const button = (label: string, key: string, onClick: () => void, primary = false) => {
            const b = document.createElement("button");
            b.type = "button";
            if (primary) b.className = "primary";
            b.append(label);
            const kbd = document.createElement("kbd");
            kbd.textContent = key;
            b.append(kbd);
            // Keep the selection and focus in the editor.
            b.addEventListener("mousedown", (e) => e.preventDefault());
            b.addEventListener("click", onClick);
            dom.append(b);
          };
          button("▶ Run selection", "⌘↵", () => actions().run(), true);
          const explain = actions().explain;
          if (explain) button("Explain", "⌘E", explain);
          return { dom };
        },
      },
    ];
  };
  const field = StateField.define<readonly Tooltip[]>({
    create: compute,
    update: (tips, tr) =>
      tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setDragging) || e.is(setFocused)) ? compute(tr.state) : tips,
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });
  return [
    pointerState,
    field,
    EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        view.dispatch({ effects: setDragging.of(true) });
        const up = () => {
          window.removeEventListener("mouseup", up);
          view.dispatch({ effects: setDragging.of(false) });
        };
        window.addEventListener("mouseup", up);
        return false;
      },
    }),
  ];
}

export const editorHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--hl-type)" },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--hl-keyword)", fontWeight: "600" },
  { tag: t.string, color: "var(--hl-string)" },
  // lang-sql tags quoted identifiers (`name`, "name") as special strings: they are names.
  { tag: t.special(t.string), color: "var(--fg)" },
  { tag: [t.number, t.bool, t.null], color: "var(--hl-number)" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--hl-type)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: "var(--muted)" },
  { tag: t.special(t.name), color: "var(--hl-type)" },
]);

// ClickHouse quotes names with backticks like MySQL.
const DIALECT = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite, duckdb: StandardSQL, sqlserver: MSSQL, clickhouse: MySQL };

const MONGO_METHODS = [
  "find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct", "insertOne", "insertMany",
  "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "createIndex", "dropIndex", "getIndexes", "drop",
  "sort", "limit", "skip", "projection", "explain", "stats", "renameCollection",
];
const REDIS_COMMANDS = (
  "GET SET DEL EXISTS EXPIRE TTL PTTL PERSIST TYPE KEYS SCAN RENAME INCR INCRBY DECR APPEND STRLEN MGET MSET " +
  "HGET HSET HDEL HGETALL HKEYS HVALS HLEN HSCAN HINCRBY LPUSH RPUSH LPOP RPOP LRANGE LLEN LINDEX LREM " +
  "SADD SREM SMEMBERS SISMEMBER SCARD SSCAN ZADD ZREM ZRANGE ZREVRANGE ZRANGEBYSCORE ZSCORE ZCARD ZSCAN " +
  "XADD XRANGE XLEN XREAD INFO DBSIZE SELECT PING CONFIG CLIENT MEMORY SLOWLOG OBJECT"
).split(" ");

/** Mongo tabs: JavaScript, with collection and method completion. Redis tabs: command completion. */
function commandLanguage(engine: "mongodb" | "redis", schema: SQLNamespace | undefined) {
  const collections = schema && !Array.isArray(schema) ? Object.values(schema).flatMap((tables) => (tables && typeof tables === "object" && !Array.isArray(tables) ? Object.keys(tables) : [])) : [];
  if (engine === "redis") {
    const commands = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/^[ \t]*\w*/);
      if (!word || (word.text.trim() === "" && !ctx.explicit)) return null;
      return { from: word.to - word.text.trimStart().length, options: REDIS_COMMANDS.map((c) => ({ label: c, type: "keyword" })), validFor: /^\w*$/ };
    };
    return [EditorState.languageData.of(() => [{ autocomplete: commands }])];
  }
  const js = javascript();
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const member = ctx.matchBefore(/db\.[\w$]*\.?[\w$]*$/);
    if (member) {
      const parts = member.text.split(".");
      if (parts.length === 2) {
        const from = member.from + 3;
        return { from, options: [...collections.map((c) => ({ label: c, type: "class" })), ...["getCollection", "runCommand", "getCollectionNames"].map((m) => ({ label: m, type: "method" }))] };
      }
      return { from: member.to - parts[2].length, options: MONGO_METHODS.map((m) => ({ label: m, type: "method", apply: `${m}()` })) };
    }
    const chained = ctx.matchBefore(/\)\.[\w$]*$/);
    if (chained) return { from: chained.from + 2, options: MONGO_METHODS.map((m) => ({ label: m, type: "method", apply: `${m}()` })) };
    return null;
  };
  return [js, js.language.data.of({ autocomplete: source })];
}

/** SQL with schema completion, plus snippets and JOIN … ON conditions from foreign keys. */
function language(engine: Engine, schema: SQLNamespace | undefined, defaultSchema: string | undefined, keys: () => ForeignKeyRef[]) {
  if (engine === "mongodb" || engine === "redis") return commandLanguage(engine, schema);
  const support = sql({ dialect: DIALECT[engine], schema, defaultSchema, upperCaseKeywords: true });
  const list = snippets(engine);
  const snippetSource = (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/\w+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: word.from, options: list, validFor: /^\w*$/ };
  };
  const joinSource = (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos);
    const conditions = joinConditions(before, keys(), defaultSchema ?? "public");
    if (!conditions.length) return null;
    const word = ctx.matchBefore(/[\w.]*/);
    return {
      from: word?.from ?? ctx.pos,
      options: conditions.map((label) => ({ label, type: "keyword", detail: "foreign key", boost: 99 })),
    };
  };
  return [support, support.language.data.of({ autocomplete: snippetSource }), support.language.data.of({ autocomplete: joinSource })];
}

const fontTheme = (size: number) => EditorView.theme({ "&": { fontSize: `${size}px` } });

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialValue, onChange, onRun, onExplain, engine, schema, defaultSchema, foreignKeys, fontSize = 13, vim: vimMode = false },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageConf = useRef(new Compartment());
  const vimConf = useRef(new Compartment());
  const fontConf = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun, onExplain, engine, foreignKeys });
  callbacks.current = { onChange, onRun, onExplain, engine, foreignKeys };
  const keys = () => callbacks.current.foreignKeys ?? [];

  useEffect(() => {
    const run = (mode: RunMode) => () => {
      callbacks.current.onRun(mode);
      return true;
    };
    view.current = new EditorView({
      parent: host.current!,
      doc: initialValue,
      extensions: [
        // Vim's keymap goes first so it sees keys before the others.
        vimConf.current.of(vimMode ? vim() : []),
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: run("current") },
            { key: "Shift-Mod-Enter", run: run("all") },
            { key: "Shift-Mod-f", run: () => (formatIn(view.current!, callbacks.current.engine), true) },
          ]),
        ),
        basicSetup,
        languageConf.current.of(language(engine, schema, defaultSchema, keys)),
        syntaxHighlighting(editorHighlight),
        editorTheme,
        selectionActions(() => ({
          run: () => callbacks.current.onRun("current"),
          explain: callbacks.current.onExplain && (() => callbacks.current.onExplain?.()),
        })),
        fontConf.current.of(fontTheme(fontSize)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
        }),
      ],
    });
    return () => view.current?.destroy();
    // The editor is uncontrolled: created once per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: languageConf.current.reconfigure(language(engine, schema, defaultSchema, keys)) });
  }, [engine, schema, defaultSchema]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: vimConf.current.reconfigure(vimMode ? vim() : []) });
  }, [vimMode]);

  useEffect(() => {
    view.current?.dispatch({ effects: fontConf.current.reconfigure(fontTheme(fontSize)) });
  }, [fontSize]);

  useImperativeHandle(ref, () => ({
    target(mode) {
      const state = view.current!.state;
      const doc = state.doc.toString();
      if (mode === "all") return doc.trim() ? { sql: doc, offset: 0 } : null;
      const selection = state.selection.main;
      if (!selection.empty) return { sql: state.sliceDoc(selection.from, selection.to), offset: selection.from };
      const statement = statementAt(doc, selection.head, engine);
      return statement ? { sql: statement.text, offset: statement.start } : null;
    },
    getValue() {
      return view.current!.state.doc.toString();
    },
    showError(position, message) {
      const v = view.current!;
      const from = Math.max(0, Math.min(position, v.state.doc.length));
      const word = /^[\w."$]+/.exec(v.state.sliceDoc(from, from + 200))?.[0].length ?? 1;
      const to = Math.min(from + Math.max(word, 1), v.state.doc.length);
      v.dispatch(setDiagnostics(v.state, [{ from, to, severity: "error", message }]));
    },
    clearError() {
      const v = view.current!;
      v.dispatch(setDiagnostics(v.state, []));
    },
    format() {
      formatIn(view.current!, engine);
    },
    focus() {
      view.current?.focus();
    },
    insert(text, all) {
      const v = view.current!;
      const { from, to } = all ? { from: 0, to: v.state.doc.length } : v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
  }));

  return <div ref={host} className="h-full min-h-0" />;
});

/** Formats the selection, or the whole document when nothing is selected. */
function formatIn(view: EditorView, engine: Engine) {
  const selection = view.state.selection.main;
  const from = selection.empty ? 0 : selection.from;
  const to = selection.empty ? view.state.doc.length : selection.to;
  try {
    if (engine === "redis" || engine === "mongodb") return;
    const languages = { mysql: "mysql", sqlite: "sqlite", duckdb: "duckdb", sqlserver: "transactsql", clickhouse: "clickhouse" } as const;
    const formatted = formatSql(view.state.sliceDoc(from, to), {
      language: languages[engine as keyof typeof languages] ?? "postgresql",
      keywordCase: "upper",
      tabWidth: 2,
    });
    view.dispatch({ changes: { from, to, insert: formatted } });
  } catch {
    // Leave unparseable SQL as it is.
  }
}
