import { ChevronRight, CircleAlert, CircleCheck, FolderOpen, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULTS, parseConnectionUrl } from "../lib/connectionUrl";
import {
  api,
  ENGINE_LABEL,
  toError,
  type ConnectionConfig,
  type Engine,
  type Environment,
  type HostKeyIssue,
  isFileEngine,
  type SshAuth,
  type SshConfig,
  type SshConfigHost,
  type SslMode,
} from "../lib/ipc";
import { useConnections } from "../store/connections";
import { useUi } from "../store/ui";
import { Button } from "./ui";
import { Select } from "./Select";

const COLORS = ["#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#ec4899", "#14b8a6", "#64748b", "#ef4444"];

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "verify-full", label: "Verify full (encrypted, certificate checked)" },
  { value: "require", label: "Require (encrypted, certificate not checked)" },
  { value: "prefer", label: "Prefer (encrypt if the server supports it)" },
  { value: "disable", label: "Disable (no encryption)" },
];

const isLocalHost = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host.trim());

const DEFAULT_SSH: SshConfig = { host: "", port: 22, user: "", auth: "agent", keyPath: "~/.ssh/id_ed25519" };

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; serverVersion: string }
  | { state: "error"; message: string; hostKey?: HostKeyIssue };

export function ConnectionForm({ editingId, prefill }: { editingId: string | null; prefill?: Partial<ConnectionConfig> }) {
  const existing = useConnections((s) => s.saved.find((c) => c.id === editingId));
  const saved = useConnections((s) => s.saved);
  const folders = useMemo(() => [...new Set(saved.map((c) => c.folder).filter((f): f is string => !!f))], [saved]);
  const [config, setConfig] = useState<ConnectionConfig>(
    () =>
      existing ?? {
        id: crypto.randomUUID(),
        engine: "postgres",
        name: "",
        host: "localhost",
        port: 5432,
        user: "postgres",
        database: "postgres",
        sslMode: "prefer",
        environment: "local",
        color: COLORS[0],
        readOnly: false,
        ssh: null,
        folder: null,
        aiEnabled: false,
        ...prefill,
      },
  );
  const file = isFileEngine(config.engine);
  const [password, setPassword] = useState("");
  const [useSsh, setUseSsh] = useState(Boolean(existing?.ssh));
  const [ssh, setSsh] = useState<SshConfig>(existing?.ssh ?? DEFAULT_SSH);
  const [sshSecret, setSshSecret] = useState("");
  const [sslTouched, setSslTouched] = useState(Boolean(existing));
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = (patch: Partial<ConnectionConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setTest({ state: "idle" });
  };

  /** Swaps engine-specific defaults, keeping anything the user typed. */
  const switchEngine = (engine: Engine) => {
    const from = DEFAULTS[config.engine];
    const to = DEFAULTS[engine];
    update({
      engine,
      port: config.port === from.port ? to.port : config.port,
      user: config.user === from.user ? to.user : config.user,
      database: config.database === from.database ? to.database : config.database,
    });
  };

  const setHost = (host: string) =>
    update({ host, ...(sslTouched ? {} : { sslMode: isLocalHost(host) ? "prefer" : "verify-full" }) });

  const applyUrl = (text: string) => {
    const parsed = parseConnectionUrl(text);
    if (!parsed) return false;
    const { password: urlPassword, ...rest } = parsed;
    update({ ...rest, name: config.name || rest.database || rest.host || "" });
    if (urlPassword) setPassword(urlPassword);
    if (rest.sslMode) setSslTouched(true);
    return true;
  };

  const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([]);
  useEffect(() => {
    if (useSsh) void api.sshConfigHosts().then(setSshHosts, () => setSshHosts([]));
  }, [useSsh]);

  const updateSsh = (patch: Partial<SshConfig>) => {
    setSsh((s) => ({ ...s, ...patch }));
    setTest({ state: "idle" });
  };

  // Editing with an empty secret field keeps the one in the Keychain.
  const passwordArg = () => (existing && password === "" ? undefined : password);
  const sshSecretArg = () => (!useSsh ? "" : existing?.ssh && sshSecret === "" ? undefined : sshSecret);
  const defaultName = file
    ? config.database.split("/").pop() || (config.engine === "duckdb" ? "DuckDB (in memory)" : "SQLite")
    : `${config.database || config.user}@${config.host}`;
  const finalConfig = (): ConnectionConfig => ({
    ...config,
    name: config.name.trim() || defaultName,
    ssh: useSsh && !file ? { ...ssh, keyPath: ssh.auth === "key" ? ssh.keyPath : null } : null,
    folder: config.folder?.trim() || null,
    aiEnabled: config.environment === "prod" ? false : config.aiEnabled,
  });

  const browse = async () => {
    const extensions = config.engine === "duckdb" ? ["duckdb", "db", "ddb"] : ["db", "sqlite", "sqlite3", "db3"];
    const path = await api.pickFile(`Choose a ${ENGINE_LABEL[config.engine]} database`, extensions).catch(() => null);
    if (path) update({ database: path });
  };

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const info = await api.testConnection(finalConfig(), passwordArg(), sshSecretArg());
      setTest({ state: "ok", serverVersion: info.serverVersion });
    } catch (e) {
      const error = toError(e);
      setTest({ state: "error", message: error.message, hostKey: error.hostKey });
    }
  };

  const trustAndTest = async (issue: HostKeyIssue) => {
    try {
      await api.trustSshHost(issue);
      await runTest();
    } catch (e) {
      setTest({ state: "error", message: toError(e).message });
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const store = useConnections.getState();
      await store.save(finalConfig(), passwordArg(), sshSecretArg());
      if (existing) {
        // Settings changed: reconnect on next use.
        if (store.status[config.id]?.state === "connected") await store.disconnect(config.id);
      }
      useUi.getState().showTabs();
      void useConnections.getState().connect(config.id);
    } catch (e) {
      setError(toError(e).message);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    await useConnections.getState().remove(config.id);
    useUi.getState().showTabs();
  };

  const sslWarning = !file && !isLocalHost(config.host) && !useSsh && config.sslMode !== "verify-full";
  const certs = config.sslMode !== "disable" && ["postgres", "mysql", "mongodb"].includes(config.engine);
  const iam = config.engine === "postgres" || config.engine === "mysql";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 pb-8 pt-8">
          <header className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-[17px] font-semibold tracking-tight">{existing ? "Edit connection" : "New connection"}</h1>
              <p className="mt-0.5 text-[12px] text-muted">
                {file ? "A database file on this Mac." : "Passwords are kept in Onyx's encrypted vault."}
              </p>
            </div>
            <span className="size-3 shrink-0 rounded-full ring-4 ring-hover" style={{ background: config.color }} />
          </header>

          <EnginePicker value={config.engine} onChange={switchEngine} />

          <Section title="Connection">
            {!existing && !file && (
              <Field label="Connection URL" hint="Paste one to fill in the fields below.">
                <input
                  className={inputClass}
                  placeholder={URL_EXAMPLES[config.engine] ?? URL_EXAMPLES.postgres}
                  spellCheck={false}
                  onPaste={(e) => {
                    if (applyUrl(e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                  onChange={(e) => applyUrl(e.target.value)}
                />
              </Field>
            )}
            <div className="grid grid-cols-6 gap-3">
              <Field label="Name" className="col-span-6">
                <input className={inputClass} value={config.name} placeholder={defaultName} onChange={(e) => update({ name: e.target.value })} autoFocus />
              </Field>
              {file ? (
                <Field
                  label={config.engine === "duckdb" ? "Database file (optional)" : "Database file"}
                  className="col-span-6"
                  hint={
                    config.engine === "duckdb"
                      ? "Leave empty to query CSV, Parquet and JSON files directly: SELECT * FROM 'data.csv'. Needs the duckdb CLI (brew install duckdb)."
                      : undefined
                  }
                >
                  <div className="flex gap-1.5">
                    <input
                      className={`${inputClass} font-mono`}
                      value={config.database}
                      spellCheck={false}
                      placeholder="~/data/app.db"
                      onChange={(e) => update({ database: e.target.value })}
                    />
                    <Button className="h-8" onClick={() => void browse()}>
                      <FolderOpen className="size-3.5" /> Browse
                    </Button>
                  </div>
                </Field>
              ) : (
                <>
                  <Field
                    label="Host"
                    className="col-span-4"
                    hint={
                      config.engine === "mongodb"
                        ? "Or a whole mongodb+srv:// address (Atlas), without the password."
                        : config.engine === "clickhouse"
                          ? "ClickHouse's HTTP interface: port 8123, or 8443 with SSL."
                          : undefined
                    }
                  >
                    <input className={inputClass} value={config.host} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
                  </Field>
                  <Field label="Port" className="col-span-2">
                    <input
                      className={inputClass}
                      value={config.port}
                      inputMode="numeric"
                      onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                    />
                  </Field>
                  {config.engine === "postgres" && config.port === 3306 && (
                    <p className="col-span-6 -mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                      <CircleAlert className="size-3.5 shrink-0" />
                      Port 3306 is usually MySQL.
                      <button type="button" className="font-medium text-accent hover:underline" onClick={() => switchEngine("mysql")}>
                        Switch to MySQL
                      </button>
                    </p>
                  )}
                  <Field label={["redis", "mongodb"].includes(config.engine) ? "User (optional)" : "User"} className="col-span-2">
                    <input className={inputClass} value={config.user} spellCheck={false} onChange={(e) => update({ user: e.target.value })} />
                  </Field>
                  <Field label={config.awsIam ? "Password (IAM sign-in)" : "Password"} className="col-span-2">
                    <input
                      className={inputClass}
                      type="password"
                      value={password}
                      disabled={!!config.awsIam}
                      placeholder={config.awsIam ? "IAM token" : existing ? "Saved in Keychain" : ""}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setTest({ state: "idle" });
                      }}
                    />
                  </Field>
                  <Field
                    label={config.engine === "redis" ? "Database number" : ["mysql", "sqlserver"].includes(config.engine) ? "Database (optional)" : "Database"}
                    className="col-span-2"
                  >
                    <input
                      className={inputClass}
                      value={config.database}
                      placeholder={DEFAULTS[config.engine].database}
                      spellCheck={false}
                      onChange={(e) => update({ database: e.target.value })}
                    />
                  </Field>
                </>
              )}
            </div>
          </Section>

          {!file && (
            <Section title="Security" description="Encryption and how Onyx signs in.">
              <Field label="SSL">
                <Select
                  className={`${inputClass} w-full`}
                  value={config.sslMode}
                  options={SSL_MODES.map((m) => ({ value: m.value, label: m.label }))}
                  onChange={(sslMode: SslMode) => {
                    setSslTouched(true);
                    update({ sslMode });
                  }}
                />
                {sslWarning && (
                  <p className="mt-1 flex items-center gap-1 text-[12px] text-danger">
                    <CircleAlert className="size-3.5" />
                    {config.sslMode === "disable" ? "Traffic to a remote server will be unencrypted." : "The server's certificate will not be verified."}
                  </p>
                )}
              </Field>
              {certs && (
                <Disclosure title="Certificates" summary={config.sslCa || config.sslCert ? "set" : "CA, client certificate"} initiallyOpen={!!(config.sslCa || config.sslCert)}>
                  {(
                    [
                      ["sslCa", "CA certificate", "Trusted besides the system's and Amazon RDS's"],
                      ["sslCert", config.engine === "mongodb" ? "Client certificate + key" : "Client certificate", ""],
                      ...(config.engine === "mongodb" ? [] : [["sslKey", "Client key", ""]]),
                    ] as ["sslCa" | "sslCert" | "sslKey", string, string][]
                  ).map(([key, label, hint]) => (
                    <label key={key} className="flex items-center gap-2 text-[12px]">
                      <span className="w-40 shrink-0 text-muted" data-tip={hint || undefined}>
                        {label}
                      </span>
                      <input
                        className={`${inputClass} h-7 font-mono text-[11.5px]`}
                        value={config[key] ?? ""}
                        placeholder="~/certs/file.pem"
                        spellCheck={false}
                        onChange={(e) => update({ [key]: e.target.value || null })}
                      />
                      <Button
                        className="h-7"
                        onClick={() => void api.pickFile(`Choose the ${label.toLowerCase()}`, ["pem", "crt", "key", "cer"]).then((p) => p && update({ [key]: p }))}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </label>
                  ))}
                </Disclosure>
              )}
              {iam && (
                <Row title="AWS IAM sign-in" description="Amazon RDS: a short-lived token instead of a password.">
                  <Switch
                    checked={!!config.awsIam}
                    onChange={(on) => update({ awsIam: on ? { profile: null, region: null } : null, ...(on && config.sslMode === "disable" ? { sslMode: "verify-full" } : {}) })}
                  />
                </Row>
              )}
              {iam && config.awsIam && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="AWS profile">
                    <input
                      className={inputClass}
                      value={config.awsIam.profile ?? ""}
                      placeholder="default"
                      spellCheck={false}
                      onChange={(e) => update({ awsIam: { ...config.awsIam, profile: e.target.value || null } })}
                    />
                  </Field>
                  <Field label="Region">
                    <input
                      className={inputClass}
                      value={config.awsIam.region ?? ""}
                      placeholder="From the host name"
                      spellCheck={false}
                      onChange={(e) => update({ awsIam: { ...config.awsIam, region: e.target.value || null } })}
                    />
                  </Field>
                </div>
              )}
            </Section>
          )}

          {!file && (
            <Section
              title="SSH tunnel"
              description="Reach a database behind a bastion host."
              action={
                <Switch
                  checked={useSsh}
                  onChange={(on) => {
                    setUseSsh(on);
                    setTest({ state: "idle" });
                  }}
                />
              }
            >
              {useSsh && (
                <div className="grid grid-cols-6 gap-3">
                  {sshHosts.length > 0 && (
                    <div className="col-span-6 flex items-center gap-2 text-[12px] text-muted">
                      Fill in from ~/.ssh/config
                      <Select<string>
                        value=""
                        placeholder="Choose a host"
                        onChange={(alias) => {
                          const h = sshHosts.find((x) => x.alias === alias);
                          if (!h) return;
                          updateSsh({
                            host: h.hostName,
                            port: h.port ?? 22,
                            ...(h.user ? { user: h.user } : {}),
                            ...(h.identityFile ? { auth: "key", keyPath: h.identityFile } : { auth: "agent" }),
                          });
                        }}
                        options={sshHosts.map((h) => ({ value: h.alias, label: h.alias, hint: `${h.user ? `${h.user}@` : ""}${h.hostName}` }))}
                        className="q-field h-7 w-56 px-2 text-[12px]"
                      />
                    </div>
                  )}
                  <Field label="SSH host" className="col-span-3">
                    <input className={inputClass} value={ssh.host} spellCheck={false} placeholder="bastion.example.com" onChange={(e) => updateSsh({ host: e.target.value })} />
                  </Field>
                  <Field label="Port" className="col-span-1">
                    <input
                      className={inputClass}
                      value={ssh.port}
                      inputMode="numeric"
                      onChange={(e) => updateSsh({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                    />
                  </Field>
                  <Field label="SSH user" className="col-span-2">
                    <input className={inputClass} value={ssh.user} spellCheck={false} placeholder="ec2-user" onChange={(e) => updateSsh({ user: e.target.value })} />
                  </Field>
                  <div className="col-span-6">
                    <Segmented
                      value={ssh.auth}
                      options={[
                        { value: "agent" as SshAuth, label: "ssh-agent" },
                        { value: "key" as SshAuth, label: "Key file" },
                        { value: "password" as SshAuth, label: "Password" },
                      ]}
                      onChange={(auth) => updateSsh({ auth })}
                    />
                  </div>
                  {ssh.auth === "key" && (
                    <>
                      <Field label="Private key" className="col-span-3">
                        <input className={inputClass} value={ssh.keyPath ?? ""} spellCheck={false} onChange={(e) => updateSsh({ keyPath: e.target.value })} />
                      </Field>
                      <Field label="Passphrase (if any)" className="col-span-3">
                        <input
                          className={inputClass}
                          type="password"
                          value={sshSecret}
                          placeholder={existing?.ssh ? "Saved in Keychain" : ""}
                          onChange={(e) => setSshSecret(e.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  {ssh.auth === "password" && (
                    <Field label="SSH password" className="col-span-6">
                      <input
                        className={inputClass}
                        type="password"
                        value={sshSecret}
                        placeholder={existing?.ssh ? "Saved in Keychain" : ""}
                        onChange={(e) => setSshSecret(e.target.value)}
                      />
                    </Field>
                  )}
                  <p className="col-span-6 text-[11.5px] text-faint">
                    The database host and port above are as seen from the SSH server. Host keys are checked against ~/.ssh/known_hosts.
                  </p>
                </div>
              )}
            </Section>
          )}

          <Section title="Options">
            <Row title="Environment" description="Prod connections get a red marker and confirm before writes.">
              <div className="w-64">
                <Segmented
                  value={config.environment}
                  options={(["local", "staging", "prod"] as Environment[]).map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
                  onChange={(env) => update({ environment: env, ...(env === "prod" ? { color: "#ef4444" } : {}) })}
                />
              </div>
            </Row>
            <Row title="Colour" description="Marks this connection's tabs and sidebar.">
              <div className="flex gap-1.5">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => update({ color })}
                    className={`size-[18px] rounded-full transition-transform duration-150 hover:scale-110 ${config.color === color ? "ring-2 ring-fg ring-offset-2 ring-offset-panel" : ""}`}
                    style={{ background: color }}
                  />
                ))}
              </div>
            </Row>
            <Row title="Folder" description="Groups connections on the Connections screen.">
              <input
                className={`${inputClass} w-64`}
                list="connection-folders"
                value={config.folder ?? ""}
                placeholder="None"
                onChange={(e) => update({ folder: e.target.value })}
              />
              <datalist id="connection-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Row>
            <Row
              title="Read-only"
              description={
                ["postgres", "mysql", "clickhouse"].includes(config.engine)
                  ? "The server refuses every write on this connection."
                  : file
                    ? "The file is opened read-only."
                    : "Onyx runs only queries that read."
              }
            >
              <Switch checked={config.readOnly} onChange={(readOnly) => update({ readOnly })} />
            </Row>
            <Row
              title="Natural-language SQL (⇧⌘I)"
              description={
                config.environment === "prod"
                  ? "Always off for prod connections."
                  : "Sends table and column names and types (never rows) to the Claude API with your key from Settings."
              }
            >
              <Switch checked={config.environment !== "prod" && !!config.aiEnabled} disabled={config.environment === "prod"} onChange={(aiEnabled) => update({ aiEnabled })} />
            </Row>
          </Section>
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-panel">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-6 py-3">
          <div className="min-w-0 flex-1 text-[12px]">
            {test.state === "testing" && (
              <span className="flex items-center gap-1.5 text-muted">
                <LoaderCircle className="size-3.5 animate-spin" /> Connecting…
              </span>
            )}
            {test.state === "ok" && (
              <span className="flex items-center gap-1.5 text-success">
                <CircleCheck className="size-3.5" /> Connected · {ENGINE_LABEL[config.engine]} {test.serverVersion}
              </span>
            )}
            {test.state === "error" && (
              <span className="flex flex-col items-start gap-1.5">
                <span className="line-clamp-3 select-text text-danger" title={test.message}>
                  {test.message}
                </span>
                {test.hostKey && !test.hostKey.changed && (
                  <Button onClick={() => void trustAndTest(test.hostKey!)}>
                    <ShieldCheck className="size-3.5" /> Trust this host key and test again
                  </Button>
                )}
              </span>
            )}
            {error && <span className="line-clamp-3 text-danger">{error}</span>}
          </div>
          {existing && (
            <Button variant="danger" onClick={() => void remove()} onBlur={() => setConfirmDelete(false)}>
              {confirmDelete ? "Click again to delete" : "Delete"}
            </Button>
          )}
          <Button onClick={() => useUi.getState().showTabs()}>Cancel</Button>
          <Button onClick={() => void runTest()} disabled={test.state === "testing"}>
            Test
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {existing ? "Save" : "Save and connect"}
          </Button>
        </div>
      </footer>
    </form>
  );
}

const ENGINES: Engine[] = ["postgres", "mysql", "sqlite", "duckdb", "sqlserver", "clickhouse", "mongodb", "redis"];
const ENGINE_HINT: Record<Engine, string> = {
  postgres: "Server",
  mysql: "Server",
  sqlite: "File",
  duckdb: "File · analytics",
  sqlserver: "Server",
  clickhouse: "Analytics",
  mongodb: "Documents",
  redis: "Key-value",
};

/** The engine, as a grid of cards. */
function EnginePicker({ value, onChange }: { value: Engine; onChange(engine: Engine): void }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {ENGINES.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          className={`flex flex-col items-start rounded-[10px] border px-3 py-2 text-left transition-colors duration-150 ${
            value === e ? "border-accent bg-accent-soft" : "border-border bg-panel hover:border-border-strong hover:bg-hover"
          }`}
        >
          <span className={`text-[12.5px] font-medium ${value === e ? "text-fg" : ""}`}>{ENGINE_LABEL[e]}</span>
          <span className="text-[11px] text-faint">{ENGINE_HINT[e]}</span>
        </button>
      ))}
    </div>
  );
}

function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  const empty = !children || (Array.isArray(children) && children.every((c) => !c));
  return (
    <section className="rounded-xl border border-border bg-panel">
      <div className={`flex items-center gap-3 px-4 pt-3 ${empty ? "pb-3" : "pb-1"}`}>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12.5px] font-semibold">{title}</h2>
          {description && <p className="text-[11.5px] text-faint">{description}</p>}
        </div>
        {action}
      </div>
      {!empty && <div className="flex flex-col gap-3 px-4 pb-4 pt-2">{children}</div>}
    </section>
  );
}

