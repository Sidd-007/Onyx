import { Code, ListFilter, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import { OPERATORS, whereClause, type Filter, type Operator } from "../lib/filters";
import type { Engine } from "../lib/ipc";
import { IconButton } from "./ui";
import { Select } from "./Select";

/**
 * Compact filters: column ▾ operator ▾ value, more rows with +, or a raw WHERE
 * clause (</>). Enter applies.
 */
export function FilterBar({
  columns,
  engine,
  disabled,
  onApply,
  initialRaw,
}: {
  columns: string[];
  engine: Engine;
  disabled?: boolean;
  onApply(where: string): void;
  /** A WHERE clause already applied (following a foreign key). */
  initialRaw?: string;
}) {
  const blank = (): Filter => ({ column: columns[0] ?? "", op: "=", value: "" });
  const [mode, setMode] = useState<"builder" | "raw">(initialRaw ? "raw" : "builder");
  const [filters, setFilters] = useState<Filter[]>([blank()]);
  const [raw, setRaw] = useState(initialRaw ?? "");
  const [applied, setApplied] = useState(initialRaw ?? "");

  // Columns arrive after the first load.
  if (filters.length === 1 && !filters[0].column && columns[0]) setFilters([blank()]);

  const apply = () => {
    const where = mode === "raw" ? raw.trim() : whereClause(filters, engine);
    setApplied(where);
    onApply(where);
  };
  const clear = () => {
    setFilters([blank()]);
    setRaw("");
    setApplied("");
    onApply("");
  };
  const update = (i: number, patch: Partial<Filter>) => setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  const field =
    "q-field h-6 min-w-0 px-1.5 text-[12px] disabled:opacity-50";
  const actions = (
    <>
      {applied && (
        <IconButton title={`Clear filter\n${applied}`} onClick={clear}>
          <X className="size-3.5" />
        </IconButton>
      )}
      <IconButton title="Apply filter" shortcut="↵" disabled={disabled} onClick={apply} className={applied ? "text-accent" : ""}>
        <Search className="size-3.5" />
      </IconButton>
    </>
  );

  if (mode === "raw") {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <IconButton title="Use the filter builder" active onClick={() => setMode("builder")}>
          <Code className="size-3.5" />
        </IconButton>
        <input
          autoFocus
          value={raw}
          disabled={disabled}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={onKey}
          placeholder="WHERE …   e.g. status = 'paid' AND total > 1000"
          spellCheck={false}
          className={`${field} flex-1 font-mono`}
        />
        {actions}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {filters.map((f, i) => {
        const op = OPERATORS.find((o) => o.value === f.op)!;
        return (
          <div key={i} className="flex min-w-0 items-center gap-1">
            {i === 0 ? (
              <span className="flex size-6 shrink-0 items-center justify-center text-faint" data-tip="Filter rows">
                <ListFilter className="size-3.5" />
              </span>
            ) : (
              <span className="w-6 shrink-0 text-center text-[10px] font-semibold text-faint">AND</span>
            )}
            <Select
              className={`${field} w-32 min-w-16`}
              value={f.column}
              disabled={disabled}
              onChange={(column) => update(i, { column })}
              options={columns.map((c) => ({ value: c, label: c }))}
            />
            <Select
              className={`${field} w-28 min-w-16`}
              value={f.op}
              disabled={disabled}
              onChange={(op: Operator) => update(i, { op })}
              options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <input
              value={f.value}
              disabled={disabled || !op.needsValue}
              onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={onKey}
              placeholder={op.needsValue ? (f.op === "in" ? "a, b, c" : "value") : ""}
              spellCheck={false}
              className={`${field} min-w-24 flex-1 basis-24 font-mono`}
            />
            {i === 0 ? (
              <>
                <IconButton title="Add a filter" disabled={disabled} onClick={() => setFilters((fs) => [...fs, blank()])}>
                  <Plus className="size-3.5" />
                </IconButton>
                <IconButton
                  title="Write a raw WHERE clause"
                  onClick={() => {
                    setRaw(whereClause(filters, engine));
                    setMode("raw");
                  }}
                >
                  <Code className="size-3.5" />
                </IconButton>
                {actions}
              </>
            ) : (
              <IconButton title="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>
        );
      })}
    </div>
  );
}
