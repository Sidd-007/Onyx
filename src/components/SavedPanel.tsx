import { ChevronRight, FileCode, Folder, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { SavedQuery } from "../lib/ipc";
import { openSql } from "../store/actions";
import { useConnections } from "../store/connections";
import { useLibrary } from "../store/library";
import { IconButton, ConnectionDot } from "./ui";

/** Saved queries, grouped by the folder part of "folder/name". */
export function SavedPanel({ filter }: { filter: string }) {
  const saved = useLibrary((s) => s.saved);
  useEffect(() => {
    void useLibrary.getState().loadSaved();
  }, []);

  const visible = saved.filter((q) => !filter || q.name.toLowerCase().includes(filter) || q.sql.toLowerCase().includes(filter));
  if (!saved.length) {
    return <p className="px-2 py-1 text-[12px] text-faint">Save a query with ⌘S to keep it here.</p>;
  }
  if (!visible.length) return <p className="px-2 py-1 text-[12px] text-faint">No matches.</p>;

  const folders = new Map<string, SavedQuery[]>();
  for (const q of visible) {
    const slash = q.name.lastIndexOf("/");
    const folder = slash > 0 ? q.name.slice(0, slash) : "";
    folders.set(folder, [...(folders.get(folder) ?? []), q]);
  }

  return (
    <div>
      {[...folders].map(([folder, queries]) =>
        folder ? (
          <FolderNode key={folder} name={folder} queries={queries} forceOpen={filter !== ""} />
        ) : (
          queries.map((q) => <QueryRow key={q.id} query={q} depth={0} />)
        ),
      )}
    </div>
  );
}

function FolderNode({ name, queries, forceOpen }: { name: string; queries: SavedQuery[]; forceOpen: boolean }) {
  const [open, setOpen] = useState(true);
  const expanded = open || forceOpen;
  return (
    <>
      <div className="flex h-7 items-center gap-1 rounded-md px-1 text-[12px] hover:bg-hover" onClick={() => setOpen(!open)}>
        <ChevronRight className={`size-3 text-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
        <Folder className="size-3.5 text-muted" strokeWidth={1.75} />
        <span className="truncate text-muted">{name}</span>
      </div>
      {expanded && queries.map((q) => <QueryRow key={q.id} query={q} depth={1} />)}
    </>
  );
}

function QueryRow({ query, depth }: { query: SavedQuery; depth: number }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === query.connectionId));
  const [confirm, setConfirm] = useState(false);
  const title = query.name.split("/").pop() || query.name;
  return (
    <div
      className="group flex h-7 items-center gap-1.5 rounded-md pr-1 text-[12px] hover:bg-hover"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={query.sql}
      onClick={() => openSql(query.sql, connection ? query.connectionId : null, { title, savedQueryId: query.id })}
    >
      <FileCode className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {connection && <ConnectionDot environment={connection.environment} />}
      <IconButton
        title={confirm ? "Click again to delete" : "Delete saved query"}
        className={`size-5 ${confirm ? "text-danger" : "opacity-0 group-hover:opacity-100"}`}
        onBlur={() => setConfirm(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (!confirm) return setConfirm(true);
          void useLibrary.getState().remove(query.id);
        }}
      >
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  );
}
