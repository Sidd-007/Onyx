import { Clock, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toError } from "../lib/ipc";
import { redisArg } from "../lib/nosql";
import { executeStatement, queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import { useTabs, type QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { Button, IconButton } from "./ui";

type Entry = { a: string; b: string | null };

/** A Redis key: its value edited in place (by type), TTL, rename and delete. */
export default function RedisKeyView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const key = tab.table ?? "";
  const db = Number((tab.schema ?? "db0").replace(/^db/, "")) || 0;
  const [type, setType] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The row being edited (`index` null: a new one). */
  const [edit, setEdit] = useState<{ index: number | null; entry: Entry } | null>(null);
  const readOnly = connection?.readOnly ?? true;
  const k = redisArg(key);

  /** One command in this key's database, on the tab's own session; its first result. */
  const query = useCallback(
    async (command: string) => (await queryRows(tab.connectionId, `SELECT ${db}\n${command}`, 10_000, tab.id)).rows,
    [tab.connectionId, tab.id, db],
  );
  /** A change, on the same session. */
  const write = async (command: string) => {
    const failed = await executeStatement(tab.connectionId, `SELECT ${db}\n${command}`, tab.id);
    if (failed) {
      toast(failed.message, "error");
      return false;
    }
    return true;
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = (await query(`TYPE ${k}`))[0]?.[0] ?? "none";
      setType(t);
      setTtl(Number((await query(`TTL ${k}`))[0]?.[0] ?? -1));
      const pairs = (rows: (string | null)[][]) => rows.map((r) => ({ a: r[0] ?? "", b: r[1] ?? null }));
      if (t === "string") setText((await query(`GET ${k}`))[0]?.[0] ?? "");
      else if (t === "hash") setEntries(pairs(await query(`HGETALL ${k}`)));
      else if (t === "list") setEntries((await query(`LRANGE ${k} 0 999`)).map((r, i) => ({ a: String(i), b: r[r.length - 1] ?? null })));
      else if (t === "set") setEntries((await query(`SMEMBERS ${k}`)).map((r) => ({ a: r[0] ?? "", b: null })));
      else if (t === "zset") setEntries(pairs(await query(`ZRANGE ${k} 0 999 WITHSCORES`)));
      else if (t === "stream") setEntries(pairs(await query(`XRANGE ${k} - + COUNT 200`)));
      else setEntries([]);
    } catch (e) {
      setError(toError(e).message);
    }
  }, [query, k]);
  useEffect(() => void load(), [load]);

  const confirm = (title: string, statement: string, then: () => void) =>
    useOverlays.getState().askDanger({
      title,
      statement,
      connectionName: connection?.name ?? "",
      prod: connection?.environment === "prod",
      action: "Run",
      run: async () => {
        if (await write(statement)) then();
      },
    });

  const saveEntry = async (e: Entry, original?: Entry) => {
    const ok =
      type === "hash"
        ? await write(`HSET ${k} ${redisArg(e.a)} ${redisArg(e.b ?? "")}`).then(async (done) => (done && original && original.a !== e.a ? write(`HDEL ${k} ${redisArg(original.a)}`) : done))
        : type === "list"
          ? await write(original ? `LSET ${k} ${e.a} ${redisArg(e.b ?? "")}` : `RPUSH ${k} ${redisArg(e.b ?? "")}`)
          : type === "set"
            ? await write(`SADD ${k} ${redisArg(e.a)}`).then(async (done) => (done && original && original.a !== e.a ? write(`SREM ${k} ${redisArg(original.a)}`) : done))
            : type === "zset"
              ? await write(`ZADD ${k} ${Number(e.b) || 0} ${redisArg(e.a)}`).then(async (done) => (done && original && original.a !== e.a ? write(`ZREM ${k} ${redisArg(original.a)}`) : done))
              : false;
    if (ok) {
      setEdit(null);
      await load();
    }
  };
  const removeEntry = (e: Entry) => {
    const command =
      type === "hash" ? `HDEL ${k} ${redisArg(e.a)}` : type === "list" ? `LREM ${k} 1 ${redisArg(e.b ?? "")}` : type === "set" ? `SREM ${k} ${redisArg(e.a)}` : `ZREM ${k} ${redisArg(e.a)}`;
    confirm("Remove this item?", command, () => void load());
  };

  const [asking, setAsking] = useState<"ttl" | "rename" | null>(null);
  const setExpiry = (answer: string) => {
    const seconds = Number(answer);
    void write(answer.trim() === "" ? `PERSIST ${k}` : `EXPIRE ${k} ${Math.max(1, Math.floor(seconds))}`).then((ok) => {
      if (ok) void load();
    });
  };
  const rename = (next: string) => {
    if (!next || next === key) return;
    confirm(`Rename ${key}?`, `RENAME ${k} ${redisArg(next)}`, () => {
      useTabs.getState().update(tab.id, { title: next });
      useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, table: next } : t)) }));
      void useConnections.getState().refreshSchema(tab.connectionId);
    });
  };

  const columns = type === "hash" ? ["field", "value"] : type === "zset" ? ["member", "score"] : type === "list" ? ["#", "value"] : type === "stream" ? ["id", "fields"] : ["member"];
  const editableType = !readOnly && ["hash", "list", "set", "zset"].includes(type ?? "");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <KeyRound className="size-4 text-accent" />
        <span className="font-mono text-[13px] font-semibold">{key}</span>
        {type && <span className="q-label">{type}</span>}
        <span className="flex items-center gap-1 text-[11.5px] text-muted" data-tip="Time to live">
          <Clock className="size-3" />
          {ttl === null ? "…" : ttl === -1 ? "no expiry" : ttl === -2 ? "gone" : `${ttl.toLocaleString()}s`}
        </span>
        <span className="flex-1" />
        <IconButton title="Reload" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        {!readOnly && type !== "none" && (
          <>
            <Button onClick={() => setAsking("ttl")}>
              <Clock className="size-3.5" /> TTL
            </Button>
            <Button onClick={() => setAsking("rename")}>
              <Pencil className="size-3.5" /> Rename
            </Button>
            <Button variant="danger" onClick={() => confirm(`Delete ${key}?`, `DEL ${k}`, () => void useConnections.getState().refreshSchema(tab.connectionId).then(load))}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        )}
      </header>
      {asking && (
        <Prompt
          title={asking === "ttl" ? "Expire in how many seconds?" : `Rename ${key}`}
          hint={asking === "ttl" ? "Empty keeps the key forever." : undefined}
          initial={asking === "ttl" ? (ttl && ttl > 0 ? String(ttl) : "") : key}
          onCancel={() => setAsking(null)}
          onDone={(v) => {
            setAsking(null);
            if (asking === "ttl") setExpiry(v);
            else rename(v.trim());
          }}
        />
      )}
      {error && <p className="m-4 rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</p>}
      {type === null && !error && <LoaderCircle className="m-6 size-4 animate-spin text-muted" />}
      {type === "none" && <p className="m-6 text-[12px] text-muted">This key doesn't exist (any more).</p>}
      {type === "string" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <textarea value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} spellCheck={false} className="q-field min-h-0 flex-1 resize-none p-3 font-mono text-[12.5px]" />
          {!readOnly && (
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => void write(`SET ${k} ${redisArg(text)} KEEPTTL`).then((ok) => ok && toast("Saved", "success"))}>
                <Save className="size-3.5" /> Save
              </Button>
            </div>
          )}
        </div>
      )}
      {type && !["string", "none"].includes(type) && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="overflow-hidden rounded-xl border border-border font-mono text-[12px]">
            <div className="flex border-b border-border bg-panel px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-faint">
              {columns.map((c) => (
                <span key={c} className={c === "#" ? "w-12" : "flex-1"}>
                  {c}
                </span>
              ))}
              {editableType && <span className="w-16" />}
            </div>
            {entries.map((e, i) =>
              edit?.index === i ? (
                <EntryEditor key={i} type={type} entry={e} onCancel={() => setEdit(null)} onSave={(next) => void saveEntry(next, e)} />
              ) : (
                <div key={i} className="group flex items-center border-b border-border px-3 py-1.5 last:border-0 hover:bg-hover">
                  <span className={type === "list" ? "w-12 text-faint" : "min-w-0 flex-1 truncate select-text"}>{e.a}</span>
                  {columns.length > 1 && <span className="min-w-0 flex-1 truncate select-text">{e.b ?? <span className="text-faint">NULL</span>}</span>}
                  {editableType && (
                    <span className="flex w-16 justify-end gap-0.5 opacity-0 group-hover:opacity-100">
                      <IconButton title="Edit" className="size-5" onClick={() => setEdit({ index: i, entry: e })}>
                        <Pencil className="size-3" />
                      </IconButton>
                      <IconButton title="Remove" className="size-5 hover:text-danger" onClick={() => removeEntry(e)}>
                        <Trash2 className="size-3" />
                      </IconButton>
                    </span>
                  )}
                </div>
              ),
            )}
            {edit?.index === null && <EntryEditor type={type} entry={edit.entry} onCancel={() => setEdit(null)} onSave={(next) => void saveEntry(next)} />}
          </div>
          {editableType && !edit && (
            <Button variant="ghost" className="mt-2 h-7" onClick={() => setEdit({ index: null, entry: { a: type === "list" ? String(entries.length) : "", b: type === "zset" ? "0" : "" } })}>
              <Plus className="size-3.5" /> Add {type === "hash" ? "field" : type === "zset" || type === "set" ? "member" : "item"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function EntryEditor({ type, entry, onCancel, onSave }: { type: string; entry: Entry; onCancel(): void; onSave(e: Entry): void }) {
  const [a, setA] = useState(entry.a);
  const [b, setB] = useState(entry.b ?? "");
  const twoFields = type === "hash" || type === "zset";
  return (
    <form
      className="flex items-center gap-2 border-t border-border bg-panel px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ a, b });
      }}
    >
      {type !== "list" && <input autoFocus value={a} onChange={(e) => setA(e.target.value)} placeholder={type === "hash" ? "field" : "member"} className="q-field h-7 min-w-0 flex-1 px-2" />}
      {(twoFields || type === "list") && (
        <input autoFocus={type === "list"} value={b} onChange={(e) => setB(e.target.value)} placeholder={type === "zset" ? "score" : "value"} className="q-field h-7 min-w-0 flex-1 px-2" />
      )}
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit">
        Save
      </Button>
    </form>
  );
}

function Prompt({ title, hint, initial, onCancel, onDone }: { title: string; hint?: string; initial: string; onCancel(): void; onDone(value: string): void }) {
  const [value, setValue] = useState(initial);
  return (
    <Modal onClose={onCancel} width="max-w-sm">
      <form
        className="flex flex-col gap-3 p-4 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(value);
        }}
      >
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="q-field h-8 px-2.5 font-mono" spellCheck={false} />
        {hint && <p className="text-faint">{hint}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit">
            OK
          </Button>
        </div>
      </form>
    </Modal>
  );
}
