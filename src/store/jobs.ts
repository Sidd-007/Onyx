import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toError, type ProgressEvent } from "../lib/ipc";
import { toast } from "./toasts";

export interface Job {
  id: number;
  title: string;
  /** The latest progress line ("Writing rows of users (3/40)"). */
  detail: string | null;
  rows: number | null;
  bytes: number | null;
  startedAt: number;
}

interface JobsStore {
  jobs: Job[];
  update(id: number, patch: Partial<Job>): void;
}

export const useJobs = create<JobsStore>((set) => ({
  jobs: [],
  update: (id, patch) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
}));

let nextId = 1;

export interface JobContext {
  /** A channel for the command's progress events; they show on the job. */
  progress(): Channel<ProgressEvent>;
}

/**
 * Runs long work (exports, dumps) in the background: it shows in the status bar while it
 * runs and ends with a toast. `work` resolves to the success message, or null when the user
 * cancelled (a save dialog), which ends the job quietly.
 */
export function runJob(title: string, work: (job: JobContext) => Promise<string | null>): Promise<void> {
  const id = nextId++;
  useJobs.setState((s) => ({ jobs: [...s.jobs, { id, title, detail: null, rows: null, bytes: null, startedAt: Date.now() }] }));
  const context: JobContext = {
    progress() {
      const channel = new Channel<ProgressEvent>();
      channel.onmessage = (m) => {
        const { update } = useJobs.getState();
        if (m.type === "progress") update(id, { ...(m.rows != null ? { rows: m.rows } : {}), ...(m.bytes != null ? { bytes: m.bytes } : {}) });
        else update(id, { detail: m.line });
      };
      return channel;
    },
  };
  return work(context).then(
    (message) => {
      if (message) toast(message, "success");
    },
    (e) => toast(`${title} failed: ${toError(e).message}`, "error"),
  ).finally(() => useJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })));
}
