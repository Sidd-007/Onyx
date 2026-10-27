import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

interface ToastStore {
  toasts: Toast[];
  push(message: string, kind?: Toast["kind"]): void;
  dismiss(id: number): void;
}

let nextId = 1;

/** Small notices in the corner (exports, copies, errors from menus). */
export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push(message, kind = "info") {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    window.setTimeout(() => get().dismiss(id), kind === "error" ? 8000 : 3500);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = (message: string, kind?: Toast["kind"]) => useToasts.getState().push(message, kind);
