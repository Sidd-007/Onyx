import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

interface Tip {
  text: string;
  shortcut?: string;
  rect: DOMRect | { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

/** Programmatic tooltips (canvas grid headers); DOM elements just set data-tip. */
export const useTip = create<{ tip: Tip | null; show(tip: Tip): void; hide(): void }>((set) => ({
  tip: null,
  show: (tip) => set({ tip }),
  hide: () => set({ tip: null }),
}));

const DELAY_MS = 350;

/**
 * One tooltip for the whole app: any element with `data-tip` (and optional
 * `data-shortcut`) gets a small dark label after a short hover.
 */
export function TooltipLayer() {
  const tip = useTip((s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === current) return;
      current = el;
      window.clearTimeout(timer);
      useTip.getState().hide();
      if (!el) return;
      timer = window.setTimeout(() => {
        const text = el.getAttribute("data-tip");
        if (text) useTip.getState().show({ text, shortcut: el.getAttribute("data-shortcut") ?? undefined, rect: el.getBoundingClientRect() });
      }, DELAY_MS);
    };
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      useTip.getState().hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const below = tip.rect.bottom + 6 + height < window.innerHeight;
    setPos({
      left: Math.max(6, Math.min(tip.rect.left + tip.rect.width / 2 - width / 2, window.innerWidth - width - 6)),
      top: below ? tip.rect.bottom + 6 : tip.rect.top - height - 6,
    });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[90] flex max-w-72 items-center gap-2 rounded-[7px] bg-solid px-2 py-1 font-mono text-[11px] text-solid-text shadow-[var(--shadow)]"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <span className="whitespace-pre-line">{tip.text}</span>
      {tip.shortcut && <span className="rounded-[4px] border border-solid-text/30 px-1 text-[10.5px] text-solid-text/70">{tip.shortcut}</span>}
    </div>
  );
}
