import { useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

/**
 * Icon-only button. `title` becomes a hover tooltip (and the accessible label);
 * `shortcut` is shown beside it.
 */
export function IconButton({
  children,
  className = "",
  title,
  shortcut,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; shortcut?: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={title}
      data-tip={title}
      data-shortcut={shortcut}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] transition-colors duration-[120ms] disabled:opacity-35 disabled:hover:bg-transparent ${
        active ? "bg-selected text-fg" : "text-muted hover:bg-hover hover:text-fg"
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

type Variant = "primary" | "secondary" | "danger" | "destructive" | "ghost";

const variants: Record<Variant, string> = {
  primary: "q-primary border border-transparent",
  secondary: "border border-border-strong bg-raised text-fg hover:bg-hover",
  danger: "border border-transparent text-danger hover:bg-danger-soft",
  destructive: "border border-transparent bg-danger font-[550] text-white hover:opacity-[.88]",
  ghost: "border border-transparent text-muted hover:border-border hover:bg-hover hover:text-fg",
};

export function Button({
  variant = "secondary",
  className = "",
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      data-tip={title}
      className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-medium transition duration-[120ms] disabled:pointer-events-none disabled:opacity-40 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="q-kbd">{children}</kbd>;
}

/** Only non-local environments get a marker; prod is red. */
export function EnvBadge({ environment }: { environment: string }) {
  if (environment === "local") return null;
  const prod = environment === "prod";
  return (
    <span className={`font-mono text-[10px] uppercase tracking-[0.1em] ${prod ? "text-danger" : "text-muted"}`}>
      {environment}
    </span>
  );
}

/** A connection's marker in the chrome: ink, red on prod (its own colour shows on its card). */
export function ConnectionDot({ environment, className = "size-1.5" }: { environment: string; className?: string }) {
  return <span className={`shrink-0 rounded-full ${environment === "prod" ? "bg-danger" : "bg-fg"} ${className}`} />;
}

/** Thin vertical divider between toolbar groups. */
export function Divider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
}

/** The Mac app draws its window buttons over the content (overlay title bar). */
const inMacApp = "__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform);
const subscribeResize = (cb: () => void) => {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
};
/** Full screen hides the window buttons. */
const isFullscreen = () => window.innerWidth >= screen.width && window.innerHeight >= screen.height;

/**
 * Whether this top bar sits under the traffic lights and must leave them room: the sidebar's
 * header when the sidebar is on the left, else the main area's top bar.
 */
export function useTrafficLightInset(where: "sidebar" | "tabs"): boolean {
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const side = useSettings((s) => s.sidebarSide);
  const fullscreen = useSyncExternalStore(subscribeResize, isFullscreen);
  if (!inMacApp || fullscreen) return false;
  const sidebarHasThem = !sidebarHidden && side === "left";
  return where === "sidebar" ? sidebarHasThem : !sidebarHasThem;
}

/** An empty top bar for screens without tabs: keeps the window draggable and the lights clear. */
export function DragStrip() {
  return <div data-tauri-drag-region className="h-11 shrink-0 border-b border-border bg-panel" />;
}
