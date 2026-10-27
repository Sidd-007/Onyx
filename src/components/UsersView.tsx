import { KeyRound, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, toError, type ConnectionConfig } from "../lib/ipc";
import { executeStatement } from "../store/actions";
import { isConnected, useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button, IconButton } from "./ui";

type Rows = { columns: string[]; rows: (string | null)[][] };
interface Account {
  /** `name` (Postgres) or `'user'@'host'` (MySQL), as SQL. */
  sql: string;
  name: string;
  host?: string;
  badges: string[];
}
interface Grant {
  /** What it covers, as shown. */
  scope: string;
  privileges: string;
  /** The statement that takes it away. */
  revoke: string;
}

const sqlString = (v: string, mysql: boolean) => `'${(mysql ? v.replace(/\\/g, "\\\\") : v).replace(/'/g, "''")}'`;
const pgIdent = (v: string) => `"${v.replace(/"/g, '""')}"`;
const myIdent = (v: string) => `\`${v.replace(/`/g, "``")}\``;
const truthy = (v: string | null) => v === "t" || v === "true" || v === "1" || v === "Y";

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALL PRIVILEGES"];

/** Database users and roles with their grants: create, grant, revoke, drop. Postgres and MySQL. */
export default function UsersView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const connected = useConnections((s) => isConnected(s.status[tab.connectionId]));
  if (!connection) return null;
  if (connection.engine !== "postgres" && connection.engine !== "mysql") {
    return <p className="p-6 text-center text-[12px] text-muted">Users and permissions are for Postgres and MySQL.</p>;
  }
  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-muted">
        Not connected to {connection.name}.
        <Button variant="primary" onClick={() => void useConnections.getState().connect(connection.id)}>
          Connect
        </Button>
      </div>
    );
  }
  return <Users connection={connection} />;
}

