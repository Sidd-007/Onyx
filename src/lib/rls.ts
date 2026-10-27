/**
 * F14: why can (or can't) an identity see rows? The evidence (grants, RLS flags, policies,
 * bypass conditions) is read from the catalog; the answer comes from actually running the
 * query as that identity inside a transaction that's always rolled back.
 */

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const roleIdent = (r: string) => (/^[a-z_][a-z0-9_]*$/.test(r) ? r : `"${r.replace(/"/g, '""')}"`);

/** Grants, RLS flags, owner and bypass for each role on `schema.table`. Read-only catalog queries. */
export function evidenceSql(schema: string, table: string, roles: string[]): string {
  const rel = lit(`${roleIdent(schema)}.${roleIdent(table)}`);
  return `SELECT r.rolname AS role,
  has_table_privilege(r.rolname, ${rel}, 'SELECT') AS can_select,
  has_table_privilege(r.rolname, ${rel}, 'INSERT') AS can_insert,
  has_table_privilege(r.rolname, ${rel}, 'UPDATE') AS can_update,
  has_table_privilege(r.rolname, ${rel}, 'DELETE') AS can_delete,
  r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
  pg_has_role(r.rolname, c.relowner, 'USAGE') AS acts_as_owner,
  c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
  pg_get_userbyid(c.relowner) AS owner,
  pg_has_role(current_user, r.oid, 'MEMBER') AS onyx_can_become
FROM pg_roles r, pg_class c
WHERE c.oid = ${rel}::regclass AND r.rolname = ANY (ARRAY[${roles.map(lit).join(", ")}]::name[])
ORDER BY r.rolname`;
}

export const policiesSql = (schema: string, table: string) =>
  `SELECT policyname, permissive, array_to_string(roles, ', ') AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = ${lit(schema)} AND tablename = ${lit(table)} ORDER BY policyname`;

export interface RoleEvidence {
  role: string;
  canSelect: boolean;
  superuser: boolean;
  bypassRls: boolean;
  actsAsOwner: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
  onyxCanBecome: boolean;
}

export function readEvidence(columns: string[], row: (string | null)[]): RoleEvidence {
  const get = (c: string) => row[columns.indexOf(c)];
  const b = (c: string) => get(c) === "t" || get(c) === "true";
  return { role: get("role") ?? "", canSelect: b("can_select"), superuser: b("superuser"), bypassRls: b("bypass_rls"), actsAsOwner: b("acts_as_owner"), rlsEnabled: b("rls_enabled"), rlsForced: b("rls_forced"), onyxCanBecome: b("onyx_can_become") };
}

/** Whether row policies apply to this identity at all (PostgreSQL's rules). */
export function policyApplies(e: RoleEvidence): { applies: boolean; why: string } {
  if (!e.rlsEnabled) return { applies: false, why: "Row-level security is off for this table: every row the grants allow is visible." };
  if (e.superuser) return { applies: false, why: "A superuser: bypasses row-level security entirely." };
  if (e.bypassRls) return { applies: false, why: "Has BYPASSRLS: policies don't apply to this role." };
  if (e.actsAsOwner && !e.rlsForced) return { applies: false, why: "Owns the table (or acts as its owner) and RLS isn't FORCEd: policies don't apply to it." };
  return { applies: true, why: "Policies apply: rows are visible only where a permissive policy allows (and every restrictive one does)." };
}

/** The statements that make a transaction act as `role` (with Supabase-style JWT claims). Always followed by ROLLBACK. */
export function asIdentity(role: string, claims: string): string[] {
  const out = ["BEGIN", `SET LOCAL ROLE ${roleIdent(role)}`];
  if (claims.trim()) {
    out.push(`SELECT set_config('request.jwt.claims', ${lit(claims.trim())}, true)`);
    try {
      const c = JSON.parse(claims) as Record<string, unknown>;
      for (const k of ["sub", "role", "email"]) if (typeof c[k] === "string") out.push(`SELECT set_config('request.jwt.claim.${k}', ${lit(c[k] as string)}, true)`);
    } catch {
      throw new Error("Claims must be a JSON object");
    }
  }
  return out;
}

export interface Expectation {
  /** allow: at least `n` rows visible; deny-rows: no rows visible; deny-privilege: no SELECT grant at all. */
  kind: "allow" | "deny-rows" | "deny-privilege" | "exact";
  n: number;
}

export type Outcome = { kind: "rows"; count: number } | { kind: "no-privilege"; message: string } | { kind: "error"; message: string };

export function classify(error: string | null, count: number | null): Outcome {
  if (error) return /permission denied/i.test(error) ? { kind: "no-privilege", message: error } : { kind: "error", message: error };
  return { kind: "rows", count: count ?? 0 };
}

export function passes(e: Expectation, o: Outcome): boolean {
  switch (e.kind) {
    case "deny-privilege":
      return o.kind === "no-privilege";
    case "deny-rows":
      return o.kind === "rows" && o.count === 0;
    case "allow":
      return o.kind === "rows" && o.count >= Math.max(1, e.n);
    case "exact":
      return o.kind === "rows" && o.count === e.n;
  }
}
