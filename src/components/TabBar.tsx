import { Bookmark, FileCode, LoaderCircle, Plus, Table2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { closeTab, openTabForCurrentConnection } from "../store/actions";
import { useConnections } from "../store/connections";
import { useRuns } from "../store/runs";
import { useOverlays } from "../store/overlays";
import { useTabs } from "../store/tabs";
import { TOOLS } from "./tools";
import { IconButton, useTrafficLightInset } from "./ui";

export function TabBar() {
  const insetLights = useTrafficLightInset("tabs");
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const splitId = useTabs((s) => s.splitId);
  const saved = useConnections((s) => s.saved);
  const runs = useRuns((s) => s.runs);
  const txOpen = useConnections((s) => s.txOpen);
  const strip = useRef<HTMLDivElement>(null);
  // Keep the active tab in view when it changes (⌘1…9, opening one from the sidebar).
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-tab="${activeId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div data-tauri-drag-region className={`flex h-11 shrink-0 items-stretch border-b border-border bg-panel ${insetLights ? "pl-[78px]" : ""}`}>
      <div ref={strip} data-tauri-drag-region className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          const active = tab.id === activeId || tab.id === splitId;
          const focused = tab.id === activeId;
          const connection = saved.find((c) => c.id === tab.connectionId);
          const prod = connection?.environment === "prod";
          const Icon = tab.kind === "table" ? Table2 : tab.kind === "query" ? (tab.savedQueryId ? Bookmark : FileCode) : TOOLS[tab.kind].icon;
          return (
            <div
              key={tab.id}
              data-tab={tab.id}
              onClick={() => useTabs.getState().activate(tab.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const { splitId: current } = useTabs.getState();
                useOverlays.getState().openMenu(e.clientX, e.clientY, [
                  ...(tab.id !== activeId && tab.id !== current ? [{ label: "Open on the right", hint: "split", onSelect: () => useTabs.getState().setSplit(tab.id) }] : []),
                  ...(current ? [{ label: "Close split view", hint: "⌘\\", onSelect: () => useTabs.getState().setSplit(null) }] : []),
                  ...(!current && tab.id === activeId ? [{ label: "Split editor", hint: "⌘\\", onSelect: () => useTabs.getState().toggleSplit() }] : []),
                  "separator",
                  { label: "Close tab", hint: "⌘W", onSelect: () => closeTab(tab.id) },
                  { label: "Close other tabs", onSelect: () => useTabs.getState().tabs.filter((t) => t.id !== tab.id).forEach((t) => closeTab(t.id)) },
                ]);
              }}
              data-tip={`${tab.kind === "table" ? `${tab.schema}.${tab.table}` : tab.title}${connection ? `\n${connection.name}` : ""}`}
              className={`group relative -mb-px flex min-w-28 max-w-56 shrink-0 cursor-default items-center gap-2 border-r border-border pl-3 pr-1.5 text-[12.5px] transition-colors duration-[120ms] ${
                active ? "bg-bg text-fg" : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {/* The active tab joins the editor below; its top edge is ink (red on prod). */}
              {active && <span className={`absolute inset-x-0 top-0 h-[2px] ${prod ? "bg-danger" : "bg-fg"} ${focused ? "" : "opacity-40"}`} />}
              {runs[tab.id]?.status === "running" ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <Icon className={`size-3.5 shrink-0 ${prod ? "text-danger" : ""} ${active ? "" : "opacity-70"}`} />
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {txOpen[tab.id] && (
                <span className="shrink-0 font-mono text-[10px] font-medium tracking-[0.1em] text-fg" title="Open transaction: commit or roll back">
                  TX
                </span>
              )}
              <IconButton
                title="Close tab"
                shortcut="⌘W"
                className={`size-5 shrink-0 rounded-md ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X className="size-3" />
              </IconButton>
            </div>
          );
        })}
      </div>
      <div data-tauri-drag-region className="flex flex-1 items-center pl-1">
        <IconButton title="New query" shortcut="⌘T" onClick={openTabForCurrentConnection}>
          <Plus className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
