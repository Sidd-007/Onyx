import { TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "./ui";

/** A crash inside one tab stays in that tab: the rest of the app (and other tabs) keep working. */
export class TabErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-lg flex-col gap-2 rounded-xl border border-border bg-panel p-4 text-[12px]">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4 text-danger" /> {this.props.name} hit an error
          </div>
          <p className="text-muted">Nothing was changed by it. Your other tabs are fine; reload this one to try again.</p>
          <pre className="max-h-40 select-text overflow-auto rounded bg-raised p-2 font-mono text-[11px] text-danger">{this.state.error.message}</pre>
          <Button className="h-7 self-start" onClick={() => this.setState({ error: null })}>Reload this tab</Button>
        </div>
      </div>
    );
  }
}
