import type { Engine } from "./ipc";
import { quoteIdent } from "./sqlSplit";

export type Operator = "=" | "!=" | "like" | "not like" | "<" | "<=" | ">" | ">=" | "in" | "is null" | "is not null";

export const OPERATORS: { value: Operator; label: string; needsValue: boolean }[] = [
  { value: "=", label: "equals", needsValue: true },
  { value: "!=", label: "does not equal", needsValue: true },
  { value: "like", label: "contains (like)", needsValue: true },
  { value: "not like", label: "does not contain", needsValue: true },
  { value: "<", label: "less than", needsValue: true },
  { value: "<=", label: "less than or equal", needsValue: true },
  { value: ">", label: "greater than", needsValue: true },
  { value: ">=", label: "greater than or equal", needsValue: true },
  { value: "in", label: "in (comma separated)", needsValue: true },
  { value: "is null", label: "is null", needsValue: false },
  { value: "is not null", label: "is not null", needsValue: false },
];

export interface Filter {
  column: string;
  op: Operator;
  value: string;
}

const needsValue = (op: Operator) => OPERATORS.find((o) => o.value === op)?.needsValue ?? true;

/** A string literal. Postgres: standard strings ('' escapes '). MySQL: \ and ' are escaped. */
export function literal(value: string, engine: Engine): string {
  if (engine === "mysql") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

/** One condition, or null when it still needs a value. */
export function condition(filter: Filter, engine: Engine): string | null {
  const column = quoteIdent(filter.column, engine);
  if (!needsValue(filter.op)) return `${column} ${filter.op.toUpperCase()}`;
  const value = filter.value.trim() === "" ? "" : filter.value;
  if (value === "") return null;
  switch (filter.op) {
    case "like":
    case "not like": {
      // "contains" unless the user wrote their own wildcards.
      const pattern = /[%_]/.test(value) ? value : `%${value}%`;
      // Compare as text so LIKE works on numbers and dates too.
      const target = engine === "postgres" ? `${column}::text` : column;
      return `${target} ${filter.op.toUpperCase()} ${literal(pattern, engine)}`;
    }
    case "in": {
      const items = value.split(",").map((v) => v.trim()).filter(Boolean);
      return items.length ? `${column} IN (${items.map((v) => literal(v, engine)).join(", ")})` : null;
    }
    default:
      return `${column} ${filter.op} ${literal(value, engine)}`;
  }
}

/** All complete filters, ANDed. Empty string when there are none. */
export function whereClause(filters: Filter[], engine: Engine): string {
  return filters
    .map((f) => condition(f, engine))
    .filter((c): c is string => c !== null)
    .join(" AND ");
}
