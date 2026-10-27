import { useConnections } from "../store/connections";
import { ConnectionLauncher } from "./ConnectionLauncher";
import { Kbd } from "./ui";

/** No tabs: the Connections screen until something is connected, then a few hints. */
export function EmptyState() {
  const anyConnected = useConnections((s) => Object.values(s.status).some((st) => st.state === "connected"));
  if (!anyConnected) return <ConnectionLauncher />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <pre className="font-mono text-[12px] leading-tight text-faint">{"[ _ ]"}</pre>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
        onyx<span className="q-caret">_</span>
      </h2>
      <p className="max-w-[320px] text-muted">Open a table from the sidebar, or start a new query.</p>
      <p className="mt-2 flex gap-3 text-muted">
        <span className="flex items-center gap-1.5"><Kbd>⌘K</Kbd> search</span>
        <span className="flex items-center gap-1.5"><Kbd>⌘T</Kbd> new query</span>
        <span className="flex items-center gap-1.5"><Kbd>⌘↵</Kbd> run</span>
      </p>
    </div>
  );
}
