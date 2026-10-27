import type { TypeKind } from "./columnTypes";
import type { Engine } from "./ipc";
import { literal } from "./filters";
import { quoteIdent } from "./sqlSplit";
import { parseJson, stringify } from "./jsonDiff";

/** A text value as its JSON type: numbers, booleans and JSON columns stay typed. */
function jsonValue(value: string | null, kind: TypeKind | undefined): unknown {
  if (value === null) return null;
  if (kind === "number") return exactNumber(value) ?? value;
  if (kind === "bool") {
    if (/^(1|t|true)$/i.test(value)) return true;
    if (/^(0|f|false)$/i.test(value)) return false;
  }
  return value;
}

/**
 * The value as a JSON number when that keeps it exactly (same digits, nothing rounded); else
 * null, and it stays a string. Big integers (ids) and long decimals (money) stay exact.
 */
export function exactNumber(value: string): number | null {
  const text = value.trim();
  if (!/^-?(\d+)(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  // Compare without insignificant zeros: 1.50 is 1.5, 007 is not a number we should change.
  if (/^-?0\d/.test(text)) return null;
  const canonical = text.includes("e") || text.includes("E") ? text : text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return String(n) === canonical || (canonical === "-0" && n === 0) ? n : null;
}

/** One row as JSON text, in column order. `kinds` types the values per column. */
export function rowAsJson(columns: string[], values: (string | null)[], kinds?: (TypeKind | undefined)[]): string {
  // Built as text, so numbers inside JSON columns keep every digit (no JSON.parse round trip).
  const fields = new Map<string, string>();
  columns.forEach((c, i) => {
    const value = values[i] ?? null;
    let text: string | null = null;
    if (value !== null && kinds?.[i] === "json") {
      try {
        text = stringify(parseJson(value), 2);
      } catch {
        // Not JSON after all: a string.
      }
    }
    fields.set(c, text ?? JSON.stringify(jsonValue(value, kinds?.[i])));
  });
  return fields.size ? `{\n${[...fields].map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`).join(",\n")}\n}` : "{}";
}

/** NULL is an empty field and the empty string is `""`, so they stay different. */
export function csvField(value: string | null): string {
  if (value === null) return "";
  if (value === "") return '""';
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Header line plus one line per row. */
export function rowsAsCsv(columns: string[], rows: (string | null)[][]): string {
  return [columns.map(csvField).join(","), ...rows.map((r) => r.map(csvField).join(","))].join("\n");
}

/** Tab-separated, for pasting into spreadsheets; tabs and line breaks in values become spaces. */
export function rowsAsTsv(columns: string[], rows: (string | null)[][]): string {
  const field = (v: string | null) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  return [columns.map(field).join("\t"), ...rows.map((r) => r.map(field).join("\t"))].join("\n");
}

/** Values only, tab-separated: what spreadsheets paste into cells (⌘C). */
export function valuesAsTsv(rows: (string | null)[][]): string {
  const field = (v: string | null) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  return rows.map((r) => r.map(field).join("\t")).join("\n");
}

/** A Markdown table, for pasting into docs, issues and chat. */
export function rowsAsMarkdown(columns: string[], rows: (string | null)[][]): string {
  const field = (v: string | null) => (v === null ? "NULL" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(columns.map(field)), line(columns.map(() => "---")), ...rows.map((r) => line(r.map(field)))].join("\n");
}

export function rowAsInsert(engine: Engine, table: string, columns: string[], values: (string | null)[]): string {
  const cols = columns.map((c) => quoteIdent(c, engine)).join(", ");
  const vals = values.map((v) => (v === null ? "NULL" : literal(v, engine))).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${vals});`;
}
