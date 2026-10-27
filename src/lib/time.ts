const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** "just now", "5 min. ago", "yesterday", then a date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 45_000) return "just now";
  if (diff > 7 * 86_400_000) return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  for (const [unit, size] of units) {
    if (diff >= size) return relative.format(-Math.round(diff / size), unit);
  }
  return relative.format(-Math.round(diff / 60_000), "minute");
}
