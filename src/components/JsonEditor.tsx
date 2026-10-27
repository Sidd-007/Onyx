import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { compact, parseJson, prettyJson } from "../lib/jsonDiff";
import { Modal } from "./Modal";
import { editorHighlight, editorTheme } from "./SqlEditor";
import { Button } from "./ui";

function check(text: string): string | null {
  if (!text.trim()) return null;
  try {
    parseJson(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Formatting and saving keep numbers exactly as typed: JSON.parse would round
// 9007199254740993 to 9007199254740992.
const pretty = (text: string) => prettyJson(text);

/** Edits a JSON cell with validation: Save stays off until the JSON parses. */
export function JsonEditor({
  column,
  value,
  onSave,
  onCancel,
}: {
  column: string;
  value: string | null;
  onSave(value: string | null): void;
  onCancel(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useRef<() => void>(() => {});

  save.current = () => {
    const text = view.current?.state.doc.toString() ?? "";
    if (check(text)) return;
    // Compact, as databases store it.
    onSave(text.trim() ? compact(parseJson(text)) : null);
  };

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      doc: value === null ? "" : pretty(value),
      extensions: [
        keymap.of([{ key: "Mod-Enter", run: () => (save.current(), true) }]),
        basicSetup,
        json(),
        linter(jsonParseLinter()),
        lintGutter(),
        syntaxHighlighting(editorHighlight),
        editorTheme,
        EditorView.theme({ "&": { fontSize: "12.5px" } }),
        EditorView.updateListener.of((u) => u.docChanged && setError(check(u.state.doc.toString()))),
      ],
    });
    view.current.focus();
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const format = () => {
    const v = view.current!;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: pretty(v.state.doc.toString()) } });
  };

  return (
    <Modal onClose={onCancel} width="max-w-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex-1 text-[13px] font-semibold">
          Edit <span className="font-mono">{column}</span>
        </h2>
        <Button variant="ghost" onClick={format}>
          Format
        </Button>
      </div>
      <div ref={host} className="h-80 min-h-0" />
      <footer className="flex items-center gap-2 border-t border-border bg-panel px-4 py-2.5">
        <span className={`min-w-0 flex-1 truncate text-[11.5px] ${error ? "text-danger" : "text-faint"}`}>
          {error ?? "Valid JSON · empty sets NULL · ⌘↵ to save"}
        </span>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!!error} onClick={() => save.current()}>
          Stage change
        </Button>
      </footer>
    </Modal>
  );
}
