import { useEffect, useLayoutEffect, useRef } from "react";
import { ropePath, STILL, WireModel, type WireSpec } from "../lib/wires";

export interface Wire extends WireSpec {
  lit: boolean;
  dim: boolean;
  title: string;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The ER diagram's relations as bouncy, bundled ropes. The simulation writes path data
 * straight to the DOM each frame (no React render per frame) and sleeps once everything is
 * still; moving a table wakes it.
 */
export function ErWires({ wires, px }: { wires: Wire[]; px: number }) {
  const model = useRef(new WireModel());
  const paths = useRef(new Map<string, SVGPathElement>());
  const clips = useRef<SVGPathElement>(null);
  const frame = useRef<number | null>(null);
  const first = useRef(true);

  const draw = () => {
    for (const [id, el] of paths.current) {
      const p = model.current.points(id);
      if (p) el.setAttribute("d", ropePath(p));
    }
    clips.current?.setAttribute("d", model.current.clips().map(([x1, y1, x2, y2]) => `M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`).join(" "));
  };

  const tick = () => {
    const moving = model.current.step();
    draw();
    frame.current = moving > STILL ? requestAnimationFrame(tick) : null;
  };

  // Every render: pins follow the tables; then animate (or, with reduced motion, settle at once).
  useLayoutEffect(() => {
    model.current.sync(wires);
    if (first.current || reducedMotion()) {
      first.current = false;
      model.current.settle();
      draw();
    } else if (frame.current === null) {
      frame.current = requestAnimationFrame(tick);
    }
  });
  useEffect(() => () => void (frame.current !== null && cancelAnimationFrame(frame.current)), []);

  return (
    <g data-wires="">
      {wires.map((w) => (
        <g key={w.id} opacity={w.dim ? 0.25 : 1}>
          <path
            ref={(el) => void (el ? paths.current.set(w.id, el) : paths.current.delete(w.id))}
            fill="none"
            stroke={w.lit ? "var(--accent)" : "var(--faint)"}
            strokeWidth={(w.lit ? 2 : 1.25) * px}
            strokeLinecap="round"
          />
          <circle cx={w.b.x} cy={w.b.y} r={3.5 * px} fill={w.lit ? "var(--accent)" : "var(--faint)"} />
          <title>{w.title}</title>
        </g>
      ))}
      <path ref={clips} fill="none" stroke="var(--muted)" strokeWidth={3.5 * px} strokeLinecap="round" pointerEvents="none" />
    </g>
  );
}
