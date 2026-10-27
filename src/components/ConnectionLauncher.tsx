import { CircleAlert, FileUp, Folder, LoaderCircle, Plus, Search, Settings2, ShieldCheck, Unplug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { openDatabaseFile } from "../lib/dropFiles";
import { api, ENGINE_LABEL, isFileEngine, type ConnectionConfig } from "../lib/ipc";
import { useConnections } from "../store/connections";
import { useUi } from "../store/ui";
import { EnvBadge, IconButton } from "./ui";

/** A card per saved connection, grouped by folder: click to connect, drag to reorder. */
export function ConnectionLauncher({ closable }: { closable?: boolean }) {
  const saved = useConnections((s) => s.saved);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    if (!closable) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useUi.getState().showTabs();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable]);

  const q = search.trim().toLowerCase();
  const shown = saved.filter(
    (c) => !q || [c.name, c.host, c.database, c.folder ?? "", ENGINE_LABEL[c.engine]].some((v) => v.toLowerCase().includes(q)),
  );
  const folders = [...new Set(shown.map((c) => c.folder ?? ""))].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  /** Moves the dragged card before `target` (or to the end of `folder`), into that folder. */
  const drop = async (folder: string, target?: string) => {
    const id = dragging;
    setDragging(null);
    if (!id || id === target) return;
    const moved = saved.find((c) => c.id === id);
    if (!moved) return;
    const store = useConnections.getState();
    if ((moved.folder ?? "") !== folder) await store.save({ ...moved, folder: folder || null });
    const ids = saved.map((c) => c.id).filter((x) => x !== id);
    const at = target ? ids.indexOf(target) : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, id);
    await api.reorderConnections(ids);
    await store.load();
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <header className="flex items-center gap-2">
          <div className="flex-1">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Connections</h1>
            <p className="mt-0.5 text-[12px] text-muted">
              {saved.length ? "Choose a database to connect to. Drag cards to reorder them or move them into a folder." : "Add your first database to get started."}
            </p>
          </div>
          <IconButton title="Open a SQLite or DuckDB file" shortcut="⌘O" onClick={() => void openFile()}>
            <FileUp className="size-3.5" />
          </IconButton>
          {closable && (
            <IconButton title="Close" shortcut="Esc" onClick={() => useUi.getState().showTabs()}>
              <X className="size-3.5" />
            </IconButton>
          )}
        </header>
        {saved.length > 6 && (
          <label className="q-field flex h-7 items-center gap-1.5 px-2">
            <Search className="size-3.5 text-faint" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search connections"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
          </label>
        )}
        {folders.map((folder) => (
          <section
            key={folder || "-"}
            className="flex flex-col gap-2"
            onDragOver={(e) => dragging && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void drop(folder);
            }}
          >
            {(folder || folders.length > 1) && (
              <h2 className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
                <Folder className="size-3" /> {folder || "No folder"}
              </h2>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
              {shown
                .filter((c) => (c.folder ?? "") === folder)
                .map((c) => (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(c.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => dragging && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void drop(folder, c.id);
                    }}
                    className={dragging === c.id ? "opacity-40" : ""}
                  >
                    <ConnectionCard config={c} />
                  </div>
                ))}
              {folder === "" && (
                <button
                  type="button"
                  onClick={() => useUi.getState().newConnection()}
                  className="flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-border text-[12px] text-muted transition-colors duration-100 hover:border-border-strong hover:text-fg"
                >
                  <Plus className="size-4" />
                  New connection
                </button>
              )}
            </div>
          </section>
        ))}
        {folders.length === 0 && (
          <p className="py-6 text-center text-[12px] text-muted">{q ? "No connections match." : ""}</p>
        )}
        {folders.length > 0 && !folders.includes("") && (
          <button
            type="button"
            onClick={() => useUi.getState().newConnection()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-border text-[12px] text-muted hover:border-border-strong hover:text-fg"
          >
            <Plus className="size-4" /> New connection
          </button>
        )}
      </div>
    </div>
  );
}

async function openFile() {
  const path = await api.pickFile("Open a SQLite or DuckDB database", ["db", "sqlite", "sqlite3", "db3", "duckdb", "ddb"]).catch(() => null);
  if (path) await openDatabaseFile(path);
}

function ConnectionCard({ config }: { config: ConnectionConfig }) {
  const status = useConnections((s) => s.status[config.id]) ?? { state: "disconnected" as const };
  const [trusting, setTrusting] = useState(false);
  const connected = status.state === "connected";
  const hostKey = status.state === "error" ? status.error.hostKey : undefined;

  const open = async () => {
    if (status.state === "connecting") return;
    if (connected || (await useConnections.getState().connect(config.id))) {
      // Connected: back to work, with the database in the sidebar.
      useUi.getState().setSidebarConnection(config.id);
      useUi.getState().showTabs();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void open()}
      onKeyDown={(e) => e.key === "Enter" && void open()}
      className={`group relative flex min-h-[92px] cursor-default flex-col gap-1 rounded-[12px] border p-3.5 text-left outline-none transition-colors duration-[120ms] hover:bg-hover focus-visible:border-fg ${
        status.state === "error" ? "border-danger/40" : "border-border"
      }`}
    >
      {config.environment === "prod" && <span className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-danger" />}
      <div className="flex items-center gap-1.5 pr-12">
        <span className="truncate text-[13px] font-medium">{config.name}</span>
        <EnvBadge environment={config.environment} />
      </div>
      <p
        className="truncate font-mono text-[10.5px] text-faint"
        data-tip={isFileEngine(config.engine) ? config.database || "In memory" : `${config.user}@${config.host}:${config.port}`}
      >
        {ENGINE_LABEL[config.engine]} ·{" "}
        {isFileEngine(config.engine) ? config.database.split("/").pop() || "in memory" : config.host}
        {config.ssh && " · SSH"}
      </p>
      <div className="mt-auto pt-1 font-mono text-[10px] uppercase tracking-[0.1em]">
        {status.state === "connecting" && (
          <span className="flex items-center gap-1.5 text-muted">
            <LoaderCircle className="size-3 animate-spin" /> Connecting…
          </span>
        )}
        {connected && (
          <span className="flex items-center gap-1.5 text-fg">
            <span className="size-1.5 rounded-full bg-fg" /> Connected
          </span>
        )}
        {status.state === "disconnected" && <span className="text-muted">Idle · click to connect</span>}
        {status.state === "error" && (
          <span className="flex flex-col items-start gap-1 font-sans text-[11px] normal-case tracking-normal">
            <span className="line-clamp-2 select-text text-danger" data-tip={status.error.message}>
              <CircleAlert className="mr-1 inline size-3" />
              {status.error.message}
            </span>
            {hostKey && !hostKey.changed && (
              <button
                type="button"
                disabled={trusting}
                className="flex items-center gap-1 font-medium text-accent hover:underline"
                onClick={async (e) => {
                  e.stopPropagation();
                  setTrusting(true);
                  await useConnections.getState().trustHostAndConnect(config.id, hostKey);
                  setTrusting(false);
                }}
              >
                <ShieldCheck className="size-3" /> Trust host key and connect
              </button>
            )}
          </span>
        )}
      </div>
      <div className="absolute right-2 top-2 hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {connected && (
          <IconButton className="size-5" title="Disconnect" onClick={() => void useConnections.getState().disconnect(config.id)}>
            <Unplug className="size-3" />
          </IconButton>
        )}
        <IconButton className="size-5" title="Edit connection" onClick={() => useUi.getState().editConnection(config.id)}>
          <Settings2 className="size-3" />
        </IconButton>
      </div>
    </div>
  );
}
