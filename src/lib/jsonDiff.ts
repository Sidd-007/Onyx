/**
 * F04: JSON as values, not text. A parser that keeps numbers exactly as written (no
 * JavaScript rounding), a semantic diff (key order doesn't matter; arrays by position or by
 * a unique key), and PostgreSQL expressions for any path.
 */

export type JsonNode =
  | { t: "object"; entries: [string, JsonNode][]; duplicates: string[] }
  | { t: "array"; items: JsonNode[] }
  | { t: "string"; v: string }
  | { t: "number"; raw: string }
  | { t: "boolean"; v: boolean }
  | { t: "null" };

export type Path = (string | number)[];

/** Parses JSON text. Numbers keep their digits; repeated object keys are kept and reported. */
export function parseJson(text: string): JsonNode {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`Not valid JSON: ${what} at character ${i + 1}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail("expected a string");
    let out = "";
    i++;
    for (;;) {
      if (i >= text.length) fail("unfinished string");
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (e in map) out += map[e];
        else fail("bad escape");
      } else if (c < " ") fail("control character in a string");
      else out += c;
    }
  };
  const value = (): JsonNode => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: [string, JsonNode][] = [];
      const seen = new Set<string>();
      const duplicates: string[] = [];
      ws();
      if (text[i] === "}") return i++, { t: "object", entries, duplicates };
      for (;;) {
        ws();
        const k = str();
        ws();
        if (text[i++] !== ":") fail("expected :");
        const v = value();
        if (seen.has(k)) duplicates.push(k);
        seen.add(k);
        entries.push([k, v]);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, { t: "object", entries, duplicates };
        else fail("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === "]") return i++, { t: "array", items };
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return i++, { t: "array", items };
        else fail("expected , or ]");
      }
    }
    if (c === '"') return { t: "string", v: str() };
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(i));
    if (m && m[0]) return (i += m[0].length), { t: "number", raw: m[0] };
    for (const [word, node] of [["true", { t: "boolean", v: true }], ["false", { t: "boolean", v: false }], ["null", { t: "null" }]] as const) {
      if (text.startsWith(word, i)) return (i += word.length), node as JsonNode;
    }
    return fail("unexpected input");
  };
  const out = value();
  ws();
  if (i < text.length) fail("extra text after the value");
  return out;
}

/** `1.50`, `1.5` and `15e-1` are the same number; compared as decimals, never as floats. */
export function canonicalNumber(raw: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(raw);
  if (!m) return raw;
  let digits = (m[2] + (m[3] ?? "")).replace(/^0+/, "");
  let exp = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (!digits) return "0";
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  return `${m[1]}${digits}e${exp}`;
}

/** The value of an object key, the last one when a key repeats (as Postgres' jsonb keeps). */
const get = (o: Extract<JsonNode, { t: "object" }>, k: string) => {
  for (let j = o.entries.length - 1; j >= 0; j--) if (o.entries[j][0] === k) return o.entries[j][1];
  return undefined;
};

export function equal(a: JsonNode, b: JsonNode): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "number":
      return canonicalNumber(a.raw) === canonicalNumber((b as typeof a).raw);
    case "string":
    case "boolean":
      return a.v === (b as typeof a).v;
    case "null":
      return true;
    case "array": {
      const bi = (b as typeof a).items;
      return a.items.length === bi.length && a.items.every((x, j) => equal(x, bi[j]));
    }
    case "object": {
      const bo = b as typeof a;
      const keys = new Set([...a.entries.map((e) => e[0]), ...bo.entries.map((e) => e[0])]);
      return [...keys].every((k) => {
        const x = get(a, k);
        const y = get(bo, k);
        return x !== undefined && y !== undefined && equal(x, y);
      });
    }
  }
}

export interface JsonChange {
  path: Path;
  /** added / removed: the key or element is missing on one side (not the same as JSON null). */
  kind: "added" | "removed" | "changed" | "type";
  before?: JsonNode;
  after?: JsonNode;
}

export interface JsonDiff {
  changes: JsonChange[];
  /** Arrays that couldn't be matched by the chosen key (missing, not scalar, or repeated). */
  ambiguous: { path: Path; reason: string }[];
  /** Objects with repeated keys: only the last value of each counts. */
  duplicateKeys: { path: Path; keys: string[] }[];
}

const scalarKey = (n: JsonNode | undefined) => (n?.t === "string" ? `s:${n.v}` : n?.t === "number" ? `n:${canonicalNumber(n.raw)}` : null);

/** `arrayKey`: match array elements (objects) by this field instead of by position. */
export function diffJson(a: JsonNode, b: JsonNode, arrayKey: string | null = null): JsonDiff {
  const out: JsonDiff = { changes: [], ambiguous: [], duplicateKeys: [] };
  const walk = (x: JsonNode, y: JsonNode, path: Path) => {
    for (const n of [x, y]) if (n.t === "object" && n.duplicates.length && !out.duplicateKeys.some((d) => same(d.path, path))) out.duplicateKeys.push({ path, keys: n.duplicates });
    if (x.t !== y.t) return void out.changes.push({ path, kind: "type", before: x, after: y });
    if (x.t === "object" && y.t === "object") {
      const keys = [...new Set([...x.entries.map((e) => e[0]), ...y.entries.map((e) => e[0])])];
      for (const k of keys) {
        const p = get(x, k);
        const q = get(y, k);
        if (p === undefined) out.changes.push({ path: [...path, k], kind: "added", after: q });
        else if (q === undefined) out.changes.push({ path: [...path, k], kind: "removed", before: p });
        else walk(p, q, [...path, k]);
      }
      return;
    }
    if (x.t === "array" && y.t === "array") {
      if (arrayKey !== null) {
        const index = (items: JsonNode[]) => {
          const m = new Map<string, number>();
          for (const [j, it] of items.entries()) {
            const k = it.t === "object" ? scalarKey(get(it, arrayKey)) : null;
            if (k === null) return `an element has no usable "${arrayKey}"`;
            if (m.has(k)) return `two elements share ${arrayKey} = ${k.slice(2)}`;
            m.set(k, j);
          }
          return m;
        };
        const ix = index(x.items);
        const iy = index(y.items);
        if (typeof ix !== "string" && typeof iy !== "string") {
          for (const [k, j] of iy) {
            const old = ix.get(k);
            if (old === undefined) out.changes.push({ path: [...path, j], kind: "added", after: y.items[j] });
            else walk(x.items[old], y.items[j], [...path, j]);
          }
          for (const [k, j] of ix) if (!iy.has(k)) out.changes.push({ path: [...path, j], kind: "removed", before: x.items[j] });
          return;
        }
        // Can't match by the key: say why, and compare by position instead.
        out.ambiguous.push({ path, reason: typeof ix === "string" ? ix : (iy as string) });
      }
      const n = Math.max(x.items.length, y.items.length);
      for (let j = 0; j < n; j++) {
        if (j >= x.items.length) out.changes.push({ path: [...path, j], kind: "added", after: y.items[j] });
        else if (j >= y.items.length) out.changes.push({ path: [...path, j], kind: "removed", before: x.items[j] });
        else walk(x.items[j], y.items[j], [...path, j]);
      }
      return;
    }
    if (!equal(x, y)) out.changes.push({ path, kind: "changed", before: x, after: y });
  };
  walk(a, b, []);
  return out;
}

const same = (a: Path, b: Path) => a.length === b.length && a.every((p, i) => p === b[i]);

/** A node as JSON text (numbers exactly as written). */
export function stringify(n: JsonNode | undefined, indent = 0): string {
  if (!n) return "(missing)";
  const pad = " ".repeat(indent);
  switch (n.t) {
    case "number":
      return n.raw;
    case "string":
      return JSON.stringify(n.v);
    case "boolean":
      return String(n.v);
    case "null":
      return "null";
    case "array":
      return n.items.length ? `[\n${n.items.map((it) => `${pad}  ${stringify(it, indent + 2)}`).join(",\n")}\n${pad}]` : "[]";
    case "object":
      return n.entries.length ? `{\n${n.entries.map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${stringify(v, indent + 2)}`).join(",\n")}\n${pad}}` : "{}";
  }
}

/** A node as compact JSON text (numbers exactly as written), as databases store it. */
export function compact(n: JsonNode): string {
  switch (n.t) {
    case "number":
      return n.raw;
    case "string":
      return JSON.stringify(n.v);
    case "boolean":
      return String(n.v);
    case "null":
      return "null";
    case "array":
      return `[${n.items.map(compact).join(",")}]`;
    case "object":
      return `{${n.entries.map(([k, v]) => `${JSON.stringify(k)}:${compact(v)}`).join(",")}}`;
  }
}

/** Pretty-printed JSON text with every number kept as written; the text as it was if it isn't JSON. */
export function prettyJson(text: string, indent = 0): string {
  try {
    return stringify(parseJson(text), indent);
  } catch {
    return text;
  }
}

export const pathText = (p: Path) => (p.length ? p.map((s) => (typeof s === "number" ? `[${s}]` : /^[A-Za-z_]\w*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join("") : "(root)");

/** A Postgres text-array literal element: quoted when it needs to be. */
const arrayElement = (s: string | number) => {
  const v = String(s);
  return /^[\w-]+$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

/** `col #> '{a,0,b}'` (JSON) or `col #>> …` (text) for a path, keys escaped. */
export function pgPath(column: string, path: Path, asText: boolean): string {
  const col = /^[a-z_][a-z0-9_]*$/.test(column) ? column : `"${column.replace(/"/g, '""')}"`;
  if (!path.length) return asText ? `${col}::text` : col;
  const literal = `{${path.map(arrayElement).join(",")}}`;
  return `${col} ${asText ? "#>>" : "#>"} '${literal.replace(/'/g, "''")}'`;
}

/** A WHERE condition matching rows whose value at `path` equals this node. */
export function pgFilter(column: string, path: Path, node: JsonNode): string {
  if (node.t === "null") return `${pgPath(column, path, false)} = 'null'::jsonb`;
  if (node.t === "string") return `${pgPath(column, path, true)} = '${node.v.replace(/'/g, "''")}'`;
  if (node.t === "number") return `(${pgPath(column, path, true)})::numeric = ${node.raw}`;
  if (node.t === "boolean") return `(${pgPath(column, path, true)})::boolean = ${node.v}`;
  return `${pgPath(column, path, false)} = '${stringify(node).replace(/'/g, "''")}'::jsonb`;
}

export const typeName = (n: JsonNode) => n.t;
