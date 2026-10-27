import { Cable, Download, KeyRound, LayoutGrid, LoaderCircle, Maximize, RefreshCw, Search, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { HEADER, layout, MAX_ROWS, ROW, type Box } from "../lib/erLayout";
import { api, toError, type TableSnapshot } from "../lib/ipc";
import { openTable } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { ErWires, type Wire } from "./ErWires";
import { Button, Divider, IconButton } from "./ui";

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';
const AUTO_SELECT = 60;

/** Tables and their foreign keys, laid out automatically; drag to arrange, export as SVG or PNG. */
export default function ErDiagram({ tab }: { tab: QueryTab }) {
  const schema = tab.schema ?? "";
  const connected = useConnections((s) => isConnected(s.status[tab.connectionId]));
  const [tables, setTables] = useState<TableSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [moved, setMoved] = useState<Record<string, Box>>({});
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  /** Only primary and foreign key columns: big diagrams stay readable. */
  const [keysPick, setKeysPick] = useState<boolean | null>(null);
  const [aspect, setAspect] = useState(1.6);
  /** Relations as bouncy, bundled wires (or plain curves). */
  const [bouncy, setBouncy] = useState(() => {
    try {
      return localStorage.getItem("onyx.er.wires") !== "plain";
    } catch {
      return true;
    }
  });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "pan" | "box"; name?: string; x: number; y: number; ox: number; oy: number } | null>(null);

  const load = () => {
    setTables(null);
    setError(null);
    api.schemaSnapshot(tab.connectionId, schema).then(
      (list) => {
        const t = list.filter((x) => x.kind === "table");
        setTables(t);
        // Big schemas: start with the tables that have relations.
        const related = t.filter((x) => x.foreignKeys.length || t.some((o) => o.foreignKeys.some((f) => f.refTable === x.name)));
        const pick = t.length <= AUTO_SELECT ? t : related.length ? related.slice(0, AUTO_SELECT) : t.slice(0, AUTO_SELECT);
        setSelected(new Set(pick.map((x) => x.name)));
        setMoved({});
      },
      (e) => setError(toError(e).message),
    );
  };
  useEffect(() => {
    if (connected) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, schema, connected]);

  const shown = useMemo(() => (tables ?? []).filter((t) => selected.has(t.name)), [tables, selected]);
  // On by itself for big diagrams, until the user picks.
  const keysOnly = keysPick ?? shown.length > 25;
  // The columns each box lists.
  const drawn = useMemo(() => {
    const map = new Map<string, TableSnapshot["columns"]>();
    for (const t of shown) {
      if (!keysOnly) {
        map.set(t.name, t.columns);
        continue;
      }
      const fk = new Set(t.foreignKeys.flatMap((f) => f.columns));
      const keys = t.columns.filter((c) => c.primaryKey || fk.has(c.name));
      map.set(t.name, keys.length ? keys : t.columns.slice(0, 1));
    }
    return map;
  }, [shown, keysOnly]);
  // Lay out for the shape of the canvas.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width && height) setAspect(Math.min(3, Math.max(0.8, width / height)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tables]);
  const auto = useMemo(
    () => layout(shown.map((t) => ({ name: t.name, columns: drawn.get(t.name)!.length, refs: t.foreignKeys.map((f) => f.refTable) })), aspect),
    [shown, drawn, aspect],
  );
  // Zoomed far out, boxes show just their name, drawn big enough to read.
  const overview = view.k < 0.45;
  const box = (name: string) => moved[name] ?? auto.get(name);

  const edges = shown.flatMap((t) =>
    t.foreignKeys
      .filter((f) => selected.has(f.refTable))
      .map((f) => ({ from: t.name, to: f.refTable, fromCol: f.columns[0], toCol: f.refColumns[0], name: f.name })),
  );

  const rowY = (t: TableSnapshot | undefined, column: string) => {
    const i = t ? (drawn.get(t.name) ?? t.columns).findIndex((c) => c.name === column) : -1;
    return HEADER + (i >= 0 && i < MAX_ROWS ? i : 0) * ROW + ROW / 2 + 3;
  };

  const fit = () => {
    const el = svg.current;
    if (!el || !shown.length) return;
    const boxes = shown.map((t) => box(t.name)!);
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const { width, height } = el.getBoundingClientRect();
    const k = Math.min(1.2, Math.max(0.05, Math.min((width - 60) / (maxX - minX), (height - 60) / (maxY - minY))));
    setView({ k, x: (width - (maxX - minX) * k) / 2 - minX * k, y: (height - (maxY - minY) * k) / 2 - minY * k });
  };
  useEffect(() => {
    if (shown.length) window.requestAnimationFrame(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const zoomBy = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const rect = svg.current?.getBoundingClientRect();
      const px = cx ?? (rect ? rect.width / 2 : 0);
      const py = cy ?? (rect ? rect.height / 2 : 0);
      const k = Math.min(3, Math.max(0.05, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  const exportAs = async (format: "svg" | "png") => {
    const el = svg.current;
    if (!el || !shown.length) return;
    try {
      const text = standaloneSvg(el, shown.map((t) => box(t.name)!));
      if (format === "svg") {
        const path = await api.saveFile(`${schema}-er`, "svg", text);
        if (path) toast(`Saved ${path}`, "success");
        return;
      }
      const png = await toPng(text);
      const path = await api.saveFile(`${schema}-er`, "png", png, true);
      if (path) toast(`Saved ${path}`, "success");
    } catch (e) {
      toast(toError(e).message, "error");
    }
  };

  if (!connected) return <p className="p-6 text-center text-[12px] text-muted">Connect to draw this schema.</p>;
  if (error) return <p className="p-6 select-text text-[12px] text-danger">{error}</p>;
  if (!tables) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    );
  }

  const q = filter.trim().toLowerCase();
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <label className="m-1.5 flex h-6 items-center gap-1.5 rounded-md bg-hover px-2">
          <Search className="size-3 text-faint" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" />
        </label>
        <div className="flex gap-1 px-1.5 pb-1 text-[11px]">
          <Button variant="ghost" className="h-5" onClick={() => setSelected(new Set(tables.map((t) => t.name)))}>
            All
          </Button>
          <Button variant="ghost" className="h-5" onClick={() => setSelected(new Set())}>
            None
          </Button>
          <span className="ml-auto self-center text-faint">
            {selected.size}/{tables.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {tables
            .filter((t) => !q || t.name.toLowerCase().includes(q))
            .map((t) => (
              <label key={t.name} className="flex h-6 items-center gap-1.5 rounded px-1.5 text-[12px] hover:bg-hover">
                <input
                  type="checkbox"
                  checked={selected.has(t.name)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(t.name);
                      else next.delete(t.name);
                      return next;
                    })
                  }
                  className=""
                />
                <span className="truncate">{t.name}</span>
              </label>
            ))}
        </div>
      </aside>
      <div className="relative min-w-0 flex-1">
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-raised p-0.5 shadow-sm">
          <IconButton title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <ZoomOut className="size-3.5" />
          </IconButton>
          <span className="w-10 text-center text-[11px] tabular-nums text-muted">{Math.round(view.k * 100)}%</span>
          <IconButton title="Zoom in" onClick={() => zoomBy(1.2)}>
            <ZoomIn className="size-3.5" />
          </IconButton>
          <IconButton title="Fit" onClick={fit}>
            <Maximize className="size-3.5" />
          </IconButton>
          <Divider />
          <IconButton title={keysOnly ? "Show every column" : "Show only key columns (PK, FK)"} active={keysOnly} onClick={() => (setKeysPick(!keysOnly), setMoved({}))}>
            <KeyRound className="size-3.5" />
          </IconButton>
          <IconButton
            title={bouncy ? "Plain lines for relations" : "Bouncy, bundled wires for relations"}
            active={bouncy}
            onClick={() => {
              const next = !bouncy;
              setBouncy(next);
              try {
                localStorage.setItem("onyx.er.wires", next ? "bouncy" : "plain");
              } catch {
                // Not remembered: fine.
              }
            }}
          >
            <Cable className="size-3.5" />
          </IconButton>
          <IconButton title="Lay out again" onClick={() => setMoved({})}>
            <LayoutGrid className="size-3.5" />
          </IconButton>
          <IconButton title="Reload from the database" onClick={load}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          <IconButton
            title="Export"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              useOverlays.getState().openMenu(r.right - 140, r.bottom + 4, [
                { label: "Export as SVG…", onSelect: () => void exportAs("svg") },
                { label: "Export as PNG…", onSelect: () => void exportAs("png") },
              ]);
            }}
          >
            <Download className="size-3.5" />
          </IconButton>
        </div>
        {!shown.length && <p className="absolute inset-0 flex items-center justify-center text-[12px] text-muted">Pick tables on the left.</p>}
        <svg
          ref={svg}
          className="size-full cursor-grab select-none active:cursor-grabbing"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { kind: "pan", x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
          }}
          onMouseMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
            else if (d.name) {
              const b = box(d.name)!;
              setMoved((m) => ({ ...m, [d.name!]: { ...b, x: d.ox + (e.clientX - d.x) / view.k, y: d.oy + (e.clientY - d.y) / view.k } }));
            }
          }}
          onMouseUp={() => (drag.current = null)}
          onMouseLeave={() => (drag.current = null)}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
            else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
          }}
          fontFamily={FONT}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`} data-content="">
            {(() => {
              // Where each relation starts and ends, and which way it leaves each table.
              const ends = edges.flatMap((edge) => {
                const a = box(edge.from);
                const b = box(edge.to);
                if (!a || !b) return [];
                const from = tables.find((t) => t.name === edge.from);
                const to = tables.find((t) => t.name === edge.to);
                const ay = overview ? a.y + a.h / 2 : a.y + rowY(from, edge.fromCol);
                const by = overview ? b.y + b.h / 2 : b.y + rowY(to, edge.toCol);
                const self = edge.from === edge.to;
                const leftward = b.x + b.w / 2 < a.x + a.w / 2;
                const ax = self ? a.x + a.w : leftward ? a.x : a.x + a.w;
                const bx = self ? b.x + b.w : leftward ? b.x + b.w : b.x;
                const lit = hover === edge.from || hover === edge.to;
                return [{ edge, self, leftward, ax, ay, bx, by, lit }];
              });
              // Lines stay visible however far out.
              const px = overview ? 0.8 / view.k : 1;
              if (bouncy) {
                const wires: Wire[] = ends.map(({ edge, self, leftward, ax, ay, bx, by, lit }) => ({
                  id: `${edge.from}.${edge.fromCol}>${edge.to}.${edge.toCol}:${edge.name}`,
                  a: { x: ax, y: ay, dx: self || !leftward ? 1 : -1 },
                  b: { x: bx, y: by, dx: self || leftward ? 1 : -1 },
                  // Bundled by the table and side they leave from / arrive at.
                  startKey: `${edge.from}:${self || !leftward ? "r" : "l"}`,
                  endKey: `${edge.to}:${self || leftward ? "r" : "l"}:in`,
                  self,
                  lit,
                  dim: !!hover && !lit,
                  title: `${edge.from}.${edge.fromCol} → ${edge.to}.${edge.toCol} (${edge.name})`,
                }));
                return <ErWires wires={wires} px={px} />;
              }
              return ends.map(({ edge, self, leftward, ax, ay, bx, by, lit }, i) => {
                const bend = self ? 40 : Math.max(40, Math.abs(bx - ax) / 2);
                const d = `M${ax},${ay} C${ax + (leftward && !self ? -bend : bend)},${ay} ${bx + (leftward || self ? bend : -bend)},${by} ${bx},${by}`;
                return (
                  <g key={i}>
                    <path d={d} fill="none" stroke={lit ? "var(--accent)" : "var(--faint)"} strokeWidth={(lit ? 2 : 1.25) * px} opacity={hover && !lit ? 0.25 : 1} />
                    <circle cx={bx} cy={by} r={3.5 * px} fill={lit ? "var(--accent)" : "var(--faint)"} />
                    <title>{`${edge.from}.${edge.fromCol} → ${edge.to}.${edge.toCol} (${edge.name})`}</title>
                  </g>
                );
              });
            })()}
            {shown.map((t) => {
              const b = box(t.name)!;
              const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
              const lit = hover === t.name;
              const cols = drawn.get(t.name)!;
              if (overview) {
                // About 12px on screen, but never wider than the box.
                const size = Math.min(12 / view.k, (b.w - 24) / (Math.max(t.name.length, 4) * 0.58));
                return (
                  <g
                    key={t.name}
                    transform={`translate(${b.x},${b.y})`}
                    onMouseEnter={() => setHover(t.name)}
                    onMouseLeave={() => setHover(null)}
                    onDoubleClick={() => openTable(tab.connectionId, schema, t.name, "structure")}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      drag.current = { kind: "box", name: t.name, x: e.clientX, y: e.clientY, ox: b.x, oy: b.y };
                    }}
                    className="cursor-move"
                  >
                    <rect width={b.w} height={b.h} rx={10} fill={lit ? "var(--accent-soft)" : "var(--panel)"} stroke={lit ? "var(--accent)" : "var(--border-strong)"} strokeWidth={1.5 / view.k} />
                    <text x={b.w / 2} y={b.h / 2} fontSize={size} fontWeight={600} fill="var(--fg)" textAnchor="middle" dominantBaseline="central">
                      {t.name}
                    </text>
                    <title>{`${t.name} · ${t.columns.length} columns`}</title>
                  </g>
                );
              }
              return (
                <g
                  key={t.name}
                  transform={`translate(${b.x},${b.y})`}
                  onMouseEnter={() => setHover(t.name)}
                  onMouseLeave={() => setHover(null)}
                  onDoubleClick={() => openTable(tab.connectionId, schema, t.name, "structure")}
                >
                  <rect width={b.w} height={b.h} rx={7} fill="var(--raised)" stroke={lit ? "var(--accent)" : "var(--border)"} strokeWidth={lit ? 1.5 : 1} />
                  <path d={`M0,7 Q0,0 7,0 H${b.w - 7} Q${b.w},0 ${b.w},7 V${HEADER} H0 Z`} fill="var(--panel)" />
                  <line x1={0} x2={b.w} y1={HEADER} y2={HEADER} stroke="var(--border)" />
                  <text
                    x={12}
                    y={HEADER / 2 + 4.5}
                    fontSize={12.5}
                    fontWeight={600}
                    fill="var(--fg)"
                    className="cursor-move"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      drag.current = { kind: "box", name: t.name, x: e.clientX, y: e.clientY, ox: b.x, oy: b.y };
                    }}
                  >
                    {t.name.length > 28 ? `${t.name.slice(0, 27)}…` : t.name}
                  </text>
                  <rect
                    width={b.w}
                    height={HEADER}
                    fill="transparent"
                    className="cursor-move"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      drag.current = { kind: "box", name: t.name, x: e.clientX, y: e.clientY, ox: b.x, oy: b.y };
                    }}
                  >
                    <title>Drag to move · double-click for structure</title>
                  </rect>
                  {cols.slice(0, MAX_ROWS).map((c, i) => {
                    const y = HEADER + i * ROW + ROW / 2 + 7;
                    const tag = c.primaryKey ? "PK" : fkCols.has(c.name) ? "FK" : "";
                    return (
                      <g key={c.name}>
                        {tag && (
                          <text x={10} y={y} fontSize={8.5} fontWeight={700} fill={c.primaryKey ? "var(--fg)" : "var(--muted)"} fontFamily={MONO}>
                            {tag}
                          </text>
                        )}
                        <text x={30} y={y} fontSize={11.5} fill="var(--fg)" fontWeight={c.primaryKey ? 600 : 400}>
                          {c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name}
                        </text>
                        <text x={b.w - 10} y={y} fontSize={10} textAnchor="end" fill="var(--faint)" fontFamily={MONO}>
                          {c.dataType.length > 14 ? `${c.dataType.slice(0, 13)}…` : c.dataType}
                        </text>
                      </g>
                    );
                  })}
                  {cols.length > MAX_ROWS && (
                    <text x={30} y={HEADER + MAX_ROWS * ROW + ROW / 2 + 7} fontSize={10.5} fill="var(--faint)">
                      +{cols.length - MAX_ROWS} more columns
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** The diagram as a standalone SVG: colours resolved, framed around the tables. */
function standaloneSvg(el: SVGSVGElement, boxes: { x: number; y: number; w: number; h: number }[]): string {
  const pad = 24;
  const minX = Math.min(...boxes.map((b) => b.x)) - pad;
  const minY = Math.min(...boxes.map((b) => b.y)) - pad;
  const width = Math.max(...boxes.map((b) => b.x + b.w)) + pad - minX;
  const height = Math.max(...boxes.map((b) => b.y + b.h)) + pad - minY;
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("class");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.ceil(width)));
  clone.setAttribute("height", String(Math.ceil(height)));
  clone.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
  clone.querySelector("[data-content]")?.removeAttribute("transform");
  const styles = getComputedStyle(document.documentElement);
  const resolve = (value: string) => value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => styles.getPropertyValue(name).trim() || "currentColor");
  clone.querySelectorAll("*").forEach((node) => {
    for (const attr of ["fill", "stroke"]) {
      const v = node.getAttribute(attr);
      if (v?.includes("var(")) node.setAttribute(attr, resolve(v));
    }
    node.removeAttribute("class");
  });
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(minX));
  background.setAttribute("y", String(minY));
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", resolve("var(--bg)"));
  clone.insertBefore(background, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

/** Renders SVG text to a 2× PNG, as base64. */
function toPng(svgText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png").split(",")[1]);
    };
    img.onerror = () => reject(new Error("Couldn't render the diagram"));
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
  });
}


