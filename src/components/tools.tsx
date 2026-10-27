import { Activity, BellRing, BookOpen, Combine, GitCompare, GitFork, Layers, Lightbulb, FolderSearch, ScanSearch, Users2, FlaskConical, DatabaseZap, Camera, ShieldQuestion, Shapes, ListTree, Timer, Wrench, Code2, Waypoints, Building2, Minimize2, Orbit, ScrollText, History, KeyRound, Network, Radio, Rows3, UsersRound, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { QueryTab, ToolKind } from "../store/tabs";

/** Tool tabs (one per connection, or per table): their title, icon and screen. Each loads when first opened. */
export const TOOLS: Record<ToolKind, { title: string; icon: LucideIcon; view: LazyExoticComponent<ComponentType<{ tab: QueryTab }>> }> = {
  er: { title: "ER diagram", icon: Network, view: lazy(() => import("./ErDiagram")) },
  diff: { title: "Schema diff", icon: GitCompare, view: lazy(() => import("./SchemaDiff")) },
  activity: { title: "Activity", icon: Activity, view: lazy(() => import("./ActivityView")) },
  datadiff: { title: "Compare data", icon: Rows3, view: lazy(() => import("./DataDiff")) },
  users: { title: "Users", icon: UsersRound, view: lazy(() => import("./UsersView")) },
  rediskey: { title: "Key", icon: KeyRound, view: lazy(() => import("./RedisKeyView")) },
  monitor: { title: "Monitor", icon: Radio, view: lazy(() => import("./MonitorView")) },
  changes: { title: "Changes", icon: History, view: lazy(() => import("./ChangesView")) },
  crossdb: { title: "Cross-database query", icon: Combine, view: lazy(() => import("./CrossDbView")) },
  notebook: { title: "Notebook", icon: BookOpen, view: lazy(() => import("./NotebookView")) },
  related: { title: "Related", icon: GitFork, view: lazy(() => import("./RelatedView")) },
  tail: { title: "Live tail", icon: ScrollText, view: lazy(() => import("./TailView")) },
  alerts: { title: "Alerts", icon: BellRing, view: lazy(() => import("./AlertsView")) },
  advisor: { title: "Index advisor", icon: Lightbulb, view: lazy(() => import("./AdvisorView")) },
  migrations: { title: "Migrations", icon: Layers, view: lazy(() => import("./MigrationsView")) },
  investigation: { title: "Investigations", icon: FolderSearch, view: lazy(() => import("./InvestigationView")) },
  context: { title: "Execution contexts", icon: ScanSearch, view: lazy(() => import("./ContextView")) },
  entitydiff: { title: "Compare entities", icon: Users2, view: lazy(() => import("./EntityDiffView")) },
  race: { title: "Race lab", icon: FlaskConical, view: lazy(() => import("./RaceView")) },
  cache: { title: "Cache consistency", icon: DatabaseZap, view: lazy(() => import("./CacheView")) },
  observe: { title: "Before / after", icon: Camera, view: lazy(() => import("./ObserveView")) },
  rls: { title: "Permissions", icon: ShieldQuestion, view: lazy(() => import("./RlsView")) },
  fixtures: { title: "Edge-case fixtures", icon: Shapes, view: lazy(() => import("./FixturesView")) },
  logic: { title: "Query debugger", icon: ListTree, view: lazy(() => import("./LogicView")) },
  perf: { title: "Performance experiment", icon: Timer, view: lazy(() => import("./PerfView")) },
  backfill: { title: "Backfill", icon: Wrench, view: lazy(() => import("./BackfillView")) },
  code: { title: "Find in code", icon: Code2, view: lazy(() => import("./CodeView")) },
  trace: { title: "Request trace", icon: Waypoints, view: lazy(() => import("./TraceView")) },
  tenant: { title: "Tenant workspace", icon: Building2, view: lazy(() => import("./TenantView")) },
  shrink: { title: "Shrink a reproducer", icon: Minimize2, view: lazy(() => import("./ShrinkView")) },
  vector: { title: "Vector search", icon: Orbit, view: lazy(() => import("./VectorView")) },
};
