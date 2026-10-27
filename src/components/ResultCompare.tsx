import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { formatCount } from "../lib/format";
import { diffResults, keyIssue, suggestKey, type DiffRow, type Table } from "../lib/resultDiff";
import type { ResultSet } from "../lib/resultSet";
import { Select } from "./Select";

const SHOWN = 2000;

function toTable(r: ResultSet): Table {
  return { columns: r.columns, rows: Array.from({ length: r.rowCount }, (_, row) => r.columns.map((_, c) => r.cell(c, row))) };
}

const TINT: Record<DiffRow["kind"], string> = {
  added: "bg-selected",
  removed: "bg-danger-soft",
  changed: "bg-hover",
};
const MARK: Record<DiffRow["kind"], string> = { added: "+", removed: "−", changed: "~" };

/** What changed between the pinned result and the latest one. */
export default function ResultCompare({ before, after }: { before: ResultSet; after: ResultSet }) {
  const shared = after.columns.filter((c) => before.columns.includes(c));
  const tables = useMemo(() => ({ before: toTable(before), after: toTable(after) }), [before, after]);
  const [key, setKey] = useState<string | null>(() => suggestKey(tables.before, tables.after));
  const diff = useMemo(() => diffResults(tables.before, tables.after, key), [tables, key]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-[11.5px]">
        <span className="text-success">+{formatCount(diff.added)} added</span>
        <span className="text-danger">−{formatCount(diff.removed)} removed</span>
        {key !== null && !diff.keyProblem && <span className="text-warning">~{formatCount(diff.changed)} changed</span>}
        <span className="text-muted">{formatCount(diff.same)} same</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-muted">
          Match rows by
          <Select
            value={key ?? ""}
            onChange={(v) => setKey(v || null)}
            options={[
              { value: "", label: "whole row" },
              ...shared.map((c) => {
                const issue = keyIssue(tables.before, c, "pinned") ?? keyIssue(tables.after, c, "latest");
                return { value: c, label: c, hint: issue ? "not unique" : "unique" };
              }),
            ]}
            className="h-6 max-w-48 rounded-md bg-hover px-1.5 text-[11.5px] text-fg"
          />
        </label>
      </div>
      {diff.keyProblem && (
        <p className="flex shrink-0 items-center gap-1.5 border-b border-border bg-warning-soft px-3 py-1.5 text-[12px] text-warning">
          <TriangleAlert className="size-3.5 shrink-0" />
          Can't match rows by {key}: {diff.keyProblem}, so rows would be paired wrongly. Comparing whole rows instead; pick a unique column.
        </p>
      )}
      <p className="shrink-0 border-b border-border bg-panel px-3 py-1 text-[11px] text-muted">
        {key !== null && !diff.keyProblem ? (
          <>
            A row is the same row in both results when its <span className="font-mono text-fg">{key}</span> matches; then any other value that differs shows as a change.
          </>
        ) : (
          <>Rows are matched by all their values, so an edited row shows as one removed and one added. Pick an identifying column to see changed cells.</>
        )}
        {diff.columns.length < Math.max(before.columns.length, after.columns.length) && ` Comparing the ${diff.columns.length} columns both results have.`}
      </p>
      <div className="min-h-0 flex-1 select-text overflow-auto">
        {diff.rows.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-muted">The results are the same.</p>
        ) : (
          <table className="min-w-full font-mono text-[11.5px]">
            <thead className="sticky top-0 bg-panel text-left text-[11px] text-faint">
              <tr>
                <th className="w-6 px-2 py-1" />
                {diff.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {diff.rows.slice(0, SHOWN).map((r, i) => (
                <tr key={i} className={`border-t border-border ${TINT[r.kind]}`}>
                  <td className="px-2 py-0.5 text-center text-muted">{MARK[r.kind]}</td>
                  {r.row.map((v, c) => (
                    <td key={c} className="max-w-80 truncate whitespace-nowrap px-2 py-0.5">
                      {r.kind === "changed" && r.changed.has(c) ? (
                        <>
                          <span className="text-danger line-through">{r.before[c] ?? "NULL"}</span>{" "}
                          <span className="text-success">{v ?? "NULL"}</span>
                        </>
                      ) : v === null ? (
                        <span className="text-faint">NULL</span>
                      ) : (
                        v
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {diff.rows.length > SHOWN && (
          <p className="p-3 text-center text-[11px] text-faint">Showing the first {formatCount(SHOWN)} differences.</p>
        )}
      </div>
    </div>
  );
}
