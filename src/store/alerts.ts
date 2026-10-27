import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isRead } from "../lib/advisor";
import { api, toError } from "../lib/ipc";
import { useConnections } from "./connections";
import { toast } from "./toasts";

export type AlertCondition = "rows" | "none" | "above" | "below";

/** A saved read query checked on an interval while Onyx is open; it notifies when its condition turns true. */
export interface QueryAlert {
  id: string;
  name: string;
  connectionId: string;
  sql: string;
  everyMin: number;
  condition: AlertCondition;
  threshold: number;
  enabled: boolean;
  lastRun?: number;
  /** The first value of the last result (or its row count, for row conditions). */
  lastValue?: string | null;
  lastError?: string | null;
  firing?: boolean;
}

export const CONDITION_LABEL: Record<AlertCondition, string> = {
  rows: "returns any rows",
  none: "returns no rows",
  above: "first value is above",
  below: "first value is below",
};

/** Whether a result meets the alert's condition, and the value to show. */
export function evaluate(alert: Pick<QueryAlert, "condition" | "threshold">, rows: (string | null)[][]): { firing: boolean; value: string | null } {
  if (alert.condition === "rows" || alert.condition === "none") {
    const value = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
    return { firing: alert.condition === "rows" ? rows.length > 0 : rows.length === 0, value };
  }
  const raw = rows[0]?.[0] ?? null;
  const n = raw === null ? NaN : Number(raw);
  if (Number.isNaN(n)) return { firing: false, value: raw };
  return { firing: alert.condition === "above" ? n > alert.threshold : n < alert.threshold, value: raw };
}

interface AlertsStore {
  alerts: QueryAlert[];
  save(alert: QueryAlert): void;
  remove(id: string): void;
  check(id: string): Promise<void>;
}

const checking = new Set<string>();

export const useAlerts = create<AlertsStore>()(
  persist(
    (set, get) => ({
      alerts: [],
      save(alert) {
        set((s) => ({ alerts: s.alerts.some((a) => a.id === alert.id) ? s.alerts.map((a) => (a.id === alert.id ? { ...a, ...alert } : a)) : [...s.alerts, alert] }));
      },
      remove(id) {
        set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
      },
      async check(id) {
        const alert = get().alerts.find((a) => a.id === id);
        if (!alert || checking.has(id)) return;
        checking.add(id);
        const patch = (p: Partial<QueryAlert>) => set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, ...p } : a)) }));
        try {
          if (!isRead(alert.sql)) throw new Error("Alerts run a single SELECT only");
          if (!(await useConnections.getState().connect(alert.connectionId))) throw new Error("Couldn't connect");
          const out = await api.adminQuery(alert.connectionId, alert.sql.trim().replace(/;\s*$/, ""));
          const { firing, value } = evaluate(alert, out.rows);
          if (firing && !alert.firing) {
            const body = `${alert.name}: ${CONDITION_LABEL[alert.condition]}${alert.condition === "above" || alert.condition === "below" ? ` ${alert.threshold}` : ""} (${value ?? "NULL"})`;
            toast(body, "info");
            void api.notify("Onyx alert", body).catch(() => {});
          }
          patch({ lastRun: Date.now(), lastValue: value, lastError: null, firing });
        } catch (e) {
          patch({ lastRun: Date.now(), lastError: toError(e).message });
        } finally {
          checking.delete(id);
        }
      },
    }),
    { name: "onyx.alerts", version: 1 },
  ),
);

/** Checks due alerts every 20 seconds while the app is open. Returns a stop function. */
export function startAlerts(): () => void {
  const tick = () => {
    const now = Date.now();
    for (const a of useAlerts.getState().alerts) {
      if (a.enabled && now - (a.lastRun ?? 0) >= a.everyMin * 60_000) void useAlerts.getState().check(a.id);
    }
  };
  const first = window.setTimeout(tick, 5000);
  const timer = window.setInterval(tick, 20_000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(timer);
  };
}
