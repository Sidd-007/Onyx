import type { Engine } from "./ipc";

/** A statement's trimmed range in the source text (end exclusive, without the `;`). */
export interface Statement {
  start: number;
  end: number;
  text: string;
}

/**
 * Splits SQL on top-level semicolons, skipping those inside strings, quoted
 * identifiers, comments and (Postgres) dollar-quoted bodies. Blank or
 * comment-only pieces are dropped.
 */
export function splitStatements(sql: string, dialect: Engine = "postgres"): Statement[] {
  // ClickHouse quotes and escapes like MySQL; SQL Server quotes names in [brackets].
  const mysql = dialect === "mysql" || dialect === "clickhouse";
  const brackets = dialect === "sqlserver";
  const statements: Statement[] = [];
  const n = sql.length;
  let segmentStart = 0;
  let i = 0;

  const push = (segmentEnd: number) => {
    let start = segmentStart;
    let end = segmentEnd;
    while (start < end && /\s/.test(sql[start])) start++;
    while (end > start && /\s/.test(sql[end - 1])) end--;
    const text = sql.slice(start, end);
    if (text && !isOnlyComments(text)) statements.push({ start, end, text });
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    const lineComment =
      (c === "-" && next === "-" && (!mysql || /\s/.test(sql[i + 2] ?? " "))) || (mysql && c === "#");
    if (lineComment) {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? n : newline + 1;
    } else if (c === "/" && next === "*") {
      i = skipBlockComment(sql, i);
    } else if (c === "'") {
      // MySQL strings and Postgres E'...' strings allow backslash escapes.
      const backslashes = mysql || (/[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? ""));
      i = skipQuoted(sql, i, "'", backslashes);
    } else if (c === '"') {
      i = skipQuoted(sql, i, '"', mysql);
    } else if (c === "`" && mysql) {
      i = skipQuoted(sql, i, "`", false);
    } else if (c === "[" && brackets) {
      i = skipQuoted(sql, i, "]", false);
    } else if (c === "$" && !mysql && !brackets && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
      } else {
        i++;
      }
    } else if (c === ";") {
      push(i);
      segmentStart = i + 1;
      i++;
    } else {
      i++;
    }
  }
  push(n);
  return statements;
}

/** The statement under the cursor, or the closest one before it. */
export function statementAt(sql: string, pos: number, dialect: Engine = "postgres"): Statement | null {
  // Redis: one command per line. MongoDB: the block of lines around the cursor (blank lines separate).
  if (dialect === "redis" || dialect === "mongodb") return blockAt(sql, pos, dialect === "redis" ? /\n/ : /\n[ \t]*\n/);
  const statements = splitStatements(sql, dialect);
  let before: Statement | null = null;
  for (const s of statements) {
    if (pos >= s.start && pos <= s.end) return s;
    if (s.end <= pos) before = s;
  }
  return before ?? statements[0] ?? null;
}

function blockAt(text: string, pos: number, separator: RegExp): Statement | null {
  const blocks: Statement[] = [];
  const re = new RegExp(separator.source, "g");
  let start = 0;
  const push = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    const body = text.slice(a, b);
    // Skip comment-only blocks.
    if (b > a && !body.split("\n").every((l) => /^\s*(\/\/|#|$)/.test(l))) blocks.push({ start: a, end: b, text: body });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(m.index);
    start = m.index + m[0].length;
  }
  push(text.length);
  let before: Statement | null = null;
  for (const b of blocks) {
    if (pos >= b.start && pos <= b.end) return b;
    if (b.end <= pos) before = b;
  }
  return before ?? blocks[0] ?? null;
}

function skipQuoted(sql: string, i: number, quote: string, backslashes: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashes && c === "\\") {
      j += 2;
    } else if (c === quote) {
      if (sql[j + 1] === quote) j += 2;
      else return j + 1;
    } else {
      j++;
    }
  }
  return sql.length;
}

/** Postgres block comments nest. */
function skipBlockComment(sql: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return sql.length;
}

function isOnlyComments(text: string): boolean {
  return text.replace(/(--|#)[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() === "";
}

/** Quote an identifier: Postgres only when needed, MySQL always (backticks). */
/** Reserved words that must be quoted even when they look like plain names (e.g. a table called "order"). */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create " +
    "current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc " +
    "distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral " +
    "leading limit localtime localtimestamp not null offset on only or order placing primary references returning " +
    "select session_user some symmetric table then to trailing true union unique user using variadic when where " +
    "window with join left right inner outer full cross natural is like ilike between index key values set update " +
    "delete insert drop alter by"
  ).split(" "),
);

export function quoteIdent(name: string, dialect: Engine = "postgres"): string {
  if (dialect === "mysql" || dialect === "clickhouse") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "sqlserver") return `[${name.replace(/]/g, "]]")}]`;
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
