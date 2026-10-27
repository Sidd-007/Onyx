import { describe, expect, it } from "vitest";
import { quoteIdent, splitStatements, statementAt } from "./sqlSplit";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe("splitStatements", () => {
  it("splits on top-level semicolons and trims", () => {
    expect(texts("select 1;\n  select 2 ;select 3")).toEqual(["select 1", "select 2", "select 3"]);
  });

  it("ignores semicolons in strings, identifiers and comments", () => {
    const sql = `select 'a;b', "c;d" -- e;f
      /* g; /* nested; */ h; */ from t; select 2`;
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("handles doubled quotes and E-string escapes", () => {
    expect(texts("select 'it''s;'; select E'\\';'; select 3")).toEqual([
      "select 'it''s;'",
      "select E'\\';'",
      "select 3",
    ]);
  });

  it("keeps dollar-quoted function bodies whole", () => {
    const sql = `create function f() returns int language plpgsql as $body$
      begin return 1; end; $body$; select f();`;
    expect(texts(sql)).toHaveLength(2);
    expect(texts("select $$a;b$$; select 2")).toEqual(["select $$a;b$$", "select 2"]);
  });

  it("does not treat $1 parameters as dollar quotes", () => {
    expect(texts("select $1; select 2")).toEqual(["select $1", "select 2"]);
  });

  it("drops blank and comment-only pieces", () => {
    expect(texts(";; -- just a comment\n; select 1;")).toEqual(["select 1"]);
  });

  it("reports offsets into the original text", () => {
    const sql = "select 1;\n\n  select 2;";
    const [, second] = splitStatements(sql);
    expect(sql.slice(second.start, second.end)).toBe("select 2");
  });
});

describe("splitStatements (MySQL)", () => {
  const my = (sql: string) => splitStatements(sql, "mysql").map((s) => s.text);

  it("skips semicolons in backticks, # comments and backslash-escaped strings", () => {
    expect(my("select `a;b` from t # c;d\n; select 'x\\';y', \"p\\\";q\"; select 3")).toEqual([
      "select `a;b` from t # c;d",
      "select 'x\\';y', \"p\\\";q\"",
      "select 3",
    ]);
  });

  it("only treats -- as a comment when followed by whitespace", () => {
    expect(my("select 1--1; select 2")).toEqual(["select 1--1", "select 2"]);
    expect(my("select 1 -- c;\n; select 2")).toEqual(["select 1 -- c;", "select 2"]);
  });

  it("has no dollar quoting", () => {
    expect(my("select $$a; select 2")).toEqual(["select $$a", "select 2"]);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\nselect 2;\n\n";
  it("finds the statement containing the cursor", () => {
    expect(statementAt(sql, 12)?.text).toBe("select 2");
  });
  it("uses the statement just before the cursor when between statements", () => {
    expect(statementAt(sql, sql.length)?.text).toBe("select 2");
    expect(statementAt(sql, 9)?.text).toBe("select 1");
  });
  it("returns null for empty text", () => {
    expect(statementAt("  ", 0)).toBeNull();
  });
});

describe("quoteIdent", () => {
  it("leaves simple names alone and quotes the rest", () => {
    expect(quoteIdent("users")).toBe("users");
    expect(quoteIdent("Users")).toBe('"Users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
  it("always backticks for MySQL", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
  });
});
