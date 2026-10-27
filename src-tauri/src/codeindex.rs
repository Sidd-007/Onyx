//! F08: from a table or column to the code that uses it. Scans a project folder (no code is
//! run): Prisma schema mappings are resolved (`@@map` / `@map`), Prisma client calls and SQL
//! that reads or writes the table are probable, other mentions are textual. Dependency and
//! build folders and secret files are skipped.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;

const SKIP_DIRS: [&str; 14] = ["node_modules", ".git", "dist", "build", "target", ".next", ".nuxt", "vendor", "coverage", ".venv", "venv", "__pycache__", ".turbo", ".cache"];
const CODE_EXT: [&str; 9] = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "sql", "prisma", "py"];
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 1_000_000;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// Relative to the folder.
    pub path: String,
    pub line: usize,
    pub text: String,
    /// resolved: through a schema mapping; probable: SQL or ORM usage of the table; textual: a mention.
    pub kind: &'static str,
    pub via: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    pub references: Vec<Reference>,
    pub files_scanned: usize,
    /// The folder had more files than were scanned.
    pub truncated: bool,
    pub revision: Option<String>,
    /// Prisma models mapped to this table.
    pub models: Vec<String>,
}

fn secret(name: &str) -> bool {
    name.starts_with(".env") || name.ends_with(".pem") || name.ends_with(".key") || name.starts_with("id_rsa") || name.starts_with("id_ed25519")
}

fn files(root: &Path) -> (Vec<PathBuf>, bool) {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(e.path());
                }
            } else if !secret(&name) && Path::new(&name).extension().and_then(|x| x.to_str()).is_some_and(|x| CODE_EXT.contains(&x)) && e.metadata().is_ok_and(|m| m.len() <= MAX_BYTES) {
                out.push(e.path());
                if out.len() >= MAX_FILES {
                    return (out, true);
                }
            }
        }
    }
    out.sort();
    (out, false)
}

/// A Prisma model and how it maps to the database.
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    pub name: String,
    pub table: String,
    pub schema: Option<String>,
    pub line: usize,
    pub path: String,
    /// (field, column, line)
    pub fields: Vec<(String, String, usize)>,
}

