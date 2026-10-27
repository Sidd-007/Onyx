import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api, defaultSchemaOf, ENGINE_LABEL, type ConnectionConfig } from "../lib/ipc";
import { isConnected, useConnections } from "../store/connections";
import { runJob } from "../store/jobs";
import { useOverlays } from "../store/overlays";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Button } from "./ui";

/** Copy picked rows and every row they're related to (foreign keys) into another connection. */
export function CopyRelatedDialog({ connection, schema, table, onClose }: { connection: ConnectionConfig; schema: string; table: string; onClose(): void }) {
  const saved = useConnections((s) => s.saved);
  const status = useConnections((s) => s.status);
  const targets = saved.filter((c) => isConnected(status[c.id]) && c.engine === connection.engine && !c.readOnly);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(50);
  const [children, setChildren] = useState(true);
  const [targetId, setTargetId] = useState(targets.find((c) => c.id !== connection.id)?.id ?? targets[0]?.id ?? "");
  const [targetSchema, setTargetSchema] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const target = saved.find((c) => c.id === targetId);

  useEffect(() => {
    if (!targetId) return;
    void api.listSchemas(targetId).then((s) => {
      setSchemas(s);
      const t = saved.find((c) => c.id === targetId);
      setTargetSchema(s.includes(schema) ? schema : t ? defaultSchemaOf(t) || s[0] || "" : s[0] || "");
    });
  }, [targetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const same = targetId === connection.id && targetSchema === schema;
  const start = (confirmed: boolean) => {
    onClose();
    void runJob(`Copy ${table} with related rows`, async (job) => {
      const done = await api.copyRelated(connection.id, targetId, { schema, table, filter, limit, children, targetSchema }, confirmed, job.progress());
      const parts = Object.entries(done.tables).map(([t, n]) => `${n.toLocaleString()} ${t}`);
      return `Copied into ${target?.name}: ${parts.join(", ") || "nothing new"}`;
    });
  };
  const go = () => {
    if (target?.environment !== "prod") return start(false);
    useOverlays.getState().askDanger({
      title: `Write rows into ${target.name} (prod)?`,
      statement: `-- rows of ${table} matching ${filter || "anything"} (up to ${limit}) and everything they reference, into ${targetSchema}`,
      connectionName: target.name,
      prod: true,
      action: "Copy",
      run: async () => start(true),
    });
  };

  return (
    <Modal onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-3.5 p-5 text-[12px]">
        <div>
          <h2 className="text-[13px] font-semibold">Copy {table} with related rows</h2>
          <p className="mt-1 text-muted">
            The rows you pick, plus every row they point to through foreign keys{children ? ", and the rows that point to them (one level)" : ""}. {connection.name} is only read; rows already in the target are skipped.
          </p>
        </div>
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="q-label">Which rows (WHERE)</span>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="created_at > now() - interval '7 days'" className="q-field h-8 px-2.5 font-mono" spellCheck={false} />
          </label>
          <label className="flex w-24 flex-col gap-1">
            <span className="q-label">At most</span>
            <input value={limit} inputMode="numeric" onChange={(e) => setLimit(Math.max(1, Math.min(10000, Number(e.target.value.replace(/\D/g, "")) || 1)))} className="q-field h-8 px-2.5" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-muted">
          <input type="checkbox" checked={children} onChange={(e) => setChildren(e.target.checked)} />
          Include rows that reference them (orders of these users, …)
        </label>
        <div className="flex items-end gap-2">
          <span className="mb-2 font-mono text-muted">{schema}.{table}</span>
          <ArrowRight className="mb-2.5 size-4 text-faint" />
          <Select value={targetId} placeholder="target" onChange={setTargetId} options={targets.map((c) => ({ value: c.id, label: c.name, hint: ENGINE_LABEL[c.engine] }))} className="q-field h-8 w-48 px-2.5" />
          <Select value={targetSchema} placeholder="schema" onChange={setTargetSchema} options={schemas.map((s) => ({ value: s, label: s }))} className="q-field h-8 w-40 px-2.5" />
        </div>
        {targets.length === 0 && <p className="text-warning">Connect to a writable {ENGINE_LABEL[connection.engine]} connection to copy into.</p>}
        {same && <p className="text-warning">Pick a different target than the source.</p>}
        <p className="text-[11px] text-faint">The target needs the same tables (create them with Export structure as SQL, or Copy to a connection).</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!targetId || !targetSchema || same} onClick={go}>
            Copy in the background
          </Button>
        </div>
      </div>
    </Modal>
  );
}
