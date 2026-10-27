import { BarChart3, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCompact } from "../lib/format";
import { shown } from "../lib/privacy";
import { profile, type Profile } from "../lib/profile";
import { useSettings } from "../store/settings";
import { Modal } from "./Modal";

/** How a column's values are distributed. `load` gives its values and, for tables, exact counts. */
export function ProfileDialog({
  column,
  load,
  onClose,
}: {
  column: string;
  load(): Promise<{ values: (string | null)[]; sampled: boolean; exact?: { rows: number; nulls: number; distinct: number } }>;
  onClose(): void;
}) {
  const [data, setData] = useState<{ p: Profile; sampled: boolean; exact?: { rows: number; nulls: number; distinct: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const privacy = useSettings((s) => s.privacy);
  useEffect(() => {
    load().then(
      (r) => setData({ p: profile(r.values), sampled: r.sampled, exact: r.exact }),
      (e) => setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(n && n / of < 0.001 ? 2 : 1)}%` : "—");
  const fmt = (n: number | undefined) => (n === undefined ? "—" : Math.abs(n) >= 1e6 ? n.toExponential(3) : Number(n.toFixed(4)).toLocaleString());

  return (
    <Modal onClose={onClose} width="max-w-lg">
      <div className="flex flex-col gap-4 p-5 text-[12px]">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <BarChart3 className="size-4 text-accent" /> <span className="font-mono">{column}</span>
          {data && <span className="q-label">{data.p.kind}</span>}
        </h2>
        {error && <p className="rounded-[10px] border border-danger/30 px-3 py-2 text-danger">{error}</p>}
        {!data && !error && <LoaderCircle className="size-4 animate-spin text-muted" />}
        {data && (
          <>
            <div className="grid grid-cols-4 divide-x divide-border rounded-[12px] border border-border">
              {(
                [
                  ["Rows", formatCompact(data.exact?.rows ?? data.p.count)],
                  ["NULL", pct(data.exact?.nulls ?? data.p.nulls, data.exact?.rows ?? data.p.count)],
                  ["Distinct", `${formatCompact(data.exact?.distinct ?? data.p.distinct)}${data.p.distinctCapped && !data.exact ? "+" : ""}`],
                  ["Empty", pct(data.p.empty, data.p.count)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="px-3.5 py-3">
                  <div className="q-label">{label}</div>
                  <div className="mt-1.5 font-mono text-[22px] font-medium leading-none tracking-[-0.04em]">{value}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px]">
              <span className="text-muted">min</span>
              <span className="truncate text-right">{shown(column, data.p.min, privacy) ?? "—"}</span>
              <span className="text-muted">max</span>
              <span className="truncate text-right">{shown(column, data.p.max, privacy) ?? "—"}</span>
              {data.p.kind === "number" && (
                <>
                  <span className="text-muted">mean</span>
                  <span className="text-right">{fmt(data.p.mean)}</span>
                  <span className="text-muted">median</span>
                  <span className="text-right">{fmt(data.p.median)}</span>
                </>
              )}
              {data.p.lengths && (
                <>
                  <span className="text-muted">length</span>
                  <span className="text-right">
                    {data.p.lengths.min}–{data.p.lengths.max} (avg {data.p.lengths.mean.toFixed(1)})
                  </span>
                </>
              )}
            </div>
            {data.p.histogram && data.p.histogram.length > 1 && (
              <div>
                <div className="q-label mb-1.5">Distribution</div>
                <div className="group/bars flex h-20 items-end gap-[2px] border-b border-border-strong">
                  {data.p.histogram.map((b, i) => {
                    const top = Math.max(...data.p.histogram!.map((x) => x.count));
                    return (
                      <div
                        key={i}
                        className="flex-1 rounded-t-[4px] bg-fg transition-opacity duration-[120ms] group-hover/bars:opacity-45 hover:!opacity-100"
                        style={{ height: `${Math.max(2, (b.count / top) * 100)}%`, ...(b.count === 0 ? { background: "var(--track)" } : {}) }}
                        data-tip={`${fmt(b.from)} – ${fmt(b.to)}: ${b.count.toLocaleString()}`}
                      />
                    );
                  })}
                </div>
                <div className="mt-0.5 flex justify-between font-mono text-[10px] text-faint">
                  <span>{fmt(data.p.histogram[0].from)}</span>
                  <span>{fmt(data.p.histogram.at(-1)!.to)}</span>
                </div>
              </div>
            )}
            <div>
              <div className="mb-1 text-[11px] text-muted">Most common</div>
              <div className="flex flex-col gap-1">
                {data.p.top.map((t) => {
                  const of = data.p.count - data.p.nulls;
                  return (
                    <div key={t.value} className="relative flex h-6 items-center overflow-hidden rounded-md bg-input px-2 font-mono text-[11.5px]">
                      <span className="absolute inset-y-0 left-0 bg-selected" style={{ width: `${(t.count / (data.p.top[0]?.count || 1)) * 100}%` }} />
                      <span className="relative min-w-0 flex-1 truncate">{t.value === "" ? <span className="text-faint">(empty)</span> : shown(column, t.value, privacy)}</span>
                      <span className="relative tabular-nums text-muted">
                        {t.count.toLocaleString()} · {pct(t.count, of)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="text-[11px] text-faint">
              {data.sampled ? `Distribution from a sample of ${data.p.count.toLocaleString()} rows${data.exact ? "; the counts above are exact" : ""}.` : `From all ${data.p.count.toLocaleString()} rows loaded.`}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
