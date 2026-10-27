import { describe, expect, it } from "vitest";
import { exactNumber, rowAsInsert, rowAsJson, rowsAsCsv, rowsAsMarkdown } from "./rowFormat";

describe("row formats", () => {
  it("copies rows as JSON, CSV and INSERT", () => {
    expect(JSON.parse(rowAsJson(["id", "name"], ["1", null]))).toEqual({ id: "1", name: null });
    expect(
      JSON.parse(
        rowAsJson(
          ["id", "big", "price", "ok", "meta", "name"],
          ["7", "9007199254740993", "12.50", "1", '{"a":1}', "x"],
          ["number", "number", "number", "bool", "json", "text"],
        ),
      ),
    ).toEqual({ id: 7, big: "9007199254740993", price: 12.5, ok: true, meta: { a: 1 }, name: "x" });
    // Numbers inside a JSON column keep every digit.
    expect(rowAsJson(["meta"], ['{"n":9007199254740993}'], ["json"])).toBe('{\n  "meta": {\n    "n": 9007199254740993\n  }\n}');
    expect(rowsAsCsv(["id", "note"], [["1", 'a "b", c'], ["2", null]])).toBe('id,note\n1,"a ""b"", c"\n2,');
    expect(rowAsInsert("mysql", "`users`", ["id", "name"], ["1", "O'Neil"])).toBe(
      "INSERT INTO `users` (`id`, `name`) VALUES ('1', 'O\\'Neil');",
    );
    expect(rowAsInsert("postgres", "users", ["id"], [null])).toBe("INSERT INTO users (id) VALUES (NULL);");
  });
});

describe("clipboard formats keep values exact", () => {
  const columns = ["big", "money", "tenth", "blank", "nothing", "words", "controls"];
  const row = ["9223372036854775807", "12345678901234567890.123456789", "0.1", "", null, "naïve café — 你好 👋🏽 עברית", "a\tb\nc"];

  it("JSON never rounds numbers, and keeps NULL and '' apart", () => {
    const parsed = JSON.parse(rowAsJson(columns, row, ["number", "number", "number", "text", "text", "text", "text"]));
    expect(parsed.big).toBe("9223372036854775807");
    expect(parsed.money).toBe("12345678901234567890.123456789");
    expect(parsed.tenth).toBe(0.1);
    expect(parsed.blank).toBe("");
    expect(parsed.nothing).toBeNull();
    expect(parsed.words).toBe(row[5]);
    expect(exactNumber("1.50")).toBe(1.5);
    expect(exactNumber("42")).toBe(42);
    expect(exactNumber("007")).toBeNull();
    expect(exactNumber("9007199254740993")).toBeNull();
  });

  it("CSV writes NULL as an empty field and '' as \"\"", () => {
    expect(rowsAsCsv(columns, [row])).toBe(`${columns.join(",")}\n9223372036854775807,12345678901234567890.123456789,0.1,"",,naïve café — 你好 👋🏽 עברית,"a\tb\nc"`);
  });

  it("Markdown and INSERT tell NULL from ''", () => {
    expect(rowsAsMarkdown(["a", "b"], [[null, ""]])).toContain("| NULL |  |");
    expect(rowAsInsert("postgres", "t", ["a", "b"], [null, ""])).toBe('INSERT INTO t (a, b) VALUES (NULL, \'\');');
  });
});
