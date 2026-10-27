import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useMemo, useState } from "react";
import { inferKind } from "../lib/columnTypes";
import { selectedCells, sortRows } from "../lib/gridSelection";
import type { ResultSet } from "../lib/resultSet";
import type { Theme as OnyxTheme } from "../lib/themes";
import { shown } from "../lib/privacy";
import { ProfileDialog } from "./ProfileDialog";
import { useActiveTheme } from "../lib/useColorScheme";
import { useOverlays } from "../store/overlays";
import { useSettings } from "../store/settings";
import { hasDocuments } from "./DocumentView";
import { copyMenu, handleCopyKey, keepSelectionOnControlClick, headerMenu, RowPanel, SelectionFooter, useColumnLayout, type CopySource } from "./gridParts";
import { looksLikeJson, useJsonExplorer } from "./JsonExplorer";

const FONT = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';
const MAX_DISPLAY_CHARS = 300;

const shared: Partial<Theme> = {
  fontFamily: FONT,
  baseFontStyle: "12px",
  headerFontStyle: "600 11.5px",
  markerFontStyle: "10.5px",
  editorFontSize: "12px",
  cellHorizontalPadding: 8,
  cellVerticalPadding: 4,
  headerIconSize: 16,
  lineHeight: 1.4,
};

/** Grid colours from the palette in effect (the canvas can't use CSS variables). */
function gridTheme(theme: OnyxTheme): Partial<Theme> {
  const p = theme.palette;
  return {
    ...shared,
    accentColor: p.solid,
    accentFg: p.solidText,
    accentLight: p.selected,
    textDark: p.text,
    textMedium: p.muted,
    textLight: p.faint,
    textHeader: p.muted,
    textHeaderSelected: p.solidText,
    bgCell: p.bg,
    bgCellMedium: p.panel,
    bgHeader: p.panel,
    bgHeaderHasFocus: p.raise,
    bgHeaderHovered: p.hover,
    bgBubble: p.raise,
    bgBubbleSelected: p.raise,
    bgSearchResult: p.selected,
    borderColor: p.line,
    horizontalBorderColor: p.line,
    drilldownBorder: "transparent",
    linkColor: p.text,
  };
}

export function useGridTheme(): Partial<Theme> {
  const theme = useActiveTheme();
  return useMemo(() => gridTheme(theme), [theme]);
}

/** Column width from the header and a sample of the first rows. */
export function estimateWidth(result: ResultSet, column: number): number {
  let chars = result.columns[column].length + 2;
  const sample = Math.min(result.rowCount, 200);
  for (let row = 0; row < sample; row++) {
    chars = Math.max(chars, Math.min(result.cell(column, row)?.length ?? 4, 60));
  }
  return Math.round(Math.min(Math.max(chars * 7.2 + 20, 64), 420));
}

/** Grid colours and fonts for the current appearance and font size (canvas can't use CSS variables). */
export function useGridFont(): Partial<Theme> {
  const size = useSettings((s) => s.fontSize);
  const base = useGridTheme();
  return useMemo(
    () => ({ ...base, baseFontStyle: `${size - 1}px`, headerFontStyle: `600 ${size - 1.5}px`, editorFontSize: `${size - 1}px` }),
    [base, size],
  );
}

