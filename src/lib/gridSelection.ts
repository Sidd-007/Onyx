import type { GridSelection } from "@glideapps/glide-data-grid";

export interface SelectionStats {
  cells: number;
  /** Non-NULL cells. */
  values: number;
  numeric: number;
  sum: number;
  min: number | null;
  max: number | null;
}

/** Cells covered by a grid selection (ranges, whole rows and whole columns), up to `cap`. */
export function* selectedCells(selection: GridSelection, rows: number, columns: number, cap = 200_000): Generator<[number, number]> {
  const seen = new Set<string>();
  let emitted = 0;
  const emit = function* (col: number, row: number): Generator<[number, number]> {
    const key = `${col}:${row}`;
    if (seen.has(key) || emitted >= cap) return;
    seen.add(key);
    emitted++;
    yield [col, row];
  };
  const ranges = selection.current ? [selection.current.range, ...selection.current.rangeStack] : [];
  for (const r of ranges) {
    for (let row = r.y; row < r.y + r.height; row++) for (let col = r.x; col < r.x + r.width; col++) yield* emit(col, row);
  }
  for (const row of selection.rows) for (let col = 0; col < columns; col++) yield* emit(col, row);
  for (const col of selection.columns) for (let row = 0; row < rows; row++) yield* emit(col, row);
}

/**
 * The block a selection covers, for copying: ticked rows × every column, else the selected
 * range, else whole selected columns. Row and column numbers are display positions.
 */
export function selectionBlock(
  selection: GridSelection,
  rows: number,
  columns: number,
): { rows: number[]; columns: number[] } | null {
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);
  if (selection.rows.length > 0) return { rows: selection.rows.toArray().filter((r) => r < rows), columns: all(columns) };
  const range = selection.current?.range;
  if (range) {
    return {
      rows: Array.from({ length: range.height }, (_, i) => range.y + i).filter((r) => r < rows),
      columns: Array.from({ length: range.width }, (_, i) => range.x + i).filter((c) => c < columns),
    };
  }
  if (selection.columns.length > 0) return { rows: all(rows), columns: selection.columns.toArray().filter((c) => c < columns) };
  return null;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** Count, sum, average, min and max of the numbers among `values`. */
export function stats(values: Iterable<string | null>): SelectionStats {
  const s: SelectionStats = { cells: 0, values: 0, numeric: 0, sum: 0, min: null, max: null };
  for (const v of values) {
    s.cells++;
    if (v === null) continue;
    s.values++;
    const t = v.trim();
    if (!NUMBER.test(t)) continue;
    const n = Number(t);
    s.numeric++;
    s.sum += n;
    s.min = s.min === null ? n : Math.min(s.min, n);
    s.max = s.max === null ? n : Math.max(s.max, n);
  }
  return s;
}

/** Sorts row numbers by a column: numbers numerically, everything else as text; NULLs last. */
export function sortRows(count: number, value: (row: number) => string | null, desc: boolean): Int32Array {
  const order = Int32Array.from({ length: count }, (_, i) => i);
  const keys = Array.from({ length: count }, (_, i) => value(i));
  const numeric = keys.every((k) => k === null || NUMBER.test(k.trim()));
  const nums = numeric ? keys.map((k) => (k === null ? 0 : Number(k))) : null;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  order.sort((a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    if (ka === null || kb === null) return ka === kb ? a - b : ka === null ? 1 : -1;
    const c = nums ? nums[a] - nums[b] : collator.compare(ka, kb);
    return (desc ? -c : c) || a - b;
  });
  return order;
}
