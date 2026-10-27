import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openQueryTab, openSql } from "../store/actions";
import { useConnections } from "../store/connections";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import type { ConnectionConfig, Engine } from "./ipc";

const SQLITE = /\.(db|sqlite|sqlite3|db3)$/i;
const DUCKDB = /\.(duckdb|ddb)$/i;
const DATA_FILE = /\.(csv|tsv|parquet|json|jsonl|ndjson)$/i;

const basename = (path: string) => path.split("/").pop() ?? path;

function fileConnection(engine: Engine, path: string, name: string): ConnectionConfig {
  return {
    id: crypto.randomUUID(),
    engine,
    name,
    host: "localhost",
    port: 0,
    user: "",
    database: path,
    sslMode: "disable",
    environment: "local",
    // Connection colours are the user's to pick; dropped files start neutral.
    color: "#8b8b93",
    readOnly: false,
    ssh: null,
    folder: "Files",
    aiEnabled: false,
  };
}

/** Saves (or reuses) a connection for a database file, connects, and opens a query tab. */
export async function openDatabaseFile(path: string) {
  const engine: Engine = DUCKDB.test(path) ? "duckdb" : "sqlite";
  const store = useConnections.getState();
  let connection = store.saved.find((c) => c.engine === engine && c.database === path);
  if (!connection) {
    connection = fileConnection(engine, path, basename(path));
    await store.save(connection);
  }
  useUi.getState().setSidebarConnection(connection.id);
  if (await useConnections.getState().connect(connection.id)) openQueryTab(connection.id);
  else useUi.getState().showConnections();
}

/** CSV, Parquet and JSON files are queried with DuckDB, in memory. */
async function queryDataFile(path: string) {
  const store = useConnections.getState();
  let connection = store.saved.find((c) => c.engine === "duckdb" && c.database === "");
  if (!connection) {
    connection = fileConnection("duckdb", "", "DuckDB (files)");
    await store.save(connection);
  }
  if (!(await useConnections.getState().connect(connection.id))) {
    const status = useConnections.getState().status[connection.id];
    toast(status?.state === "error" ? status.error.message : "Couldn't start DuckDB", "error");
    return;
  }
  openSql(`SELECT * FROM '${path.replace(/'/g, "''")}' LIMIT 1000;`, connection.id, { title: basename(path) });
}

/** Database and data files dropped on the window open right away. */
export function listenForDroppedFiles(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  const unlisten = getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    for (const path of event.payload.paths) {
      if (SQLITE.test(path) || DUCKDB.test(path)) void openDatabaseFile(path).catch((e) => toast(String(e?.message ?? e), "error"));
      else if (DATA_FILE.test(path)) void queryDataFile(path).catch((e) => toast(String(e?.message ?? e), "error"));
      else toast(`Onyx opens SQLite, DuckDB, CSV, Parquet and JSON files, not ${basename(path)}`, "error");
    }
  });
  return () => void unlisten.then((stop) => stop());
}
