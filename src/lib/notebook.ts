/** Notebooks (.qnb files): SQL and markdown cells, saved as JSON in the IDE folder. */

export interface Cell {
  id: string;
  type: "sql" | "md";
  source: string;
}

export interface Notebook {
  version: 1;
  cells: Cell[];
}

export const isNotebook = (path: string) => /\.qnb$/i.test(path);

const newId = () => Math.random().toString(36).slice(2, 10);

export const newCell = (type: Cell["type"], source = ""): Cell => ({ id: newId(), type, source });

/** An empty or unreadable file opens as a notebook with one empty SQL cell. */
export function parseNotebook(text: string): Notebook {
  try {
    const raw = JSON.parse(text) as Partial<Notebook>;
    const cells = (Array.isArray(raw.cells) ? raw.cells : [])
      .filter((c): c is Cell => !!c && typeof c.source === "string")
      .map((c) => ({ id: typeof c.id === "string" && c.id ? c.id : newId(), type: c.type === "md" ? ("md" as const) : ("sql" as const), source: c.source }));
    if (cells.length) return { version: 1, cells };
  } catch {
    // Not JSON (a new, empty file).
  }
  return { version: 1, cells: [newCell("sql", text.trim() && !text.trim().startsWith("{") ? text : "")] };
}

export const serializeNotebook = (nb: Notebook) => `${JSON.stringify(nb, null, 2)}\n`;

export type Inline = { kind: "text" | "code" | "bold" | "italic"; text: string } | { kind: "link"; text: string; href: string };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ kind: "italic", text: m[3] ?? m[4] });
    else out.push({ kind: "link", text: m[5], href: m[6] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** A small, safe subset of Markdown (no HTML): headings, lists, code fences, rules, emphasis, links. */
export function markdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", inline: inline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, inline: inline(heading[2]) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(inline(item[3]));
      else blocks.push({ kind: "list", ordered, items: [inline(item[3])] });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