export function ResultsGrid({
  result,
  version,
  showRow,
  onCloseRow,
}: {
  result: ResultSet;
  version: number;
  /** The side panel with the selected row's fields. */
  showRow?: boolean;
  onCloseRow?(): void;
}) {
  const theme = useGridFont();
  const rowHeight = useSettings((s) => s.fontSize) + 11;
  // MongoDB's whole-document column stays out of the grid (the document view shows it).
  const privacy = useSettings((s) => s.privacy);
  const [profiling, setProfiling] = useState<number | null>(null);
  const layout = useColumnLayout(result.columns.length, result.columns.join("\u0001"), hasDocuments(result) ? [result.columns.length - 1] : []);
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [searching, setSearching] = useState(false);
  const hasRows = result.rowCount > 0;

  // Client-side sort, once the rows are all in.
  const order = useMemo(
    () => (sort && result.complete ? sortRows(result.rowCount, (r) => result.cell(sort.column, r), sort.desc) : null),
    [sort, result, result.complete, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rowAt = useCallback((row: number) => (order ? order[row] : row), [order]);
  const value = useCallback((col: number, row: number) => result.cell(layout.visible[col], rowAt(row)), [result, layout.visible, rowAt]);

  const columns = useMemo<GridColumn[]>(
    () =>
      layout.visible.map((i) => ({
        title: sort?.column === i ? `${result.columns[i]} ${sort.desc ? "▼" : "▲"}` : result.columns[i],
        id: String(i),
        width: layout.widths[i] ?? estimateWidth(result, i),
      })),
    [result, layout.visible, layout.widths, hasRows, sort], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const raw = value(col, row);
      // Privacy mode shows personal values masked, and keeps them out of the cell overlay.
      const v = shown(result.columns[layout.visible[col]], raw, privacy);
      if (v === null) {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: "NULL",
          allowOverlay: false,
          readonly: true,
          themeOverride: { textDark: theme.textLight },
        };
      }
      const short = v.length > MAX_DISPLAY_CHARS ? `${v.slice(0, MAX_DISPLAY_CHARS)}…` : v;
      return {
        kind: GridCellKind.Text,
        data: v,
        displayData: short.replace(/\r?\n/g, " ↵ "),
        allowOverlay: v === raw,
        readonly: true,
      };
    },
    [value, version, theme, privacy], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (result.columns.length === 0) {
    return <p className="p-4 text-muted">The query returned no columns.</p>;
  }

  const sortBy = (column: number, desc: boolean | null) => setSort(desc === null ? null : { column, desc });
  const copySource = (sel: GridSelection): CopySource => ({
    selection: sel,
    rows: result.rowCount,
    names: layout.visible.map((i) => result.columns[i]),
    value,
    // Results carry no types: guess them from the values, so JSON keeps numbers as numbers.
    kinds: layout.visible.map((i) => inferKind(Array.from({ length: Math.min(result.rowCount, 1000) }, (_, r) => result.cell(i, r)))),
  });
  const currentRow = selection.current?.cell[1] ?? selection.rows.first();
  const names = result.columns;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          className="relative min-w-0 flex-1"
          onKeyDown={(e) => {
            if (e.metaKey && e.key.toLowerCase() === "f") {
              e.preventDefault();
              e.stopPropagation();
              setSearching(true);
              return;
            }
            handleCopyKey(e, () => copySource(selection));
          }}
          onMouseDownCapture={keepSelectionOnControlClick}
        >
          <div className="absolute inset-0">
            <DataEditor
              columns={columns}
              rows={result.rowCount}
              getCellContent={getCellContent}
              getCellsForSelection={true}
              gridSelection={selection}
              onGridSelectionChange={setSelection}
              showSearch={searching}
              onSearchClose={() => setSearching(false)}
              onColumnResize={(column, size) => layout.resize(Number(column.id), size)}
              onColumnMoved={(from, to) => layout.move(from, to)}
              onHeaderClicked={(col) => {
                const i = layout.visible[col];
                setSort((s) => (s?.column !== i ? { column: i, desc: false } : !s.desc ? { column: i, desc: true } : null));
              }}
              onHeaderContextMenu={(col, event) => {
                event.preventDefault();
                const i = layout.visible[col];
                useOverlays.getState().openMenu(
                  event.bounds.x + event.localEventX,
                  event.bounds.y + event.localEventY,
                  headerMenu({
                    name: names[i],
                    column: i,
                    layout,
                    sort: (desc) => sortBy(i, desc),
                    sorted: sort?.column === i ? (sort.desc ? "desc" : "asc") : null,
                    profile: () => setProfiling(i),
                  }),
                );
              }}
              onCellContextMenu={([col, row], event) => {
                event.preventDefault();
                // Right-click outside the selection selects that cell first.
                const inside = [...selectedCells(selection, result.rowCount, layout.visible.length)].some(([c, r]) => c === col && r === row);
                const picked: GridSelection = inside
                  ? selection
                  : { ...emptySelection, current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] } };
                if (!inside) setSelection(picked);
                useOverlays.getState().openMenu(event.bounds.x + event.localEventX, event.bounds.y + event.localEventY, [
                  ...copyMenu(copySource(picked)),
                  "separator",
                  ...(() => {
                    const c = layout.visible[col];
                    const value = c === undefined ? null : result.cell(c, rowAt(row));
                    if (c === undefined || !looksLikeJson(value)) return [];
                    const others = Array.from({ length: Math.min(result.rowCount, 500) }, (_, r) => r)
                      .filter((r) => r !== rowAt(row))
                      .map((r) => ({ label: `row ${r + 1}`, value: result.cell(c, r) }));
                    return [{ label: "Explore JSON…", onSelect: () => useJsonExplorer.getState().open({ column: names[c], value, others }) }];
                  })(),
                  { label: "Find…", hint: "⌘F", onSelect: () => setSearching(true) },
                ]);
              }}
              rowMarkers={{ kind: "both", width: Math.max(40, String(result.rowCount).length * 7 + 18) }}
              rowSelectionMode="multi"
              smoothScrollX
              smoothScrollY
              rowHeight={rowHeight}
              headerHeight={rowHeight + 4}
              theme={theme}
              width="100%"
              height="100%"
            />
          </div>
        </div>
        {showRow && (
          <RowPanel
            columns={names}
            values={currentRow !== undefined && currentRow < result.rowCount ? names.map((_, c) => result.cell(c, rowAt(currentRow))) : null}
            onClose={() => onCloseRow?.()}
          />
        )}
      </div>
      <SelectionFooter selection={selection} rows={result.rowCount} columns={layout.visible.length} value={value}>
        {layout.hiddenCount > 0 && (
          <button type="button" className="hover:text-fg" onClick={() => layout.showAll()}>
            {layout.hiddenCount} hidden column{layout.hiddenCount === 1 ? "" : "s"} · Show
          </button>
        )}
        {sort && !result.complete && <span>Sorting when all rows are in…</span>}
      </SelectionFooter>
      {profiling !== null && (
        <ProfileDialog
          column={result.columns[profiling]}
          onClose={() => setProfiling(null)}
          load={async () => ({ values: Array.from({ length: result.rowCount }, (_, r) => result.cell(profiling, r)), sampled: !!result.truncated })}
        />
      )}
    </div>
  );
}

const emptySelection: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };
