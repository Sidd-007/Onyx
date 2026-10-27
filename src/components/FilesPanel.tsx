import { BookOpen, ChevronRight, FileCode, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, toError } from "../lib/ipc";
import { isNotebook } from "../lib/notebook";
import { baseName, parentOf, useIde } from "../store/ide";
import { useOverlays } from "../store/overlays";
import { useTabs } from "../store/tabs";
import { toast } from "../store/toasts";
import { GitPanel } from "./GitPanel";
import { Button, IconButton } from "./ui";

type Editing = { kind: "file" | "folder" | "notebook"; parent: string } | { kind: "rename"; path: string } | null;
type Node = { path: string; dir: boolean };

const isSql = (path: string) => /\.(sql|psql|pgsql|mysql|ddl)$/i.test(path);

/** IDE mode's explorer: the workspace folder's files. Click a file to edit it in a tab. */
export function FilesPanel({ search, filter }: { search: React.ReactNode; filter: string }) {
  const listing = useIde((s) => s.listing);
  const expanded = useIde((s) => s.expanded);
  const activePath = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.filePath);
  const [editing, setEditing] = useState<Editing>(null);
  // Where the header's New file / New folder go: the folder of whatever was clicked last.
  const [selectedDir, setSelectedDir] = useState("");
  const [drag, setDrag] = useState<{ path: string; x: number; y: number; target: string | null } | null>(null);
  // The click that ends a drag isn't a click on the row.
  const dragged = useRef(false);

  useEffect(() => {
    void useIde.getState().refresh();
    // Pick up files changed outside Onyx when the window comes back.
    const onFocus = () => void useIde.getState().refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const children = useMemo(() => {
    const map = new Map<string, Node[]>();
    for (const e of listing?.entries ?? []) {
      const parent = parentOf(e.path);
      map.set(parent, [...(map.get(parent) ?? []), e]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true })));
    }
    return map;
  }, [listing]);

  if (!listing) {
    return (
      <div className="m-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
        <FolderOpen className="size-4 text-faint" />
        <p className="text-[11.5px] text-muted">Open a folder to write and run .sql files from it.</p>
        <Button variant="primary" onClick={() => void useIde.getState().openFolder()}>
          Open folder…
        </Button>
      </div>
    );
  }

  const startNew = (kind: "file" | "folder" | "notebook", parent = selectedDir) => {
    if (parent) useIde.getState().setExpanded(parent, true);
    setEditing({ kind, parent });
  };

  const menuFor = (e: React.MouseEvent, node: Node | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = node ? (node.dir ? node.path : parentOf(node.path)) : "";
    useOverlays.getState().openMenu(e.clientX, e.clientY, [
      { label: "New file…", onSelect: () => startNew("file", dir) },
      { label: "New notebook…", onSelect: () => startNew("notebook", dir) },
      { label: "New folder…", onSelect: () => startNew("folder", dir) },
      ...(node
        ? [
            "separator" as const,
            ...(!node.dir ? [{ label: "Open", onSelect: () => void useIde.getState().openFile(node.path) }] : []),
            { label: "Rename…", onSelect: () => setEditing({ kind: "rename", path: node.path }) },
            { label: "Reveal in Finder", onSelect: () => void api.workspaceReveal(node.path).catch((err) => toast(toError(err).message, "error")) },
            { label: "Copy path", onSelect: () => void navigator.clipboard.writeText(`${listing.root}/${node.path}`) },
          ]
        : []),
    ]);
  };

  /** Drag a row onto a folder (or a file in it, or empty space for the top) to move it there. */
  const beginDrag = (e: React.MouseEvent, node: Node) => {
    if (e.button !== 0 || editing) return;
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    const targetAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
      const dir = el ? (el.dataset.dropDir ?? "") : null;
      // Not where it already is, and a folder never into itself.
      const ok = dir !== null && dir !== parentOf(node.path) && !(node.dir && (dir === node.path || dir.startsWith(`${node.path}/`)));
      return ok ? dir : null;
    };
    const move = (ev: MouseEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      active = true;
      document.body.style.cursor = "grabbing";
      setDrag({ path: node.path, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      if (!active) return;
      dragged.current = true;
      window.setTimeout(() => (dragged.current = false));
      setDrag(null);
      const dir = targetAt(ev.clientX, ev.clientY);
      if (dir === null) return;
      void useIde
        .getState()
        .rename(node.path, [dir, baseName(node.path)].filter(Boolean).join("/"))
        .then((ok) => ok && dir && useIde.getState().setExpanded(dir, true));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const commit = async (name: string) => {
    const edit = editing;
    setEditing(null);
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (!edit || !clean) return;
    if (edit.kind === "rename") {
      const to = [parentOf(edit.path), clean].filter(Boolean).join("/");
      if (to !== edit.path) await useIde.getState().rename(edit.path, to);
      return;
    }
    // New files are SQL unless named otherwise.
    const file = edit.kind === "notebook" ? clean.replace(/(\.qnb)?$/i, ".qnb") : edit.kind === "file" && !/\.[\w]+$/.test(clean) ? `${clean}.sql` : clean;
    await useIde.getState().create([edit.parent, file].filter(Boolean).join("/"), edit.kind === "folder");
  };

  const rows: React.ReactNode[] = [];
  const newRow = (parent: string, depth: number) =>
    editing && editing.kind !== "rename" && editing.parent === parent ? (
      <NameInput key={`new:${parent}`} depth={depth} dir={editing.kind === "folder"} placeholder={editing.kind === "notebook" ? "name.qnb" : undefined} initial="" onDone={commit} onCancel={() => setEditing(null)} />
    ) : null;

  if (filter) {
    // Searching: matching files as a flat list.
    for (const e of listing.entries) {
      if (!e.dir && e.path.toLowerCase().includes(filter)) {
        rows.push(<FileRow key={e.path} node={e} depth={0} label={e.path} active={e.path === activePath} onMenu={menuFor} onPick={setSelectedDir} onDrag={beginDrag} wasDragged={dragged} dropTarget={drag?.target ?? null} />);
      }
    }
    if (!rows.length) rows.push(<p key="none" className="px-2 py-1 text-[12px] text-faint">No matching files.</p>);
  } else {
    const walk = (parent: string, depth: number) => {
      const created = newRow(parent, depth);
      if (created) rows.push(created);
      for (const node of children.get(parent) ?? []) {
        if (editing?.kind === "rename" && editing.path === node.path) {
          rows.push(<NameInput key={node.path} depth={depth} dir={node.dir} initial={baseName(node.path)} onDone={commit} onCancel={() => setEditing(null)} />);
          continue;
        }
        const open = node.dir && expanded.includes(node.path);
        rows.push(
          node.dir ? (
            <FolderRow key={node.path} node={node} depth={depth} open={open} onMenu={menuFor} onPick={setSelectedDir} onDrag={beginDrag} wasDragged={dragged} dropTarget={drag?.target ?? null} />
          ) : (
            <FileRow key={node.path} node={node} depth={depth} active={node.path === activePath} onMenu={menuFor} onPick={setSelectedDir} onDrag={beginDrag} wasDragged={dragged} dropTarget={drag?.target ?? null} />
          ),
        );
        if (open) walk(node.path, depth + 1);
      }
    };
    walk("", 0);
    if (!listing.entries.length && !editing) {
      rows.push(
        <p key="empty" className="px-2 py-1 text-[12px] text-faint">
          This folder is empty. Right-click or use + to add a file.
        </p>,
      );
    }
  }

  return (
    <>
      <div className="flex items-center gap-0.5 px-1.5 pb-1">
        <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold tracking-wide text-muted uppercase" data-tip={listing.root}>
          {baseName(listing.root)}
        </span>
        <IconButton title="New file" onClick={() => startNew("file")}>
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton title="New notebook" onClick={() => startNew("notebook")}>
          <BookOpen className="size-3.5" />
        </IconButton>
        <IconButton title="New folder" onClick={() => startNew("folder")}>
          <FolderPlus className="size-3.5" />
        </IconButton>
        <IconButton title="Refresh" onClick={() => void useIde.getState().refresh()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        <IconButton title="Open another folder" onClick={() => void useIde.getState().openFolder()}>
          <FolderOpen className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex px-1.5 pb-1.5">{search}</div>
      <div
        data-drop-dir=""
        className={`min-h-0 flex-1 select-none overflow-y-auto px-1.5 pb-3 ${drag?.target === "" ? "bg-accent-soft" : ""}`}
        onContextMenu={(e) => menuFor(e, null)}
        onClick={() => setSelectedDir("")}
      >
        {rows}
        {listing.truncated && <p className="px-2 py-1 text-[11px] text-faint">Only the first 20,000 entries are shown.</p>}
      </div>
      <GitPanel />
      {drag && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 text-[12px] shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 8 }}
        >
          {listing.entries.find((e) => e.path === drag.path)?.dir ? <Folder className="size-3.5 text-muted" /> : <FileCode className="size-3.5 text-accent" />}
          {baseName(drag.path)}
          <span className="text-faint">{drag.target === null ? "" : `→ ${drag.target ? baseName(drag.target) : baseName(listing.root)}`}</span>
        </div>
      )}
    </>
  );
}

