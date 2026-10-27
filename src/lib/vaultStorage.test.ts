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

const { vaultStorage, flushVaultStorage, moveLegacyCopies } = await import("./vaultStorage");

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

  it("never saves over the vault after a failed read", async () => {
    vault.set("onyx.rls-cases", JSON.stringify({ state: { cases: ["saved"] }, version: 0 }));
    const { api } = await import("./ipc");
    vi.mocked(api.uiStateGet).mockRejectedValueOnce(new Error("vault locked"));
    expect(await vaultStorage!.getItem("onyx.rls-cases")).toBeNull();
    // The store now holds its defaults; saving them must not reach the vault.
    await vaultStorage!.setItem("onyx.rls-cases", { state: { cases: [] }, version: 0 });
    await flushVaultStorage();
    expect(vault.get("onyx.rls-cases")).toContain("saved");
  });

  it("moves every store's plain copy at startup, opened or not, without overwriting the vault", async () => {
    store.set("onyx.tenant-recipes", "plain recipes");
    store.set("onyx.tabs", "old tabs");
    vault.set("onyx.tabs", "newer tabs");
    store.set("unrelated", "keep");
    await moveLegacyCopies();
    expect(vault.get("onyx.tenant-recipes")).toBe("plain recipes");
    expect(vault.get("onyx.tabs")).toBe("newer tabs");
    expect([...store.keys()]).toEqual(["unrelated"]);
  });

  it("keeps the plain copy when the vault is locked", async () => {
    store.set("onyx.alerts", "plain alerts");
    const { api } = await import("./ipc");
    vi.mocked(api.uiStateGet).mockRejectedValueOnce(new Error("vault locked"));
    await moveLegacyCopies(["onyx.alerts"]);
    expect(store.get("onyx.alerts")).toBe("plain alerts");
  });
});
