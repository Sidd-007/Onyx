import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Download,
  ListTree,
  LoaderCircle,
  Lock,
  PanelRight,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { drawIcon, typeKind } from "../lib/columnTypes";
import { selectedCells } from "../lib/gridSelection";
import { literal } from "../lib/filters";
import { api, canEditRows, ENGINE_LABEL, toError, type ColumnInfo, type ExportFormat, type ForeignKeyInfo, type RowEdit } from "../lib/ipc";
import type { ResultSet } from "../lib/resultSet";
import { rowAsInsert, rowAsJson } from "../lib/rowFormat";
import { mongoFind } from "../lib/nosql";
import { shown } from "../lib/privacy";
import { pageSql } from "../lib/sqlGen";
import { quoteIdent } from "../lib/sqlSplit";
import { alpha, type Palette } from "../lib/themes";
import { useActiveTheme } from "../lib/useColorScheme";
import { copyText, exportRows, openAndRun, openRelated, openSql, openTable, queryRows, queryScalar } from "../store/actions";
import { useConnections } from "../store/connections";
import { useOverlays } from "../store/overlays";
import { useRuns } from "../store/runs";
import { useSettings } from "../store/settings";
import { affects, useDataChanges } from "../store/dataChanges";
import { looksLikeJson, useJsonExplorer } from "./JsonExplorer";
import { decisions, fieldId, resolve, type Choice, type FieldState } from "../lib/merge";
import { toast } from "../store/toasts";
import { useTabs, type QueryTab } from "../store/tabs";
import { ConfirmRiskDialog } from "./ConfirmRiskDialog";
import { ContextMenu, type MenuState } from "./ContextMenu";
import { FilterBar } from "./FilterBar";
import { Modal } from "./Modal";
import { ProfileDialog } from "./ProfileDialog";
import { copyMenu, handleCopyKey, keepSelectionOnControlClick, headerMenu, RowPanel, SelectionFooter, useColumnLayout, type CopySource } from "./gridParts";
import { JsonEditor } from "./JsonEditor";
import { EXPORT_LABELS } from "./ResultsPanel";
import { estimateWidth, useGridFont } from "./ResultsGrid";
import { StructureView } from "./StructureView";
import { useTip } from "./TooltipLayer";
import { Button, Divider, IconButton } from "./ui";
import { Select } from "./Select";

const PAGE_SIZES = [100, 500, 1000];

/** Changes not yet saved. Row and column numbers refer to the loaded page. */
interface Staged {
  updates: Map<number, Map<number, string | null>>;
  deletes: Set<number>;
  /** New rows; only the columns the user set are inserted (the rest get defaults). */
  inserts: Map<number, string | null>[];
}

const emptyStaged = (): Staged => ({ updates: new Map(), deletes: new Set(), inserts: [] });
const emptySelection: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

