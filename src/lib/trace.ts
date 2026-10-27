/**
 * F16: a request's trace, opened as database work. Accepts OpenTelemetry's OTLP/JSON export
 * (resourceSpans → scopeSpans → spans) and a flat { spans: [...] } form with plain attribute
 * objects. Importing never runs a query: a span becomes an editor tab only when asked.
 */

export interface Span {
  id: string;
  parent: string | null;
  name: string;
  start: number; // ms since the trace's first span
  end: number;
  attrs: Record<string, string>;
  db: { system: string; query: string; namespace: string | null; params: Record<string, string> } | null;
}

export interface Trace {
  spans: Span[];
  /** Spans whose parent isn't in the file (a partial trace). */
  orphans: string[];
  problems: string[];
}

type RawValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean } | string | number | boolean;

const value = (v: RawValue): string => (typeof v === "object" && v !== null ? String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? "") : String(v));

function attrs(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((a: { key: string; value: RawValue }) => [a.key, value(a.value)]));
  if (raw && typeof raw === "object") return Object.fromEntries(Object.entries(raw as Record<string, RawValue>).map(([k, v]) => [k, value(v)]));
  return {};
}

/** Nanoseconds (often strings too big for numbers) to milliseconds, exactly enough. */
const nanosToMs = (n: string | number) => Number(BigInt(String(n)) / 1000n) / 1000;

export function parseTrace(text: string): Trace {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const raw: Record<string, unknown>[] = Array.isArray(doc.resourceSpans)
    ? (doc.resourceSpans as { scopeSpans?: { spans?: Record<string, unknown>[] }[] }[]).flatMap((r) => (r.scopeSpans ?? []).flatMap((s) => s.spans ?? []))
    : Array.isArray(doc.spans)
      ? (doc.spans as Record<string, unknown>[])
      : [];
  if (!raw.length) throw new Error("No spans found: expected OTLP/JSON (resourceSpans…) or { \"spans\": [...] }");
  const problems: string[] = [];
  const spans: Span[] = [];
  for (const s of raw) {
    const id = String(s.spanId ?? "");
    if (!id || s.startTimeUnixNano === undefined || s.endTimeUnixNano === undefined) {
      problems.push(`A span without an id or times was skipped (${String(s.name ?? "unnamed")})`);
      continue;
    }
    const a = attrs(s.attributes);
    const query = a["db.query.text"] ?? a["db.statement"];
    const system = a["db.system.name"] ?? a["db.system"];
    const params = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("db.query.parameter.")).map(([k, v]) => [k.slice("db.query.parameter.".length), v]));
    spans.push({ id, parent: s.parentSpanId ? String(s.parentSpanId) : null, name: String(s.name ?? ""), start: nanosToMs(s.startTimeUnixNano as string), end: nanosToMs(s.endTimeUnixNano as string), attrs: a, db: query && system ? { system, query, namespace: a["db.namespace"] ?? a["db.name"] ?? null, params } : null });
  }
  const t0 = Math.min(...spans.map((s) => s.start));
  for (const s of spans) {
    s.start -= t0;
    s.end -= t0;
    if (s.end < s.start) problems.push(`Span ${s.name} ends before it starts`);
  }
  const ids = new Set(spans.map((s) => s.id));
  const orphans = spans.filter((s) => s.parent && !ids.has(s.parent)).map((s) => s.id);
  return { spans: spans.sort((a, b) => a.start - b.start), orphans, problems };
}

/** The query's shape: literals and numbers become ?, IN lists collapse, spacing normalized. */
export function normalize(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, "(?…)")
    .replace(/\s+/g, " ")
    .trim();
}

export interface QueryGroup {
  shape: string;
  spans: Span[];
  totalMs: number;
  /** Repeated under one parent: the N+1 pattern. */
  repeatedUnder: { parent: string; count: number } | null;
}

export function groupQueries(trace: Trace): QueryGroup[] {
  const groups = new Map<string, Span[]>();
  for (const s of trace.spans) if (s.db) groups.set(normalize(s.db.query), [...(groups.get(normalize(s.db.query)) ?? []), s]);
  return [...groups]
    .map(([shape, spans]) => {
      const byParent = new Map<string, number>();
      for (const s of spans) byParent.set(s.parent ?? "", (byParent.get(s.parent ?? "") ?? 0) + 1);
      const [parent, count] = [...byParent].sort((a, b) => b[1] - a[1])[0];
      return { shape, spans, totalMs: spans.reduce((t, s) => t + (s.end - s.start), 0), repeatedUnder: count >= 5 ? { parent, count } : null };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Time covered by at least one span (overlaps counted once), vs the plain sum. */
export function coverage(spans: Span[]): { unionMs: number; sumMs: number } {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let union = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const s of sorted) {
    if (s.start > curEnd) {
      if (curEnd > curStart) union += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    } else curEnd = Math.max(curEnd, s.end);
  }
  if (curEnd > curStart) union += curEnd - curStart;
  return { unionMs: union, sumMs: spans.reduce((t, s) => t + (s.end - s.start), 0) };
}

/** Exact replay needs every $n / ? placeholder's value; missing ones are named, never guessed. */
export function replayable(span: Span): { ok: boolean; missing: string[] } {
  if (!span.db) return { ok: false, missing: [] };
  const params = span.db.params;
  // OpenTelemetry keys parameters by name or index (0- or 1-based depending on the driver): accept either.
  const has = (n: number) => String(n) in params || String(n - 1) in params;
  const dollar = [...new Set([...span.db.query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))];
  const marks = (span.db.query.replace(/'(?:[^']|'')*'/g, "").match(/\?/g) ?? []).length;
  const missing = [...dollar.filter((n) => !has(n)).map(String), ...Array.from({ length: marks }, (_, i) => i + 1).filter((n) => !has(n)).map((n) => `?${n}`)];
  return { ok: missing.length === 0, missing };
}
