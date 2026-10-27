/**
 * Bouncy, bundled wires for the ER diagram. Each relation is a short rope (Verlet points held
 * at a rest length) pinned at both columns: it sags a little and swings when a table moves.
 * Ropes that arrive at the same side of a table are pulled into a ribbon near it, and so are
 * ropes that leave one, so busy tables read as a few bundles instead of a tangle.
 */

export interface Pin {
  x: number;
  y: number;
  /** The way the wire leaves the column: +1 to the right, -1 to the left. */
  dx: number;
}

export interface WireSpec {
  id: string;
  a: Pin;
  b: Pin;
  /** Wires with the same key are bundled near their start (a) / end (b). */
  startKey: string;
  endKey: string;
  self?: boolean;
}

/** Points per rope (the first two and last two are pinned). */
export const POINTS = 18;
const GRAVITY = 0.32;
const DAMPING = 0.955;
const ITERATIONS = 6;
/** Pull towards the bundle's ribbon, at its strongest right at the shared table. */
const BUNDLE = 0.5;
/** Space between strands in a ribbon. */
export const SPACING = 4.5;
/** How far from the shared table a ribbon reaches, and how finely it's sampled. */
const REACH = 170;
const SAMPLE = 10;
const SLACK = 1.06;
/** Average movement per frame (px) below which the wires count as still and stop animating. */
export const STILL = 0.03;

interface Rope {
  spec: WireSpec;
  p: Float64Array;
  q: Float64Array;
  rest: number;
}

const lead = (s: WireSpec) => Math.min(26, Math.max(10, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / 5));

/** The rope's length at rest: the route it takes (out of each column, then across), plus a little, so it hangs. */
function restLength(s: WireSpec): number {
  const l = lead(s);
  const ax = s.a.x + s.a.dx * l;
  const bx = s.b.x + s.b.dx * l;
  const route = 2 * l + Math.hypot(bx - ax, s.b.y - s.a.y);
  const total = s.self ? 70 + Math.abs(s.b.y - s.a.y) : route * SLACK + 4;
  return total / (POINTS - 1);
}

export class WireModel {
  private ropes = new Map<string, Rope>();