pub fn prisma_models(text: &str, path: &str) -> Vec<Model> {
    let mut out = Vec::new();
    let mut current: Option<Model> = None;
    let quoted = |l: &str, attr: &str| l.find(attr).and_then(|i| l[i + attr.len()..].split('"').nth(1)).map(str::to_owned);
    for (i, raw) in text.lines().enumerate() {
        let l = raw.trim();
        if let Some(rest) = l.strip_prefix("model ") {
            let name = rest.split_whitespace().next().unwrap_or("").trim_end_matches('{').to_owned();
            current = Some(Model { table: name.clone(), name, schema: None, line: i + 1, path: path.to_owned(), fields: vec![] });
        } else if let Some(m) = current.as_mut() {
            if l.starts_with('}') {
                out.push(current.take().unwrap());
            } else if l.starts_with("@@map") {
                if let Some(t) = quoted(l, "@@map(") {
                    m.table = t;
                }
            } else if l.starts_with("@@schema") {
                m.schema = quoted(l, "@@schema(");
            } else if !l.starts_with("//") && !l.starts_with("@@") && !l.is_empty() {
                let mut parts = l.split_whitespace();
                if let (Some(field), Some(ty)) = (parts.next(), parts.next()) {
                    // Relation fields (another model) aren't columns.
                    let scalar = ty.trim_end_matches(['?', '[', ']']).chars().next().is_some_and(|c| c.is_lowercase()) || ["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"].contains(&ty.trim_end_matches(['?', '[', ']']));
                    if scalar || l.contains("@map(") {
                        let column = quoted(l, "@map(").unwrap_or_else(|| field.to_owned());
                        m.fields.push((field.to_owned(), column, i + 1));
                    }
                }
            }
        }
    }
    out
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Is `word` at `i` in `line` a whole identifier?
fn whole(line: &str, i: usize, len: usize) -> bool {
    let ok = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
    ok(line[..i].chars().last()) && ok(line[i + len..].chars().next())
}

fn find_word(line: &str, word: &str) -> Option<usize> {
    let lower = line.to_lowercase();
    let w = word.to_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(&w) {
        let at = from + i;
        if whole(&lower, at, w.len()) {
            return Some(at);
        }
        from = at + w.len();
    }
    None
}

/// The table written with another schema in front (`billing.orders` when looking for `public.orders`).
fn other_schema(line: &str, at: usize, schema: &str) -> bool {
    let before = line[..at].trim_end_matches('"').trim_end_matches('`');
    if let Some(prefix) = before.strip_suffix('.') {
        let s: String = prefix.trim_end_matches(['"', '`']).chars().rev().take_while(|c| c.is_alphanumeric() || *c == '_').collect::<Vec<_>>().into_iter().rev().collect();
        return !s.is_empty() && !s.eq_ignore_ascii_case(schema);
    }
    false
}

const SQL_VERBS: [&str; 6] = ["from", "join", "into", "update", "table", "references"];

pub fn search(root: &Path, schema: &str, table: &str, column: Option<&str>) -> Result<Search> {
    let (paths, truncated) = files(root);
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().into_owned();
    let texts: Vec<(String, String)> = paths.iter().filter_map(|p| std::fs::read_to_string(p).ok().map(|t| (rel(p), t))).collect();
    let models: Vec<Model> = texts.iter().filter(|(p, _)| p.ends_with(".prisma")).flat_map(|(p, t)| prisma_models(t, p)).filter(|m| m.table.eq_ignore_ascii_case(table) && m.schema.as_deref().is_none_or(|s| s.eq_ignore_ascii_case(schema))).collect();
    let mut refs = Vec::new();
    for m in &models {
        match column {
            None => refs.push(Reference { path: m.path.clone(), line: m.line, text: format!("model {} (maps to {})", m.name, m.table), kind: "resolved", via: "Prisma schema".into() }),
            Some(c) => {
                for (field, col, line) in &m.fields {
                    if col.eq_ignore_ascii_case(c) {
                        refs.push(Reference { path: m.path.clone(), line: *line, text: format!("{}.{field} (maps to column {col})", m.name), kind: "resolved", via: "Prisma schema".into() });
                    }
                }
            }
        }
    }
    let clients: Vec<(String, Option<String>)> = models
        .iter()
        .map(|m| (format!("{}.", lower_first(&m.name)), column.and_then(|c| m.fields.iter().find(|f| f.1.eq_ignore_ascii_case(c)).map(|f| f.0.clone()))))
        .collect();
    for (path, text) in &texts {
        if path.ends_with(".prisma") {
            continue;
        }
        let sql_file = path.ends_with(".sql");
        let mut uses_model = false;
        for (i, line) in text.lines().enumerate() {
            let trimmed = line.trim();
            let mut push = |kind: &'static str, via: &str| refs.push(Reference { path: path.clone(), line: i + 1, text: trimmed.chars().take(200).collect(), kind, via: via.into() });
            // Prisma client: prisma.order.findMany(…)
            if let Some((client, field)) = clients.iter().find(|(c, _)| line.contains(&format!(".{c}")) || line.contains(&format!("prisma.{c}"))) {
                uses_model = true;
                match (column, field) {
                    (None, _) => push("probable", "Prisma client call"),
                    (Some(_), Some(f)) if find_word(line, f).is_some() => push("probable", "Prisma client call naming the field"),
                    _ => {}
                }
                let _ = client;
                continue;
            }
            if let (Some(_), Some(f)) = (column, clients.iter().find_map(|(_, f)| f.clone()))
                && uses_model
                && find_word(line, &f).is_some()
            {
                push("textual", "field name near a Prisma call");
                continue;
            }
            let target = column.unwrap_or(table);
            let Some(at) = find_word(line, target) else { continue };
            if column.is_none() && other_schema(line, at, schema) {
                continue;
            }
            let lower = line.to_lowercase();
            let sqlish = column.is_none() && SQL_VERBS.iter().any(|v| lower[..at].trim_end().trim_end_matches(['"', '`', '.']).trim_end_matches(&schema.to_lowercase()).trim_end_matches(['"', '`', '.']).trim_end().ends_with(v));
            if sqlish {
                push("probable", if sql_file { "SQL file" } else { "SQL in code" });
            } else if column.is_some() && find_word(text, table).is_some() && (sql_file || lower.contains("select") || lower.contains("where") || lower.contains("update")) {
                push("probable", "SQL naming the column in a file that uses the table");
            } else {
                push("textual", "the name appears");
            }
        }
    }
    let order = |k: &str| match k {
        "resolved" => 0,
        "probable" => 1,
        _ => 2,
    };
    refs.sort_by(|a, b| order(a.kind).cmp(&order(b.kind)).then(a.path.cmp(&b.path)).then(a.line.cmp(&b.line)));
    refs.truncate(500);
    let revision = std::process::Command::new("git").arg("-C").arg(root).args(["rev-parse", "--short", "HEAD"]).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
    Ok(Search { references: refs, files_scanned: texts.len(), truncated, revision, models: models.iter().map(|m| m.name.clone()).collect() })
}

/// Opens `path` at `line` in Cursor or VS Code when installed, else in the default app.
pub fn open_in_editor(path: &Path, line: usize) -> Result<()> {
    for cli in ["cursor", "code"] {
        if let Some(bin) = crate::tools::find(cli)
            && std::process::Command::new(bin).arg("-g").arg(format!("{}:{line}", path.display())).spawn().is_ok()
        {
            return Ok(());
        }
    }
    std::process::Command::new("open").arg(path).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_prisma_mappings_and_ranks_references() {
        let dir = std::env::temp_dir().join(format!("onyx_code_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("prisma")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(dir.join("prisma/schema.prisma"), "model Order {\n  id Int @id\n  customerId Int @map(\"customer_id\")\n  customer Customer @relation(fields: [customerId], references: [id])\n  @@map(\"orders\")\n}\n").unwrap();
        std::fs::write(dir.join("src/api.ts"), "const o = await prisma.order.findMany({ where: { customerId: 1 } });\nconst raw = sql`SELECT * FROM orders WHERE id = 1`;\n// orders are cool\nconst other = sql`SELECT * FROM billing.orders`;\nconst q = `SELECT id FROM public.orders`;\n").unwrap();
        std::fs::write(dir.join("node_modules/x/orders.js"), "SELECT * FROM orders").unwrap();
        std::fs::write(dir.join(".env"), "DATABASE_URL=postgres://secret@orders").unwrap();
        let s = search(&dir, "public", "orders", None).unwrap();
        let kinds: Vec<(&str, &str, usize)> = s.references.iter().map(|r| (r.kind, r.path.as_str(), r.line)).collect();
        assert_eq!(kinds, [("resolved", "prisma/schema.prisma", 1), ("probable", "src/api.ts", 1), ("probable", "src/api.ts", 2), ("probable", "src/api.ts", 5), ("textual", "src/api.ts", 3)], "{:?}", s.references);
        let c = search(&dir, "public", "orders", Some("customer_id")).unwrap();
        assert_eq!(c.references[0].text, "Order.customerId (maps to column customer_id)");
        assert!(c.references.iter().any(|r| r.path == "src/api.ts" && r.line == 1), "{:?}", c.references);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
