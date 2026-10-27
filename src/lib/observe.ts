/**
 * F03: what changed in a chosen slice of state while something happened outside Onyx.
 * Bounded selectors are captured in one consistent read-only snapshot per connection, before
 * and after; the differences are observations over the interval, not attributed to anything.
 */
import { diffResults, type ResultDiff } from "./resultDiff";

export interface Selector {
  id: string;
  connectionId: string;
  label: string;
  /** A bounded SELECT (the cap is enforced too). */
  sql: string;
  /** The column that identifies a row (new rows are found through the same selector). */
  key: string;
}

export interface Snapshot {
  at: number;
  results: Record<string, { columns: string[]; rows: (string | null)[][]; truncated: boolean } | { error: string }>;
}

export const SELECTOR_CAP = 1000;

/** Statements that open a consistent, read-only snapshot on a session. */
export function snapshotBegin(engine: string): string | null {
  if (engine === "postgres") return "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
  if (engine === "mysql") return "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY";
  return null;
}

export interface SelectorChange {
  selector: Selector;
  diff: ResultDiff | null;
  partial: boolean;
  error?: string;
}

export function compareSnapshots(selectors: Selector[], before: Snapshot, after: Snapshot): SelectorChange[] {
  return selectors.map((s) => {
    const a = before.results[s.id];
    const b = after.results[s.id];
    if (!a || !b || "error" in a || "error" in b) return { selector: s, diff: null, partial: true, error: (a && "error" in a ? a.error : b && "error" in b ? b.error : "not captured") };
    return { selector: s, diff: diffResults(a, b, s.key || null), partial: a.truncated || b.truncated };
  });
}

export const changed = (c: SelectorChange[]) => c.some((x) => x.diff && x.diff.added + x.diff.removed + x.diff.changed > 0);
