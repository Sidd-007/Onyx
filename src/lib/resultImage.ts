import { systemTheme } from "./themes";
/** Results as a PNG (for docs, tickets, chat): the grid drawn fresh in the theme's colors, or the chart's SVG. */

const MAX_ROWS = 40;
const MAX_WIDTH = 2400;
const SCALE = 2;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't draw the image"))), "image/png"));
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** The first rows of a result as a table image. */
export async function tableImage(columns: string[], rowCount: number, cell: (column: number, row: number) => string | null, caption: string): Promise<Blob> {
  const rows = Math.min(rowCount, MAX_ROWS);
  const mono = `12px ${cssVar("--font-mono") || "ui-monospace, monospace"}`;
  const sans = `600 12px ${cssVar("--font-sans") || "system-ui, sans-serif"}`;
  const pad = 10;
  const rowH = 24;
  const headH = 28;
  const footH = 26;
  const measure = document.createElement("canvas").getContext("2d")!;

  // Column widths from the header and the shown values.
  const widths: number[] = [];
  let total = 0;
  for (let c = 0; c < columns.length && total < MAX_WIDTH; c++) {
    measure.font = sans;
    let w = measure.measureText(columns[c]).width;
    measure.font = mono;
    for (let r = 0; r < rows; r++) w = Math.max(w, measure.measureText(cell(c, r) ?? "NULL").width);
    const width = Math.min(280, Math.max(40, w)) + pad * 2;
    widths.push(width);
    total += width;
  }
  const width = Math.min(total, MAX_WIDTH);
  const height = headH + rows * rowH + footH;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "middle";
  const p = systemTheme().palette;
  const [bg, panel, fg, muted, faint, border, hover] = (
    [["--bg", p.bg], ["--panel", p.panel], ["--fg", p.text], ["--muted", p.muted], ["--faint", p.faint], ["--border", p.line], ["--hover", p.hover]] as const
  ).map(([name, fallback]) => cssVar(name) || fallback);

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = panel || bg;
  ctx.fillRect(0, 0, width, headH);
  for (let r = 0; r < rows; r++) {
    if (r % 2 === 1) {
      ctx.fillStyle = hover;
      ctx.fillRect(0, headH + r * rowH, width, rowH);
    }
  }
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headH - 0.5);
  ctx.lineTo(width, headH - 0.5);
  ctx.moveTo(0, headH + rows * rowH + 0.5);
  ctx.lineTo(width, headH + rows * rowH + 0.5);
  ctx.stroke();

  let x = 0;
  widths.forEach((w, c) => {
    ctx.font = sans;
    ctx.fillStyle = muted || fg;
    ctx.fillText(fit(ctx, columns[c], w - pad * 2), x + pad, headH / 2);
    ctx.font = mono;
    for (let r = 0; r < rows; r++) {
      const v = cell(c, r);
      ctx.fillStyle = v === null ? faint : fg;
      ctx.fillText(fit(ctx, v ?? "NULL", w - pad * 2), x + pad, headH + r * rowH + rowH / 2);
    }
    x += w;
  });

  ctx.font = `11px ${cssVar("--font-sans") || "system-ui, sans-serif"}`;
  ctx.fillStyle = faint || muted;
  const shown = rowCount > rows || widths.length < columns.length ? `First ${rows} of ${rowCount} rows${widths.length < columns.length ? `, ${widths.length} of ${columns.length} columns` : ""}` : `${rowCount} rows`;
  ctx.fillText(fit(ctx, `${shown} · ${caption}`, width - pad * 2), pad, headH + rows * rowH + footH / 2 + 1);
  return toBlob(canvas);
}

const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "opacity", "fill-opacity", "stroke-opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline"];

/** An on-screen SVG (the chart) as a PNG, with its CSS-variable colors resolved. */
export async function svgImage(svg: SVGSVGElement): Promise<Blob> {
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  from.forEach((el, i) => {
    const style = getComputedStyle(el);
    (to[i] as SVGElement).setAttribute("style", STYLE_PROPS.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const back = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  back.setAttribute("width", "100%");
  back.setAttribute("height", "100%");
  back.setAttribute("fill", cssVar("--bg") || systemTheme().palette.bg);
  clone.insertBefore(back, clone.firstChild);

  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Couldn't draw the chart"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width * SCALE;
    canvas.height = height * SCALE;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(SCALE, SCALE);
    ctx.drawImage(img, 0, 0, width, height);
    return toBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
