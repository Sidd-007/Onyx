import { Channel } from "@tauri-apps/api/core";
import { CheckCheck, Loader2, Pause, Play, RefreshCw, RotateCcw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, toError, type BackfillJob, type BackfillSpec } from "../lib/ipc";
import { quoteIdent } from "../lib/sqlSplit";
import { queryRows } from "../store/actions";
import { useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import type { QueryTab } from "../store/tabs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, RowsPreview, SqlArea, Step, Text } from "./workbench";

/** F07: a bounded, resumable change in batches; each batch commits with its checkpoint. */
export default function BackfillView({ tab }: { tab: QueryTab }) {
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  const [spec, setSpec] = useState<BackfillSpec>({ schema: tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public", table: tab.table ?? "", key: "id", eligible: "status = 'old'", set: "status = 'archived'", postcondition: "status <> 'archived'", batchSize: 1000, pauseMs: 200, lockTimeoutMs: 2000, maxFailedBatches: 3 });
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const [preview, setPreview] = useState<{ count: string | null; columns: string[]; rows: (string | null)[][] } | null>(null);
  const [verification, setVerification] = useState<Record<string, Awaited<ReturnType<typeof api.backfillVerify>>>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<BackfillSpec>) => setSpec((s) => ({ ...s, ...p }));
  const prod = connection?.environment === "prod";
  const q = (n: string) => quoteIdent(n, "postgres");

  // The error the job list's own load showed ("Not connected"…): a later load that works clears
  // it, without hiding a run's or a verification's error.
  const listError = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setJobs((await api.backfillList(tab.connectionId, spec.schema)) ?? []);
      setError((e) => (e !== null && e === listError.current ? null : e));
      listError.current = null;
    } catch (e) {
      listError.current = toError(e).message;
      setError(listError.current);
    }
  }, [tab.connectionId, spec.schema]);
  useEffect(() => void refresh(), [refresh]);

  const confirmed = (title: string, statement: string, run: () => Promise<void>) =>
    prod || connection?.environment === "staging"
      ? useOverlays.getState().askDanger({ title, statement, connectionName: connection!.name, prod, action: "Go ahead", run })
      : void run();

  const doPreview = async () => {
    setError(null);
    try {
      const from = `${q(spec.schema)}.${q(spec.table)}`;
      const [c, rows] = await Promise.all([queryRows(tab.connectionId, `SELECT count(*) FROM ${from} WHERE ${spec.eligible}`, 1), queryRows(tab.connectionId, `SELECT * FROM ${from} WHERE ${spec.eligible} ORDER BY ${q(spec.key)} LIMIT 10`, 10)]);
      setPreview({ count: c.rows[0]?.[0] ?? null, ...rows });
    } catch (e) {
      setError(toError(e).message);
    }
  };

  const setupTables = () =>
    useOverlays.getState().askDanger({
      title: `Create Onyx's job tables in ${spec.schema}?`,
      statement: `CREATE TABLE IF NOT EXISTS ${spec.schema}.onyx_jobs (…);\nCREATE TABLE IF NOT EXISTS ${spec.schema}.onyx_job_keys (…);`,
      connectionName: connection?.name ?? "",
      prod,
      action: "Create",
      detail: "Progress lives in the database, next to the data, so a batch's changes and its checkpoint commit together. Drop the two tables when you no longer need the job history.",
      run: async () => {
        try {
          await api.backfillSetup(tab.connectionId, spec.schema, true);
          toast("Job tables created", "success");
          await refresh();
        } catch (e) {
          setError(toError(e).message);
        }
      },
    });

  const create = () =>
    confirmed(`Create a job for ${spec.table}?`, `UPDATE ${spec.schema}.${spec.table} SET ${spec.set}\nWHERE ${spec.key} IN (<a batch of ${spec.batchSize} candidates>) AND (${spec.eligible})`, async () => {
      setBusy(true);
      try {
        await api.backfillCreate(tab.connectionId, spec, true);
        await refresh();
      } catch (e) {
        setError(toError(e).message);
      }
      setBusy(false);
    });

  const run = (job: BackfillJob) =>
    confirmed(`${job.committed ? "Resume" : "Run"} ${job.id}?`, `UPDATE ${job.spec.schema}.${job.spec.table} SET ${job.spec.set}\nWHERE … AND (${job.spec.eligible})\n-- ${job.pending} rows pending, batches of ${job.spec.batchSize}`, async () => {
      setRunning(job.id);
      setError(null);
      const channel = new Channel<Record<string, number>>();
      channel.onmessage = (m) => setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, ...m, status: "running" } : j)));
      try {
        const done = await api.backfillRun(tab.connectionId, job.spec.schema, job.id, true, channel as never);
        toast(`${job.id}: ${done.status} (${done.committed} changed, ${done.skipped} skipped, ${done.failed} failed)`, done.status === "done" ? "success" : "info");
      } catch (e) {
        setError(`${toError(e).message}\nCommitted batches stay committed; the job's progress is in the database, so it resumes from there.`);
      }
      setRunning(null);
      await refresh();
    });

  if (connection && connection.engine !== "postgres") return <div className="m-6 text-[12px] text-muted">Resumable backfills work on PostgreSQL.</div>;
  return (
    <Page title="Resumable backfill" intro="Change many rows in batches without long locks, pause safely, and resume after a crash without guessing what happened. The rows to change are listed once; each batch updates only rows that are still eligible and records its progress in the same transaction. Pausing stops before the next batch; it doesn't undo committed ones.">
      <Step n={1} title="The change">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Schema"><Text value={spec.schema} onChange={(schema) => set({ schema })} mono className="w-32" /></Labeled>
          <Labeled label="Table"><Text value={spec.table} onChange={(table) => set({ table })} mono className="w-44" /></Labeled>
          <Labeled label="Unique key"><Text value={spec.key} onChange={(key) => set({ key })} mono className="w-28" /></Labeled>
          <Labeled label="Batch size"><Text value={String(spec.batchSize)} onChange={(v) => set({ batchSize: Number(v.replace(/\D/g, "")) || 1 })} mono className="w-24" /></Labeled>
          <Labeled label="Pause between (ms)"><Text value={String(spec.pauseMs)} onChange={(v) => set({ pauseMs: Number(v.replace(/\D/g, "")) || 0 })} mono className="w-24" /></Labeled>
          <Labeled label="Lock timeout (ms)"><Text value={String(spec.lockTimeoutMs)} onChange={(v) => set({ lockTimeoutMs: Number(v.replace(/\D/g, "")) || 0 })} mono className="w-24" /></Labeled>
          <Labeled label="Stop after failed batches"><Text value={String(spec.maxFailedBatches)} onChange={(v) => set({ maxFailedBatches: Number(v.replace(/\D/g, "")) || 1 })} mono className="w-20" /></Labeled>
        </div>
        <Labeled label="Which rows (WHERE): checked when listing candidates and again in every batch"><SqlArea value={spec.eligible} onChange={(eligible) => set({ eligible })} rows={1} /></Labeled>
        <Labeled label="The change (SET …)"><SqlArea value={spec.set} onChange={(s) => set({ set: s })} rows={1} /></Labeled>
        <Labeled label="Afterwards, no changed row should match (postcondition)"><SqlArea value={spec.postcondition} onChange={(postcondition) => set({ postcondition })} rows={1} /></Labeled>
        <div className="flex gap-2">
          <Button className="h-7" onClick={() => void doPreview()} disabled={!spec.table}>Preview candidates</Button>
          <Button variant="primary" className="h-7" onClick={create} disabled={busy || !spec.table || connection?.readOnly}>Create job</Button>
          <Button variant="ghost" className="h-7" onClick={setupTables}><Wrench className="size-3.5" /> Set up job tables</Button>
        </div>
        {preview && <><p className="text-muted">{preview.count} rows match now (first 10 by {spec.key}):</p><RowsPreview columns={preview.columns} rows={preview.rows} /></>}
        <ErrorNote error={error} />
      </Step>
      <Step n={2} title={`Jobs in ${spec.schema}`} right={<Button variant="ghost" className="h-6 font-normal" onClick={() => void refresh()}><RefreshCw className="size-3.5" /></Button>}>
        {!jobs.length && <p className="text-faint">No jobs here yet (set up the job tables, then create one).</p>}
        {jobs.map((j) => {
          const done = j.committed + j.skipped + j.failed;
          const v = verification[j.id];
          return (
            <div key={j.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">{j.id}</span>
                <span className="font-mono text-muted">{j.spec.table}: SET {j.spec.set}</span>
                <Badge tone={j.status === "done" ? "good" : j.status.startsWith("paused") || j.status === "interrupted" ? "warn" : "accent"}>{j.status}</Badge>
                <span className="flex-1" />
                {running === j.id ? (
                  <Button className="h-6" onClick={() => void api.backfillPause(j.id)}><Pause className="size-3.5" /> Pause after this batch</Button>
                ) : (
                  j.status !== "done" && <Button variant="primary" className="h-6" disabled={!!running} onClick={() => run(j)}>{running === j.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} {j.committed ? "Resume" : "Run"}</Button>
                )}
                {j.failed > 0 && !running && <Button className="h-6" onClick={() => confirmed(`Retry ${j.failed} failed rows?`, `-- ${j.lastError ?? ""}`, async () => { await api.backfillRetry(tab.connectionId, j.spec.schema, j.id, true); await refresh(); })}><RotateCcw className="size-3.5" /> Retry failed</Button>}
                <Button className="h-6" disabled={!!running} onClick={() => void api.backfillVerify(tab.connectionId, j.spec.schema, j.id).then((r) => (setVerification((x) => ({ ...x, [j.id]: r })), void refresh()), (e) => setError(toError(e).message))}><CheckCheck className="size-3.5" /> Verify</Button>
              </div>
              <div className="q-progress"><div style={{ width: `${j.candidates ? (done / j.candidates) * 100 : 0}%` }} /></div>
              <p className="text-muted">{j.candidates.toLocaleString()} candidates · {j.committed.toLocaleString()} changed · {j.skipped.toLocaleString()} skipped (no longer eligible or gone) · {j.failed.toLocaleString()} failed · {j.pending.toLocaleString()} pending · {j.batches} batches</p>
              {j.lastError && <p className="text-[11.5px] text-danger">Last failed batch: {j.lastError} (nothing of that batch was committed)</p>}
              {v && <p className={v.violations ? "text-danger" : "text-success"}>Verified {v.checked.toLocaleString()} changed rows: {v.violations ? `${v.violations} still match the postcondition (e.g. ${v.examples.slice(0, 5).join(", ")})` : "all satisfy the postcondition"}.</p>}
            </div>
          );
        })}
      </Step>
    </Page>
  );
}
