import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = new Map<string, string>();
vi.mock("./ipc", () => ({
  api: {
    uiStateGet: vi.fn(async (key: string) => vault.get(key) ?? null),
    uiStateSet: vi.fn(async (key: string, value: string | null) => void (value === null ? vault.delete(key) : vault.set(key, value))),
  },
}));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { vaultStorage, flushVaultStorage } = await import("./vaultStorage");

describe("vault storage", () => {
  beforeEach(() => {
    vault.clear();
    store.clear();
  });

  it("moves an old plain-text copy into the vault and deletes it", async () => {
    store.set("onyx.tabs", JSON.stringify({ state: { sql: "SELECT secret" }, version: 2 }));
    const got = await vaultStorage!.getItem("onyx.tabs");
    expect(got?.state).toEqual({ sql: "SELECT secret" });
    expect(store.has("onyx.tabs")).toBe(false);
    expect(vault.get("onyx.tabs")).toContain("SELECT secret");
  });

  it("never writes before a key has loaded, so defaults can't overwrite saved state", async () => {
    vault.set("onyx.alerts", JSON.stringify({ state: { alerts: [1] }, version: 1 }));
    await vaultStorage!.setItem("onyx.alerts", { state: { alerts: [] }, version: 1 });
    await flushVaultStorage();
    expect(vault.get("onyx.alerts")).toContain("[1]");
    await vaultStorage!.getItem("onyx.alerts");
    await vaultStorage!.setItem("onyx.alerts", { state: { alerts: [2] }, version: 1 });
    await flushVaultStorage();
    expect(vault.get("onyx.alerts")).toContain("[2]");
    expect(store.size).toBe(0);
  });
});
