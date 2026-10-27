/** Column profile: what a column's values look like, from the values (a sample or all). */
export interface Profile {
  count: number;
  nulls: number;
  empty: number;
  distinct: number;
  /** Distinct values stopped being counted past this many. */
  distinctCapped: boolean;
  top: { value: string; count: number }[];
  kind: "number" | "date" | "text";
  min: string | null;
  max: string | null;
  mean?: number;
  median?: number;
  /** Numbers: equal-width buckets. */
  histogram?: { from: number; to: number; count: number }[];
  /** Text: lengths. */
  lengths?: { min: number; max: number; mean: number };
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/;
const DISTINCT_CAP = 200_000;

export function profile(values: (string | null)[], buckets = 20): Profile {
  const counts = new Map<string, number>();
  let nulls = 0;
  let empty = 0;
  let distinctCapped = false;
  const present: string[] = [];
  for (const v of values) {
    if (v === null) {
      nulls++;
      continue;
    }
    if (v === "") empty++;
    present.push(v);
    const c = counts.get(v);
    if (c !== undefined) counts.set(v, c + 1);
    else if (counts.size < DISTINCT_CAP) counts.set(v, 1);
    else distinctCapped = true;
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([value, count]) => ({ value, count }));
  const nonEmpty = present.filter((v) => v !== "");
  const kind: Profile["kind"] =
    nonEmpty.length && nonEmpty.every((v) => NUMBER.test(v)) ? "number" : nonEmpty.length && nonEmpty.every((v) => DATE.test(v)) ? "date" : "text";
  const base: Profile = { count: values.length, nulls, empty, distinct: counts.size, distinctCapped, top, kind, min: null, max: null };
  if (!nonEmpty.length) return base;
  if (kind === "number") {
    const nums = nonEmpty.map(Number).sort((a, b) => a - b);
    const min = nums[0];
    const max = nums[nums.length - 1];
    const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
    const median = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
    const n = max === min ? 1 : Math.min(buckets, counts.size);
    const width = (max - min) / n || 1;
    const histogram = Array.from({ length: n }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
    for (const x of nums) histogram[Math.min(n - 1, Math.floor((x - min) / width))].count++;
    return { ...base, min: String(min), max: String(max), mean, median, histogram };
  }
  const sorted = [...nonEmpty].sort();
  const lengths = nonEmpty.map((v) => v.length);
  return {
    ...base,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    ...(kind === "text" ? { lengths: { min: Math.min(...lengths), max: Math.max(...lengths), mean: lengths.reduce((s, n) => s + n, 0) / lengths.length } } : {}),
  };
}
