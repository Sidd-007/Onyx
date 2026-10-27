import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { create } from "zustand";
import { api, toError, type ConnectionConfig, type ErrorPayload, type ForeignKeyRef, type HostKeyIssue } from "../lib/ipc";

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; serverVersion: string }
  | { state: "error"; error: ErrorPayload };

interface ConnectionsStore {
  saved: ConnectionConfig[];
  status: Record<string, ConnectionStatus>;
  /** Tables and columns per connection, for editor autocomplete. */
  completion: Record<string, SQLNamespace>;
  /** Bumped to make open schema trees reload. */
  schemaVersion: Record<string, number>;
  /** Every foreign key per connection, for JOIN … ON suggestions. */
  foreignKeys: Record<string, ForeignKeyRef[]>;
  /** Query tabs with a manual transaction open on their session: tab id → connection id. */
  txOpen: Record<string, string>;
  setTxOpen(tabId: string, connectionId: string | null): void;

  load(): Promise<void>;
  save(config: ConnectionConfig, password?: string, sshSecret?: string): Promise<void>;
  remove(id: string): Promise<void>;
  connect(id: string): Promise<boolean>;
  /** After the user checked an unknown SSH host key's fingerprint. */
  trustHostAndConnect(id: string, issue: HostKeyIssue): Promise<boolean>;
  disconnect(id: string): Promise<void>;
  refreshSchema(id: string): Promise<void>;
}

export const useConnections = create<ConnectionsStore>((set, get) => ({
  saved: [],
  status: {},
  completion: {},
  schemaVersion: {},
  foreignKeys: {},
  txOpen: {},

  setTxOpen(tabId, connectionId) {
    set((s) => {
      const { [tabId]: _, ...rest } = s.txOpen;
      return { txOpen: connectionId ? { ...rest, [tabId]: connectionId } : rest };
    });
  },

  async load() {
    set({ saved: await api.listConnections() });
  },

  async save(config, password, sshSecret) {
    await api.saveConnection(config, password, sshSecret);
    await get().load();
  },

  async remove(id) {
    await api.deleteConnection(id);
    set((s) => ({ status: { ...s.status, [id]: { state: "disconnected" } } }));
    await get().load();
  },

  /** Resolves true once connected; failures are kept in `status`. */
  async connect(id) {
    const current = get().status[id];
    if (current?.state === "connected") return true;
    setStatus(id, { state: "connecting" });
    try {
      const info = await api.connect(id);
      setStatus(id, { state: "connected", serverVersion: info.serverVersion });
      void loadCompletion(id);
      return true;
    } catch (e) {
      setStatus(id, { state: "error", error: toError(e) });
      return false;
    }
  },

  async trustHostAndConnect(id, issue) {
    try {
      await api.trustSshHost(issue);
    } catch (e) {
      setStatus(id, { state: "error", error: toError(e) });
      return false;
    }
    return get().connect(id);
  },

  async disconnect(id) {
    await api.disconnect(id);
    setStatus(id, { state: "disconnected" });
    // The server rolls back open transactions when the sessions close.
    set((s) => ({ txOpen: Object.fromEntries(Object.entries(s.txOpen).filter(([, c]) => c !== id)) }));
  },

  async refreshSchema(id) {
    set((s) => ({ schemaVersion: { ...s.schemaVersion, [id]: (s.schemaVersion[id] ?? 0) + 1 } }));
    await loadCompletion(id);
  },
}));

function setStatus(id: string, status: ConnectionStatus) {
  useConnections.setState((s) => ({ status: { ...s.status, [id]: status } }));
}

async function loadCompletion(id: string) {
  try {
    const tables = await api.completionTables(id);
    // Columns carry their type, shown beside them in the completion popup.
    const namespace: Record<string, Record<string, Completion[]>> = {};
    for (const t of tables) {
      (namespace[t.schema] ??= {})[t.name] = t.columns.map((c, i) => ({ label: c, type: "property", detail: t.types[i] ?? "" }));
    }
    useConnections.setState((s) => ({ completion: { ...s.completion, [id]: namespace } }));
  } catch {
    // Autocomplete is best-effort.
  }
  try {
    const keys = await api.allForeignKeys(id);
    useConnections.setState((s) => ({ foreignKeys: { ...s.foreignKeys, [id]: keys } }));
  } catch {
    // JOIN hints are best-effort too.
  }
}

export const isConnected = (status: ConnectionStatus | undefined) => status?.state === "connected";
