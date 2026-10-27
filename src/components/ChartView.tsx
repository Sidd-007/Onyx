import { useEffect, useMemo, useRef, useState } from "react";
import { formatCount } from "../lib/format";
import type { ResultSet } from "../lib/resultSet";
import { Select } from "./Select";

/** Single ink: series are the text colour at falling strengths, in a fixed order. The legend names them. */
const SERIES = [100, 70, 45, 85, 30].map((p) => `color-mix(in srgb, var(--text) ${p}%, transparent)`);
const MAX_SERIES = SERIES.length;
const MAX_POINTS = { line: 5000, bar: 400 };
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const format = new Intl.NumberFormat("en", { maximumFractionDigits: 2, notation: "compact" });
const exact = new Intl.NumberFormat("en", { maximumFractionDigits: 6 });

const STYLE = `
.viz-root { --viz-surface: var(--bg); --viz-grid: var(--line); --viz-text: var(--text); --viz-muted: var(--faint);
  ${SERIES.map((c, i) => `--series-${i + 1}: ${c};`).join(" ")} }
`;

/** Columns whose sampled non-NULL values are mostly numbers. */
function numericColumns(result: ResultSet): number[] {
  const sample = Math.min(result.rowCount, 300);
  return result.columns
    .map((_, c) => c)
    .filter((c) => {
      let values = 0;
      let numbers = 0;
      for (let r = 0; r < sample; r++) {
        const v = result.cell(c, r);
        if (v === null) continue;
        values++;
        if (NUMBER.test(v.trim())) numbers++;
      }
      return values > 0 && numbers / values >= 0.8;
    });
}

