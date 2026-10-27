import { ChevronRight, ClipboardCopy, GitCompare, Search, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { diffJson, parseJson, pathText, pgFilter, pgPath, stringify, type JsonChange, type JsonNode, type Path } from "../lib/jsonDiff";
import { copyText } from "../store/actions";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button } from "./ui";

interface Target {
  column: string;
  /** null: SQL NULL (no JSON value at all). */
  value: string | null;
  /** Other values to compare with (other rows of the column). */
  others: { label: string; value: string | null }[];
}

export const useJsonExplorer = create<{ target: Target | null; open(t: Target): void; close(): void }>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Text that's probably JSON (an object or array). */
export const looksLikeJson = (v: string | null) => !!v && /^\s*[[{]/.test(v);

const KIND_TINT: Record<JsonChange["kind"], string> = { added: "text-success", removed: "text-danger", changed: "text-warning", type: "text-warning" };
const CHILD_LIMIT = 200;

/** F04: a JSON value as a tree, and a semantic comparison with another value. */
export function JsonExplorer() {
  const target = useJsonExplorer((s) => s.target);
  if (!target) return null;
  return <Explorer target={target} onClose={() => useJsonExplorer.getState().close()} />;
}

function Explorer({ target, onClose }: { target: Target; onClose(): void }) {
  const [mode, setMode] = useState<"explore" | "compare">("explore");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Path | null>(null);
  const [other, setOther] = useState<string>(target.others[0]?.value ?? "");
  const [otherPick, setOtherPick] = useState(target.others.length ? "0" : "paste");
  const [arrayKey, setArrayKey] = useState("");
  const [onlyKind, setOnlyKind] = useState<JsonChange["kind"] | "all">("all");

  const parsed = useMemo(() => parse(target.value), [target.value]);
  const otherParsed = useMemo(() => parse(otherPick === "paste" ? other : (target.others[Number(otherPick)]?.value ?? null)), [other, otherPick, target.others]);
  const diff = useMemo(() => ("node" in parsed && "node" in otherParsed ? diffJson(parsed.node, otherParsed.node, arrayKey.trim() || null) : null), [parsed, otherParsed, arrayKey]);

  const node = "node" in parsed ? parsed.node : null;
  const pickedNode = picked && node ? at(node, picked) : null;

  return (
    <Modal onClose={onClose} width="max-w-4xl">
      <div className="flex h-[75vh] flex-col text-[12px]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="font-semibold">{target.column}</span>
          <div className="ml-2 flex rounded-lg bg-hover p-0.5">
            {(["explore", "compare"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`h-6 rounded-md px-2.5 ${mode === m ? "bg-raised font-medium text-fg shadow-sm" : "text-muted"}`}>
                {m === "explore" ? "Explore" : "Compare"}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          {mode === "explore" && (
            <label className="flex h-7 w-64 items-center gap-1.5 rounded-md bg-hover px-2">
              <Search className="size-3.5 text-faint" />
              <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find keys or values" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          )}
        </div>
        {"error" in parsed ? (
          <p className="m-4 text-danger">{parsed.error}</p>
        ) : mode === "explore" ? (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px]">
              {node && <Tree node={node} path={[]} name="" search={search.trim().toLowerCase()} picked={picked} onPick={setPicked} depth={0} />}
              {parsed.note && <p className="mt-2 font-sans text-faint">{parsed.note}</p>}
            </div>
            <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-panel p-3">
              {picked && pickedNode ? (
                <div className="flex flex-col gap-2">
                  <div className="font-mono text-[11.5px]">{pathText(picked)}</div>
                  <div className="text-[11px] text-muted">type: {pickedNode.t}</div>
                  {(
                    [
                      ["Value as JSON", pgPath(target.column, picked, false)],
                      ["Value as text", pgPath(target.column, picked, true)],
                      ["Rows with this value", pgFilter(target.column, picked, pickedNode)],
                    ] as const
                  ).map(([label, sql]) => (
                    <div key={label}>
                      <div className="mb-0.5 text-[11px] text-muted">{label} (PostgreSQL)</div>
                      <div className="flex items-start gap-1">
                        <code className="min-w-0 flex-1 select-text break-all rounded bg-raised px-1.5 py-1 font-mono text-[11px]">{sql}</code>
                        <button type="button" title="Copy" onClick={() => void copyText(sql, "Copied")} className="text-muted hover:text-fg">
                          <ClipboardCopy className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-faint">Click a key to see its path and copy a query for it.</p>
              )}
            </aside>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <span className="text-muted">Compare with</span>
              <Select
                value={otherPick}
                onChange={setOtherPick}
                options={[...target.others.map((o, i) => ({ value: String(i), label: o.label })), { value: "paste", label: "Pasted JSON…" }]}
                className="h-6 max-w-56 rounded-md bg-hover px-1.5"
              />
              <span className="ml-2 text-muted">Arrays matched</span>
              <input value={arrayKey} onChange={(e) => setArrayKey(e.target.value)} placeholder="by position (or a key, e.g. id)" className="q-field h-6 w-52 px-2" />
              <span className="flex-1" />
              <Select
                value={onlyKind}
                onChange={setOnlyKind}
                options={[{ value: "all", label: "All changes" }, ...(["added", "removed", "changed", "type"] as const).map((k) => ({ value: k, label: k === "type" ? "Type changes" : `${k[0].toUpperCase()}${k.slice(1)}` }))]}
                className="h-6 rounded-md bg-hover px-1.5"
              />
            </div>
            {otherPick === "paste" && <textarea value={other} onChange={(e) => setOther(e.target.value)} rows={4} placeholder="Paste the other JSON value" className="m-3 mb-0 resize-none rounded-lg border border-border bg-raised p-2 font-mono text-[11px] outline-none" />}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {"error" in otherParsed ? (
                <p className="text-danger">{otherParsed.error}</p>
              ) : diff ? (
                <div className="flex flex-col gap-2">
                  {diff.ambiguous.map((a, i) => (
                    <p key={i} className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-warning">
                      <TriangleAlert className="size-3.5" /> {pathText(a.path)}: can't match elements by “{arrayKey}”: {a.reason}. Compared by position instead.
                    </p>
                  ))}
                  {diff.duplicateKeys.map((d, i) => (
                    <p key={`d${i}`} className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-warning">
                      <TriangleAlert className="size-3.5" /> {pathText(d.path)} repeats the key {d.keys.join(", ")}: only the last value counts (as in jsonb).
                    </p>
                  ))}
                  <p className="text-muted">
                    <GitCompare className="mr-1 inline size-3.5" />
                    {diff.changes.length ? `${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}` : "Same value"} · key order and number formatting (1.50 = 1.5) don't count; a missing key and null do.
                  </p>
                  <table className="w-full font-mono text-[11.5px]">
                    <tbody>
                      {diff.changes
                        .filter((c) => onlyKind === "all" || c.kind === onlyKind)
                        .slice(0, 1000)
                        .map((c, i) => (
                          <tr key={i} className="border-t border-border align-top">
                            <td className={`w-20 px-2 py-1 font-sans text-[11px] ${KIND_TINT[c.kind]}`}>{c.kind === "type" ? "type changed" : c.kind}</td>
                            <td className="px-2 py-1">{pathText(c.path)}</td>
                            <td className="max-w-72 truncate px-2 py-1 text-danger" title={stringify(c.before)}>
                              {c.before ? short(c.before) : <span className="text-faint">(missing)</span>}
                            </td>
                            <td className="max-w-72 truncate px-2 py-1 text-success" title={stringify(c.after)}>
                              {c.after ? short(c.after) : <span className="text-faint">(missing)</span>}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        )}
        <div className="flex shrink-0 justify-end border-t border-border px-4 py-2">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function parse(value: string | null): { node: JsonNode; note?: string } | { error: string } {
  if (value === null) return { error: "SQL NULL: this cell has no JSON value at all (not the same as JSON null)." };
  try {
    return { node: parseJson(value), note: value.length > 2_000_000 ? "Large document: nodes beyond the first 200 children are collapsed." : undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function at(node: JsonNode, path: Path): JsonNode | null {
  let n: JsonNode | undefined = node;
  for (const p of path) {
    if (!n) return null;
    if (n.t === "object" && typeof p === "string") n = [...n.entries].reverse().find((e) => e[0] === p)?.[1];
    else if (n.t === "array" && typeof p === "number") n = n.items[p];
    else return null;
  }
  return n ?? null;
}

const short = (n: JsonNode) => {
  const s = n.t === "object" ? `{${n.entries.length} keys}` : n.t === "array" ? `[${n.items.length} items]` : stringify(n);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

/** Whether anything under `node` matches the search (key or scalar value). */
function matches(node: JsonNode, name: string, search: string): boolean {
  if (!search) return true;
  if (name.toLowerCase().includes(search)) return true;
  if (node.t === "object") return node.entries.some(([k, v]) => matches(v, k, search));
  if (node.t === "array") return node.items.some((v, i) => matches(v, String(i), search));
  return stringify(node).toLowerCase().includes(search);
}

function Tree({ node, path, name, search, picked, onPick, depth }: { node: JsonNode; path: Path; name: string; search: string; picked: Path | null; onPick(p: Path): void; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(CHILD_LIMIT);
  if (!matches(node, name, search)) return null;
  const isPicked = picked !== null && picked.length === path.length && picked.every((p, i) => p === path[i]);
  const container = node.t === "object" || node.t === "array";
  const children: [string | number, JsonNode][] = node.t === "object" ? node.entries.map(([k, v]) => [k, v]) : node.t === "array" ? node.items.map((v, i) => [i, v]) : [];
  const expanded = open || (!!search && depth < 8);
  return (
    <div>
      <div className={`flex cursor-default items-center gap-1 rounded px-1 ${isPicked ? "bg-selected" : "hover:bg-hover"}`} style={{ paddingLeft: depth * 14 }} onClick={() => (onPick(path), container && setOpen(!open))}>
        {container ? <ChevronRight className={`size-3 shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`} /> : <span className="w-3" />}
        {name !== "" && <span className="text-accent">{name}</span>}
        {name !== "" && <span className="text-faint">:</span>}
        <span className={node.t === "string" ? "text-[var(--hl-string)]" : node.t === "number" ? "text-[var(--hl-number)]" : node.t === "null" || node.t === "boolean" ? "text-[var(--hl-keyword)]" : "text-faint"}>{short(node)}</span>
        {node.t === "object" && node.duplicates.length > 0 && <span className="text-warning" title="Repeated keys: only the last counts">⚠ {node.duplicates.join(", ")}</span>}
      </div>
      {container && expanded && (
        <>
          {children.slice(0, limit).map(([k, v]) => (
            <Tree key={String(k)} node={v} path={[...path, k]} name={typeof k === "number" ? `[${k}]` : k} search={search} picked={picked} onPick={onPick} depth={depth + 1} />
          ))}
          {children.length > limit && (
            <button type="button" className="ml-6 text-[11px] text-accent" style={{ paddingLeft: depth * 14 }} onClick={() => setLimit((l) => l + CHILD_LIMIT)}>
              Show more ({children.length - limit} hidden)
            </button>
          )}
        </>
      )}
    </div>
  );
}
