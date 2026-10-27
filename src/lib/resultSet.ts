import { tableFromIPC, type Vector } from "apache-arrow";

/**
 * One result set, filled batch by batch while the query streams. Values stay in
 * Arrow's UTF-8 buffers and are only turned into JS strings when a cell is drawn.
 */
export class ResultSet {
  readonly columns: string[];
  rowCount = 0;
  /** Set when the server reports the statement complete. */
  complete = false;
  /** Rows past the run's limit were dropped; `totalRows` counts them all. */
  truncated = false;
  totalRows: number | null = null;
  private batches: Vector[][] = [];
  private batchStarts: number[] = [];

  constructor(columns: string[]) {
    this.columns = columns;
  }

  addBatch(bytes: ArrayBuffer) {
    const table = tableFromIPC(new Uint8Array(bytes));
    const vectors = this.columns.map((_, i) => table.getChildAt(i)!);
    this.batchStarts.push(this.rowCount);
    this.batches.push(vectors);
    this.rowCount += table.numRows;
  }

  cell(column: number, row: number): string | null {
    const b = this.batchIndex(row);
    if (b < 0) return null;
    return (this.batches[b][column]?.get(row - this.batchStarts[b]) as string | null) ?? null;
  }

  private batchIndex(row: number): number {
    let lo = 0;
    let hi = this.batchStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.batchStarts[mid] <= row) lo = mid;
      else hi = mid - 1;
    }
    return hi < 0 ? -1 : lo;
  }
}
