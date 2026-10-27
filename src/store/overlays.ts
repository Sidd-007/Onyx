import { create } from "zustand";
import type { MenuEntry, MenuState } from "../components/ContextMenu";

export interface DangerRequest {
  title: string;
  statement: string;
  connectionName: string;
  prod: boolean;
  action: string;
  /** A sentence of context under the title. */
  detail?: string;
  run(): Promise<void>;
}

interface OverlayStore {
  menu: MenuState | null;
  danger: DangerRequest | null;
  openMenu(x: number, y: number, items: MenuEntry[]): void;
  closeMenu(): void;
  askDanger(request: DangerRequest): void;
  closeDanger(): void;
}

/** One app-wide context menu and one destructive-action confirmation. */
export const useOverlays = create<OverlayStore>((set) => ({
  menu: null,
  danger: null,
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  askDanger: (danger) => set({ danger }),
  closeDanger: () => set({ danger: null }),
}));
