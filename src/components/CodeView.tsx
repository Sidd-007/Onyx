import { ExternalLink, FolderOpen, Loader2, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, toError } from "../lib/ipc";
import { useIde } from "../store/ide";
import type { QueryTab } from "../store/tabs";
import { useUi } from "../store/ui";
import { Button } from "./ui";
import { Badge, ErrorNote, Labeled, Page, Step, Text } from "./workbench";

type Result = Awaited<ReturnType<typeof api.codeReferences>>;
const TONE = { resolved: "good", probable: "accent", textual: "muted" } as const;

/** F08: where the application's code uses a table or column (the IDE folder). */
export default function CodeView({ tab }: { tab: QueryTab }) {
  const listing = useIde((s) => s.listing);
  const [schema, setSchema] = useState(tab.schema ?? useUi.getState().sidebarSchema[tab.connectionId] ?? "public");
  const [table, setTable] = useState(tab.table ?? "");
  const [column, setColumn] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.codeReferences(schema, table, column.trim() || null));
      setScannedAt(Date.now());
    } catch (e) {
      setError(toError(e).message);
    }
    setBusy(false);
  };
  useEffect(() => {
    if (listing && table) void find();
  }, [listing?.root]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!listing)
    return (
      <Page title="Find in code" intro="Where does the application read or write this table or column? Open the project's folder in IDE mode (it's scanned on this Mac, nothing runs).">
        <Button variant="primary" className="h-7 self-start" onClick={() => void useIde.getState().openFolder()}><FolderOpen className="size-3.5" /> Open the project folder…</Button>
      </Page>
    );
  return (
    <Page title="Find in code" intro={<>Scans <span className="font-mono">{listing.root}</span> (dependencies, build output and .env files are skipped; no project code runs). Resolved: through the Prisma schema's mappings. Probable: SQL or Prisma calls that use the table. Textual: the name just appears.</>}>
      <Step n={1} title="What to find">
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Schema"><Text value={schema} onChange={setSchema} mono className="w-32" /></Labeled>
          <Labeled label="Table"><Text value={table} onChange={setTable} mono className="w-48" /></Labeled>
          <Labeled label="Column (optional)"><Text value={column} onChange={setColumn} mono className="w-40" /></Labeled>
          <Button variant="primary" className="h-7" disabled={busy || !table} onClick={() => void find()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Find</Button>
          {result && <Button variant="ghost" className="h-7" onClick={() => void find()}><RefreshCw className="size-3.5" /> Rescan</Button>}
        </div>
        <ErrorNote error={error} />
      </Step>
      {result && (
        <Step n={2} title={`${result.references.length} references`}>
          <p className="text-[11px] text-faint">
            {result.filesScanned.toLocaleString()} files scanned{result.truncated ? " (stopped at 20,000: partial)" : ""}{result.revision ? ` at commit ${result.revision}` : ""}{scannedAt ? `, ${new Date(scannedAt).toLocaleTimeString()}` : ""}.{result.models.length ? ` Prisma model: ${result.models.join(", ")}.` : " No Prisma model maps to this table."} Dynamic SQL built at run time can't be found this way.
          </p>
          {result.references.map((r, i) => (
            <button key={i} type="button" onClick={() => void api.openCode(r.path, r.line).catch((e) => setError(toError(e).message))} className="group flex items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-hover">
              <Badge tone={TONE[r.kind]}>{r.kind}</Badge>
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[11.5px] text-accent">{r.path}:{r.line}</span> <span className="text-[11px] text-faint">{r.via}</span>
                <span className="block truncate font-mono text-[11px] text-muted">{r.text}</span>
              </span>
              <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </Step>
      )}
    </Page>
  );
}
