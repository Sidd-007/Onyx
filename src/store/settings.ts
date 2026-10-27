import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, onAppearanceChange, systemTheme } from "../lib/themes";

export interface Settings {
  /** Interface zoom, 0.9–1.25. */
  uiScale: number;
  /** Editor and grid font size, px. */
  fontSize: number;
  /** Rows a query tab keeps per result before "Load more" (0: no limit). */
  rowLimit: number;
  /** Cancel queries that run longer than this (0: never). */
  queryTimeoutSec: number;
  /** Record prod connections' queries in history. */
  prodHistory: boolean;
  vim: boolean;
  /** Which side of the window the sidebar is on. */
  sidebarSide: "left" | "right";
  /** Privacy mode (⇧⌘P): personal data is masked in grids. */
  privacy: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  uiScale: 1,
  fontSize: 13,
  rowLimit: 1000,
  queryTimeoutSec: 0,
  prodHistory: true,
  vim: false,
  sidebarSide: "left",
  privacy: false,
};

interface SettingsStore extends Settings {
  set(patch: Partial<Settings>): void;
  reset(): void;
}

/** Preferences, kept in localStorage (nothing secret here; the API key is in the vault). */
export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: "onyx.settings",
      version: 3,
      // Earlier versions had themes (gone: there's one look now).
      migrate: (state) => {
        const { theme: _t, darkTheme: _d, lightTheme: _l, ...s } = state as Partial<Settings> & { theme?: unknown; darkTheme?: unknown; lightTheme?: unknown };
        return { ...DEFAULT_SETTINGS, ...s } as SettingsStore;
      },
    },
  ),
);

export const togglePrivacy = () => useSettings.getState().set({ privacy: !useSettings.getState().privacy });

export const toggleSidebarSide = () =>
  useSettings.getState().set({ sidebarSide: useSettings.getState().sidebarSide === "left" ? "right" : "left" });

/** Puts the palette for macOS's appearance and the zoom on <html>. */
export function applySettings(s: Pick<Settings, "uiScale">) {
  applyTheme(systemTheme());
  document.documentElement.style.setProperty("zoom", String(s.uiScale));
}

/** Re-applies the palette when macOS switches between light and dark. */
export const followSystemAppearance = (): (() => void) => onAppearanceChange(() => applySettings(useSettings.getState()));
