import { Suspense, useEffect, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionLauncher } from "./components/ConnectionLauncher";
import { ConnectionForm } from "./components/ConnectionForm";
import { EmptyState } from "./components/EmptyState";
import { Overlays } from "./components/Overlays";
import { QueryTabView } from "./components/QueryTabView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TableView } from "./components/TableView";
import { listenForDroppedFiles } from "./lib/dropFiles";
import { api } from "./lib/ipc";
import { listenToMenu } from "./lib/menu";
import { useConnections } from "./store/connections";
import { useLibrary } from "./store/library";
import { applySettings, followSystemAppearance, useSettings } from "./store/settings";
import { useTabs, type QueryTab } from "./store/tabs";
import { startAlerts } from "./store/alerts";
import { useUi } from "./store/ui";
import { DragStrip } from "./components/ui";
import { TOOLS } from "./components/tools";
import { TabErrorBoundary } from "./components/TabErrorBoundary";

function TabContent({ tab }: { tab: QueryTab }) {
  return (
    <TabErrorBoundary key={tab.id} name={tab.title}>
      <TabBody tab={tab} />
    </TabErrorBoundary>
  );
}

function TabBody({ tab }: { tab: QueryTab }) {
  if (tab.kind === "table") return <TableView tab={tab} />;
  if (tab.kind === "query") return <QueryTabView tab={tab} />;
  const Tool = TOOLS[tab.kind].view;
  return <Tool tab={tab} />;
}

function App() {
  const view = useUi((s) => s.view);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const splitId = useTabs((s) => s.splitId);
  const split = !!splitId && splitId !== activeId && tabs.some((t) => t.id === splitId);
  const [splitAt, setSplitAt] = useState(50);
  const panes = useRef<HTMLDivElement>(null);
  const startSplitResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = panes.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) => setSplitAt(Math.min(80, Math.max(20, ((ev.clientX - box.left) / box.width) * 100)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const uiScale = useSettings((s) => s.uiScale);
  const sidebarSide = useSettings((s) => s.sidebarSide);

  useEffect(() => applySettings({ uiScale }), [uiScale]);
  useEffect(followSystemAppearance, []);
  useEffect(startAlerts, []);

  useEffect(() => {
    void (async () => {
      // Startup probe (timing release builds): stop before the vault is opened.
      const probe = "__TAURI_INTERNALS__" in window && (await api.appReady().catch(() => false));
      if (probe) return;
      void useConnections.getState().load().catch(() => {});
      void useLibrary.getState().loadSaved().catch(() => {});
    })();
    const stopMenu = listenToMenu();
    const stopDrop = listenForDroppedFiles();
    return () => {
      stopMenu();
      stopDrop();
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {!sidebarHidden && sidebarSide === "left" && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {(view.kind !== "tabs" || tabs.length === 0) && <DragStrip />}
          {view.kind === "connection-form" ? (
            <ConnectionForm key={view.editingId ?? "new"} editingId={view.editingId} prefill={view.prefill} />
          ) : view.kind === "connections" ? (
            <ConnectionLauncher closable />
          ) : view.kind === "settings" ? (
            <SettingsView />
          ) : null}
          {/* Tabs stay mounted behind Connections and Settings: unsaved tool setups, results and
              editor history survive a visit there. */}
          <div className={view.kind === "tabs" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            {tabs.length > 0 && <TabBar />}
            {/* Keep every tab mounted so editors keep their undo history and scroll. */}
            <div ref={panes} className="flex min-h-0 flex-1">
              {tabs.map((tab) => {
                const left = tab.id === activeId;
                const right = split && tab.id === splitId;
                return (
                  <div
                    key={tab.id}
                    onMouseDown={() => right && useTabs.getState().activate(tab.id)}
                    className={left || right ? `flex min-h-0 min-w-0 flex-col ${right ? "border-l border-border" : ""}` : "hidden"}
                    style={split ? { order: left ? 1 : 3, flex: left ? `0 0 ${splitAt}%` : "1 1 0" } : { flex: "1 1 0" }}
                  >
                    <Suspense fallback={null}>
                      <TabContent tab={tab} />
                    </Suspense>
                  </div>
                );
              })}
              {split && (
                <div
                  onMouseDown={startSplitResize}
                  onDoubleClick={() => setSplitAt(50)}
                  className="-mx-0.5 w-1 shrink-0 cursor-col-resize transition-colors duration-150 hover:bg-accent-soft"
                  style={{ order: 2 }}
                />
              )}
            </div>
            {tabs.length === 0 && <EmptyState />}
          </div>
        </main>
        {!sidebarHidden && sidebarSide === "right" && <Sidebar />}
      </div>
      <StatusBar tab={view.kind === "tabs" ? active : null} />
      <CommandPalette />
      <Overlays />
    </div>
  );
}

export default App;
