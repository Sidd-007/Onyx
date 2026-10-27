import type { ColumnInfo } from "./ipc";

export type Generator =
  | "skip"
  | "null"
  | "sequence"
  | "integer"
  | "decimal"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "time"
  | "email"
  | "first_name"
  | "last_name"
  | "full_name"
  | "phone"
  | "city"
  | "country"
  | "url"
  | "word"
  | "sentence"
  | "json"
  | "choice"
  | "reference";

export const GENERATORS: { value: Generator; label: string }[] = [
  { value: "skip", label: "Leave out (default)" },
  { value: "null", label: "NULL" },
  { value: "sequence", label: "Sequence 1, 2, 3…" },
  { value: "integer", label: "Integer" },
  { value: "decimal", label: "Decimal" },
  { value: "boolean", label: "Boolean" },
  { value: "uuid", label: "UUID" },
  { value: "date", label: "Date" },
  { value: "timestamp", label: "Timestamp" },
  { value: "time", label: "Time" },
  { value: "email", label: "Email" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "full_name", label: "Full name" },
  { value: "phone", label: "Phone" },
  { value: "city", label: "City" },
  { value: "country", label: "Country" },
  { value: "url", label: "URL" },
  { value: "word", label: "Word" },
  { value: "sentence", label: "Sentence" },
  { value: "json", label: "JSON object" },
  { value: "choice", label: "One of the allowed values" },
  { value: "reference", label: "An existing referenced value" },
];

const FIRST = ["Ava", "Liam", "Maya", "Noah", "Aria", "Kabir", "Zoe", "Ethan", "Isha", "Leo", "Mila", "Arjun", "Nora", "Omar", "Sara", "Yuki"];
const LAST = ["Patel", "Smith", "Garcia", "Kim", "Singh", "Müller", "Rossi", "Chen", "Silva", "Novak", "Okafor", "Haddad", "Ivanova", "Sato"];
const CITIES = ["Mumbai", "Berlin", "Austin", "Lagos", "Osaka", "Lima", "Toronto", "Seoul", "Lisbon", "Nairobi", "Pune", "Sydney"];
const COUNTRIES = ["India", "Germany", "United States", "Nigeria", "Japan", "Peru", "Canada", "South Korea", "Portugal", "Kenya"];
const WORDS = ["alpha", "harbor", "copper", "meadow", "signal", "orbit", "maple", "quartz", "ember", "river", "pixel", "summit", "violet", "lantern"];

/** A small seeded PRNG (mulberry32), so a preview matches what gets inserted. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MySQL `enum('a','b')` / `set(...)` values. */
export function enumValues(dataType: string): string[] {
  const m = /^(?:enum|set)\((.*)\)$/i.exec(dataType.trim());
  if (!m) return [];
  return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
}

/** A sensible generator from the column's name and type. */
export function pickGenerator(column: ColumnInfo, isReference: boolean): Generator {
  const name = column.name.toLowerCase();
  const type = column.dataType.toLowerCase();
  if (/nextval\(|identity|auto_increment|autoincrement/.test(column.default ?? "")) return "skip";
  if (isReference) return "reference";
  if (column.primaryKey && /int/.test(type) && column.default === null) return /int/.test(type) ? "sequence" : "uuid";
  if (enumValues(type).length) return "choice";
  if (/uuid|uniqueidentifier/.test(type)) return "uuid";
  if (/^(bool|tinyint\(1\)|bit\(1\))/.test(type)) return "boolean";
  if (/json/.test(type)) return "json";
  if (/^(timestamp|datetime)/.test(type) || /_at$/.test(name)) return /int/.test(type) ? "integer" : "timestamp";
  if (/^date/.test(type)) return "date";
  if (/^time/.test(type)) return "time";
  if (/(int|serial)/.test(type)) return "integer";
  if (/(numeric|decimal|float|double|real|money)/.test(type)) return "decimal";
  if (/e?mail/.test(name)) return "email";
  if (/first.?name|given/.test(name)) return "first_name";
  if (/last.?name|surname|family/.test(name)) return "last_name";
  if (/(^|_)name$|full.?name|display/.test(name)) return "full_name";
  if (/phone|mobile|tel/.test(name)) return "phone";
  if (/city|town/.test(name)) return "city";
  if (/country/.test(name)) return "country";
  if (/url|link|website|avatar|image/.test(name)) return "url";
  if (/desc|bio|note|comment|body|text|message/.test(name)) return "sentence";
  if (column.default !== null) return "skip";
  return "word";
}

const pick = <T,>(list: T[], r: () => number) => list[Math.floor(r() * list.length)];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The `n`th generated value (0-based) for a column. `references`: existing values for "reference"/"choice". */
export function generate(gen: Generator, column: ColumnInfo, n: number, r: () => number, references: string[] = []): string | null {
  const maxLength = Number(/\((\d+)\)/.exec(column.dataType)?.[1] ?? 0);
  const fit = (s: string) => (maxLength && /char/i.test(column.dataType) ? s.slice(0, maxLength) : s);
  const first = () => pick(FIRST, r);
  const last = () => pick(LAST, r);
  const day = () => new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 3 * 365) * 86_400_000);
  switch (gen) {
    case "skip":
    case "null":
      return null;
    case "sequence":
      return String(n + 1);
    case "integer":
      return String(Math.floor(r() * (/small|tiny/i.test(column.dataType) ? 100 : 10_000)));
    case "decimal":
      return (r() * 1000).toFixed(2);
    case "boolean":
      return /tinyint|bit/i.test(column.dataType) ? (r() < 0.5 ? "0" : "1") : r() < 0.5 ? "false" : "true";
    case "uuid": {
      const h = () => Math.floor(r() * 16).toString(16);
      const s = Array.from({ length: 32 }, h).join("");
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
    }
    case "date":
      return day().toISOString().slice(0, 10);
    case "timestamp": {
      const d = day();
      return `${d.toISOString().slice(0, 10)} ${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}:${pad(Math.floor(r() * 60))}`;
    }
    case "time":
      return `${pad(Math.floor(r() * 24))}:${pad(Math.floor(r() * 60))}:00`;
    case "email":
      // The row number keeps emails unique.
      return fit(`${first().toLowerCase()}.${last().toLowerCase().replace(/[^a-z]/g, "")}${n + 1}@example.com`);
    case "first_name":
      return fit(first());
    case "last_name":
      return fit(last());
    case "full_name":
      return fit(`${first()} ${last()}`);
    case "phone":
      return fit(`+1-555-${pad(Math.floor(r() * 1000), 3)}-${pad(Math.floor(r() * 10000), 4)}`);
    case "city":
      return fit(pick(CITIES, r));
    case "country":
      return fit(pick(COUNTRIES, r));
    case "url":
      return fit(`https://example.com/${pick(WORDS, r)}/${n + 1}`);
    case "word":
      return fit(`${pick(WORDS, r)}-${n + 1}`);
    case "sentence": {
      const words = Array.from({ length: 6 + Math.floor(r() * 8) }, () => pick(WORDS, r));
      return fit(`${words.join(" ").replace(/^./, (c) => c.toUpperCase())}.`);
    }
    case "json":
      return JSON.stringify({ id: n + 1, tag: pick(WORDS, r), score: Math.round(r() * 100) });
    case "choice": {
      const values = enumValues(column.dataType);
      return values.length ? pick(values, r) : references.length ? pick(references, r) : null;
    }
    case "reference":
      return references.length ? pick(references, r) : null;
  }
}
