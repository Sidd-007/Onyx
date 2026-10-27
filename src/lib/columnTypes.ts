/** Coarse kind of a column type, for its header icon. */
export type TypeKind = "number" | "text" | "date" | "time" | "json" | "bool" | "binary";

export function typeKind(dataType: string | undefined): TypeKind {
  const t = (dataType ?? "").toLowerCase();
  if (/json/.test(t)) return "json";
  if (/^bool|^tinyint\(1\)|^bit\(1\)$/.test(t)) return "bool";
  if (/^(timestamp|datetime|date|year)/.test(t)) return "date";
  if (/^(time|interval)/.test(t)) return "time";
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bit)/.test(t)) return "binary";
  if (/(int|serial|numeric|decimal|float|double|real|money)/.test(t)) return "number";
  return "text";
}

/** Lucide icon outlines (24×24) as SVG path data, for drawing on the grid canvas. */
const PATHS: Record<TypeKind | "key", string> = {
  number: "M4 9H20M4 15H20M10 3L8 21M16 3L14 21",
  text: "M12 4v16M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2M9 20h6",
  date: "M8 2v3M16 2v3M3 9h18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
  time: "M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0M12 6v6l4 2",
  json: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
  bool: "M12 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0M9 5h6a7 7 0 0 1 0 14H9a7 7 0 0 1 0-14z",
  binary:
    "M16 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2zM8 4a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0V6a2 2 0 0 1 2-2zM6 20h4M14 10h4M6 14h2v6M14 4h2v6",
  key: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
};

const cache = new Map<string, Path2D>();

/** Draws an icon whose top-left is (x, y), `size` px square, stroked in `color`. */
export function drawIcon(ctx: CanvasRenderingContext2D, icon: TypeKind | "key", x: number, y: number, size: number, color: string) {
  let path = cache.get(icon);
  if (!path) {
    path = new Path2D(PATHS[icon]);
    cache.set(icon, path);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

/**
 * A column's kind guessed from its values, for results without type information: numbers
 * (but not ids like "007" whose leading zeros matter), booleans and JSON. Text otherwise.
 */
export function inferKind(values: Iterable<string | null>, sample = 1000): TypeKind {
  let seen = 0;
  let numbers = 0;
  let bools = 0;
  let json = 0;
  for (const v of values) {
    if (v === null) continue;
    if (++seen > sample) break;
    const t = v.trim();
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(t) && t.replace(/[-.eE+]/g, "").length <= 15) numbers++;
    else if (/^(true|false)$/i.test(t)) bools++;
    else if (/^[[{]/.test(t)) {
      try {
        JSON.parse(t);
        json++;
      } catch {
        return "text";
      }
    } else return "text";
  }
  const total = Math.min(seen, sample);
  if (total === 0) return "text";
  if (numbers === total) return "number";
  if (bools === total) return "bool";
  if (json === total) return "json";
  return "text";
}