export function TableView({ tab }: { tab: QueryTab }) {
  const prod = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId)?.environment === "prod");
  // MongoDB collections have no SELECT: their data opens as a query instead.
  const documents = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId)?.engine === "mongodb");
  const view = documents ? "structure" : (tab.tableView ?? "data");
  const toggle = (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton
        title={documents ? "Find documents" : "Data"}
        active={view === "data"}
        onClick={() =>
          documents
            ? openAndRun(tab.connectionId, tab.table!, mongoFind(tab.table!))
            : useTabs.getState().update(tab.id, { tableView: "data" })
        }
      >
        <Rows3 className="size-3.5" />
      </IconButton>
      <IconButton
        title="Structure"
        active={view === "structure"}
        onClick={() => useTabs.getState().update(tab.id, { tableView: "structure" })}
      >
        <ListTree className="size-3.5" />
      </IconButton>
      <Divider />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {prod && <div className="h-0.5 shrink-0 bg-danger" />}
      {/* Keep the data view mounted so switching to Structure and back doesn't reload. */}
      {!documents && (
        <div className={view === "data" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <TableData tab={tab} leading={toggle} />
        </div>
      )}
      {view === "structure" && (
        <>
          <Toolbar>
            {toggle}
            <span className="flex h-6 items-center truncate text-[12px] text-muted">
              {tab.schema}.<span className="text-fg">{tab.table}</span>
            </span>
          </Toolbar>
          <StructureView connectionId={tab.connectionId} schema={tab.schema!} table={tab.table!} />
        </>
      )}
    </div>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-start gap-1 border-b border-border px-1.5 py-1.5">{children}</div>;
}

function TableData({ tab, leading }: { tab: QueryTab; leading: ReactNode }) {
  const schema = tab.schema!;
  const table = tab.table!;
  const connection = useConnections((s) => s.saved.find((c) => c.id === tab.connectionId));
  // Never connect on our own (e.g. tabs restored at launch): wait for the user.
  const connectionState = useConnections((s) => s.status[tab.connectionId]?.state ?? "disconnected");
  const connected = connectionState === "connected";
  const engine = connection?.engine ?? "postgres";
  const run = useRuns((s) => s.runs[tab.id]);
  const result = run?.outputs.find((o) => o.kind === "rows")?.result;

  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [foreignKeys, setForeignKeys] = useState<Map<string, ForeignKeyInfo>>(new Map());
  const [filter, setFilter] = useState(tab.filter ?? "");
  const [jsonCell, setJsonCell] = useState<{ col: number; row: number } | null>(null);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [total, setTotal] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  const [staged, setStaged] = useState<Staged>(emptyStaged);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [review, setReview] = useState<{ statements: string[]; error?: string; saving?: boolean; fields?: FieldState[]; choices?: Record<string, Choice> } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showRow, setShowRow] = useState(false);

  const q = useCallback((name: string) => quoteIdent(name, engine), [engine]);
  const target = `${q(schema)}.${q(table)}`;
  const baseSql = useMemo(() => {
    let text = `SELECT * FROM ${target}`;
    if (filter.trim()) text += ` WHERE ${filter.trim()}`;
    if (sort) text += ` ORDER BY ${q(sort.column)}${sort.desc ? " DESC" : ""}`;
    return text;
  }, [target, filter, sort, q]);
  const sql = pageSql(engine, baseSql, !!sort, pageSize, page * pageSize);
  const schemaVersion = useConnections((s) => s.schemaVersion[tab.connectionId] ?? 0);

  // Column details (primary key, types) once connected.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void api.listColumns(tab.connectionId, schema, table).then(
      (cols) => live && setColumns(cols),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tab.connectionId, schema, table, connected, schemaVersion]);

  // Single-column foreign keys: their values link to the referenced row.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void api.tableStructure(tab.connectionId, schema, table).then(
      (s) => live && setForeignKeys(new Map(s.foreignKeys.filter((f) => f.columns.length === 1).map((f) => [f.columns[0], f]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tab.connectionId, schema, table, connected, schemaVersion]);

  // Following a foreign key here (or reopening with a filter) applies that filter.
  useEffect(() => {
    if (tab.filterVersion) {
      setFilter(tab.filter ?? "");
      setPage(0);
    }
  }, [tab.filterVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Total rows (with the filter), for the page count.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    setTotal(null);
    const where = filter.trim() ? ` WHERE ${filter.trim()}` : "";
    queryScalar(tab.connectionId, `SELECT COUNT(*) FROM ${target}${where}`).then(
      (n) => live && setTotal(n === null ? null : Number(n)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tab.connectionId, target, filter, reloads, connected]);

  // Rows: browsing doesn't go into query history.
  useEffect(() => {
    if (!connected) return;
    setStaged(emptyStaged());
    setSelection(emptySelection);
    void useRuns.getState().start(tab.id, tab.connectionId, sql, 0, { record: false });
  }, [tab.id, tab.connectionId, sql, reloads, connected]);

  const columnNames = result?.columns ?? columns?.map((c) => c.name) ?? [];
  const keyColumns = columns?.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
  const keyIndexes = result ? keyColumns.map((name) => result.columns.indexOf(name)) : [];
  const editable = !!result && !connection?.readOnly && canEditRows(engine) && keyColumns.length > 0 && keyIndexes.every((i) => i >= 0);
  const changeCount = staged.updates.size + staged.deletes.size + staged.inserts.length;
  const locked = changeCount > 0;

  // Rows changed elsewhere (undo, a query in an editor): reload, or say so when edits are pending.
  const [stale, setStale] = useState<string | null>(null);
  const lastChange = useDataChanges((s) => s.last);
  const seenChange = useRef(lastChange?.seq ?? 0);
  useEffect(() => {
    if (!lastChange || lastChange.seq === seenChange.current) return;
    seenChange.current = lastChange.seq;
    if (!affects(lastChange, tab.connectionId, schema, table)) return;
    if (locked) setStale(lastChange.why);
    else setReloads((n) => n + 1);
  }, [lastChange]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setStale(null), [reloads]);
  const busy = run?.status === "running";

  const stage = (change: (s: Staged) => void) =>
    setStaged((s) => {
      const next: Staged = {
        updates: new Map([...s.updates].map(([r, m]) => [r, new Map(m)])),
        deletes: new Set(s.deletes),
        inserts: s.inserts.map((m) => new Map(m)),
      };
      change(next);
      return next;
    });

  const setCell = (col: number, row: number, value: string | null) => {
    if (!result) return;
    stage((s) => {
      if (row >= result.rowCount) {
        s.inserts[row - result.rowCount]?.set(col, value);
        return;
      }
      const changes = s.updates.get(row) ?? new Map<number, string | null>();
      if (value === result.cell(col, row)) changes.delete(col);
      else changes.set(col, value);
      if (changes.size) s.updates.set(row, changes);
      else s.updates.delete(row);
    });
  };

  /** Many cells at once (paste, "Set value"): rows past the end become new rows. */
  const setCells = (edits: { col: number; row: number; value: string | null }[]) => {
    if (!result || !edits.length) return;
    stage((s) => {
      for (const { col, row, value } of edits) {
        if (row >= result.rowCount) {
          const i = row - result.rowCount;
          while (s.inserts.length <= i) s.inserts.push(new Map());
          s.inserts[i].set(col, value);
          continue;
        }
        if (s.deletes.has(row)) continue;
        const changes = s.updates.get(row) ?? new Map<number, string | null>();
        if (value === result.cell(col, row)) changes.delete(col);
        else changes.set(col, value);
        if (changes.size) s.updates.set(row, changes);
        else s.updates.delete(row);
      }
    });
  };
  const [fill, setFill] = useState<{ cells: [number, number][] } | null>(null);
  const [profiling, setProfiling] = useState<string | null>(null);

  /** Value as shown, staged changes included. */
  const cellValue = (col: number, row: number): string | null => {
    if (!result) return null;
    if (row >= result.rowCount) return staged.inserts[row - result.rowCount]?.get(col) ?? null;
    const changes = staged.updates.get(row);
    return changes?.has(col) ? changes.get(col)! : result.cell(col, row);
  };
  const rowValues = (row: number) => columnNames.map((_, c) => cellValue(c, row));

  /** Rows picked with the checkboxes/row numbers, plus every row a cell selection spans. */
  const selectedRows = (): number[] => {
    const rows = new Set(selection.rows.toArray());
    const range = selection.current?.range;
    if (range) for (let r = range.y; r < range.y + range.height; r++) rows.add(r);
    return [...rows].sort((a, b) => a - b);
  };

  const toggleDelete = (rows: number[]) => {
    if (!result) return;
    stage((s) => {
      const newRows = rows.filter((r) => r >= result.rowCount).map((r) => r - result.rowCount);
      s.inserts = s.inserts.filter((_, i) => !newRows.includes(i));
      for (const r of rows.filter((r) => r < result.rowCount)) {
        if (s.deletes.has(r)) s.deletes.delete(r);
        else s.deletes.add(r);
      }
    });
    setSelection(emptySelection);
  };

  const buildEdits = (): RowEdit[] => {
    if (!result) return [];
    const key = (row: number) => keyColumns.map((column, i) => ({ column, value: result.cell(keyIndexes[i], row) }));
    const cells = (m: Map<number, string | null>) => [...m].map(([col, value]) => ({ column: result.columns[col], value }));
    // The values as loaded: saving refuses if any of them changed since.
    const loaded = (row: number, cols: number[]) => cols.map((col) => ({ column: result.columns[col], value: result.cell(col, row) }));
    const all = result.columns.map((_, i) => i);
    return [
      ...[...staged.updates]
        .filter(([row]) => !staged.deletes.has(row))
        .map(([row, m]): RowEdit => ({ kind: "update", key: key(row), set: cells(m), original: loaded(row, [...m.keys()]) })),
      ...staged.inserts.map((m): RowEdit => ({ kind: "insert", values: cells(m) })),
      ...[...staged.deletes].map((row): RowEdit => ({ kind: "delete", key: key(row), original: loaded(row, all) })),
    ];
  };

  /** The edits as they'll be saved: merged with what others changed since loading (F11). */
  const mergedEdits = (fields: FieldState[], choices: Record<string, Choice>) => resolve(buildEdits(), fields, choices);

  const openReview = async () => {
    try {
      // Three ways: what I loaded, what I changed, what's there now.
      const fields = await api.checkEdits(tab.connectionId, schema, table, buildEdits());
      const choices: Record<string, Choice> = {};
      const edits = mergedEdits(fields, choices);
      setReview({ statements: edits.length ? await api.previewEdits(tab.connectionId, schema, table, edits) : [], fields, choices });
    } catch (e) {
      setReview({ statements: [], error: toError(e).message });
    }
  };

  const choose = async (id: string, choice: Choice) => {
    if (!review?.fields) return;
    const choices = { ...review.choices, [id]: choice };
    const edits = mergedEdits(review.fields, choices);
    setReview({ ...review, choices, statements: edits.length ? await api.previewEdits(tab.connectionId, schema, table, edits) : [] });
  };

  const applyChanges = async () => {
    setReview((r) => r && { ...r, saving: true, error: undefined });
    try {
      // The review dialog is the confirmation, on prod too.
      const fields = review?.fields ?? [];
      const choices = review?.choices ?? {};
      const open = decisions(fields).filter((f) => !f.deleted && !choices[fieldId(f)]);
      if (open.length) throw new Error(`Choose mine or theirs for ${open.length} field${open.length === 1 ? "" : "s"} first`);
      const report = await api.applyEdits(tab.connectionId, schema, table, mergedEdits(fields, choices), true);
      setReview(null);
      setReloads((n) => n + 1);
      if (report.problems.length) {
        toast(`Saved, but the check afterwards found a problem:\n${report.problems.join("\n")}`, "error");
      } else {
        const verified = report.checked ? ` · verified ${report.checked} row${report.checked === 1 ? "" : "s"}` : "";
        toast(`Saved ${report.changed} row${report.changed === 1 ? "" : "s"}${verified}${report.notes.length ? `\n${report.notes.join("\n")}` : ""}`, "success");
      }
    } catch (e) {
      const message = toError(e).message;
      // Changed again since the review: check again, so the review shows the new state.
      if (message.startsWith("Nothing was saved:")) {
        const fields = await api.checkEdits(tab.connectionId, schema, table, buildEdits()).catch(() => review?.fields ?? []);
        setReview((r) => r && { ...r, fields, choices: {}, saving: false, error: "Someone changed these rows again while you reviewed. Check the fields below again." });
        return;
      }
      setReview((r) => r && { ...r, saving: false, error: message });
    }
  };

  const toggleSort = (column: string) => {
    if (locked) return;
    setPage(0);
    setSort((s) => (s?.column !== column ? { column, desc: false } : !s.desc ? { column, desc: true } : null));
  };

  const exportMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const label = EXPORT_LABELS;
    setMenu({
      x: r.right - 160,
      y: r.bottom + 4,
      items: [
        { heading: filter ? "Export filtered rows" : `Export all ${total !== null ? total.toLocaleString() : ""} rows` },
        ...(["csv", "json", "sql", "xlsx"] as ExportFormat[]).map((format) => ({
          label: label[format],
          onSelect: () => void exportRows(tab.connectionId, baseSql, format, table),
        })),
      ],
    });
  };

  /** Opens the row a foreign-key value points to. */
  const follow = (col: number, row: number) => {
    const fk = foreignKeys.get(columnNames[col]);
    const value = cellValue(col, row);
    if (!fk || value === null) return;
    const where = `${quoteIdent(fk.refColumns[0], engine)} = ${literal(value, engine)}`;
    openTable(tab.connectionId, fk.refSchema, fk.refTable, "data", where);
  };

  /** The row picked by its primary key, for the related-rows view. */
  const relatedWhere = (v: (string | null)[]) => {
    const pk = (columns ?? []).filter((c) => c.primaryKey).map((c) => c.name);
    const idx = pk.map((k) => columnNames.indexOf(k));
    if (!pk.length || idx.some((i) => i < 0 || v[i] === null)) return null;
    return pk.map((k, j) => `${quoteIdent(k, engine)} = ${literal(v[idx[j]]!, engine)}`).join(" AND ");
  };

  const cellMenu = (cell: Item, col: number, x: number, y: number, copy: CopySource, cells: [number, number][]) => {
    const row = cell[1];
    if (!result) return;
    const picked = selectedRows();
    // Right-click inside the selection acts on all of it; elsewhere, on that row.
    const rows = picked.includes(row) ? picked : [row];
    if (!picked.includes(row)) {
      setSelection({ ...emptySelection, current: { cell, range: { x: cell[0], y: row, width: 1, height: 1 }, rangeStack: [] } });
    }
    const many = rows.length > 1;
    const n = many ? `${rows.length} rows` : "row";
    const values = rows.map(rowValues);
    const kinds = columnNames.map((c) => typeKind(columnInfo.get(c)?.dataType));
    setMenu({
      x,
      y,
      items: [
        ...copyMenu(copy),
        "separator",
        { heading: many ? `${rows.length} rows` : "Row" },
        {
          label: `Copy ${n} as JSON`,
          onSelect: () =>
            void copyText(
              many ? `[\n${values.map((v) => rowAsJson(columnNames, v, kinds)).join(",\n")}\n]` : rowAsJson(columnNames, values[0], kinds),
              `Copied ${n} as JSON`,
            ),
        },
        {
          label: `Copy ${n} as INSERT`,
          onSelect: () => void copyText(values.map((v) => rowAsInsert(engine, target, columnNames, v)).join("\n"), `Copied ${n} as INSERT`),
        },
        "separator",
        ...(!many && foreignKeys.has(columnNames[col]) && values[0][col] !== null
          ? [
              {
                label: `Open ${foreignKeys.get(columnNames[col])!.refTable} row ${values[0][col]}`,
                hint: "⌘-click",
                onSelect: () => follow(col, row),
              },
            ]
          : []),
        ...(!many && (typeKind(columnInfo.get(columnNames[col])?.dataType) === "json" || looksLikeJson(values[0][col]))
          ? [
              {
                label: "Explore JSON…",
                onSelect: () =>
                  useJsonExplorer.getState().open({
                    column: columnNames[col],
                    value: values[0][col],
                    others: Array.from({ length: result.rowCount }, (_, r) => r).filter((r) => r !== row).map((r) => ({ label: `row ${page * pageSize + r + 1}`, value: cellValue(col, r) })),
                  }),
              },
            ]
          : []),
        ...(!many && editable && typeKind(columnInfo.get(columnNames[col])?.dataType) === "json"
          ? [{ label: "Edit JSON…", onSelect: () => setJsonCell({ col, row }) }]
          : []),
        { label: "Show row details", onSelect: () => setShowRow(true) },
        ...(!many && relatedWhere(values[0])
          ? [{ label: "Show related rows", onSelect: () => openRelated(tab.connectionId, schema, table, relatedWhere(values[0])!) }]
          : []),
        ...(editable
          ? ([
              "separator",
              ...(many ? [] : [{ label: "Set NULL", onSelect: () => setCell(col, row, null) }]),
              { label: cells.length > 1 ? `Set value for ${cells.length} cells…` : "Set value…", onSelect: () => setFill({ cells }) },
              ...(many ? [] : [{ label: "Edit row in a form", onSelect: () => setShowRow(true) }]),
              {
                label: many ? `Duplicate ${n}` : "Duplicate row",
                onSelect: () =>
                  stage((s) => {
                    for (const v of values) {
                      const copy = new Map<number, string | null>();
                      v.forEach((value, c) => !(columns?.find((k) => k.name === columnNames[c])?.primaryKey ?? false) && copy.set(c, value));
                      s.inserts.push(copy);
                    }
                  }),
              },
              {
                label: rows.every((r) => staged.deletes.has(r)) ? `Undo delete` : `Delete ${n}`,
                danger: !rows.every((r) => staged.deletes.has(r)),
                onSelect: () => toggleDelete(rows),
              },
            ] as const)
          : []),
      ],
    });
  };

  const loaded = result?.rowCount ?? 0;
  const pages = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const lastPage = pages !== null ? page >= pages - 1 : loaded < pageSize;
  const goTo = (n: number) => setPage(Math.max(0, pages !== null ? Math.min(n, pages - 1) : n));
  const currentRow = selection.current?.cell[1] ?? selection.rows.first();
  const columnInfo = useMemo(() => new Map((columns ?? []).map((c) => [c.name, c])), [columns]);

  return (
    <>
      <Toolbar>
        {leading}
        <FilterBar
          key={tab.filterVersion ?? 0}
          initialRaw={tab.filter}
          columns={columnNames}
          engine={engine}
          disabled={locked}
          onApply={(where) => {
            setPage(0);
            setFilter(where);
          }}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <Divider />
          <IconButton title="Previous page" disabled={page === 0 || busy || locked} onClick={() => goTo(page - 1)}>
            <ChevronLeft className="size-3.5" />
          </IconButton>
          <PageInput page={page} pages={pages} disabled={busy || locked} onChange={goTo} />
          <IconButton title="Next page" disabled={lastPage || busy || locked} onClick={() => goTo(page + 1)}>
            <ChevronRight className="size-3.5" />
          </IconButton>
          <Select
            value={pageSize}
            disabled={busy || locked}
            title={total !== null ? `${total.toLocaleString()} rows in total` : "Rows per page"}
            options={PAGE_SIZES.map((n) => ({ value: n, label: `${n} / page` }))}
            onChange={(n) => {
              setPage(0);
              setPageSize(n);
            }}
            className="h-6 rounded-md bg-transparent px-1.5 text-[11px] text-muted hover:bg-hover"
          />
          <Divider />
          {editable ? (
            <>
              <IconButton title="Add row" onClick={() => stage((s) => void s.inserts.push(new Map()))}>
                <Plus className="size-3.5" />
              </IconButton>
              <IconButton title="Delete selected rows" disabled={!selectedRows().length} onClick={() => toggleDelete(selectedRows())}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </>
          ) : (
            result &&
            columns && (
              <span
                className="flex size-6 items-center justify-center text-faint"
                data-tip={
                  connection?.readOnly
                    ? "Read-only connection"
                    : !canEditRows(engine)
                      ? `${ENGINE_LABEL[engine]} rows are changed with SQL in a query tab`
                      : "Read-only: this table has no primary key"
                }
              >
                <Lock className="size-3.5" />
              </span>
            )
          )}
          <IconButton title="Refresh" disabled={busy || locked} onClick={() => setReloads((n) => n + 1)}>
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
          </IconButton>
          <IconButton title="Export" disabled={locked} onClick={exportMenu}>
            <Download className="size-3.5" />
          </IconButton>
          <IconButton title="Open as SQL" onClick={() => openSql(`${sql};`, tab.connectionId, { title: table })}>
            <Code className="size-3.5" />
          </IconButton>
          <IconButton title="Row details" active={showRow} onClick={() => setShowRow((v) => !v)}>
            <PanelRight className="size-3.5" />
          </IconButton>
        </div>
      </Toolbar>

      {run?.error && run.status === "error" && (
        <div className="shrink-0 select-text border-b border-border bg-danger-soft px-3 py-1.5 text-[12px] text-danger">
          {run.error.message}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {!connected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-[12px] text-muted">
              Not connected to <span className="text-fg">{connection?.name ?? "this database"}</span>.
            </p>
            <Button
              variant="primary"
              disabled={connectionState === "connecting"}
              onClick={() => void useConnections.getState().connect(tab.connectionId)}
            >
              {connectionState === "connecting" ? "Connecting…" : "Connect"}
            </Button>
          </div>
        ) : result ? (
          <TableGrid
            result={result}
            version={run!.version}
            firstRow={page * pageSize + 1}
            staged={staged}
            editable={editable}
            sort={sort}
            columnInfo={columnInfo}
            foreignKeys={foreignKeys}
            selection={selection}
            onSelection={setSelection}
            onEdit={setCell}
            onCellsChange={setCells}
            onHeaderClick={toggleSort}
            onCellMenu={cellMenu}
            onDeleteRows={toggleDelete}
            onFollow={follow}
            onEditJson={(col, row) => setJsonCell({ col, row })}
            onProfile={setProfiling}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted">
            {busy && <LoaderCircle className="size-4 animate-spin" />}
          </div>
        )}
        {showRow && (
          <RowPanel
            columns={columnNames}
            types={columnNames.map((c) => columnInfo.get(c)?.dataType)}
            values={currentRow !== undefined && result ? rowValues(currentRow) : null}
            onClose={() => setShowRow(false)}
            onEdit={
              editable && currentRow !== undefined && !staged.deletes.has(currentRow)
                ? (c, value) => setCell(c, currentRow, value)
                : undefined
            }
          />
        )}
        {profiling && (
          <ProfileDialog
            column={profiling}
            onClose={() => setProfiling(null)}
            load={async () => {
              // Exact counts from the table; the distribution from a sample of up to 100k values.
              const c = q(profiling);
              const where = filter.trim() ? ` WHERE ${filter.trim()}` : "";
              const counts = await queryRows(tab.connectionId, `SELECT COUNT(*), COUNT(${c}), COUNT(DISTINCT ${c}) FROM ${target}${where}`, 1);
              const [rows, nonNull, distinct] = (counts.rows[0] ?? []).map((v) => Number(v ?? 0));
              const sample = await queryRows(tab.connectionId, pageSql(engine, `SELECT ${c} FROM ${target}${where}`, false, 100_000, 0), 100_000);
              return { values: sample.rows.map((r) => r[0]), sampled: sample.rows.length < rows, exact: { rows, nulls: rows - nonNull, distinct } };
            }}
          />
        )}
        {fill && (
          <FillDialog
            count={fill.cells.length}
            onCancel={() => setFill(null)}
            onApply={(value) => {
              setCells(fill.cells.map(([col, row]) => ({ col, row, value })));
              setFill(null);
            }}
          />
        )}
        {stale && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning/50 bg-raised py-1 pl-3.5 pr-1 text-[12px] shadow-xl">
            <TriangleAlert className="size-3.5 text-warning" />
            <span>
              Rows in this table were {stale === "undone" ? "changed by an undo" : "changed by a query"}: what you see may be out of date.
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setStaged(emptyStaged());
                setReloads((n) => n + 1);
              }}
            >
              Reload (discard my edits)
            </Button>
          </div>
        )}
        {locked && (
          <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-raised py-1 pl-3.5 pr-1 shadow-xl">
            <span className="text-[12px] font-medium" data-tip="Sorting, filters and paging wait until you save or discard">
              {changeCount} unsaved change{changeCount === 1 ? "" : "s"}
            </span>
            <Button variant="ghost" onClick={() => setStaged(emptyStaged())}>
              Discard
            </Button>
            <Button variant="primary" className="rounded-full" onClick={() => void openReview()}>
              Review & save
            </Button>
          </div>
        )}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />

      {jsonCell && (
        <JsonEditor
          column={columnNames[jsonCell.col]}
          value={cellValue(jsonCell.col, jsonCell.row)}
          onCancel={() => setJsonCell(null)}
          onSave={(value) => {
            setCell(jsonCell.col, jsonCell.row, value);
            setJsonCell(null);
          }}
        />
      )}

      {review &&
        connection &&
        (connection.environment === "prod" && !review.error && !review.saving ? (
          <ConfirmRiskDialog
            connectionName={connection.name}
            risks={review.statements.map((statement) => ({ statement, reason: "writes to a prod database" }))}
            action="Save"
            onAnswer={(approved) => (approved ? void applyChanges() : setReview(null))}
          />
        ) : (
          <ReviewDialog
            target={`${schema}.${table}`}
            connectionName={connection?.name ?? ""}
            prod={connection?.environment === "prod"}
            counts={{ updates: [...staged.updates.keys()].filter((r) => !staged.deletes.has(r)).length, inserts: staged.inserts.length, deletes: staged.deletes.size }}
            onReload={() => {
              setReview(null);
              setStaged(emptyStaged());
              setReloads((n) => n + 1);
            }}
            fields={review.fields ?? []}
            choices={review.choices ?? {}}
            onChoose={(id, c) => void choose(id, c)}
            statements={review.statements}
            error={review.error}
            saving={review.saving}
            onCancel={() => setReview(null)}
            onSave={() => void applyChanges()}
          />
        ))}
    </>
  );
}

