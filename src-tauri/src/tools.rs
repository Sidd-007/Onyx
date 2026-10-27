//! Finds command-line tools (duckdb, pg_dump, mysqldump …). Apps launched from Finder get a
//! minimal PATH, so Homebrew's folders are searched too.

use std::path::PathBuf;

pub fn find(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/libpq/bin", "/usr/bin"].map(PathBuf::from));
    // Versioned Homebrew formulas (postgresql@17, mysql@8.4, mysql-client …), newest first.
    for root in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Ok(entries) = std::fs::read_dir(root) {
            let mut formulas: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    n.starts_with("postgresql") || n.starts_with("mysql") || n.starts_with("libpq") || n.starts_with("duckdb")
                })
                .collect();
            formulas.sort();
            formulas.reverse();
            dirs.extend(formulas.into_iter().map(|p| p.join("bin")));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".duckdb/cli/latest"));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_system_tools() {
        assert!(super::find("ls").is_some() || super::find("sh").is_some());
        assert!(super::find("definitely-not-a-tool-onyx").is_none());
    }
}
