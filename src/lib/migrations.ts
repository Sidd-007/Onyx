/** Migration files in the IDE folder: `migrations/<version>_<name>.up.sql` and `.down.sql`. */

export const MIGRATIONS_DIR = "migrations";

export interface MigrationFile {
  version: string;
  up: string;
  down: string | null;
}

export function migrationFiles(paths: string[]): MigrationFile[] {
  const set = new Set(paths);
  return paths
    .filter((p) => p.startsWith(`${MIGRATIONS_DIR}/`) && p.endsWith(".up.sql") && !p.slice(MIGRATIONS_DIR.length + 1).includes("/"))
    .map((up) => {
      const version = up.slice(MIGRATIONS_DIR.length + 1, -".up.sql".length);
      const down = up.replace(/\.up\.sql$/, ".down.sql");
      return { version, up, down: set.has(down) ? down : null };
    })
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/** `20261023142501_sync_public`: sorts in creation order. */
export function newVersion(label: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50) || "migration";
  return `${stamp}_${slug}`;
}

/** Statements as a file: commented-out ones (drops) stay comments. */
export const scriptOf = (statements: string[]) => (statements.length ? `${statements.map((s) => (s.startsWith("--") ? s : `${s};`)).join("\n\n")}\n` : "");
