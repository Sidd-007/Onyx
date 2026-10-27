import { listen } from "@tauri-apps/api/event";
import { closeActiveTab, openTabForCurrentConnection } from "../store/actions";
import { useIde } from "../store/ide";
import { useRuns } from "../store/runs";
import { useTabs } from "../store/tabs";
import { togglePrivacy, toggleSidebarSide } from "../store/settings";
import { useUi } from "../store/ui";
import { openDatabaseFile } from "./dropFiles";
import { tabCommands } from "./editors";
import { api } from "./ipc";

/** Native menu items (src-tauri/src/menu.rs) arrive as a `menu` event with the item id. */
export function listenToMenu(): () => void {
  // ⌘K also works from the page itself (it only ever opens, so seeing it twice is harmless).
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      useUi.getState().setPaletteOpen(true);
    }
  };
  window.addEventListener("keydown", onKey);
  if (!("__TAURI_INTERNALS__" in window)) return () => window.removeEventListener("keydown", onKey);
  const active = () => useTabs.getState().activeId;
  const handlers: Record<string, () => void> = {
    "new-query": openTabForCurrentConnection,
    "new-connection": () => useUi.getState().newConnection(),
    "save-query": () => tabCommands(active())?.save(),
    "close-tab": closeActiveTab,
    run: () => tabCommands(active())?.run("current"),
    "run-all": () => tabCommands(active())?.run("all"),
    format: () => tabCommands(active())?.format(),
    cancel: () => {
      const id = active();
      if (id) void useRuns.getState().cancel(id);
    },
    palette: () => useUi.getState().setPaletteOpen(true),
    settings: () => useUi.getState().showSettings(),
    "toggle-sidebar": () => useUi.getState().toggleSidebar(),
    "sidebar-side": toggleSidebarSide,
    "toggle-results": () => useUi.getState().toggleResults(),
    "toggle-ide": () => useIde.getState().toggle(),
    "toggle-split": () => useTabs.getState().toggleSplit(),
    "toggle-privacy": togglePrivacy,
    explain: () => tabCommands(active())?.explain?.(false),
    "ask-ai": () => tabCommands(active())?.askAi?.(),
    "open-file": () =>
      void api
        .pickFile("Open a SQLite or DuckDB database", ["db", "sqlite", "sqlite3", "db3", "duckdb", "ddb"])
        .then((path) => (path ? openDatabaseFile(path) : undefined)),
  };
  const unlisten = listen<string>("menu", (event) => handlers[event.payload]?.());
  return () => {
    window.removeEventListener("keydown", onKey);
    void unlisten.then((stop) => stop());
  };
}
