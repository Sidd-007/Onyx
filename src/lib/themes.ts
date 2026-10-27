/**
 * Onyx's look: black and white, like a precise developer tool. Ink on paper in light mode,
 * chalk on slate in dark mode, following macOS. Hierarchy comes from weight, size, spacing and
 * hairlines, never colour: the one colour is red, for errors and destructive actions.
 *
 * `applyTheme` writes the palette to CSS variables on <html> (index.css has the same values for
 * the first paint); the results grid, a canvas, reads the palette directly.
 */

export interface Palette {
  /** Editor, grid and content. */
  bg: string;
  /** Sidebar, toolbars, tab strip, status bar. */
  panel: string;
  /** Menus, dialogs, inputs, cards. */
  raise: string;
  /** Hairlines between regions. */
  line: string;
  lineStrong: string;
  /** The three text levels: content, secondary, labels / counts / hints. */
  text: string;
  muted: string;
  faint: string;
  hover: string;
  selected: string;
  /** The inverted fill (primary button, current menu item, tooltip) and the text on it. */
  solid: string;
  solidText: string;
  /** Empty part of progress bars and zero values in charts. */
  track: string;
  danger: string;
  /** For floating layers only (menus, dialogs, tooltips): a full box-shadow. */
  shadow: string;
}

export interface Theme {
  mode: "dark" | "light";
  palette: Palette;
}

export const LIGHT: Theme = {
  mode: "light",
  palette: {
    bg: "#fafaf9",
    panel: "#f3f3f1",
    raise: "#ffffff",
    line: "rgba(10,10,10,.08)",
    lineStrong: "rgba(10,10,10,.16)",
    text: "#0a0a0a",
    muted: "#6f6f6b",
    faint: "#a8a8a3",
    hover: "rgba(10,10,10,.035)",
    selected: "rgba(10,10,10,.065)",
    solid: "#0a0a0a",
    solidText: "#fafaf9",
    track: "rgba(10,10,10,.09)",
    danger: "#d4362c",
    shadow: "0 1px 0 rgba(0,0,0,.02), 0 24px 64px -12px rgba(0,0,0,.22)",
  },
};

export const DARK: Theme = {
  mode: "dark",
  palette: {
    bg: "#09090b",
    panel: "#0e0e10",
    raise: "#141416",
    line: "rgba(255,255,255,.07)",
    lineStrong: "rgba(255,255,255,.14)",
    text: "#fafafa",
    muted: "#8b8b93",
    faint: "#4b4b52",
    hover: "rgba(255,255,255,.035)",
    selected: "rgba(255,255,255,.07)",
    solid: "#fafafa",
    solidText: "#09090b",
    track: "rgba(255,255,255,.07)",
    danger: "#ff6159",
    shadow: "0 0 0 1px rgba(255,255,255,.06), 0 24px 64px -12px rgba(0,0,0,.7)",
  },
};

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The palette for macOS's current appearance. */
export const systemTheme = (): Theme => (darkQuery.matches ? DARK : LIGHT);

/** Calls `cb` when macOS switches between light and dark. */
export function onAppearanceChange(cb: () => void): () => void {
  darkQuery.addEventListener("change", cb);
  return () => darkQuery.removeEventListener("change", cb);
}

/** `#rrggbb` with an alpha, as rgba(). */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Every CSS variable a theme sets: the RDM tokens, and the names the components were written
 * with (`--fg`, `--accent`, `--border`…) as aliases, so they all follow without a colour of
 * their own. Success and warning are not colours here: they map to text levels.
 */
export function themeVariables(theme: Theme): Record<string, string> {
  const p = theme.palette;
  return {
    "--bg": p.bg,
    "--panel": p.panel,
    "--raise": p.raise,
    "--line": p.line,
    "--line-strong": p.lineStrong,
    "--text": p.text,
    "--muted": p.muted,
    "--faint": p.faint,
    "--hover": p.hover,
    "--selected": p.selected,
    "--solid": p.solid,
    "--solid-text": p.solidText,
    "--track": p.track,
    "--danger": p.danger,
    "--shadow": p.shadow,
    // Aliases.
    "--raised": p.raise,
    "--input": p.raise,
    "--border": p.line,
    "--border-strong": p.lineStrong,
    "--fg": p.text,
    "--accent": p.solid,
    "--accent-fg": p.solidText,
    "--accent-soft": p.selected,
    "--accent-ring": p.selected,
    "--danger-soft": `color-mix(in srgb, ${p.danger} 10%, transparent)`,
    "--success": p.text,
    "--success-soft": p.selected,
    "--warning": p.muted,
    "--warning-soft": p.hover,
    // Code: weight and the three text levels, no hues.
    "--hl-keyword": p.text,
    "--hl-string": p.muted,
    "--hl-number": p.text,
    "--hl-type": p.muted,
    "--hl-comment": p.faint,
  };
}

/** Puts the theme on <html>: its variables, `color-scheme`, and data-mode for the CSS. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);
  root.style.colorScheme = theme.mode;
  root.dataset.mode = theme.mode;
}
