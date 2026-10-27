import { useEffect, type ReactNode } from "react";

/** A centered dialog over a dimmed window. Esc or a click outside closes it. */
export function Modal({ children, onClose, width = "max-w-xl" }: { children: ReactNode; onClose(): void; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className={`q-surface q-dialog w-full ${width} overflow-hidden rounded-[14px]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
