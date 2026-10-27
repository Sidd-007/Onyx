import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { api } from "./ipc";

/**
 * Storage for UI state that holds SQL or results (tabs, alerts, saved tool setups): the
 * encrypted vault instead of WebKit's plain-text localStorage. A copy left in localStorage by
 * an earlier version is moved into the vault on first read and deleted.
 *
 * Nothing is written for a key until it has been read: a store that changes before it has
 * loaded would otherwise save its defaults over what's there. Writes are batched per key and
 * flushed when the window hides or closes. If the vault can't be opened, nothing is kept
 * (rather than falling back to plain text).
 */
const loaded = new Set<string>();
const pending = new Map<string, string | null>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  clearTimeout(timer);
  timer = undefined;
  const writes = [...pending];
  pending.clear();
  await Promise.all(writes.map(([key, value]) => api.uiStateSet(key, value).catch(() => {})));
}

function queue(key: string, value: string | null) {
  if (!loaded.has(key)) return;
  pending.set(key, value);
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), 400);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flush());
  window.addEventListener("beforeunload", () => void flush());
}

const vaultState: StateStorage = {
  async getItem(key) {
    try {
      const stored = await api.uiStateGet(key);
      if (stored !== null) return stored;
      let legacy: string | null = null;
      try {
        legacy = localStorage.getItem(key);
      } catch {
        // No localStorage: nothing to move.
      }
      if (legacy !== null) {
        await api.uiStateSet(key, legacy);
        try {
          localStorage.removeItem(key);
        } catch {
          // Moved already; the plain copy goes next time.
        }
      }
      return legacy;
    } catch {
      return null;
    } finally {
      loaded.add(key);
    }
  },
  setItem: (key, value) => queue(key, value),
  removeItem: (key) => queue(key, null),
};

export const vaultStorage = createJSONStorage(() => vaultState);

/** Writes anything still waiting (tests, and before the app quits). */
export const flushVaultStorage = flush;
