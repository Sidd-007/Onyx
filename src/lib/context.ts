/**
 * F12: compare the application's execution context with Onyx's (PostgreSQL). The same
 * read-only diagnostic query runs on both connections; differences that a session can
 * reproduce are applied, one by one, in a dedicated session only.
 */

/** Run on the application's connection (psql with its credentials, or a debug endpoint): one JSON value. Reads only. */
export const DIAGNOSTIC_SQL = `SELECT json_build_object(
  'onyx_context', 1,
  'captured_at', now(),
  'server_version', current_setting('server_version'),
  'database', current_database(),
  'current_user', current_user,
  'session_user', session_user,
  'search_path', current_setting('search_path'),
  'resolved_schemas', current_schemas(true),
  'TimeZone', current_setting('TimeZone'),
  'DateStyle', current_setting('DateStyle'),
  'IntervalStyle', current_setting('IntervalStyle'),
  'transaction_isolation', current_setting('transaction_isolation'),
  'transaction_read_only', current_setting('transaction_read_only'),
  'statement_timeout', current_setting('statement_timeout'),
  'lock_timeout', current_setting('lock_timeout'),
  'idle_in_transaction_session_timeout', current_setting('idle_in_transaction_session_timeout'),
  'application_name', current_setting('application_name'),
  'client_encoding', current_setting('client_encoding'),
  'standard_conforming_strings', current_setting('standard_conforming_strings'),
  'lc_numeric', current_setting('lc_numeric'),
  'lc_time', current_setting('lc_time'),
  'row_security', current_setting('row_security'),
  'plan_cache_mode', current_setting('plan_cache_mode'),
  'jit', current_setting('jit'),
  'work_mem', current_setting('work_mem'),
  'enable_seqscan', current_setting('enable_seqscan'),
  'enable_indexscan', current_setting('enable_indexscan'),
  'random_page_cost', current_setting('random_page_cost'),
  'in_recovery', pg_is_in_recovery(),
  'server_addr', inet_server_addr()::text,
  'server_port', inet_server_port(),
  'backend_pid', pg_backend_pid(),
  'role_superuser', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
  'role_bypass_rls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'member_of', (SELECT coalesce(json_agg(r.rolname ORDER BY r.rolname), '[]'::json) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = current_user)
)::text AS onyx_context;`;

export type Provenance = "captured" | "supplied" | "unknown";

export interface ContextReport {
  values: Record<string, unknown>;
  /** Where each value came from. Captured: the diagnostic query. Supplied: typed by the user. */
  provenance: Record<string, Provenance>;
  capturedAt: string | null;
}

/** Fields the user can supply that no database view knows: driver, pool mode, parameter types. */
export const SUPPLIED_FIELDS = ["driver", "pool_mode", "parameter_types", "prepared_statements"] as const;

/** Settings a dedicated session can take on (`set_config`). Role is separate (SET ROLE). */
export const REPRODUCIBLE = [
  "search_path",
  "TimeZone",
  "DateStyle",
  "IntervalStyle",
  "statement_timeout",
  "lock_timeout",
  "application_name",
  "row_security",
  "plan_cache_mode",
  "jit",
  "work_mem",
  "enable_seqscan",
  "enable_indexscan",
  "random_page_cost",
] as const;

/** Fields that describe where the session is, not how it behaves: different by nature. */
const IDENTITY = new Set(["captured_at", "backend_pid", "onyx_context"]);

export function parseReport(text: string): ContextReport {
  const trimmed = text.trim();
  // A psql cell may come wrapped in the column name or quotes; take the JSON object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Paste the JSON the diagnostic query returned (it starts with {)");
  const values = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  if (values.onyx_context !== 1) throw new Error("That isn't a Onyx context report (run the diagnostic query on the app's connection)");
  return { values, provenance: Object.fromEntries(Object.keys(values).map((k) => [k, "captured" as Provenance])), capturedAt: typeof values.captured_at === "string" ? values.captured_at : null };
}

export interface ContextDiff {
  field: string;
  app: unknown;
  onyx: unknown;
  appProvenance: Provenance;
  onyxProvenance: Provenance;
  different: boolean;
  /** A dedicated session can take on the app's value. */
  reproducible: boolean;
  /** Expected to differ between any two sessions (pid, capture time). */
  incidental: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffContexts(app: ContextReport, onyx: ContextReport): ContextDiff[] {
  const fields = [...new Set([...Object.keys(app.values), ...Object.keys(onyx.values), ...SUPPLIED_FIELDS])];
  return fields
    .filter((f) => f !== "onyx_context")
    .map((field) => {
      const a = field in app.values ? app.values[field] : undefined;
      const q = field in onyx.values ? onyx.values[field] : undefined;
      const appProvenance = app.provenance[field] ?? "unknown";
      const onyxProvenance = onyx.provenance[field] ?? "unknown";
      const known = appProvenance !== "unknown" && onyxProvenance !== "unknown";
      return {
        field,
        app: a,
        onyx: q,
        appProvenance,
        onyxProvenance,
        different: known && !same(a, q),
        reproducible: (REPRODUCIBLE as readonly string[]).includes(field) || field === "current_user" || field === "transaction_isolation",
        incidental: IDENTITY.has(field),
      };
    });
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * Statements that make a dedicated session look like the app's for the chosen fields. Role
 * changes use SET ROLE, which the server refuses unless Onyx's user may become that role:
 * there is no fallback to a more privileged role.
 */
export function reproduceStatements(diffs: ContextDiff[], chosen: Set<string>): string[] {
  const out: string[] = [];
  for (const d of diffs) {
    if (!chosen.has(d.field) || !d.reproducible || d.app === undefined || d.app === null) continue;
    const value = String(d.app);
    if (d.field === "current_user") out.push(`SET ROLE ${quoteRole(value)}`);
    else if (d.field === "transaction_isolation") out.push(`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${isolation(value)}`);
    else out.push(`SELECT set_config(${lit(d.field)}, ${lit(value)}, false)`);
  }
  return out;
}

function quoteRole(name: string) {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function isolation(level: string) {
  const l = level.toLowerCase();
  if (!["read uncommitted", "read committed", "repeatable read", "serializable"].includes(l)) throw new Error(`Unknown isolation level ${level}`);
  return l.toUpperCase();
}

/** Unqualified table names after FROM / JOIN / UPDATE / INTO, to see what each search_path resolves them to. */
export function unqualifiedTables(sql: string): string[] {
  const clean = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  const out = new Set<string>();
  for (const m of clean.matchAll(/\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*|"[^"]+")/gi)) {
    const name = m[1];
    // Qualified (schema.table) and function calls (generate_series(…)) aren't resolved by search_path lookups here.
    const next = clean.slice(m.index + m[0].length).trimStart()[0];
    if (next === "." || next === "(" || /^(select|lateral|only)$/i.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

/** `to_regclass` for each name: which relation it means under the session's search_path. */
export const resolveSql = (names: string[]) =>
  `SELECT n AS name, coalesce(to_regclass(n)::text, '(not found)') AS resolves_to, coalesce((SELECT nspname FROM pg_namespace ns JOIN pg_class c ON c.relnamespace = ns.oid WHERE c.oid = to_regclass(n)), '') AS schema FROM unnest(ARRAY[${names.map(lit).join(", ")}]::text[]) AS n`;
