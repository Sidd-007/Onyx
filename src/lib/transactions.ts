import type { Engine } from "./ipc";
import { splitStatements } from "./sqlSplit";

export const beginSql = (engine: Engine) => (engine === "mysql" ? "START TRANSACTION" : engine === "sqlserver" ? "BEGIN TRANSACTION" : "BEGIN");

/** Engines with transactions a query tab can hold open. */
export const hasTransactions = (engine: Engine) => ["postgres", "mysql", "sqlite", "sqlserver"].includes(engine);

/** Whether running `sql` leaves a transaction open ("begin"), closes one ("end"), or neither. */
export function transactionEffect(sql: string, engine: Engine): "begin" | "end" | null {
  let effect: "begin" | "end" | null = null;
  for (const s of splitStatements(sql, engine)) {
    const t = s.text.trim().toLowerCase();
    // T-SQL's BEGIN alone opens a block, not a transaction.
    if (engine === "sqlserver" ? /^begin\s+tran(saction)?\b/.test(t) : /^(begin|start\s+transaction)\b/.test(t)) effect = "begin";
    else if (/^(commit|rollback|end)\b/.test(t) && !/\bto\s+savepoint\b/.test(t)) effect = "end";
  }
  return effect;
}

/** The connection itself failed (not the SQL): dropped, reset, or the server went away. */
export const connectionLost = (message: string) =>
  /connection to the server was lost|connection (was )?(closed|reset|refused|lost)|broken pipe|server has gone away|lost connection|unexpected eof|connection terminated/i.test(message);

/** Statements that only read (anything else may have changed data). */
export const readOnly = (sql: string) => /^\s*(select|with|show|explain|describe|desc|values|table)\b/i.test(sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, ""));

/** Tables an UPDATE / INSERT / DELETE / TRUNCATE in `sql` writes to (`schema.table` or `table`, unquoted). */
export function writtenTables(sql: string): string[] {
  const clean = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  const name = String.raw`((?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]))*)`;
  const re = new RegExp(String.raw`\b(?:update|insert\s+(?:ignore\s+)?into|replace\s+into|delete\s+from|truncate(?:\s+table)?|merge\s+into)\s+(?:only\s+)?${name}`, "gi");
  for (const m of clean.matchAll(re)) out.add(m[1].replace(/["`\[\]]/g, ""));
  return [...out];
}
