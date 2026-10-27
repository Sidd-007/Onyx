import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { api } from "./ipc";

let warned = false;
/** Set by the app: tells the user once that some state isn't being saved. */
let onVaultUnavailable: (message: string) => void = () => {};
export const setVaultUnavailableHandler = (f: (message: string) => void) => void (onVaultUnavailable = f);

/**
 * Storage for UI state that holds SQL or results (tabs, alerts, saved tool setups): the
 * encrypted vault instead of WebKit's plain-text localStorage. A copy left in localStorage by
 * an earlier version is moved into the vault on first read and deleted.
 *
 * Nothing is written for a key until it has been read successfully: a store that changes
 * before it has loaded, or whose read failed (vault locked, Keychain access declined), holds
 * defaults, and saving those would overwrite what's in the vault. After a failed read the key
 * stays unsaved for the session (never falling back to plain text), and the user is told once.
 * Writes are batched per key and flushed when the window hides or closes.
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
      if (stored !== null) {
        loaded.add(key);
        return stored;
      }
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
      loaded.add(key);
      return legacy;
    } catch (e) {
      if (!warned) {
        warned = true;
        onVaultUnavailable(`Onyx couldn't open its encrypted vault (${e instanceof Error ? e.message : String(e)}), so open tabs, alerts and saved setups won't be saved this session. What's already saved is untouched.`);
      }
      return null;
    }
  },
  setItem: (key, value) => queue(key, value),
  removeItem: (key) => queue(key, null),
};

export const vaultStorage = createJSONStorage(() => vaultState);

/** Every store kept in the vault (tool stores load only when their tab opens). */
export const VAULT_KEYS = ["onyx.tabs", "onyx.alerts", "onyx.workspace", "onyx.ide", "onyx.cache-mappings", "onyx.tenant-recipes", "onyx.rls-cases"];

/**
 * At startup: plain-text copies an earlier version left in localStorage move into the vault
 * (unless it already has that key) and are deleted, for every store, opened or not. With the
 * vault locked they stay put, to move next time, rather than being lost.
 */
export async function moveLegacyCopies(keys = VAULT_KEYS): Promise<void> {
  for (const key of keys) {
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(key);
    } catch {
      return;
    }
    if (legacy === null) continue;
    try {
      if ((await api.uiStateGet(key)) === null) await api.uiStateSet(key, legacy);
      localStorage.removeItem(key);
    } catch {
      // Vault locked: keep the copy for next time.
    }
  }
}

/** Writes anything still waiting (tests, and before the app quits). */
export const flushVaultStorage = flush;
