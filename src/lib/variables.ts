import { literal } from "./filters";
import type { Engine } from "./ipc";

export interface VariableUse {
  name: string;
  start: number;
  end: number;
}

/**
 * `:name` placeholders, outside strings, quoted names, comments and dollar-quoted bodies.
 * Postgres casts (`x::int`) and MySQL's `:=` are not variables.
 */
export function findVariables(sql: string): VariableUse[] {
  const out: VariableUse[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      const close = c;
      i++;
      while (i < sql.length && !(sql[i] === close && sql[i + 1] !== close)) i += sql[i] === close || sql[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "$" && /[$A-Za-z_]/.test(next ?? "")) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
      } else i++;
    } else if (c === ":" && sql[i - 1] !== ":" && next !== ":" && next !== "=" && /[A-Za-z_]/.test(next ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(sql.slice(i + 1))![0];
      out.push({ name, start: i, end: i + 1 + name.length });
      i += 1 + name.length;
    } else {
      i++;
    }
  }
  return out;
}

/** Distinct names, in order of first use. */
export const variableNames = (sql: string) => [...new Set(findVariables(sql).map((v) => v.name))];

/**
 * A value as SQL: numbers, NULL and booleans as they are, anything else quoted.
 * `raw` values (expressions like now()) are inserted unchanged.
 */
export function valueSql(value: string, engine: Engine, raw = false): string {
  const t = value.trim();
  if (raw) return t || "NULL";
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(null|true|false)$/i.test(t)) return t.toUpperCase() === t || /^-?\d/.test(t) ? t : t.toUpperCase();
  return literal(value, engine);
}

/** Replaces each `:name` with its value. */
export function substitute(sql: string, values: Record<string, { value: string; raw: boolean }>, engine: Engine): string {
  let out = "";
  let at = 0;
  for (const v of findVariables(sql)) {
    const entry = values[v.name];
    if (!entry) continue;
    out += sql.slice(at, v.start) + valueSql(entry.value, engine, entry.raw);
    at = v.end;
  }
  return out + sql.slice(at);
}