interface RowProps {
  node: Node;
  depth: number;
  onMenu(e: React.MouseEvent, node: Node): void;
  onPick(dir: string): void;
  onDrag(e: React.MouseEvent, node: Node): void;
  wasDragged: React.RefObject<boolean>;
  /** The folder a dragged row would land in, if any. */
  dropTarget: string | null;
}

function FolderRow({ node, depth, open, onMenu, onPick, onDrag, wasDragged, dropTarget }: RowProps & { open: boolean }) {
  return (
    <div
      data-drop-dir={node.path}
      className={`flex h-7 items-center gap-1 rounded-md pr-1 text-[12px] ${dropTarget === node.path ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-hover"}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      onMouseDown={(e) => onDrag(e, node)}
      onClick={(e) => {
        e.stopPropagation();
        if (wasDragged.current) return;
        onPick(node.path);
        useIde.getState().setExpanded(node.path, !open);
      }}
      onContextMenu={(e) => onMenu(e, node)}
    >
      <ChevronRight className={`size-3 shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
      <Folder className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} />
      <span className="truncate">{baseName(node.path)}</span>
    </div>
  );
}

function FileRow({ node, depth, active, label, onMenu, onPick, onDrag, wasDragged }: RowProps & { active: boolean; label?: string }) {
  const Icon = isSql(node.path) ? FileCode : isNotebook(node.path) ? BookOpen : FileText;
  return (
    <div
      data-drop-dir={parentOf(node.path)}
      className={`flex h-7 items-center gap-1.5 rounded-md pr-1 text-[12px] ${active ? "bg-selected" : "hover:bg-hover"}`}
      style={{ paddingLeft: 20 + depth * 14 }}
      title={node.path}
      onMouseDown={(e) => onDrag(e, node)}
      onClick={(e) => {
        e.stopPropagation();
        if (wasDragged.current) return;
        onPick(parentOf(node.path));
        void useIde.getState().openFile(node.path);
      }}
      onContextMenu={(e) => onMenu(e, node)}
    >
      <Icon className={`size-3.5 shrink-0 ${isSql(node.path) || isNotebook(node.path) ? "text-accent" : "text-muted"}`} strokeWidth={1.75} />
      <span className="truncate">{label ?? baseName(node.path)}</span>
    </div>
  );
}

/** The name field for a new or renamed file or folder. Enter saves, Esc or clicking away cancels. */
function NameInput({ depth, dir, placeholder, initial, onDone, onCancel }: { depth: number; dir: boolean; placeholder?: string; initial: string; onDone(name: string): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current!;
    input.focus();
    // Select the name without its extension, like Finder.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const Icon = dir ? Folder : FileCode;
  return (
    <div className="flex h-7 items-center gap-1.5 pr-1" style={{ paddingLeft: (dir ? 18 : 20) + depth * 14 }} onClick={(e) => e.stopPropagation()}>
      <Icon className="size-3.5 shrink-0 text-muted" strokeWidth={1.75} />
      <input
        ref={ref}
        defaultValue={initial}
        placeholder={placeholder ?? (dir ? "folder name" : "name.sql")}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone(e.currentTarget.value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        className="h-5 min-w-0 flex-1 rounded border border-accent bg-raised px-1 text-[12px] outline-none"
      />
    </div>
  );
}
