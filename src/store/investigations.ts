import { create } from "zustand";
import { newInvestigation, parseInvestigation, withEvidence, type ConnectionRef, type Evidence, type Investigation } from "../lib/investigation";
import { api, toError, type ConnectionConfig } from "../lib/ipc";
import { toast } from "./toasts";

interface InvestigationsStore {
  list: { id: string; title: string; updatedAt: number }[];
  /** Evidence waiting for the user to pick which investigation it goes into. */
  pending: Evidence | null;
  /**
   * The investigation open in the Investigations tab. One copy for everyone: evidence filed
   * from another tool lands here too, so the view is never stale and an edit there can't save
   * over newly filed evidence.
   */
  current: Investigation | null;
  open(id: string): Promise<void>;
  /** Changes the open investigation; saved shortly after (`flush` saves now). */
  edit(next: Investigation): void;
  flush(): Promise<void>;
  create(): Promise<void>;
  refresh(): Promise<void>;
  load(id: string): Promise<Investigation>;
  save(inv: Investigation): Promise<void>;
  remove(id: string): Promise<void>;
  /** Asks where to keep `e` (an existing investigation, or a new one). */
  offer(e: Omit<Evidence, "id" | "observedAt"> & { observedAt?: number }): void;
  /** Adds the pending evidence to `id` (or a new investigation titled `title`). */
  file(id: string | null, title: string): Promise<string | null>;
}

export const connectionRef = (c: ConnectionConfig): ConnectionRef => ({ id: c.id, name: c.name, engine: c.engine, environment: c.environment });

let saveTimer: number | undefined;

export const useInvestigations = create<InvestigationsStore>((set, get) => ({
  list: [],
  pending: null,
  current: null,

  async open(id) {
    await get().flush();
    try {
      set({ current: await get().load(id) });
    } catch (e) {
      toast(toError(e).message, "error");
    }
  },

  edit(next) {
    set({ current: next });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().flush(), 500);
  },

  async flush() {
    if (saveTimer === undefined) return;
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    const inv = get().current;
    if (inv) await get().save(inv).catch((e) => toast(toError(e).message, "error"));
  },

  async create() {
    await get().flush();
    const inv = newInvestigation("Untitled investigation");
    await get().save(inv);
    set({ current: inv });
  },

  async refresh() {
    try {
      set({ list: await api.listInvestigations() });
    } catch (e) {
      toast(toError(e).message, "error");
    }
  },

  async load(id) {
    return parseInvestigation(await api.getInvestigation(id));
  },

  async save(inv) {
    await api.saveInvestigation(inv.id, inv.title, JSON.stringify(inv));
    await get().refresh();
  },

  async remove(id) {
    if (get().current?.id === id) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      set({ current: null });
    }
    await api.deleteInvestigation(id);
    await get().refresh();
  },

  offer(e) {
    set({ pending: { ...e, id: crypto.randomUUID(), observedAt: e.observedAt ?? Date.now() } });
    void get().refresh();
  },

  async file(id, title) {
    const e = get().pending;
    if (!e) return null;
    try {
      // Unsaved edits to the open investigation go first, so filing builds on them.
      await get().flush();
      const open = get().current;
      const inv = id ? (open?.id === id ? open : await get().load(id)) : newInvestigation(title);
      const next = withEvidence(inv, e);
      await get().save(next);
      // The Investigations tab shows where the evidence went (a new investigation included).
      set({ pending: null, current: next });
      toast(`Saved to “${inv.title}”`, "success");
      return inv.id;
    } catch (err) {
      toast(toError(err).message, "error");
      return null;
    }
  },
}));
