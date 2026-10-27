import type { GridSelection } from "@glideapps/glide-data-grid";
import { Copy, X } from "lucide-react";
import { useMemo, useState } from "react";
import { typeKind, type TypeKind } from "../lib/columnTypes";
import { formatCount } from "../lib/format";
import { selectedCells, selectionBlock, stats } from "../lib/gridSelection";
import { rowAsJson, rowsAsCsv, rowsAsMarkdown, rowsAsTsv, valuesAsTsv } from "../lib/rowFormat";
import { copyText } from "../store/actions";
import type { MenuEntry } from "./ContextMenu";
import { IconButton } from "./ui";
import { useSettings } from "../store/settings";
import { shown } from "../lib/privacy";
import { prettyJson } from "../lib/jsonDiff";

/** Column order, hidden columns and widths, in terms of the result's own column numbers. */
export function useColumnLayout(count: number, resetKey: string, hiddenAtFirst: number[] = []) {
  const [state, setState] = useState<{ key: string; order: number[]; hidden: Set<number>; widths: Record<number, number> }>(() => ({
    key: resetKey,
    order: [...Array(count).keys()],
    hidden: new Set(hiddenAtFirst),
    widths: {},
  }));
  // A different result (other columns): start over.
  const current =
    state.key === resetKey && state.order.length === count
      ? state
      : { key: resetKey, order: [...Array(count).keys()], hidden: new Set<number>(hiddenAtFirst), widths: {} };
  if (current !== state) setState(current);

  const visible = useMemo(() => current.order.filter((c) => !current.hidden.has(c)), [current]);
  return {
    /** Result column numbers in display order, hidden ones left out. */
    visible,
    hiddenCount: current.hidden.size,
    widths: current.widths,
    /** `from`/`to` are display positions (what the grid reports). */
    move(from: number, to: number) {
      setState((s) => {
        const shown = s.order.filter((c) => !s.hidden.has(c));
        const moved = shown[from];
        const target = shown[to];
        const order = s.order.filter((c) => c !== moved);
        const at = order.indexOf(target) + (to > from ? 1 : 0);
        order.splice(at, 0, moved);
        return { ...s, order };
      });
    },
    hide(column: number) {
      setState((s) => ({ ...s, hidden: new Set([...s.hidden, column]) }));
    },
    showAll() {
      setState((s) => ({ ...s, hidden: new Set() }));
    },
    resize(column: number, width: number) {
      setState((s) => ({ ...s, widths: { ...s.widths, [column]: width } }));
    },
  };
}

export type ColumnLayout = ReturnType<typeof useColumnLayout>;

/** Header right-click: sort, hide, show hidden, copy the name. */
export function headerMenu(opts: {
  name: string;
  column: number;
  layout: ColumnLayout;
  sort?(desc: boolean | null): void;
  sorted?: "asc" | "desc" | null;
  /** "Profile column": how its values are distributed. */
  profile?(): void;
}): MenuEntry[] {
  const { name, column, layout, sort, sorted, profile } = opts;
  return [
    { heading: name },
    ...(sort
      ? [
          { label: "Sort ascending", onSelect: () => sort(false), disabled: sorted === "asc" },
          { label: "Sort descending", onSelect: () => sort(true), disabled: sorted === "desc" },
          ...(sorted ? [{ label: "Clear sort", onSelect: () => sort(null) }] : []),
          "separator" as const,
        ]
      : []),
    ...(profile ? [{ label: "Profile column…", onSelect: profile }, "separator" as const] : []),
    { label: "Hide column", onSelect: () => layout.hide(column), disabled: layout.visible.length <= 1 },
    ...(layout.hiddenCount ? [{ label: `Show all columns (${layout.hiddenCount} hidden)`, onSelect: () => layout.showAll() }] : []),
    "separator",
    { label: "Copy column name", onSelect: () => void copyText(name, "Name copied") },
  ];
}

export type CopyFormat = "tsv" | "tsv-headers" | "csv" | "json" | "markdown";

/** What a grid needs to copy its selection: names and values by display position. */
export interface CopySource {
  selection: GridSelection;
  rows: number;
  /** Column names in display order. */
  names: string[];
  value(col: number, row: number): string | null;
  /** Column types in display order, so JSON keeps numbers and booleans. */
  kinds?: (TypeKind | undefined)[];
}

/** Copies the selected block (ticked rows, a range or whole columns). False when nothing is selected. */
export function copySelection(source: CopySource, format: CopyFormat): boolean {
  const block = selectionBlock(source.selection, source.rows, source.names.length);
  if (!block || !block.rows.length || !block.columns.length) return false;
  const columns = block.columns.map((c) => source.names[c]);
  const rows = block.rows.map((r) => block.columns.map((c) => source.value(c, r)));
  const kinds = source.kinds && block.columns.map((c) => source.kinds![c]);
  const text = {
    tsv: () => valuesAsTsv(rows),
    "tsv-headers": () => rowsAsTsv(columns, rows),
    csv: () => rowsAsCsv(columns, rows),
    json: () => `[\n${rows.map((r) => rowAsJson(columns, r, kinds)).join(",\n")}\n]`,
    markdown: () => rowsAsMarkdown(columns, rows),
  }[format]();
  const cells = rows.length * columns.length;
  void copyText(text, cells === 1 ? "Copied" : `Copied ${cells.toLocaleString()} cells`);
  return true;
}

