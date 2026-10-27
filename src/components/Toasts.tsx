import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useToasts } from "../store/toasts";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.kind === "error" ? CircleAlert : t.kind === "success" ? CircleCheck : Info;
        return (
          <div
            key={t.id}
            className="q-surface q-dialog pointer-events-auto flex items-start gap-2.5 rounded-[12px] px-3 py-2.5 text-[12.5px]"
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-full ${
                t.kind === "error" ? "text-danger" : "text-muted"
              }`}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 select-text whitespace-pre-line break-words pt-px leading-[1.45]">{t.message}</span>
            <button type="button" className="text-faint hover:text-fg" onClick={() => useToasts.getState().dismiss(t.id)}>
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