function Users({ connection }: { connection: ConnectionConfig }) {
  const mysql = connection.engine === "mysql";
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picked, setPicked] = useState<Account | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "grant" | "password" | null>(null);
  const [filter, setFilter] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const sql = mysql
        ? "SELECT User AS user, Host AS host, plugin, account_locked AS locked, password_expired AS expired FROM mysql.user ORDER BY User, Host"
        : `SELECT r.rolname AS name, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
             array_to_string(ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON m.roleid = b.oid WHERE m.member = r.oid), ', ') AS member_of
           FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY 1`;
      const { rows }: Rows = await api.adminQuery(connection.id, sql);
      setAccounts(
        rows.map((r) =>
          mysql
            ? {
                sql: `${sqlString(r[0] ?? "", true)}@${sqlString(r[1] ?? "", true)}`,
                name: r[0] ?? "",
                host: r[1] ?? "",
                badges: [r[2] ?? "", truthy(r[3]) ? "locked" : "", truthy(r[4]) ? "password expired" : ""].filter(Boolean),
              }
            : {
                sql: pgIdent(r[0] ?? ""),
                name: r[0] ?? "",
                badges: [
                  truthy(r[1]) ? "login" : "role",
                  truthy(r[2]) ? "superuser" : "",
                  truthy(r[3]) ? "create db" : "",
                  truthy(r[4]) ? "create role" : "",
                  r[5] ? `in ${r[5]}` : "",
                ].filter(Boolean),
              },
        ),
      );
      setError(null);
    } catch (e) {
      setError(toError(e).message);
    }
  }, [connection.id, mysql]);

  const loadGrants = useCallback(
    async (a: Account) => {
      setGrants(null);
      try {
        if (mysql) {
          const { rows } = await api.adminQuery(connection.id, `SHOW GRANTS FOR ${a.sql}`);
          setGrants(
            rows.map((r) => {
              const line = r[0] ?? "";
              const m = /^GRANT (.+?) ON (.+?) TO /i.exec(line);
              return {
                scope: m?.[2] ?? line,
                privileges: m?.[1] ?? "",
                revoke: m ? `REVOKE ${m[1]} ON ${m[2]} FROM ${a.sql}` : "",
              };
            }),
          );
        } else {
          const name = sqlString(a.name, false);
          const { rows } = await api.adminQuery(
            connection.id,
            `SELECT table_schema, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type)
             FROM information_schema.role_table_grants WHERE grantee = ${name} GROUP BY 1, 2 ORDER BY 1, 2`,
          );
          const schemas = await api.adminQuery(
            connection.id,
            `SELECT nspname, has_schema_privilege(${name}, nspname, 'USAGE'), has_schema_privilege(${name}, nspname, 'CREATE')
             FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`,
          );
          setGrants([
            ...schemas.rows
              .filter((r) => truthy(r[1]) || truthy(r[2]))
              .map((r) => {
                const privs = [truthy(r[1]) && "USAGE", truthy(r[2]) && "CREATE"].filter(Boolean).join(", ");
                return { scope: `schema ${r[0]}`, privileges: privs, revoke: `REVOKE ${privs} ON SCHEMA ${pgIdent(r[0] ?? "")} FROM ${a.sql}` };
              }),
            ...rows.map((r) => ({
              scope: `${r[0]}.${r[1]}`,
              privileges: r[2] ?? "",
              revoke: `REVOKE ${r[2]} ON ${pgIdent(r[0] ?? "")}.${pgIdent(r[1] ?? "")} FROM ${a.sql}`,
            })),
          ]);
        }
      } catch (e) {
        setGrants([]);
        toast(toError(e).message, "error");
      }
    },
    [connection.id, mysql],
  );

  useEffect(() => void loadAccounts(), [loadAccounts]);
  useEffect(() => {
    if (picked) void loadGrants(picked);
  }, [picked, loadGrants]);

  /** Runs account statements: confirmed in a dialog, never recorded in history (they can hold passwords). */
  const run = (title: string, statement: string, shown = statement, after?: () => void) =>
    useOverlays.getState().askDanger({
      title,
      statement: shown,
      connectionName: connection.name,
      prod: connection.environment === "prod",
      action: "Run",
      run: async () => {
        const failed = await executeStatement(connection.id, statement, null, false);
        if (failed) return toast(failed.message, "error");
        toast("Done", "success");
        await loadAccounts();
        after?.();
      },
    });

  const visible = (accounts ?? []).filter((a) => !filter || `${a.name}@${a.host ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-1 p-2">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={mysql ? "Filter users" : "Filter roles"} className="q-field h-7 min-w-0 flex-1 px-2 text-[12px]" />
          <IconButton title="Refresh" onClick={() => void loadAccounts()}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          {!connection.readOnly && (
            <IconButton title={mysql ? "New user" : "New role"} onClick={() => setDialog("create")}>
              <Plus className="size-3.5" />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {error && <p className="px-2 py-1 text-[12px] text-danger">{error}</p>}
          {!accounts && !error && <LoaderCircle className="mx-auto mt-4 size-4 animate-spin text-muted" />}
          {visible.map((a) => (
            <button
              key={a.sql}
              type="button"
              onClick={() => setPicked(a)}
              className={`flex w-full flex-col items-start gap-1 rounded-lg px-2.5 py-2 text-left ${picked?.sql === a.sql ? "bg-selected" : "hover:bg-hover"}`}
            >
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                <UserRound className="size-3.5 text-muted" />
                {a.name}
                {a.host && <span className="font-normal text-faint">@{a.host}</span>}
              </span>
              <span className="flex flex-wrap gap-1">
                {a.badges.map((b) => (
                  <span key={b} className={`rounded-full px-1.5 text-[10px] ${b === "superuser" ? "bg-warning-soft text-warning" : "bg-input text-muted"}`}>
                    {b}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!picked ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted">Pick a {mysql ? "user" : "role"} to see what it can do.</div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <ShieldCheck className="size-4 text-accent" />
              <h2 className="font-semibold">
                {picked.name}
                {picked.host && <span className="font-normal text-muted">@{picked.host}</span>}
              </h2>
              <span className="flex-1" />
              {!connection.readOnly && (
                <>
                  <Button onClick={() => setDialog("grant")}>
                    <Plus className="size-3.5" /> Grant
                  </Button>
                  <Button onClick={() => setDialog("password")}>
                    <KeyRound className="size-3.5" /> Set password
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      run(`Drop ${picked.name}?`, mysql ? `DROP USER ${picked.sql}` : `DROP ROLE ${picked.sql}`, undefined, () => setPicked(null))
                    }
                  >
                    <Trash2 className="size-3.5" /> Drop
                  </Button>
                </>
              )}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!grants ? (
                <LoaderCircle className="size-4 animate-spin text-muted" />
              ) : grants.length === 0 ? (
                <p className="text-[12px] text-muted">No grants.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border">
                  {grants.map((g, i) => (
                    <div key={i} className="group flex items-center gap-3 border-b border-border px-3 py-2 text-[12px] last:border-0">
                      <span className="w-56 shrink-0 truncate font-mono text-muted" data-tip={g.scope}>
                        {g.scope}
                      </span>
                      <span className="min-w-0 flex-1 font-mono">{g.privileges}</span>
                      {g.revoke && !connection.readOnly && (
                        <Button variant="danger" className="h-6 opacity-0 group-hover:opacity-100" onClick={() => run("Revoke this grant?", g.revoke, undefined, () => void loadGrants(picked))}>
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {dialog === "create" && (
        <CreateDialog
          mysql={mysql}
          onCancel={() => setDialog(null)}
          onCreate={(sql, shown) => {
            setDialog(null);
            run(mysql ? "Create this user?" : "Create this role?", sql, shown);
          }}
        />
      )}
      {dialog === "password" && picked && (
        <PasswordDialog
          onCancel={() => setDialog(null)}
          onSet={(password) => {
            setDialog(null);
            const sql = mysql ? `ALTER USER ${picked.sql} IDENTIFIED BY ${sqlString(password, true)}` : `ALTER ROLE ${picked.sql} WITH PASSWORD ${sqlString(password, false)}`;
            run(`Set ${picked.name}'s password?`, sql, sql.replace(/'(?:[^']|'')*'$/, "'••••••••'"));
          }}
        />
      )}
      {dialog === "grant" && picked && (
        <GrantDialog
          connection={connection}
          account={picked}
          onCancel={() => setDialog(null)}
          onGrant={(sql) => {
            setDialog(null);
            run("Grant this?", sql, sql, () => void loadGrants(picked));
          }}
        />
      )}
    </div>
  );
}

