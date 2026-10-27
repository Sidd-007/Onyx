import { useSyncExternalStore } from "react";
import { onAppearanceChange, systemTheme, type Theme } from "./themes";

/** The palette in effect (it follows macOS). Needed where colours can't be CSS variables (the grid's canvas). */
export function useActiveTheme(): Theme {
  return useSyncExternalStore(onAppearanceChange, systemTheme);
}

export const useColorScheme = (): "light" | "dark" => useActiveTheme().mode;
