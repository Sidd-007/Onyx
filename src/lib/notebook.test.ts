import { describe, expect, it } from "vitest";
import { inline, markdown, parseNotebook, serializeNotebook } from "./notebook";

describe("notebooks", () => {
  it("round-trips and recovers from empty files", () => {
    const nb = parseNotebook("");
    expect(nb.cells).toHaveLength(1);
    expect(nb.cells[0].type).toBe("sql");
    nb.cells.push({ id: "m", type: "md", source: "# Hi" });
    expect(parseNotebook(serializeNotebook(nb))).toEqual(nb);
    expect(parseNotebook("SELECT 1").cells[0].source).toBe("SELECT 1");
  });

  it("renders a safe markdown subset", () => {
    const blocks = markdown("# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n```\nSELECT 1\n```\n<script>x</script>");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "code", "paragraph"]);
    expect(inline("[docs](https://x.dev) *it*")).toEqual([
      { kind: "link", text: "docs", href: "https://x.dev" },
      { kind: "text", text: " " },
      { kind: "italic", text: "it" },
    ]);
    // HTML stays text.
    expect(blocks[4]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "<script>x</script>" }] });
  });
});