function CreateDialog({ mysql, onCancel, onCreate }: { mysql: boolean; onCancel(): void; onCreate(sql: string, shown: string): void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [login, setLogin] = useState(true);
  const [createdb, setCreatedb] = useState(false);
  const build = (pw: string) =>
    mysql
      ? `CREATE USER ${sqlString(name, true)}@${sqlString(host, true)}${pw ? ` IDENTIFIED BY ${sqlString(pw, true)}` : ""}`
      : `CREATE ROLE ${pgIdent(name)} WITH ${login ? "LOGIN" : "NOLOGIN"}${createdb ? " CREATEDB" : ""}${pw ? ` PASSWORD ${sqlString(pw, false)}` : ""}`;
  return (
    <Modal onClose={onCancel} width="max-w-md">
      <form
        className="flex flex-col gap-3 p-5 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(build(password), build(password ? "••••••••" : ""));
        }}
      >
        <h2 className="text-[13px] font-semibold">{mysql ? "New user" : "New role"}</h2>
        <div className="flex gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="q-field h-8 min-w-0 flex-1 px-2.5" spellCheck={false} />
          {mysql && <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host" className="q-field h-8 w-28 px-2.5" data-tip="% means any host" spellCheck={false} />}
        </div>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" className="q-field h-8 px-2.5" autoComplete="new-password" />
        {!mysql && (
          <div className="flex gap-4 text-muted">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} /> Can log in
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={createdb} onChange={(e) => setCreatedb(e.target.checked)} /> Can create databases
            </label>
          </div>
        )}
        <pre className="select-text overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11.5px] text-muted">{build(password ? "••••••••" : "")}</pre>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            Review
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ onCancel, onSet }: { onCancel(): void; onSet(password: string): void }) {
  const [password, setPassword] = useState("");
  return (
    <Modal onClose={onCancel} width="max-w-sm">
      <form
        className="flex flex-col gap-3 p-5 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSet(password);
        }}
      >
        <h2 className="text-[13px] font-semibold">New password</h2>
        <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="q-field h-8 px-2.5" autoComplete="new-password" />
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!password}>
            Review
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function GrantDialog({ connection, account, onCancel, onGrant }: { connection: ConnectionConfig; account: Account; onCancel(): void; onGrant(sql: string): void }) {
  const mysql = connection.engine === "mysql";
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState("*");
  const [privileges, setPrivileges] = useState<string[]>(["SELECT"]);
  useEffect(() => {
    void api.listSchemas(connection.id).then((s) => {
      setSchemas(s);
      setSchema((cur) => cur || s[0] || "");
    });
  }, [connection.id]);
  useEffect(() => {
    if (!schema) return;
    void api.listObjects(connection.id, schema).then((o) => setTables(o.filter((x) => x.kind === "table" || x.kind === "view").map((x) => x.name)));
  }, [connection.id, schema]);
  const all = privileges.includes("ALL PRIVILEGES");
  const privs = all ? "ALL PRIVILEGES" : privileges.join(", ");
  const sql = useMemo(() => {
    if (mysql) return `GRANT ${privs} ON ${myIdent(schema)}.${table === "*" ? "*" : myIdent(table)} TO ${account.sql}`;
    const on = table === "*" ? `ALL TABLES IN SCHEMA ${pgIdent(schema)}` : `${pgIdent(schema)}.${pgIdent(table)}`;
    return `GRANT ${privs} ON ${on} TO ${account.sql}`;
  }, [mysql, privs, schema, table, account.sql]);
  return (
    <Modal onClose={onCancel} width="max-w-lg">
      <div className="flex flex-col gap-3 p-5 text-[12px]">
        <h2 className="text-[13px] font-semibold">Grant to {account.name}</h2>
        <div className="flex gap-2">
          <Select value={schema} placeholder={mysql ? "database" : "schema"} onChange={setSchema} options={schemas.map((s) => ({ value: s, label: s }))} className="q-field h-8 w-44 px-2.5" />
          <Select
            value={table}
            onChange={setTable}
            options={[{ value: "*", label: mysql ? "every table (*)" : "every table" }, ...tables.map((t) => ({ value: t, label: t }))]}
            className="q-field h-8 min-w-0 flex-1 px-2.5"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRIVILEGES.map((p) => {
            const on = privileges.includes(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => setPrivileges((ps) => (p === "ALL PRIVILEGES" ? (on ? ["SELECT"] : [p]) : on ? ps.filter((x) => x !== p) : [...ps.filter((x) => x !== "ALL PRIVILEGES"), p]))}
                className={`h-7 rounded-md px-2.5 font-mono text-[11.5px] ${on ? "bg-accent text-accent-fg" : "bg-input text-muted hover:text-fg"}`}
              >
                {p}
              </button>
            );
          })}
        </div>
        {!mysql && table === "*" && <p className="text-[11.5px] text-faint">Covers the tables that exist now; also grant USAGE on the schema so the role can reach them.</p>}
        <pre className="select-text overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11.5px]">{sql}</pre>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!schema || !privileges.length} onClick={() => onGrant(sql)}>
            Review
          </Button>
        </div>
      </div>
    </Modal>
  );
}
