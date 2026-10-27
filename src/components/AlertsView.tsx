import { BellRing, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { isRead } from "../lib/advisor";
import { ENGINE_LABEL } from "../lib/ipc";
import { CONDITION_LABEL, useAlerts, type AlertCondition, type QueryAlert } from "../store/alerts";
import { useConnections } from "../store/connections";
import { useSettings } from "../store/settings";
import type { QueryTab } from "../store/tabs";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { SqlEditor } from "./SqlEditor";
import { Button, IconButton } from "./ui";

const EVERY = [1, 5, 15, 30, 60, 240, 1440];
const every = (m: number) => (m >= 1440 ? `${m / 1440} day` : m >= 60 ? `${m / 60} h` : `${m} min`);

/** Query alerts: read queries checked on a schedule while Onyx is open, with a notification when they fire. */
export default function AlertsView({ tab }: { tab: QueryTab }) {
  const alerts = useAlerts((s) => s.alerts);
  const saved = useConnections((s) => s.saved);
  const [editing, setEditing] = useState<QueryAlert | null>(null);
  const blank = (): QueryAlert => ({
    id: crypto.randomUUID(),
    name: "",
    connectionId: tab.connectionId,
    sql: "SELECT count(*) FROM ",
    everyMin: 5,
    condition: "above",
    threshold: 0,
    enabled: true,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Button variant="primary" className="h-6" onClick={() => setEditing(blank())}>
          <Plus className="size-3.5" /> New alert
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-faint">Checked while Onyx is open · notifies when the condition turns true</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!alerts.length ? (
          <div className="mx-auto mt-10 max-w-md text-center text-[12px] text-muted">
            <BellRing className="mx-auto mb-2 size-5 text-faint" />
            Watch a number: failed jobs in the last hour, signups today, rows stuck in "pending". Onyx runs the query on a schedule and tells you when it crosses the line.
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-2">
            {alerts.map((a) => {
              const conn = saved.find((c) => c.id === a.connectionId);
              return (
                <div key={a.id} className={`flex items-center gap-3 rounded-xl border bg-panel px-3 py-2.5 ${a.firing ? "border-danger" : "border-border"}`}>
                  <input
                    type="checkbox"
                    className="q-switch"
                    checked={a.enabled}
                    onChange={(e) => useAlerts.getState().save({ ...a, enabled: e.target.checked })}
                    aria-label="Enabled"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <span className="font-medium">{a.name || "Untitled alert"}</span>
                      {a.firing && <span className="rounded bg-danger/15 px-1.5 text-[10.5px] font-medium text-danger">FIRING</span>}
                    </div>
                    <div className="truncate text-[11.5px] text-muted">
                      {conn?.name ?? "missing connection"} · every {every(a.everyMin)} · {CONDITION_LABEL[a.condition]}
                      {a.condition === "above" || a.condition === "below" ? ` ${a.threshold}` : ""}
                    </div>
                    <div className={`truncate text-[11px] ${a.lastError ? "text-danger" : "text-faint"}`}>
                      {a.lastError ?? (a.lastRun ? `Last: ${a.lastValue ?? "NULL"} at ${new Date(a.lastRun).toLocaleTimeString()}` : "Not checked yet")}
                    </div>
                  </div>
                  <IconButton title="Check now" className="size-6" onClick={() => void useAlerts.getState().check(a.id)}>
                    <RefreshCw className="size-3.5" />
                  </IconButton>
                  <IconButton title="Edit" className="size-6" onClick={() => setEditing(a)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton title="Delete alert" className="size-6" onClick={() => useAlerts.getState().remove(a.id)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <AlertForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AlertForm({ initial, onClose }: { initial: QueryAlert; onClose(): void }) {
  const [a, setA] = useState(initial);
  const saved = useConnections((s) => s.saved).filter((c) => c.engine !== "redis" && c.engine !== "mongodb");
  const settings = useSettings();
  const engine = saved.find((c) => c.id === a.connectionId)?.engine ?? "postgres";
  const valid = a.connectionId && isRead(a.sql);
  const set = (p: Partial<QueryAlert>) => setA((x) => ({ ...x, ...p }));
  const submit = () => {
    if (!valid) return;
    // A changed query starts fresh.
    useAlerts.getState().save({ ...a, firing: a.sql === initial.sql ? a.firing : false, lastRun: a.sql === initial.sql ? a.lastRun : undefined });
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <div className="flex w-[560px] flex-col gap-3 p-5 text-[12px]">
        <h2 className="text-[14px] font-semibold">{initial.name ? "Edit alert" : "New alert"}</h2>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Name</span>
          <input autoFocus value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Failed payments" className="q-field h-7 px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Connection</span>
          <Select
            value={a.connectionId}
            onChange={(connectionId) => set({ connectionId })}
            options={saved.map((c) => ({ value: c.id, label: c.name, hint: ENGINE_LABEL[c.engine] }))}
            className="q-field h-7 px-2"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-muted">Query (a single SELECT)</span>
          <div className="h-28 overflow-hidden rounded-lg border border-border">
            <SqlEditor initialValue={a.sql} onChange={(sql) => set({ sql })} onRun={submit} engine={engine} fontSize={settings.fontSize} />
          </div>
          {!isRead(a.sql) && <span className="text-[11px] text-danger">Alerts only run one SELECT (or WITH … SELECT).</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Check every</span>
          <Select value={a.everyMin} onChange={(everyMin) => set({ everyMin })} options={EVERY.map((m) => ({ value: m, label: every(m) }))} className="q-field h-7 px-2" />
          <span className="text-muted">and alert when it</span>
          <Select
            value={a.condition}
            onChange={(condition: AlertCondition) => set({ condition })}
            options={(Object.keys(CONDITION_LABEL) as AlertCondition[]).map((c) => ({ value: c, label: CONDITION_LABEL[c] }))}
            className="q-field h-7 px-2"
          />
          {(a.condition === "above" || a.condition === "below") && (
            <input type="number" value={a.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })} className="q-field h-7 w-24 px-2" />
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            Save alert
          </Button>
        </div>
      </div>
    </Modal>
  );
}
