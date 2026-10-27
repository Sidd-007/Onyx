export const BOX_WIDTH = 230;
export const HEADER = 30;
export const ROW = 20;
export const MAX_ROWS = 14;
const GAP_X = 90;
const GAP_Y = 36;
/** Space between groups of related tables. */
const GROUP_GAP = 140;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutInput {
  name: string;
  /** Columns drawn (all, or just the keys). */
  columns: number;
  /** Tables this one references. */
  refs: string[];
}

export const boxHeight = (columns: number) => HEADER + Math.min(columns, MAX_ROWS) * ROW + (columns > MAX_ROWS ? ROW : 0) + 6;

interface Block {
  boxes: Map<string, Box>;
  w: number;
  h: number;
}

/** Stacks names into columns no taller than `maxHeight`, starting at x. Returns the next free x. */
function stack(names: string[], height: (n: string) => number, maxHeight: number, x: number, out: Map<string, Box>): number {
  let y = 0;
  let col: string[] = [];
  const flush = () => {
    if (!col.length) return;
    x += BOX_WIDTH + GAP_X;
    col = [];
    y = 0;
  };
  for (const n of names) {
    const h = height(n);
    if (col.length && y + h > maxHeight) flush();
    out.set(n, { x, y, w: BOX_WIDTH, h });
    col.push(n);
    y += h + GAP_Y;
  }
  flush();
  return x;
}

/** One group of related tables: referenced tables left of the tables that point at them. */
function layered(names: string[], refsOf: (n: string) => string[], height: (n: string) => number, maxHeight: number): Block {
  const inGroup = new Set(names);
  const rank = new Map<string, number>();
  const rankOf = (name: string, seen: Set<string>): number => {
    if (rank.has(name)) return rank.get(name)!;
    if (seen.has(name)) return 0; // a cycle
    seen.add(name);
    const refs = refsOf(name).filter((r) => r !== name && inGroup.has(r));
    const r = refs.length ? 1 + Math.max(...refs.map((x) => rankOf(x, seen))) : 0;
    rank.set(name, r);
    return r;
  };
  for (const n of names) rankOf(n, new Set());

  const ranks: string[][] = [];
  for (const n of [...names].sort((a, b) => a.localeCompare(b))) (ranks[rank.get(n)!] ??= []).push(n);

  // Order each rank by the average position of what its tables reference, to keep links short.
  const position = new Map<string, number>();
  ranks[0]?.forEach((n, i) => position.set(n, i));
  for (let c = 1; c < ranks.length; c++) {
    const score = (n: string) => {
      const refs = refsOf(n).filter((r) => position.has(r));
      return refs.length ? refs.reduce((s, r) => s + position.get(r)!, 0) / refs.length : Infinity;
    };
    ranks[c] = (ranks[c] ?? []).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    ranks[c].forEach((n, i) => position.set(n, i));
  }

  // A rank taller than the target wraps into several columns.
  const boxes = new Map<string, Box>();
  let x = 0;
  for (const r of ranks) if (r?.length) x = stack(r, height, maxHeight, x, boxes);
  return measure(boxes);
}

function measure(boxes: Map<string, Box>): Block {
  let w = 0;
  let h = 0;
  for (const b of boxes.values()) {
    w = Math.max(w, b.x + b.w);
    h = Math.max(h, b.y + b.h);
  }
  return { boxes, w, h };
}

/**
 * Related tables are laid out together (in layers, by their foreign keys); tables with no
 * relations are packed in a grid. Columns wrap and the groups are packed in rows so the
 * whole diagram comes out about `aspect` wide for 1 tall, whatever the schema looks like.
 */
export function layout(tables: LayoutInput[], aspect = 1.6): Map<string, Box> {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const height = (n: string) => boxHeight(byName.get(n)!.columns);
  const refsOf = (n: string) => (byName.get(n)?.refs ?? []).filter((r) => byName.has(r));

  // Connected groups (links either way).
  const links = new Map<string, Set<string>>(tables.map((t) => [t.name, new Set()]));
  for (const t of tables) {
    for (const r of refsOf(t.name)) {
      if (r === t.name) continue;
      links.get(t.name)!.add(r);
      links.get(r)!.add(t.name);
    }
  }
  const groups: string[][] = [];
  const loose: string[] = [];
  const seen = new Set<string>();
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(t.name)) continue;
    const group: string[] = [];
    const queue = [t.name];
    seen.add(t.name);
    while (queue.length) {
      const n = queue.shift()!;
      group.push(n);
      for (const m of links.get(n)!) if (!seen.has(m)) (seen.add(m), queue.push(m));
    }
    if (group.length === 1) loose.push(group[0]);
    else groups.push(group);
  }

  // The target size, from the area all the boxes need.
  const area = tables.reduce((s, t) => s + (BOX_WIDTH + GAP_X) * (height(t.name) + GAP_Y), 0);
  const targetW = Math.sqrt(area * aspect);
  const tallest = Math.max(0, ...tables.map((t) => height(t.name)));
  const maxHeight = Math.max(tallest, targetW / aspect);

  const blocks = groups.sort((a, b) => b.length - a.length).map((g) => layered(g, refsOf, height, maxHeight));

  // Loose tables: a grid read left to right, as wide as gives the biggest zoom for `aspect`.
  const grid = (perRow: number): Block => {
    const boxes = new Map<string, Box>();
    let y = 0;
    for (let i = 0; i < loose.length; i += perRow) {
      const row = loose.slice(i, i + perRow);
      row.forEach((n, j) => boxes.set(n, { x: j * (BOX_WIDTH + GAP_X), y, w: BOX_WIDTH, h: height(n) }));
      y += Math.max(...row.map(height)) + GAP_Y;
    }
    return measure(boxes);
  };
  if (!loose.length) return pack(blocks, targetW).boxes;
  let best: Block | null = null;
  let bestScale = Infinity;
  for (let perRow = 1; perRow <= loose.length; perRow++) {
    const packed = pack([...blocks, grid(perRow)], targetW);
    // The size the diagram needs on a canvas of this shape (smaller zooms in more).
    const scale = Math.max(packed.w / aspect, packed.h);
    if (scale < bestScale) {
      bestScale = scale;
      best = packed;
    }
  }
  return best!.boxes;
}

/** Shelf packing: blocks left to right, a new row when `targetW` is used up. */
function pack(blocks: Block[], targetW: number): Block {
  const rowWidth = Math.max(targetW, ...blocks.map((b) => b.w));
  const out = new Map<string, Box>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowHeight + GROUP_GAP;
      rowHeight = 0;
    }
    for (const [n, box] of b.boxes) out.set(n, { ...box, x: box.x + x, y: box.y + y });
    x += b.w + GROUP_GAP;
    rowHeight = Math.max(rowHeight, b.h);
  }
  return measure(out);
}
