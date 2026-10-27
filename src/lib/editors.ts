/** What menu items and the palette can ask of the active tab. Tabs register on mount. */
export interface TabCommands {
  run(mode: "current" | "all"): void;
  format(): void;
  save(): void;
  /** Shows the query plan of the statement under the cursor. */
  explain?(analyze: boolean): void;
  /** Opens the natural-language SQL prompt. */
  askAi?(): void;
}

const registry = new Map<string, TabCommands>();

export function registerTab(tabId: string, commands: TabCommands): () => void {
  registry.set(tabId, commands);
  return () => {
    if (registry.get(tabId) === commands) registry.delete(tabId);
  };
}

export const tabCommands = (tabId: string | null) => (tabId ? registry.get(tabId) : undefined);
