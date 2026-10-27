import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import type { Engine } from "./ipc";

/** Typed shortcuts with tab stops: `sel` ⇥ → SELECT * FROM … LIMIT 100. */
export function snippets(engine: Engine): Completion[] {
  const s = (label: string, template: string, detail: string) =>
    snippetCompletion(template, { label, detail, type: "text", boost: -1 });
  const list = [
    s("sel", "SELECT *\nFROM ${table}\nLIMIT ${100};", "SELECT … LIMIT"),
    s("selw", "SELECT *\nFROM ${table}\nWHERE ${condition}\nLIMIT ${100};", "SELECT … WHERE"),
    s("cnt", "SELECT count(*)\nFROM ${table};", "count rows"),
    s("grp", "SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY count(*) DESC;", "group and count"),
    s("ins", "INSERT INTO ${table} (${columns})\nVALUES (${values});", "INSERT"),
    s("upd", "UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};", "UPDATE … WHERE"),
    s("del", "DELETE FROM ${table}\nWHERE ${condition};", "DELETE … WHERE"),
    s("cte", "WITH ${name} AS (\n  ${query}\n)\nSELECT *\nFROM ${name};", "WITH … AS"),
    s("join", "JOIN ${table} ${alias} ON ${alias}.${column} = ${other}", "JOIN … ON"),
    s("dup", "SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nHAVING count(*) > 1;", "find duplicates"),
  ];
  if (engine === "postgres") {
    list.push(
      s("ctbl", "CREATE TABLE ${name} (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${column} ${text} NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);", "CREATE TABLE"),
      s("size", "SELECT relname, pg_size_pretty(pg_total_relation_size(oid))\nFROM pg_class\nWHERE relkind = 'r'\nORDER BY pg_total_relation_size(oid) DESC\nLIMIT ${20};", "largest tables"),
    );
  } else if (engine === "mysql") {
    list.push(
      s("ctbl", "CREATE TABLE ${name} (\n  id BIGINT AUTO_INCREMENT PRIMARY KEY,\n  ${column} ${VARCHAR(255)} NOT NULL,\n  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);", "CREATE TABLE"),
      s("size", "SELECT table_name, round((data_length + index_length) / 1024 / 1024, 1) AS mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY mb DESC\nLIMIT ${20};", "largest tables"),
    );
  } else {
    list.push(s("ctbl", "CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY,\n  ${column} ${TEXT} NOT NULL\n);", "CREATE TABLE"));
  }
  return list;
}
