/**
 * F09: fixtures that exercise the values that break applications, from the schema. One
 * baseline row, then one row per edge case (one column changed at a time) with a manifest of
 * what each row tests, what was left out and why. Deterministic for a seed and generator
 * version. Invalid values are a separate set, expected to be rejected.
 */
import { enumValues, generate, pickGenerator, random } from "./fakeData";
import type { ColumnInfo } from "./ipc";

export const EDGE_VERSION = 2;

export interface EdgeCase {
  column: string;
  name: string;
  value: string | null;
  why: string;
}

export interface Omitted {
  column: string;
  name: string;
  reason: string;
}

export interface Fixture {
  columns: string[];
  rows: (string | null)[][];
  /** For each row: what it tests ("baseline" for the first). */
  manifest: { row: number; column: string | null; name: string; why: string }[];
  omitted: Omitted[];
  /** Values the database should refuse (run separately, never kept). */
  invalid: EdgeCase[];
  seed: number;
  version: number;
}

const INT_RANGE: Record<string, [string, string]> = {
  smallint: ["-32768", "32767"],
  int2: ["-32768", "32767"],
  integer: ["-2147483648", "2147483647"],
  int: ["-2147483648", "2147483647"],
  int4: ["-2147483648", "2147483647"],
  bigint: ["-9223372036854775808", "9223372036854775807"],
  int8: ["-9223372036854775808", "9223372036854775807"],
  tinyint: ["-128", "127"],
  mediumint: ["-8388608", "8388607"],
};

const plusOne = (n: string) => (BigInt(n) + 1n).toString();
const minusOne = (n: string) => (BigInt(n) - 1n).toString();

/** varchar(20) → 20; numeric(10,2) → [10, 2]. */
const typmod = (type: string) => /\((\d+)(?:\s*,\s*(\d+))?\)/.exec(type);