/** ⌘C copies the selection like a spreadsheet; ⇧⌘C includes the column names. */
export function handleCopyKey(e: React.KeyboardEvent, source: () => CopySource): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c" || e.altKey) return false;
  const target = e.target as HTMLElement;
  // Text being edited or searched copies as text.
  if (target.closest("input, textarea, [contenteditable=true]")) return false;
  if (!copySelection(source(), e.shiftKey ? "tsv-headers" : "tsv")) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/**
 * Control-click is the Mac's right click, but the grid sees a left click and replaces the
 * selection before the menu opens. Keep it from the grid (the context menu still arrives).
 */
export function keepSelectionOnControlClick(e: React.MouseEvent) {
  if (e.button === 0 && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) e.stopPropagation();
}

/** Copy items for a grid's context menu, acting on the selection. */
export function copyMenu(source: CopySource): MenuEntry[] {
  return [
    { label: "Copy", hint: "⌘C", onSelect: () => void copySelection(source, "tsv") },
    { label: "Copy with column names", hint: "⇧⌘C", onSelect: () => void copySelection(source, "tsv-headers") },
    { label: "Copy as CSV", onSelect: () => void copySelection(source, "csv") },
    { label: "Copy as JSON", onSelect: () => void copySelection(source, "json") },
    { label: "Copy as Markdown table", onSelect: () => void copySelection(source, "markdown") },
  ];
}

const number = new Intl.NumberFormat("en", { maximumFractionDigits: 4 });

/** Totals for the selected cells, like a spreadsheet's status bar. */
export function SelectionFooter({
  selection,
  rows,
  columns,
  value,
  children,
}: {
  selection: GridSelection;
  rows: number;
  columns: number;
  /** A cell's value by display position. */
  value(col: number, row: number): string | null;
  children?: React.ReactNode;
}) {
  const s = useMemo(() => {
    const cells = [...selectedCells(selection, rows, columns)];
    return cells.length > 1 ? stats(cells.map(([c, r]) => value(c, r))) : null;
  }, [selection, rows, columns, value]);
  if (!s && !children) return null;
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] tabular-nums text-muted">
      {children}
      <span className="flex-1" />
      {s && (
        <>
          <span>{formatCount(s.cells)} cells</span>
          {s.values !== s.cells && <span>{formatCount(s.values)} values</span>}
          {s.numeric > 0 && (
            <>
              <span>sum {number.format(s.sum)}</span>
              <span>avg {number.format(s.sum / s.numeric)}</span>
              <span>min {number.format(s.min!)}</span>
              <span>max {number.format(s.max!)}</span>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Pretty-prints JSON values; everything else as-is. */
export function formatValue(value: string): string {
  const t = value.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    return prettyJson(value);
  }
  return value;
}

/** The selected row, one field per line, like Beekeeper's side panel. */
export function RowPanel({
  columns,
  types,
  values,
  onClose,
  onEdit,
}: {
  columns: string[];
  /** Column types, when known. */
  types?: (string | undefined)[];
  values: (string | null)[] | null;
  onClose(): void;
  /** Given: the fields are a form (changes are staged like grid edits). */
  onEdit?(column: number, value: string | null): void;
}) {
  const kinds: (TypeKind | undefined)[] = columns.map((_, i) => (types?.[i] ? typeKind(types[i]) : undefined));
  const privacy = useSettings((s) => s.privacy);
  // The form edits real values: not while privacy mode masks them.
  if (privacy) onEdit = undefined;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-panel">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
        <span className="text-[11px] font-medium text-muted">{onEdit ? "Edit row" : "Row"}</span>
        <span className="flex-1" />
        {values && (
          <IconButton title="Copy row as JSON" onClick={() => void copyText(rowAsJson(columns, values, kinds), "Row copied as JSON")}>
            <Copy className="size-3.5" />
          </IconButton>
        )}
        <IconButton title="Close" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </header>
      {values ? (
        <dl className="min-h-0 flex-1 select-text overflow-y-auto px-3 py-2">
          {columns.map((name, i) => (
            <div key={`${name}-${i}`} className="border-b border-border py-2 last:border-0">
              <dt className="flex items-baseline gap-1.5 text-[11.5px]">
                <span className="font-medium text-fg">{name}</span>
                <span className="font-mono text-[10.5px] text-faint">{types?.[i]}</span>
              </dt>
              {onEdit ? (
                <dd className="mt-1 flex flex-col gap-1">
                  <textarea
                    value={values[i] ?? ""}
                    placeholder={values[i] === null ? "NULL" : ""}
                    rows={Math.min(8, Math.max(1, (values[i] ?? "").split("\n").length))}
                    onChange={(e) => onEdit(i, e.target.value)}
                    className="q-field resize-y px-2 py-1 font-mono text-[12px]"
                    spellCheck={false}
                  />
                  {values[i] !== null && (
                    <button type="button" className="self-start text-[10.5px] text-faint hover:text-fg" onClick={() => onEdit(i, null)}>
                      Set NULL
                    </button>
                  )}
                </dd>
              ) : (
                <dd className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[12px]">
                  {values[i] === null ? <span className="text-faint">NULL</span> : formatValue(shown(name, values[i], privacy)!)}
                </dd>
              )}
            </div>
          ))}
        </dl>
      ) : (
        <p className="p-3 text-[12px] text-faint">Select a row to see all its fields.</p>
      )}
    </aside>
  );
}
