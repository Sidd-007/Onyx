import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { describe, expect, it } from "vitest";
import { selectedCells, selectionBlock, sortRows, stats } from "./gridSelection";
import { rowsAsMarkdown, valuesAsTsv } from "./rowFormat";

const empty: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

describe("grid selection", () => {
  it("lists each selected cell once", () => {
    const selection: GridSelection = {
      ...empty,
      rows: CompactSelection.fromSingleSelection(0),
      current: { cell: [0, 0], range: { x: 0, y: 0, width: 2, height: 2 }, rangeStack: [] },
    };
    expect([...selectedCells(selection, 10, 3)]).toHaveLength(5);
    expect([...selectedCells(selection, 10, 3, 2)]).toHaveLength(2);
  });

  it("totals the numbers", () => {
    const s = stats(["1", "2.5", null, "x", " -3 "]);
    expect(s).toMatchObject({ cells: 5, values: 4, numeric: 3, sum: 0.5, min: -3, max: 2.5 });
  });

  it("sorts numbers numerically, text naturally, NULLs last", () => {
    const nums = ["10", "9", null, "100"];
    expect([...sortRows(4, (i) => nums[i], false)]).toEqual([1, 0, 3, 2]);
    expect([...sortRows(4, (i) => nums[i], true)]).toEqual([3, 0, 1, 2]);
    const text = ["b", "A", "a2", "a10"];
    expect([...sortRows(4, (i) => text[i], false)]).toEqual([1, 2, 3, 0]);
  });

  it("finds the block to copy", () => {
    const rows: GridSelection = { ...empty, rows: CompactSelection.fromSingleSelection([2, 4]) };
    expect(selectionBlock(rows, 10, 3)).toEqual({ rows: [2, 3], columns: [0, 1, 2] });
    const range: GridSelection = { ...empty, current: { cell: [1, 1], range: { x: 1, y: 1, width: 2, height: 2 }, rangeStack: [] } };
    expect(selectionBlock(range, 10, 3)).toEqual({ rows: [1, 2], columns: [1, 2] });
    const cols: GridSelection = { ...empty, columns: CompactSelection.fromSingleSelection(2) };
    expect(selectionBlock(cols, 2, 3)).toEqual({ rows: [0, 1], columns: [2] });
    expect(selectionBlock(empty, 2, 3)).toBeNull();
  });

  it("formats copies", () => {
    expect(valuesAsTsv([["1", "a\tb"], ["2", null]])).toBe("1\ta b\n2\t");
    expect(rowsAsMarkdown(["id", "note"], [["1", "x|y"], ["2", null]])).toBe("| id | note |\n| --- | --- |\n| 1 | x\\|y |\n| 2 | NULL |");
  });
});