/** "3 / 50": type a page number and press Enter. */
function PageInput({ page, pages, disabled, onChange }: { page: number; pages: number | null; disabled: boolean; onChange(page: number): void }) {
  const [text, setText] = useState(String(page + 1));
  useEffect(() => setText(String(page + 1)), [page]);
  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted">
      <input
        value={text}
        disabled={disabled}
        aria-label="Page"
        data-tip="Page (type a number, then Enter)"
        onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => e.key === "Enter" && text && onChange(Number(text) - 1)}
        onBlur={() => setText(String(page + 1))}
        className="q-field h-5 w-9 text-center"
      />
      <span>/ {pages === null ? "…" : pages.toLocaleString()}</span>
    </span>
  );
}

function ReviewDialog(props: {
  fields: FieldState[];
  choices: Record<string, Choice>;
  onChoose(id: string, choice: Choice): void;
  target: string;
  connectionName: string;
  prod: boolean;
  counts: { updates: number; inserts: number; deletes: number };
  statements: string[];
  error?: string;
  saving?: boolean;
  onCancel(): void;
  onSave(): void;
  onReload(): void;
}) {
  const { updates, inserts, deletes } = props.counts;
  const existing = updates + deletes;
  const parts = [updates && `update ${updates}`, inserts && `insert ${inserts}`, deletes && `delete ${deletes}`].filter(Boolean).join(", ");
  const undecided = decisions(props.fields).filter((f) => !f.deleted && !props.choices[fieldId(f)]).length;
  const settled = !props.error && !props.saving && props.fields.length > 0 && undecided === 0 && !props.statements.length;
  return (
    <Modal onClose={props.onCancel} width="max-w-2xl">
      <div className="p-5">
        <h2 className="font-semibold">Review changes</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-panel px-3 py-2 text-[12px]">
          <dt className="text-muted">Where</dt>
          <dd className="min-w-0 truncate">
            <span className={props.prod ? "font-medium text-danger" : "font-medium"}>{props.connectionName}</span>
            {props.prod && <span className="ml-1.5 rounded bg-danger-soft px-1 text-[10.5px] font-semibold text-danger">PROD</span>}
            <span className="text-muted"> · </span>
            <span className="font-mono">{props.target}</span>
          </dd>
          <dt className="text-muted">What</dt>
          <dd>
            {parts || "nothing"} row{updates + inserts + deletes === 1 ? "" : "s"}
            {existing > 0 && <span className="text-muted"> · each update and delete must match exactly 1 row</span>}
          </dd>
          <dt className="text-muted">Safety</dt>
          <dd className="text-muted">
            One transaction. Each row is checked against what you loaded first: if anyone changed it since, nothing is saved. Afterwards the rows are read back.
          </dd>
          <dt className="text-muted">Undo</dt>
          <dd className="text-muted">
            {existing > 0 ? "Updates and deletes can be undone later from Changes (undo)." : ""}
            {inserts > 0 ? `${existing > 0 ? " " : ""}Inserted rows can't be undone automatically: delete them if needed.` : ""}
          </dd>
        </dl>
        <pre className="mt-3 max-h-80 select-text overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[12px] leading-relaxed">
          {props.statements.map((s) => `${s};`).join("\n")}
        </pre>
        {props.fields.length > 0 && <MergeFields fields={props.fields} choices={props.choices} onChoose={props.onChoose} />}
        {settled && <p className="mt-3 text-[12px] text-muted">Nothing to save: their values are kept for every field. Done discards your staged edits and reloads the rows.</p>}
        {props.error && (
          <div className="mt-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12px]">
            <p className="select-text whitespace-pre-wrap text-danger">{props.error}</p>
            {props.error.startsWith("Nothing was saved:") && (
              <Button className="mt-2 h-6" onClick={props.onReload}>
                Reload rows (discard my changes)
              </Button>
            )}
          </div>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border bg-panel px-5 py-3">
        <Button onClick={props.onCancel}>Cancel</Button>
        {settled ? (
          // Every conflict went to "theirs": nothing left to write, so finishing drops my edits.
          <Button variant="primary" onClick={props.onReload}>
            Done: keep their values
          </Button>
        ) : (
          <Button variant="primary" onClick={props.onSave} disabled={props.saving || !props.statements.length}>
            {props.saving ? "Saving…" : `Save ${props.statements.length} change${props.statements.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </footer>
    </Modal>
  );
}

/** Staged-edit tints, from the palette (the canvas can't use CSS variables). */
const tints = (p: Palette) => ({ edited: p.selected, inserted: p.track, deleted: alpha(p.danger, 0.12) });
const FONT = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

function TableGrid(props: {
  result: ResultSet;
  version: number;
  /** Row number of the first row on this page. */
  firstRow: number;
  staged: Staged;
  editable: boolean;
  sort: { column: string; desc: boolean } | null;
  columnInfo: Map<string, ColumnInfo>;
  /** Columns that are foreign keys: drawn as links, ⌘-click follows them. */
  foreignKeys: Map<string, ForeignKeyInfo>;
  selection: GridSelection;
  onSelection(selection: GridSelection): void;
  onEdit(col: number, row: number, value: string): void;
  /** Pasted cells (result columns); rows past the end are new rows. */
  onCellsChange(edits: { col: number; row: number; value: string | null }[]): void;
  onHeaderClick(column: string): void;
  /** `display`: the cell as the grid shows it; `col`: the result's column. */
  /** `copy`: the selection to copy (the clicked cell when it was outside the selection). */
  /** `cells`: the selected cells as (result column, row), for "Set value". */
  onCellMenu(display: Item, col: number, x: number, y: number, copy: CopySource, cells: [number, number][]): void;
  onDeleteRows(rows: number[]): void;
  onFollow(col: number, row: number): void;
  onEditJson(col: number, row: number): void;
  onProfile(column: string): void;
}) {
  const { result, staged, editable, columnInfo, foreignKeys } = props;
  const theme = useGridFont();
  const palette = useActiveTheme().palette;
  const tint = useMemo(() => tints(palette), [palette]);
  const rowHeight = useSettings((s) => s.fontSize) + 11;
  const layout = useColumnLayout(result.columns.length, result.columns.join("\u0001"));
  const privacy = useSettings((s) => s.privacy);
  const [searching, setSearching] = useState(false);
  const hasRows = result.rowCount > 0;
  const real = (display: number) => layout.visible[display];

  const columns = useMemo<GridColumn[]>(
    () =>
      layout.visible.map((i) => {
        const name = result.columns[i];
        // Room for the type icon and the sort arrow.
        return { title: name, id: String(i), width: layout.widths[i] ?? Math.min(estimateWidth(result, i) + 30, 440) };
      }),
    [result, layout.visible, layout.widths, hasRows, columnInfo], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** A type icon (a key for primary keys), the name, and an arrow when sorted. Types show on hover. */
  const drawHeader: DrawHeaderCallback = useCallback(
    ({ ctx, column, rect }) => {
      const info = columnInfo.get(column.title);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      const midY = rect.y + rect.height / 2;
      let x = rect.x + 8;
      if (info) {
        const pk = info.primaryKey;
        const fk = foreignKeys.has(column.title);
        drawIcon(ctx, pk ? "key" : typeKind(info.dataType), x, midY - 6, 12, pk ? theme.textDark! : fk ? theme.textMedium! : theme.textLight!);
        x += 18;
      }
      ctx.textBaseline = "middle";
      ctx.font = `${theme.headerFontStyle ?? "600 11.5px"} ${FONT}`;
      ctx.fillStyle = theme.textHeader!;
      ctx.fillText(column.title, x, midY);
      if (props.sort?.column === column.title) {
        ctx.font = `9px ${FONT}`;
        ctx.fillStyle = theme.textDark!;
        ctx.fillText(props.sort.desc ? "▼" : "▲", rect.x + rect.width - 14, midY);
      }
      ctx.restore();
    },
    [columnInfo, foreignKeys, theme, props.sort],
  );

  const headerTip = (col: number, bounds: { x: number; y: number; width: number; height: number }) => {
    const name = result.columns[real(col)];
    const info = columnInfo.get(name);
    if (!info) return useTip.getState().hide();
    const fk = foreignKeys.get(name);
    const details = [
      info.dataType,
      info.primaryKey && "primary key",
      fk && `→ ${fk.refTable}.${fk.refColumns.join(", ")} (⌘-click a value to open it)`,
      !info.nullable && "not null",
      info.default && `default ${info.default}`,
    ]
      .filter(Boolean)
      .join(" · ");
    useTip.getState().show({
      text: `${name}\n${details}`,
      rect: { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, width: bounds.width, height: bounds.height },
    });
  };

  const valueAt = useCallback(
    (col: number, row: number): string | null => {
      if (row >= result.rowCount) return staged.inserts[row - result.rowCount]?.get(col) ?? null;
      const changes = staged.updates.get(row);
      return changes?.has(col) ? changes.get(col)! : result.cell(col, row);
    },
    [result, staged],
  );
  const displayValue = useCallback((col: number, row: number) => valueAt(real(col), row), [valueAt, layout.visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowCount = result.rowCount + staged.inserts.length;
  const copySource = (selection: GridSelection): CopySource => ({
    selection,
    rows: rowCount,
    names: layout.visible.map((i) => result.columns[i]),
    value: displayValue,
    kinds: layout.visible.map((i) => typeKind(columnInfo.get(result.columns[i])?.dataType)),
  });

  const getCellContent = useCallback(
    ([display, row]: Item): GridCell => {
      const col = real(display);
      const name = result.columns[col];
      let background: string | undefined;
      let unset = false;
      const deleted = staged.deletes.has(row);
      if (row >= result.rowCount) {
        unset = !staged.inserts[row - result.rowCount]?.has(col);
        background = tint.inserted;
      } else if (staged.updates.get(row)?.has(col)) {
        background = tint.edited;
      }
      const raw = valueAt(col, row);
      // Privacy mode: masked, and not editable in place (the dots would be saved).
      const value = shown(name, raw, privacy);
      const masked = value !== raw;
      if (deleted) background = tint.deleted;
      const json = editable && typeKind(columnInfo.get(name)?.dataType) === "json";
      const link = value !== null && foreignKeys.has(name) && !deleted;
      const display_ =
        value === null ? (unset ? "DEFAULT" : "NULL") : value.length > 300 ? `${value.slice(0, 300)}…` : value;
      return {
        kind: GridCellKind.Text,
        data: value ?? "",
        displayData: display_.replace(/\r?\n/g, " ↵ "),
        // JSON cells open the JSON editor instead of the inline one.
        allowOverlay: !json && !masked,
        readonly: !editable || deleted || masked,
        themeOverride: {
          ...(background ? { bgCell: background } : {}),
          ...(value === null || deleted ? { textDark: theme.textLight } : link ? { textDark: theme.linkColor } : {}),
        },
      };
    },
    [result, props.version, staged, editable, theme, layout.visible, foreignKeys, columnInfo, valueAt, privacy], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        className="relative min-h-0 flex-1"
        onKeyDown={(e) => {
          if (e.metaKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            e.stopPropagation();
            setSearching(true);
            return;
          }
          handleCopyKey(e, () => copySource(props.selection));
        }}
        onMouseDownCapture={keepSelectionOnControlClick}
      >
        <div className="absolute inset-0">
          <DataEditor
            columns={columns}
            rows={result.rowCount + staged.inserts.length}
            getCellContent={getCellContent}
            getCellsForSelection={true}
            drawHeader={drawHeader}
            showSearch={searching}
            onSearchClose={() => setSearching(false)}
            onCellEdited={([col, row], cell) => {
              if (cell.kind === GridCellKind.Text) props.onEdit(real(col), row, cell.data);
            }}
            // Cells copied from a spreadsheet (tab-separated): staged like edits, new rows past the end.
            onPaste={([col, row], values) => {
              if (!editable) return false;
              const edits: { col: number; row: number; value: string | null }[] = [];
              values.forEach((line, r) =>
                line.forEach((value, c) => {
                  const display = col + c;
                  if (display < layout.visible.length) edits.push({ col: real(display), row: row + r, value: value === "" || value === "NULL" ? null : value });
                }),
              );
              props.onCellsChange(edits);
              return false;
            }}
            onCellActivated={([col, row]) => {
              const c = real(col);
              if (editable && typeKind(columnInfo.get(result.columns[c])?.dataType) === "json" && !staged.deletes.has(row)) {
                props.onEditJson(c, row);
              }
            }}
            onCellClicked={([col, row], event) => {
              const c = real(col);
              if ((event.metaKey || event.ctrlKey) && foreignKeys.has(result.columns[c])) props.onFollow(c, row);
            }}
            onCellContextMenu={(cell, event) => {
              event.preventDefault();
              const inside = [...selectedCells(props.selection, rowCount, layout.visible.length)].some(([c, r]) => c === cell[0] && r === cell[1]);
              const picked: GridSelection = inside
                ? props.selection
                : { ...emptySelection, current: { cell, range: { x: cell[0], y: cell[1], width: 1, height: 1 }, rangeStack: [] } };
              const cells = [...selectedCells(picked, rowCount, layout.visible.length, 50_000)].map(([c, r]): [number, number] => [real(c), r]);
              props.onCellMenu(cell, real(cell[0]), event.bounds.x + event.localEventX, event.bounds.y + event.localEventY, copySource(picked), cells);
            }}
            onHeaderClicked={(col) => props.onHeaderClick(result.columns[real(col)])}
            onHeaderContextMenu={(col, event) => {
              event.preventDefault();
              const c = real(col);
              const name = result.columns[c];
              useOverlays
                .getState()
                .openMenu(event.bounds.x + event.localEventX, event.bounds.y + event.localEventY, headerMenu({ name, column: c, layout, profile: () => props.onProfile(name) }));
            }}
            onItemHovered={(args) => (args.kind === "header" ? headerTip(args.location[0], args.bounds) : useTip.getState().hide())}
            onColumnResize={(column, size) => layout.resize(Number(column.id), size)}
            onColumnMoved={(from, to) => layout.move(from, to)}
            gridSelection={props.selection}
            onGridSelectionChange={props.onSelection}
            rowMarkers={{
              kind: "both",
              startIndex: props.firstRow,
              // Wide enough for the last row number on the page.
              width: Math.max(40, String(props.firstRow + result.rowCount).length * 7 + 18),
            }}
            rowSelectionMode="multi"
            onDelete={(sel) => {
              const rows = sel.rows.toArray();
              if (props.editable && rows.length) props.onDeleteRows(rows);
              return false;
            }}
            smoothScrollX
            smoothScrollY
            rowHeight={rowHeight}
            headerHeight={rowHeight + 4}
            theme={theme}
            width="100%"
            height="100%"
          />
        </div>
      </div>
      <SelectionFooter
        selection={props.selection}
        rows={result.rowCount + staged.inserts.length}
        columns={layout.visible.length}
        value={displayValue}
      >
        {layout.hiddenCount > 0 && (
          <button type="button" className="hover:text-fg" onClick={() => layout.showAll()}>
            {layout.hiddenCount} hidden column{layout.hiddenCount === 1 ? "" : "s"} · Show
          </button>
        )}
      </SelectionFooter>
    </div>
  );
}

/** One value for many cells: text, or NULL. */
function FillDialog({ count, onCancel, onApply }: { count: number; onCancel(): void; onApply(value: string | null): void }) {
  const [value, setValue] = useState("");
  const [isNull, setIsNull] = useState(false);
  return (
    <Modal onClose={onCancel} width="max-w-sm">
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(isNull ? null : value);
        }}
      >
        <h2 className="font-semibold">Set {count === 1 ? "the cell" : `${count.toLocaleString()} cells`} to</h2>
        <input autoFocus value={value} disabled={isNull} onChange={(e) => setValue(e.target.value)} className="q-field h-8 px-2.5 font-mono text-[12.5px] disabled:opacity-40" placeholder="value" />
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} /> NULL
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit">
            Stage change
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** F11: fields someone else changed since you loaded them, three ways. */
function MergeFields({ fields, choices, onChoose }: { fields: FieldState[]; choices: Record<string, Choice>; onChoose(id: string, choice: Choice): void }) {
  const label = (key: FieldState["key"]) => key.map((k) => `${k.column} = ${k.value ?? "NULL"}`).join(", ");
  const v = (x: string | null | undefined) => (x === undefined ? "—" : x === null ? "NULL" : x);
  const settled = fields.filter((f) => f.converged);
  const open = fields.filter((f) => !f.converged);
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning-soft/40 p-3 text-[12px]">
      <div className="font-medium">Changed by someone else since you loaded these rows</div>
      <p className="text-muted">Their changes to fields you didn't edit are kept as they are. For each field you both changed, choose which value to keep.</p>
      {open.map((f) => {
        const id = fieldId(f);
        if (f.deleted) {
          return (
            <div key={id} className="rounded-md bg-panel px-2.5 py-1.5">
              <span className="font-mono">{label(f.key)}</span>: deleted (or its key changed) since you loaded it. Your change to it won't be saved; it isn't recreated.
            </div>
          );
        }
        return (
          <div key={id} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 rounded-md bg-panel px-2.5 py-1.5">
            <div className="min-w-0">
              <span className="font-mono">{label(f.key)}</span> · <span className="font-medium">{f.column || "row"}</span>
              <div className="truncate font-mono text-[11px] text-faint">loaded {v(f.base)}</div>
            </div>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={id} checked={choices[id] === "mine"} onChange={() => onChoose(id, "mine")} />
              <span>{f.mine === undefined ? "delete anyway" : <>mine: <span className="font-mono">{v(f.mine)}</span></>}</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={id} checked={choices[id] === "theirs"} onChange={() => onChoose(id, "theirs")} />
              <span>
                {f.mine === undefined ? "keep the row: " : "theirs: "}
                <span className="font-mono">{v(f.theirs)}</span>
              </span>
            </label>
          </div>
        );
      })}
      {settled.length > 0 && <p className="text-[11px] text-muted">{settled.length} field{settled.length === 1 ? "" : "s"} already hold the value you wanted (changed the same way by someone else): nothing to save there.</p>}
    </div>
  );
}
