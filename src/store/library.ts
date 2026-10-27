import { create } from "zustand";
import { api, type SavedQuery } from "../lib/ipc";

interface LibraryStore {
  saved: SavedQuery[];
  /** Bumped after each recorded run, so an open history list reloads. */
  historyVersion: number;
  loadSaved(): Promise<void>;
  save(query: SavedQuery): Promise<SavedQuery>;
  remove(id: string): Promise<void>;
  historyChanged(): void;
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  saved: [],
  historyVersion: 0,

  async loadSaved() {
    set({ saved: await api.listSavedQueries() });
  },

  async save(query) {
    const saved = await api.saveQuery(query);
    await get().loadSaved();
    return saved;
  },

  async remove(id) {
    await api.deleteSavedQuery(id);
    await get().loadSaved();
  },

  historyChanged() {
    set((s) => ({ historyVersion: s.historyVersion + 1 }));
  },
}));
