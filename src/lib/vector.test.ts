import { describe, expect, it } from "vitest";
import { filteredOut, neighborsSql, recall, settingSql } from "./vector";

const n = (id: string, distance: number) => ({ id, distance });

describe("vector debugger", () => {
  it("finds the eligible neighbor the index missed", () => {
    const exact = [n("a", 0.1), n("b", 0.2), n("c", 0.3), n("d", 0.4)];
    const approx = [n("a", 0.1), n("c", 0.3), n("d", 0.4)];
    const r = recall(exact, approx, 3, 100);
    expect(r.recall).toBeCloseTo(2 / 3);
    expect(r.missed.map((x) => x.id)).toEqual(["b"]);
  });

  it("accepts any tie at the cut, and targets the eligible count when it's below k", () => {
    const exact = [n("a", 0.1), n("b", 0.5), n("c", 0.5)];
    expect(recall(exact, [n("a", 0.1), n("c", 0.5)], 2, 100).recall).toBe(1);
    expect(recall([n("a", 0.1)], [n("a", 0.1)], 10, 1)).toMatchObject({ recall: 1, target: 1 });
  });

  it("calls filtered rows filtered, not missed", () => {
    expect(filteredOut([n("x", 0.01), n("a", 0.1)], new Set(["a"])).map((x) => x.id)).toEqual(["x"]);
  });

  it("builds queries and refuses settings that aren't pgvector's", () => {
    expect(neighborsSql({ schema: "public", table: "docs", idColumn: "id", column: "embedding", metric: "cosine", query: "[1,0]", fromRow: false, filter: "lang = 'en'", k: 5 }, 10, true)).toBe(
      "SELECT id::text AS id, (embedding <=> '[1,0]'::vector)::float8 AS distance FROM public.docs WHERE lang = 'en' ORDER BY embedding <=> '[1,0]'::vector LIMIT 10",
    );
    expect(settingSql("hnsw.ef_search", "100")).toBe("SET LOCAL hnsw.ef_search = 100");
    expect(() => settingSql("work_mem", "1GB")).toThrow(/isn't a pgvector/);
  });
});
