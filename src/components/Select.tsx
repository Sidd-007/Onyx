import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Right-aligned, muted (an engine name, a shortcut). */
  hint?: ReactNode;
  /** What type-ahead and the filter match; defaults to the label when it's text. */
  text?: string;
  disabled?: boolean;
}

interface Props<T extends string | number> {
  value: T;
  // The type comes from `value`, so `onChange={setState}` fits.
  options: SelectOption<NoInfer<T>>[];
  onChange(value: NoInfer<T>): void;
  /** The trigger's look (size, background); the popover is always the app's. */
  className?: string;
  disabled?: boolean;
  /** Tooltip, also the accessible name. */
  title?: string;
  /** Shown when the value isn't one of the options. */
  placeholder?: string;
  /** Replaces the trigger's content (the sidebar's connection and database pickers). */
  children?: ReactNode;
}

/** Above this many options the popover gets a filter field. */
const FILTER_AT = 10;

const textOf = <T extends string | number>(o: SelectOption<T>) => o.text ?? (typeof o.label === "string" ? o.label : String(o.value));

/** A dropdown in Onyx's own style (native selects open the system menu). */
export function Select<T extends string | number>({ value, options, onChange, className, disabled, title, placeholder, children }: Props<T>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  const choose = (v: T) => {
    setOpen(false);
    trigger.current?.focus();
    if (v !== value) onChange(v);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={open ? undefined : title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex min-w-0 items-center gap-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-40 ${
          className ?? "q-field h-7 px-2 text-[12px]"
        }`}
      >
        {children ?? (
          <>
            <span className={`min-w-0 flex-1 truncate ${selected ? "" : "text-faint"}`}>{selected?.label ?? placeholder ?? String(value)}</span>
            <ChevronsUpDown className="size-3 shrink-0 text-faint" />
          </>
        )}
      </button>
      {open && trigger.current && (
        <Popover anchor={trigger.current} options={options} value={value} onChoose={choose} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function Popover<T extends string | number>({
  anchor,
  options,
  value,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement;
  options: SelectOption<T>[];
  value: T;
  onChoose(value: T): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const [filter, setFilter] = useState("");
  const shown = useMemo(
    () => (filter ? options.filter((o) => textOf(o).toLowerCase().includes(filter.toLowerCase())) : options),
    [options, filter],
  );
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const showFilter = options.length > FILTER_AT;
  const filterRef = useRef<HTMLInputElement>(null);

  // Under the trigger, or above it when there's no room; at least the trigger's width.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom - 8;
    const up = height > below && r.top > below;
    const width = Math.max(r.width, 160);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: up ? Math.max(8, r.top - 4 - Math.min(height, r.top - 12)) : r.bottom + 4,
      width,
      maxHeight: Math.min(320, up ? r.top - 12 : below),
    });
  }, [anchor, shown.length]);

  // Focus once placed (a hidden element can't take focus), so the keys reach the list.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) (showFilter ? filterRef.current : ref.current)?.focus();
  }, [placed, showFilter]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const away = (e: Event) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    // Scrolling the page moves the trigger; scrolling the list itself is fine.
    const scroll = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("wheel", scroll, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("wheel", scroll, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  const move = (step: number) => {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + step + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(shown.length - 1);
    else if (e.key === "Enter") {
      const o = shown[active];
      if (o && !o.disabled) onChoose(o.value);
    } else if (e.key === "Escape" || e.key === "Tab") {
      onClose();
      anchor.focus();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !showFilter) {
      // Type-ahead: jump to the first option starting with what was typed.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const i = shown.findIndex((o) => textOf(o).toLowerCase().startsWith(typed.current.text));
      if (i >= 0) setActive(i);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };


  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="listbox"
      aria-activedescendant={`${id}-${active}`}
      onKeyDown={onKeyDown}
      className="q-surface fixed z-[80] flex flex-col overflow-hidden rounded-[10px] p-1 text-[12.5px] outline-none"
      style={pos ? { left: pos.left, top: pos.top, minWidth: pos.width, maxWidth: Math.max(pos.width, 420), maxHeight: pos.maxHeight } : { visibility: "hidden" }}
    >
      {showFilter && (
        <label className="mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-hover px-2">
          <Search className="size-3 text-faint" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            placeholder="Filter"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      )}
      <div ref={list} className="min-h-0 overflow-y-auto">
        {shown.map((o, i) => {
          const isSelected = o.value === value;
          return (
            <div
              key={String(o.value)}
              id={`${id}-${i}`}
              data-index={i}
              role="option"
              aria-selected={isSelected}
              aria-disabled={o.disabled}
              onMouseMove={() => !o.disabled && i !== active && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !o.disabled && onChoose(o.value)}
              className={`flex h-7 cursor-default items-center gap-2 whitespace-nowrap rounded-md pl-1.5 pr-2.5 ${
                o.disabled ? "opacity-40" : i === active ? "q-invert" : ""
              }`}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">{isSelected && <Check className="size-3.5" />}</span>
              <span className={`min-w-0 flex-1 truncate ${isSelected ? "font-medium" : ""}`}>{o.label}</span>
              {o.hint && <span className="shrink-0 pl-4 text-[11px] text-faint">{o.hint}</span>}
            </div>
          );
        })}
        {shown.length === 0 && <div className="px-2.5 py-1.5 text-faint">No matches</div>}
      </div>
    </div>,
    document.body,
  );
}
