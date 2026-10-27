import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | { label: string; onSelect(): void; danger?: boolean; disabled?: boolean; hint?: string }
  | { heading: string }
  | "separator";

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

/** A right-click style menu at a point. Closes on outside click, Esc, scroll or blur. */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: menu.y + height > window.innerHeight - 8 ? Math.max(8, menu.y - height) : menu.y,
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      role="menu"
      className="q-surface fixed z-[70] min-w-48 rounded-[10px] p-1 text-[12.5px]"
      style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : "heading" in item ? (
          <div key={i} className="q-label whitespace-nowrap px-2.5 pb-1 pt-1.5">
            {item.heading}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex h-7 w-full items-center justify-between gap-6 whitespace-nowrap rounded-[7px] px-2.5 text-left disabled:opacity-40 ${
              item.danger ? "text-danger hover:bg-danger hover:text-white" : "group hover:bg-solid hover:text-solid-text"
            }`}
          >
            {item.label}
            {item.hint && <span className="font-mono text-[10.5px] text-faint group-hover:text-solid-text/60">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