  /** Adds new wires (laid along a curve), drops gone ones, and moves pins to where tables are now. */
  sync(specs: WireSpec[]) {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.id);
      const rope = this.ropes.get(spec.id);
      if (rope) rope.spec = spec;
      else this.ropes.set(spec.id, this.create(spec));
    }
    for (const id of [...this.ropes.keys()]) if (!seen.has(id)) this.ropes.delete(id);
  }

  private create(spec: WireSpec): Rope {
    const p = new Float64Array(POINTS * 2);
    const { a, b } = spec;
    const bend = spec.self ? 40 : Math.max(40, Math.abs(b.x - a.x) / 2);
    // Start on the same Bézier the diagram drew before, so nothing jumps.
    const c1x = a.x + a.dx * bend;
    const c2x = b.x + b.dx * bend;
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      const u = 1 - t;
      p[2 * i] = u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x;
      p[2 * i + 1] = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y;
    }
    return { spec, p, q: Float64Array.from(p), rest: restLength(spec) };
  }

  private pin(r: Rope) {
    const { a, b } = r.spec;
    const l = lead(r.spec);
    const n = POINTS - 1;
    r.p[0] = a.x;
    r.p[1] = a.y;
    r.p[2] = a.x + a.dx * l;
    r.p[3] = a.y;
    r.p[2 * n] = b.x;
    r.p[2 * n + 1] = b.y;
    r.p[2 * (n - 1)] = b.x + b.dx * l;
    r.p[2 * (n - 1) + 1] = b.y;
  }

  /** One frame. Returns how far the points moved on average (0 when everything is still). */
  step(): number {
    const ropes = [...this.ropes.values()];
    let motion = 0;
    for (const r of ropes) {
      // The rest length follows the tables, with some give: it stretches and springs back.
      r.rest += (restLength(r.spec) - r.rest) * 0.12;
      for (let i = 2; i < POINTS - 2; i++) {
        const x = r.p[2 * i];
        const y = r.p[2 * i + 1];
        const vx = (x - r.q[2 * i]) * DAMPING;
        const vy = (y - r.q[2 * i + 1]) * DAMPING;
        r.q[2 * i] = x;
        r.q[2 * i + 1] = y;
        r.p[2 * i] = x + vx;
        r.p[2 * i + 1] = y + vy + GRAVITY;
      }
      this.pin(r);
    }
    this.bundle(ropes, (r) => r.spec.startKey, (r) => r.spec.a.y, false);
    this.bundle(ropes, (r) => r.spec.endKey, (r) => r.spec.b.y, true);
    for (let k = 0; k < ITERATIONS; k++) {
      for (const r of ropes) {
        for (let i = 0; i < POINTS - 1; i++) {
          const dx = r.p[2 * i + 2] - r.p[2 * i];
          const dy = r.p[2 * i + 3] - r.p[2 * i + 1];
          const d = Math.hypot(dx, dy) || 1e-6;
          const diff = ((d - r.rest) / d) * 0.5;
          const fixedA = i < 2;
          const fixedB = i + 1 >= POINTS - 2;
          const wa = fixedA ? 0 : fixedB ? 1 : 0.5;
          const wb = fixedB ? 0 : fixedA ? 1 : 0.5;
          r.p[2 * i] += dx * diff * wa * 2;
          r.p[2 * i + 1] += dy * diff * wa * 2;
          r.p[2 * i + 2] -= dx * diff * wb * 2;
          r.p[2 * i + 3] -= dy * diff * wb * 2;
        }
        this.pin(r);
      }
    }
    // How far the points really moved this frame (after gravity, bundling and the rope's pull).
    for (const r of ropes) for (let i = 2; i < POINTS - 2; i++) motion += Math.abs(r.p[2 * i] - r.q[2 * i]) + Math.abs(r.p[2 * i + 1] - r.q[2 * i + 1]);
    const free = ropes.length * (POINTS - 4);
    return free ? motion / free : 0;
  }

  /**
   * Pulls the ropes sharing a key into a ribbon, side by side in the order of their pins. Only
   * the stretch near the shared table joins it (by distance, not by fraction of the rope), so
   * short wires between neighbours stay loose instead of being knotted together.
   */
  private bundle(ropes: Rope[], key: (r: Rope) => string, order: (r: Rope) => number, fromEnd: boolean) {
    const groups = new Map<string, Rope[]>();
    for (const r of ropes) {
      const k = key(r);
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((x, y) => order(x) - order(y));
      for (let s = 0; s <= REACH; s += SAMPLE) {
        // Each rope's point at distance s from the shared pin, and how strongly it's pulled there.
        const at = g.map((r) => {
          const length = (POINTS - 1) * r.rest;
          const reach = Math.min(REACH, length * 0.4);
          const steps = Math.round(s / r.rest);
          const i = fromEnd ? POINTS - 3 - steps : 2 + steps;
          return { r, i, w: s < reach && i >= 2 && i <= POINTS - 3 ? BUNDLE * (1 - s / reach) ** 1.5 : 0 };
        });
        const live = at.filter((x) => x.w > 0.004);
        if (live.length < 2) continue;
        let mx = 0;
        let my = 0;
        let tx = 0;
        let ty = 0;
        for (const { r, i } of live) {
          mx += r.p[2 * i];
          my += r.p[2 * i + 1];
          tx += r.p[2 * i + 2] - r.p[2 * i - 2];
          ty += r.p[2 * i + 3] - r.p[2 * i - 1];
        }
        mx /= live.length;
        my /= live.length;
        const tl = Math.hypot(tx, ty) || 1;
        // The side-by-side direction, pointing down (or right) so the order matches the pins'.
        let nx = -ty / tl;
        let ny = tx / tl;
        if (ny < 0 || (ny === 0 && nx < 0)) (nx = -nx), (ny = -ny);
        const mid = (live.length - 1) / 2;
        live.forEach(({ r, i, w }, rank) => {
          const off = (rank - mid) * SPACING;
          r.p[2 * i] += (mx + nx * off - r.p[2 * i]) * w;
          r.p[2 * i + 1] += (my + ny * off - r.p[2 * i + 1]) * w;
        });
      }
    }
  }

  /** Runs until still (or `max` frames): for the first draw and for reduced motion. */
  settle(max = 400) {
    for (let i = 0; i < max; i++) if (this.step() < STILL) break;
  }

  points(id: string): Float64Array | undefined {
    return this.ropes.get(id)?.p;
  }

  /** Where clips go: across each ribbon that has formed, a little way out from the shared table. */
  clips(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    const ropes = [...this.ropes.values()];
    const add = (key: (r: Rope) => string, order: (r: Rope) => number, fromEnd: boolean) => {
      const groups = new Map<string, Rope[]>();
      for (const r of ropes) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((x, y) => order(x) - order(y));
        for (const s of [22, 46]) {
          const point = (r: Rope) => {
            const steps = Math.round(s / r.rest);
            const i = Math.min(POINTS - 3, Math.max(2, fromEnd ? POINTS - 3 - steps : 2 + steps));
            return [r.p[2 * i], r.p[2 * i + 1]];
          };
          const [fx, fy] = point(g[0]);
          const [lx, ly] = point(g[g.length - 1]);
          // Only once the strands are close together: a clip on a fan-out would look wrong.
          if (Math.hypot(lx - fx, ly - fy) < SPACING * (g.length - 1) * 2.4 + 2) out.push([fx, fy, lx, ly]);
        }
      }
    };
    add((r) => r.spec.startKey, (r) => r.spec.a.y, false);
    add((r) => r.spec.endKey, (r) => r.spec.b.y, true);
    return out;
  }
}

/** A smooth SVG path through a rope's points. */
export function ropePath(p: Float64Array): string {
  const n = p.length / 2;
  let d = `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (p[2 * i] + p[2 * i + 2]) / 2;
    const my = (p[2 * i + 1] + p[2 * i + 3]) / 2;
    d += ` Q${p[2 * i].toFixed(1)},${p[2 * i + 1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  return `${d} L${p[2 * n - 2].toFixed(1)},${p[2 * n - 1].toFixed(1)}`;
}
