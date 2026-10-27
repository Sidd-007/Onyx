import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, toError, type ErrorPayload, type QueryMessage, type Risk } from "../lib/ipc";
import { ResultSet } from "../lib/resultSet";
import { connectionLost, readOnly } from "../lib/transactions";
import { changedBySql } from "./dataChanges";
import { useConnections } from "./connections";
import { useLibrary } from "./library";
import { useSettings } from "./settings";

export type Output =
  | { kind: "rows"; result: ResultSet }
  | { kind: "command"; rowsAffected: number };

export interface Run {
  id: number;
  connectionId: string;
  /** "confirm": the prod guard is waiting for the user (see `risks`). */
  status: "running" | "done" | "error" | "cancelled" | "confirm";
  outputs: Output[];
  error: ErrorPayload | null;
  cancelled: boolean;
  /** Where the sent SQL starts in the editor, to place error positions. */
  sqlOffset: number;
  startedAt: number;
  elapsedMs: number | null;
  /** Bumped on every streamed batch so views re-render. */
  version: number;
  sql: string;
  record: boolean;
  risks: Risk[] | null;
  /** Rows kept per result (null: all). */
  maxRows: number | null;
  /** The user pressed Cancel (so a cancel without it was the timeout). */
  cancelRequested: boolean;
  timeoutMs: number | null;
  /** The query tab whose own session ran it (null: the connection's shared session). */
  session: string | null;
  federated?: { alias: string; connectionId: string }[];
  /** Open the result as a chart. */
  chart?: boolean;
  /** A write whose connection dropped before the server answered: it may or may not have happened. */
  outcomeUnknown?: boolean;
}



/** A result kept beside the next runs, to compare. */
export interface PinnedResult {
  result: ResultSet;
  sql: string;
  label: string;
}

export interface RunOptions {
  /** Add to query history (default true). */
  record?: boolean;
  /** The user approved risky statements on a prod connection. */
  confirmed?: boolean;
  /** Keep at most this many rows per result; null or 0 keeps all. */
  maxRows?: number | null;
  /** Defaults to the Settings timeout. */
  timeoutMs?: number | null;
  /** Run on this query tab's own session. */
  session?: string | null;
  /** A cross-database query over these aliased connections (run in an in-memory SQLite). */
  federated?: { alias: string; connectionId: string }[];
  /** Show the result as a chart when it arrives (Ask → chart). */
  chart?: boolean;
}

interface RunsStore {
  runs: Record<string, Run>;
  pinned: Record<string, PinnedResult>;
  pin(tabId: string, pinned: PinnedResult | null): void;
  /** Runs the tab's last SQL again with a different row limit (Load more / Fetch all). */
  rerun(tabId: string, maxRows: number | null): Promise<void>;
  start(tabId: string, connectionId: string, sql: string, sqlOffset: number, opts?: RunOptions): Promise<void>;
  cancel(tabId: string): Promise<void>;
  /** Forgets the tab's result (the ✕ on the results); a running query is left alone. */
  clear(tabId: string): void;
  /** Answers the prod guard: run it anyway, or drop it. */
  confirm(tabId: string, approved: boolean): void;
}

let nextRunId = 1;