/** Round tick values covering [min, max]. */
function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A quick line or bar chart of a result: X is any column, Y are numeric columns (one shared axis). */
export default function ChartView({ result, version }: { result: ResultSet; version: number }) {
  const numeric = useMemo(() => numericColumns(result), [result, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [kind, setKind] = useState<"line" | "bar">("line");
  const [x, setX] = useState(0);
  const [ys, setYs] = useState<number[]>(() => numeric.filter((c) => c !== 0).slice(0, 1));
  useEffect(() => {
    if (ys.length === 0 && numeric.length) setYs(numeric.filter((c) => c !== x).slice(0, 1));
  }, [numeric]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 300 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);

  const count = Math.min(result.rowCount, MAX_POINTS[kind]);
  const data = useMemo(() => {
    const labels = Array.from({ length: count }, (_, r) => result.cell(x, r) ?? "NULL");
    const series = ys.map((c) => Array.from({ length: count }, (_, r) => {
      const v = result.cell(c, r);
      return v !== null && NUMBER.test(v.trim()) ? Number(v) : null;
    }));
    return { labels, series };
  }, [result, version, x, ys, count]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = data.series.flat().filter((v): v is number => v !== null);
  const rawMin = all.length ? Math.min(...all) : 0;
  const rawMax = all.length ? Math.max(...all) : 1;
  // Bars grow from zero; lines fit the data.
  const lo = kind === "bar" ? Math.min(0, rawMin) : rawMin;
  const hi = kind === "bar" ? Math.max(0, rawMax) : rawMax;
  const yTicks = ticks(lo, hi === lo ? lo + 1 : hi);
  const yMin = Math.min(yTicks[0], lo);
  const yMax = Math.max(yTicks[yTicks.length - 1], hi);

  const directLabels = ys.length <= 4;
  const margin = { top: 12, right: directLabels ? 96 : 16, bottom: 28, left: 52 };
  const plotW = Math.max(10, size.width - margin.left - margin.right);
  const plotH = Math.max(10, size.height - margin.top - margin.bottom);
  const band = plotW / Math.max(count, 1);
  const xAt = (i: number) => margin.left + band * (i + 0.5);
  const yAt = (v: number) => margin.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const labelEvery = Math.max(1, Math.ceil((count * 70) / plotW));

  const toggleY = (c: number) =>
    setYs((list) => (list.includes(c) ? list.filter((v) => v !== c) : list.length >= MAX_SERIES ? list : [...list, c]));

  if (result.rowCount === 0) return <p className="p-6 text-center text-[12px] text-muted">No rows to chart.</p>;

  const barW = Math.min(24, Math.max(2, (band - 2 * (ys.length - 1) - 4) / Math.max(ys.length, 1)));
  const groupW = barW * ys.length + 2 * (ys.length - 1);
  const zero = yAt(Math.max(yMin, Math.min(0, yMax)));

  return (
    <div className="viz-root flex min-h-0 flex-1 flex-col">
      <style>{STYLE}</style>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[11.5px]">
        <div className="flex gap-0.5 rounded-md bg-hover p-0.5">
          {(["line", "bar"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`h-5 rounded px-2 capitalize ${kind === k ? "bg-raised font-medium shadow-sm" : "text-muted"}`}
            >
              {k}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-muted">
          X
          <Select
            value={x}
            onChange={(v: number) => setX(v)}
            options={result.columns.map((c, i) => ({ value: i, label: c }))}
            className="h-6 max-w-48 rounded-md bg-hover px-1.5 text-fg"
          />
        </label>
        <span className="text-muted">Y</span>
        {numeric.length === 0 && <span className="text-faint">No numeric columns.</span>}
        {numeric.map((c) => {
          const slot = ys.indexOf(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggleY(c)}
              disabled={slot < 0 && ys.length >= MAX_SERIES}
              className={`flex h-5 items-center gap-1 rounded-full border px-2 disabled:opacity-40 ${slot >= 0 ? "border-border bg-raised text-fg" : "border-transparent text-muted hover:bg-hover"}`}
            >
              {slot >= 0 && <span className="size-2 rounded-full" style={{ background: `var(--series-${slot + 1})` }} />}
              {result.columns[c]}
            </button>
          );
        })}
        {result.rowCount > count && (
          <span className="ml-auto text-faint">First {formatCount(count)} of {formatCount(result.rowCount)} rows</span>
        )}
      </div>

      <div ref={box} className="relative min-h-0 flex-1">
        {ys.length > 0 && (
          <svg
            width={size.width}
            height={size.height}
            className="absolute inset-0"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const i = Math.floor((e.clientX - rect.left - margin.left) / band);
              setHover(i >= 0 && i < count ? i : null);
            }}
            onMouseLeave={() => setHover(null)}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={margin.left} x2={margin.left + plotW} y1={yAt(t)} y2={yAt(t)} stroke="var(--viz-grid)" strokeWidth={1} />
                <text x={margin.left - 6} y={yAt(t)} dy="0.32em" textAnchor="end" fontSize={10} fontFamily="var(--mono)" fill="var(--viz-muted)">
                  {format.format(t)}
                </text>
              </g>
            ))}
            {data.labels.map((label, i) =>
              i % labelEvery === 0 ? (
                <text key={i} x={xAt(i)} y={margin.top + plotH + 16} textAnchor="middle" fontSize={10} fontFamily="var(--mono)" fill="var(--viz-muted)">
                  {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                </text>
              ) : null,
            )}
            {hover !== null && (
              <line x1={xAt(hover)} x2={xAt(hover)} y1={margin.top} y2={margin.top + plotH} stroke="var(--viz-muted)" strokeWidth={1} opacity={0.5} />
            )}
            {kind === "bar"
              ? data.series.map((values, s) =>
                  values.map((v, i) => {
                    if (v === null) return null;
                    const left = xAt(i) - groupW / 2 + s * (barW + 2);
                    const top = Math.min(yAt(v), zero);
                    const h = Math.max(1, Math.abs(yAt(v) - zero));
                    const r = Math.min(4, barW / 2, h);
                    // Rounded at the data end, square at the baseline.
                    const d =
                      v >= 0
                        ? `M${left},${zero} V${top + r} Q${left},${top} ${left + r},${top} H${left + barW - r} Q${left + barW},${top} ${left + barW},${top + r} V${zero} Z`
                        : `M${left},${zero} V${top + h - r} Q${left},${top + h} ${left + r},${top + h} H${left + barW - r} Q${left + barW},${top + h} ${left + barW},${top + h - r} V${zero} Z`;
                    return <path key={`${s}-${i}`} d={d} fill={`var(--series-${s + 1})`} opacity={hover === null || hover === i ? 1 : 0.45} />;
                  }),
                )
              : data.series.map((values, s) => {
                  let d = "";
                  values.forEach((v, i) => {
                    if (v === null) return;
                    d += `${d && values[i - 1] !== null ? "L" : "M"}${xAt(i)},${yAt(v)}`;
                  });
                  return (
                    <path key={s} d={d} fill="none" stroke={`var(--series-${s + 1})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  );
                })}
            {kind === "line" &&
              hover !== null &&
              data.series.map((values, s) =>
                values[hover] === null ? null : (
                  <circle
                    key={s}
                    cx={xAt(hover)}
                    cy={yAt(values[hover]!)}
                    r={4}
                    fill={`var(--series-${s + 1})`}
                    stroke="var(--viz-surface)"
                    strokeWidth={2}
                  />
                ),
              )}
            {directLabels &&
              data.series.map((values, s) => {
                const last = values.findLastIndex((v) => v !== null);
                if (last < 0) return null;
                return (
                  <text key={s} x={margin.left + plotW + 8} y={yAt(values[last]!)} dy="0.32em" fontSize={11} fill="var(--viz-text)">
                    {result.columns[ys[s]].slice(0, 14)}
                  </text>
                );
              })}
          </svg>
        )}
        {hover !== null && ys.length > 0 && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-[7px] bg-solid px-2.5 py-1.5 font-mono text-[11px] text-solid-text shadow-[var(--shadow)]"
            style={{
              left: Math.min(xAt(hover) + 12, size.width - 170),
              top: margin.top,
            }}
          >
            <div className="mb-1 font-medium">{data.labels[hover]}</div>
            {ys.map((c, s) => (
              <div key={c} className="flex items-center gap-1.5 tabular-nums">
                <span className="size-2 rounded-full border border-solid-text/60" style={{ background: `var(--series-${s + 1})` }} />
                <span className="opacity-60">{result.columns[c]}</span>
                <span className="ml-auto pl-3">{data.series[s][hover] === null ? "NULL" : exact.format(data.series[s][hover]!)}</span>
              </div>
            ))}
          </div>
        )}
        {ys.length === 0 && numeric.length > 0 && <p className="p-6 text-center text-[12px] text-muted">Pick a column for Y.</p>}
      </div>
      {ys.length >= 2 && (
        <div className="flex shrink-0 flex-wrap gap-3 border-t border-border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">
          {ys.map((c, s) => (
            <span key={c} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: `var(--series-${s + 1})` }} />
              {result.columns[c]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
