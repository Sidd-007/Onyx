/**
 * Privacy mode: personal data is masked in grids and documents (for screen sharing and
 * recordings). A value is masked when its column's name says it's personal, or when it
 * looks like an email, a phone or card number, or a token.
 */

const NAME = /(e-?mail|phone|mobile|\btel\b|whatsapp|password|passwd|\bpwd\b|secret|token|api_?key|auth|ssn|aadhaa?r|\bpan\b|passport|card|cvv|iban|account_?n(o|umber)|address|street|postcode|postal|zip|\bdob\b|birth|ip_?addr|first_?name|last_?name|full_?name|surname)/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DIGITS = /^\+?[\d\s().-]{9,}$/;
const TOKEN = /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2}|(sk|pk|rk|ghp|xox[bp])[-_][A-Za-z0-9_-]{16,})$/;

/** Whether a column's values are personal by name. */
export const isSensitiveColumn = (column: string) => NAME.test(column);

export function isSensitive(column: string, value: string | null): boolean {
  if (value === null || value === "") return false;
  if (isSensitiveColumn(column)) return true;
  const v = value.trim();
  return EMAIL.test(v) || (DIGITS.test(v) && v.replace(/\D/g, "").length >= 9 && !/^\d{4}-\d{2}-\d{2}/.test(v)) || TOKEN.test(v);
}

/** `ann@gmail.com` → `a•••@•••.com`; anything else keeps its length (up to 10 dots). */
export function mask(value: string): string {
  const v = value.trim();
  const at = v.indexOf("@");
  if (EMAIL.test(v) && at > 0) {
    const tld = v.slice(v.lastIndexOf("."));
    return `${v[0]}•••@•••${tld}`;
  }
  return "•".repeat(Math.min(10, Math.max(4, v.length)));
}

/** A cell as privacy mode shows it. */
export const shown = (column: string, value: string | null, on: boolean) => (on && isSensitive(column, value) ? mask(value!) : value);

/** A JSON document with its personal values masked (keys say what's personal; values can too). */
export function maskJson(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskJson(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k.startsWith("$") ? v : maskJson(v, k)]));
  if (typeof value === "string" || typeof value === "number") return isSensitive(key, String(value)) ? mask(String(value)) : value;
  return value;
}