export const useRuns = create<RunsStore>((set, get) => ({
  runs: {},
  pinned: {},

  pin(tabId, pinned) {
    set((s) => {
      const { [tabId]: _, ...rest } = s.pinned;
      return { pinned: pinned ? { ...rest, [tabId]: pinned } : rest };
    });
  },

  async rerun(tabId, maxRows) {
    const run = get().runs[tabId];
    if (!run || run.status === "running") return;
    await get().start(tabId, run.connectionId, run.sql, run.sqlOffset, { record: false, maxRows, confirmed: true, session: run.session, federated: run.federated });
  },

  async start(tabId, connectionId, sql, sqlOffset, opts = {}) {
    if (get().runs[tabId]?.status === "running") return;
    const record = opts.record ?? true;
    const maxRows = opts.maxRows || null;
    const timeoutSec = useSettings.getState().queryTimeoutSec;
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : timeoutSec ? timeoutSec * 1000 : null;
    const id = nextRunId++;
    const run: Run = {
      id,
      connectionId,
      status: "running",
      outputs: [],
      error: null,
      cancelled: false,
      sqlOffset,
      startedAt: performance.now(),
      elapsedMs: null,
      version: 0,
      sql,
      record,
      risks: null,
      maxRows,
      cancelRequested: false,
      timeoutMs,
      session: opts.session ?? null,
      federated: opts.federated,
      chart: opts.chart,
    };
    set((s) => ({ runs: { ...s.runs, [tabId]: run } }));

    // Ignore updates from a run that has been replaced.
    const update = (patch: (r: Run) => Partial<Run>) =>
      set((s) => {
        const r = s.runs[tabId];
        if (!r || r.id !== id) return s;
        return { runs: { ...s.runs, [tabId]: { ...r, ...patch(r), version: r.version + 1 } } };
      });
    const fail = (error: ErrorPayload) =>
      update((r) => ({
        status: "error",
        error,
        elapsedMs: performance.now() - r.startedAt,
      }));
    // A dropped connection ends the tab's transaction on the server; a write in flight may or may not have landed.
    const lost = (error: ErrorPayload) => {
      if (!connectionLost(error.message)) return;
      if (opts.session) useConnections.getState().setTxOpen(opts.session, null);
      if (!readOnly(sql)) update(() => ({ outcomeUnknown: true }));
    };
    let finished = () => {};
    const ended = new Promise<void>((resolve) => (finished = resolve));

    for (const id of opts.federated ? opts.federated.map((s) => s.connectionId) : [connectionId]) {
      if (!(await useConnections.getState().connect(id))) {
        const status = useConnections.getState().status[id];
        fail(status?.state === "error" ? status.error : toError("Could not connect"));
        return;
      }
    }

    let current: ResultSet | null = null;
    const channel = new Channel<QueryMessage>();
    channel.onmessage = (message) => {
      if (message instanceof ArrayBuffer) {
        current?.addBatch(message);
        update(() => ({}));
        return;
      }
      switch (message.type) {
        case "resultStart":
          current = new ResultSet(message.columns);
          update((r) => ({ outputs: [...r.outputs, { kind: "rows", result: current! }] }));
          break;
        case "resultEnd":
          if (current) {
            current.complete = true;
            current.truncated = message.truncated;
            current.totalRows = message.rowCount;
          }
          current = null;
          update(() => ({}));
          break;
        case "command":
          update((r) => ({
            outputs: [...r.outputs, { kind: "command", rowsAffected: message.rowsAffected }],
          }));
          break;
        case "error":
          update(() => ({ error: message.error, cancelled: message.cancelled }));
          lost(message.error);
          break;
        case "done":
          update((r) => ({
            status: !r.error ? "done" : r.cancelled ? "cancelled" : "error",
            elapsedMs: message.elapsedMs,
          }));
          if (record) useLibrary.getState().historyChanged();
          // Writes leave open views of those tables out of date.
          if (!get().runs[tabId]?.error && !readOnly(sql)) for (const id of opts.federated ? [] : [connectionId]) changedBySql(id, sql);
          finished();
          break;
      }
    };

    try {
      if (opts.federated) await api.federatedQuery(opts.federated, sql, maxRows, channel);
      else await api.runQuery(connectionId, sql, { record, confirmed: opts.confirmed ?? false, maxRows, timeoutMs, tab: opts.session ?? null }, channel);
      // The call can return before the stream's last messages arrive: callers read the final state.
      let timer = 0;
      await Promise.race([ended, new Promise<void>((resolve) => (timer = window.setTimeout(resolve, 30_000)))]);
      window.clearTimeout(timer);
    } catch (e) {
      const error = toError(e);
      if (error.risks?.length) update(() => ({ status: "confirm", risks: error.risks! }));
      else {
        fail(error);
        lost(error);
      }
    }
  },

  confirm(tabId, approved) {
    const run = get().runs[tabId];
    if (run?.status !== "confirm") return;
    if (approved) {
      void get().start(tabId, run.connectionId, run.sql, run.sqlOffset, {
        record: run.record,
        confirmed: true,
        maxRows: run.maxRows,
        timeoutMs: run.timeoutMs,
        session: run.session,
      });
    } else {
      set((s) => {
        const { [tabId]: _, ...rest } = s.runs;
        return { runs: rest };
      });
    }
  },

  clear(tabId) {
    set((s) => {
      if (!s.runs[tabId] || s.runs[tabId].status === "running") return s;
      const { [tabId]: _, ...runs } = s.runs;
      return { runs };
    });
  },

  async cancel(tabId) {
    const run = get().runs[tabId];
    if (run?.status !== "running") return;
    set((s) => ({ runs: { ...s.runs, [tabId]: { ...run, cancelRequested: true } } }));
    await api.cancelQuery(run.connectionId, run.session).catch(() => {});
  },
}));