/** A setting on one line: its name and description on the left, the control on the right. */
function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px]">{title}</div>
        {description && <div className="text-[11.5px] text-faint">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function Disclosure({ title, summary, initiallyOpen, children }: { title: string; summary: string; initiallyOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-8 w-full items-center gap-1.5 px-3 text-[12px] hover:bg-hover">
        <ChevronRight className={`size-3.5 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        {title}
        <span className="text-faint">{summary}</span>
      </button>
      {open && <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">{children}</div>}
    </div>
  );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange(on: boolean): void; disabled?: boolean }) {
  return <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className={`q-switch ${disabled ? "opacity-50" : ""}`} />;
}

const URL_EXAMPLES: Partial<Record<Engine, string>> = {
  postgres: "postgres://user:password@host:5432/database",
  mysql: "mysql://user:password@host:3306/database",
  sqlserver: "sqlserver://user:password@host:1433/database",
  clickhouse: "clickhouse://default:password@host:8123/default",
  mongodb: "mongodb+srv://user:password@cluster0.example.mongodb.net/database",
  redis: "redis://:password@host:6379/0",
};

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    // Many options wrap into rows of four.
    <div className={`q-seg ${options.length > 4 ? "!grid grid-cols-4 !rounded-[12px]" : "w-full"}`}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className="flex-1">
          {o.label}
        </button>
      ))}
    </div>
  );
}

const inputClass =
  "q-field h-8 w-full px-2.5 text-[12.5px]";

function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}
