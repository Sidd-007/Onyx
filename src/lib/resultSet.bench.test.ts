import { tableToIPC, Table, Utf8, vectorFromArray, type Vector } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { ResultSet } from "./resultSet";

// The PRD's budget: 1M rows × 20 columns loaded in under 700 MB. Run with ONYX_BENCH=1.
const bench = process.env.ONYX_BENCH ? it : it.skip;

describe("result set memory", () => {
  bench("holds 1M rows × 20 columns within budget", { timeout: 300_000 }, () => {
    const columns = Array.from({ length: 20 }, (_, i) => `col_${i}`);
    const batchRows = 10_000;
    // One realistic batch (ids, emails, timestamps, numbers…), sent 100 times like a stream.
    const data: Record<string, Vector<Utf8>> = {};
    columns.forEach((c, i) => {
      const values = Array.from({ length: batchRows }, (_, r) =>
        i === 0 ? String(r) : i % 4 === 1 ? `user${r}@example.com` : i % 4 === 2 ? `2026-10-22 21:45:${String(r % 60).padStart(2, "0")}` : (r * 1.5).toFixed(2),
      );
      data[c] = vectorFromArray(values, new Utf8());
    });
    const ipc = tableToIPC(new Table(data), "stream");

    global.gc?.();
    const before = process.memoryUsage();
    const started = performance.now();
    const result = new ResultSet(columns);
    for (let b = 0; b < 100; b++) {
      // A fresh copy per batch, as each arrives in its own buffer.
      result.addBatch(ipc.slice().buffer);
    }
    const loadMs = performance.now() - started;
    global.gc?.();
    const after = process.memoryUsage();
    const mb = (after.rss - before.rss) / 1024 / 1024;
    const heapMb = (after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1024 / 1024;

    // Random cell reads, as the grid does while scrolling.
    const reads = 200_000;
    const t = performance.now();
    for (let i = 0; i < reads; i++) result.cell(i % 20, (i * 7919) % result.rowCount);
    const perRead = ((performance.now() - t) * 1000) / reads;

    console.log(`1M×20: load ${loadMs.toFixed(0)} ms, +${mb.toFixed(0)} MB RSS (${heapMb.toFixed(0)} MB heap+buffers), ${perRead.toFixed(2)} µs per cell read`);
    expect(result.rowCount).toBe(1_000_000);
    expect(heapMb).toBeLessThan(700);
  });
});