export function casesFor(c: ColumnInfo, engine: string): { valid: EdgeCase[]; invalid: EdgeCase[]; omitted: Omitted[] } {
  const t = c.dataType.toLowerCase();
  const valid: EdgeCase[] = [];
  const invalid: EdgeCase[] = [];
  const omitted: Omitted[] = [];
  const add = (name: string, value: string | null, why: string) => valid.push({ column: c.name, name, value, why });
  const bad = (name: string, value: string | null, why: string) => invalid.push({ column: c.name, name, value, why });
  if (c.nullable) add("NULL", null, "NULL is not the same as empty: code must handle a missing value");
  else {
    omitted.push({ column: c.name, name: "NULL", reason: "NOT NULL column" });
    if (!/nextval|identity|auto_increment/i.test(c.default ?? "")) bad("NULL in NOT NULL", null, "must be rejected by the NOT NULL constraint");
  }
  const base = t.replace(/\(.*$/, "").replace(/ unsigned$/, "").trim();
  const mysql = engine === "mysql";
  if (enumValues(t).length) {
    for (const v of enumValues(t)) add(`enum ${v}`, v, "every enum value appears at least once");
    bad("unknown enum value", "onyx_not_a_value", "must be rejected: not one of the enum's values");
  } else if (base in INT_RANGE) {
    const unsigned = / unsigned/.test(t);
    const [min, max] = unsigned ? ["0", (BigInt(INT_RANGE[base][1]) * 2n + 1n).toString()] : INT_RANGE[base];
    if (c.primaryKey) omitted.push({ column: c.name, name: "boundaries", reason: "primary key: boundary values would collide with the sequence" });
    else {
      add("minimum", min, `smallest ${base}: overflow and sign handling`);
      add("maximum", max, `largest ${base}: overflow in code using 32-bit or float math`);
      add("zero", "0", "zero is often treated as false or missing");
      if (!unsigned) add("minus one", "-1", "negative values where only positives are expected");
      bad("above maximum", plusOne(max), "must be rejected: out of range");
      bad("below minimum", minusOne(min), "must be rejected: out of range");
    }
  } else if (/^(numeric|decimal|number)/.test(base)) {
    const m = typmod(t);
    if (m) {
      const p = Number(m[1]);
      const s = Number(m[2] ?? 0);
      const whole = "9".repeat(Math.max(0, p - s)) || "0";
      const max = s ? `${whole}.${"9".repeat(s)}` : whole;
      add("maximum", max, `largest numeric(${p},${s}): precision kept end to end (no float rounding)`);
      add("negative maximum", `-${max}`, "negative precision boundary");
      if (s) add("smallest step", `0.${"0".repeat(s - 1)}1`, "smallest representable step");
      bad("too many digits", `1${whole}`, "must be rejected: more digits than the precision allows");
    } else add("high precision", "12345678901234567890.123456789", "a value JavaScript numbers would round");
    add("zero", "0", "zero");
  } else if (/^(real|float|double|float4|float8)/.test(base)) {
    add("0.1", "0.1", "not exactly representable in binary floating point");
    add("large", mysql ? "1e300" : "1e308", "near the top of the range");
    add("tiny", "1e-300", "near the bottom of the range");
  } else if (/^(bool|boolean)/.test(base) || t === "tinyint(1)") {
    add("true", mysql ? "1" : "true", "both values appear");
    add("false", mysql ? "0" : "false", "false is not the same as missing");
  } else if (/^(char|varchar|character|text|nvarchar|nchar|string|citext|tinytext|mediumtext|longtext)/.test(base)) {
    const m = typmod(t);
    const n = m ? Number(m[1]) : null;
    // Lengths as the database counts them: characters (code points); SQL Server counts UTF-16 units.
    const length = (v: string) => (engine === "sqlserver" ? v.length : [...v].length);
    /** The first form that fits the column; none fits → left out, never cut by the database. */
    const fitting = (name: string, forms: string[], why: string) => {
      const v = forms.find((f) => n === null || length(f) <= n);
      if (v === undefined) omitted.push({ column: c.name, name, reason: `doesn't fit ${c.dataType}: even the shortest form has ${length(forms[forms.length - 1])} characters` });
      else add(name, v, v === forms[0] ? why : `${why} (a shorter form, to fit ${n} characters)`);
    };
    const padded = /^(char|character|nchar)$/.test(base) || /^character\(/.test(t);
    add("empty string", "", padded ? `empty is not the same as NULL (${c.dataType} reads back padded with spaces)` : "empty is not the same as NULL");
    if (!padded) fitting("only spaces", ["   ", " "], "blank but not empty: trimming bugs");
    else omitted.push({ column: c.name, name: "only spaces", reason: `${c.dataType} pads with spaces, so it would be the same as the empty string` });
    fitting("unicode", ["naïve café — 你好 👋🏽", "é你👋🏽", "你👋🏽"], "accents, CJK and an emoji with a skin-tone modifier");
    fitting("right to left", ["שלום עולם", "שלום"], "right-to-left text");
    fitting("combining", ["e\u0301"], "a combining accent (e + U+0301): length and comparison bugs");
    fitting("zero width", ["zero\u200bwidth", "a\u200bb"], "an invisible character (U+200B)");
    fitting("quotes", [`O'Brien "quoted" \\ back`, `'"\\`], "quotes and backslashes: escaping bugs");
    if (n !== null && n > 0) {
      add("exactly max length", "x".repeat(n), `exactly ${n} characters`);
      bad("over max length", "x".repeat(n + 1), `must be rejected: longer than ${n}`);
    } else add("long", "x".repeat(10_000), "10,000 characters");
  } else if (/^(timestamp|datetime|timestamptz)/.test(base)) {
    const tz = /time zone|tz/.test(t) && !/without/.test(t);
    add("epoch", tz ? "1970-01-01 00:00:00+00" : "1970-01-01 00:00:00", "the Unix epoch, often confused with 'unset'");
    add("leap day", tz ? "2024-02-29 12:00:00+00" : "2024-02-29 12:00:00", "February 29th");
    add("DST gap", tz ? "2026-03-08 02:30:00-05" : "2026-03-29 02:30:00", "a wall-clock time that doesn't exist where clocks spring forward");
    add("DST overlap", tz ? "2026-11-01 01:30:00-04" : "2026-10-25 02:30:00", "a wall-clock time that happens twice");
    add("end of year", tz ? "2026-12-31 23:59:59+00" : "2026-12-31 23:59:59", "year boundaries");
    add("far future", mysql ? "2037-12-31 23:59:59" : tz ? "9999-12-31 23:59:59+00" : "9999-12-31 23:59:59", mysql ? "near the TIMESTAMP limit" : "the largest year");
    bad("not a date", "2026-02-30 00:00:00", "must be rejected: February 30th");
  } else if (/^date/.test(base)) {
    add("leap day", "2024-02-29", "February 29th");
    add("end of month", "2026-01-31", "adding a month to the 31st");
    add("far future", "9999-12-31", "the largest year");
    add("early", mysql ? "1000-01-01" : "0001-01-01", "the smallest supported year");
    bad("not a date", "2026-02-30", "must be rejected: February 30th");
  } else if (/uuid|uniqueidentifier/.test(base)) {
    if (!c.primaryKey) {
      add("nil uuid", "00000000-0000-0000-0000-000000000000", "the all-zero UUID, often used as 'none'");
      add("max uuid", "ffffffff-ffff-ffff-ffff-ffffffffffff", "the all-ones UUID");
    } else omitted.push({ column: c.name, name: "special UUIDs", reason: "primary key: would collide" });
    bad("not a uuid", "not-a-uuid", "must be rejected: malformed");
  } else if (/json/.test(base)) {
    add("empty object", "{}", "an object with no keys");
    add("empty array", "[]", "an array where an object may be expected");
    add("json null", "null", "JSON null, not SQL NULL");
    add("deep", '{"a":{"b":{"c":[1,{"d":null}]}}}', "nested values and a null inside");
    add("big number", '{"n":9223372036854775807,"x":12345678901234567890.5}', "numbers JavaScript would round");
    add("unicode keys", '{"ключ":"值","emoji 👋":true}', "non-ASCII keys");
    bad("not json", "{not json", "must be rejected: invalid JSON");
  } else {
    omitted.push({ column: c.name, name: "type cases", reason: `no edge cases known for ${c.dataType}` });
  }
  return { valid, invalid, omitted };
}

/**
 * The fixture. `references`: existing parent keys for foreign-key columns; rows are spread so
 * one parent gets one row, another many, and the rest none (zero/one/many cardinality).
 * `unique`: columns with a single-column unique index (they get a value of their own per row).
 */
export function buildFixture(columns: ColumnInfo[], engine: string, seed: number, references: Record<string, string[]> = {}, unique: string[] = []): Fixture {
  const r = random(seed);
  const gens = Object.fromEntries(columns.map((c) => [c.name, pickGenerator(c, c.name in references)]));
  const included = columns.filter((c) => gens[c.name] !== "skip" || !c.nullable);
  const writable = included.filter((c) => !/nextval|identity|auto_increment/i.test(c.default ?? ""));
  const names = writable.map((c) => c.name);
  const all = writable.map((c) => ({ c, ...casesFor(c, engine) }));
  const fixture: Fixture = { columns: names, rows: [], manifest: [], omitted: all.flatMap((x) => x.omitted), invalid: all.flatMap((x) => x.invalid), seed, version: EDGE_VERSION };
  const generated = (n: number) =>
    writable.map((c) => {
      const refs = references[c.name];
      if (refs?.length) {
        // Cardinality: row 0 → parent 0 (one row); rows 1–5 → parent 1 (many); other parents get none.
        return n === 0 ? refs[0] : refs[Math.min(1, refs.length - 1)];
      }
      const gen = gens[c.name] === "skip" ? "word" : gens[c.name];
      return generate(gen, c, n, r, refs ?? []);
    });
  // Every case row is the baseline with one column changed. Only key and unique columns (which
  // can't repeat) and foreign keys (spread for zero/one/many) take their own value per row.
  const own = new Set([...writable.filter((c) => c.primaryKey).map((c) => c.name), ...unique, ...Object.keys(references)]);
  const base = generated(0);
  fixture.rows.push(base);
  const varying = names.filter((n) => own.has(n));
  fixture.manifest.push({ row: 0, column: null, name: "baseline", why: `ordinary values; every other row is this one with one column changed${varying.length ? ` (${varying.join(", ")} take${varying.length === 1 ? "s" : ""} a value of its own per row: ${varying.length === 1 ? "it" : "they"} can't repeat or ${varying.length === 1 ? "is" : "are"} spread across parents)` : ""}` });
  for (const { c, valid } of all) {
    if (c.name in references) continue;
    const i = names.indexOf(c.name);
    for (const e of valid) {
      const fresh = generated(fixture.rows.length);
      const row = base.map((v, k) => (own.has(names[k]) ? fresh[k] : v));
      row[i] = e.value;
      fixture.manifest.push({ row: fixture.rows.length, column: c.name, name: e.name, why: e.why });
      fixture.rows.push(row);
    }
  }
  for (const [col, refs] of Object.entries(references)) {
    if (!names.includes(col)) continue;
    if (refs.length >= 2) fixture.manifest.push({ row: -1, column: col, name: "zero / one / many", why: `parent ${refs[0]} gets one row, ${refs[1]} gets ${fixture.rows.length - 1}; other parents none` });
    else fixture.omitted.push({ column: col, name: "zero / one / many", reason: "needs at least two existing parent rows" });
  }
  return fixture;
}
