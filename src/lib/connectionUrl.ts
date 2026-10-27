import type { ConnectionConfig, Engine, SslMode } from "./ipc";

export const DEFAULTS: Record<Engine, { port: number; user: string; database: string }> = {
  postgres: { port: 5432, user: "postgres", database: "postgres" },
  mysql: { port: 3306, user: "root", database: "" },
  sqlite: { port: 0, user: "", database: "" },
  duckdb: { port: 0, user: "", database: "" },
  sqlserver: { port: 1433, user: "sa", database: "master" },
  clickhouse: { port: 8123, user: "default", database: "default" },
  redis: { port: 6379, user: "", database: "0" },
  mongodb: { port: 27017, user: "", database: "test" },
};

/** postgres://user:password@host:port/database?sslmode=... or mysql://...?ssl-mode=... */
export function parseConnectionUrl(
  text: string,
): (Partial<ConnectionConfig> & { password?: string }) | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const engine: Engine | null =
    url.protocol === "postgres:" || url.protocol === "postgresql:"
      ? "postgres"
      : url.protocol === "mysql:"
        ? "mysql"
        : url.protocol === "redis:" || url.protocol === "rediss:"
          ? "redis"
          : url.protocol === "clickhouse:"
            ? "clickhouse"
            : url.protocol === "sqlserver:" || url.protocol === "mssql:"
              ? "sqlserver"
              : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
                ? "mongodb"
                : null;
  if (!engine) return null;
  // Atlas and replica-set addresses keep their whole form: the MongoDB driver reads it (without the password).
  if (engine === "mongodb" && (url.protocol === "mongodb+srv:" || url.host.includes(","))) {
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    const user = decodeURIComponent(url.username);
    url.username = "";
    url.password = "";
    return {
      engine,
      host: url.toString().replace(/\/$/, ""),
      port: DEFAULTS.mongodb.port,
      user,
      password,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || DEFAULTS.mongodb.database,
      sslMode: url.protocol === "mongodb+srv:" ? "verify-full" : undefined,
    };
  }
  // libpq's sslmode=verify-full, or MySQL's ssl-mode=VERIFY_IDENTITY.
  const sslmode = (url.searchParams.get("sslmode") ?? url.searchParams.get("ssl-mode") ?? "").toLowerCase().replace("_", "-");
  const sslMode: SslMode | undefined = ["verify-full", "verify-ca", "verify-identity"].includes(sslmode)
    ? "verify-full"
    : sslmode === "require" || sslmode === "required"
      ? "require"
      : sslmode === "disable" || sslmode === "disabled"
        ? "disable"
        : ["prefer", "preferred", "allow"].includes(sslmode)
          ? "prefer"
          : undefined;
  return {
    engine,
    host: decodeURIComponent(url.hostname.replace(/^\[|\]$/g, "")),
    port: url.port ? Number(url.port) : DEFAULTS[engine].port,
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || DEFAULTS[engine].database,
    ...(sslMode ? { sslMode } : url.protocol === "rediss:" || url.searchParams.get("tls") === "true" ? { sslMode: "require" as const } : {}),
  };
}
