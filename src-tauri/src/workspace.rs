//! IDE mode's folder of SQL files. The folder is only ever set from a native Open dialog,
//! and every path the UI sends is relative to it and must stay inside it.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{AppError, Result};

/// More than this many entries and the tree stops listing (a home folder picked by mistake).
const MAX_ENTRIES: usize = 20_000;
/// Files larger than this aren't opened in the editor.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", "dist", "build"];

pub struct Workspace {
    /// Where the chosen folder is remembered between launches.
    remembered: PathBuf,
    root: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Relative to the folder, `/`-separated.
    pub path: String,
    pub dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub root: String,
    pub entries: Vec<Entry>,
    /// The folder had more than MAX_ENTRIES entries.
    pub truncated: bool,
}

impl Workspace {
    pub fn load(remembered: PathBuf) -> Self {
        let root = std::fs::read_to_string(&remembered).ok().map(|s| PathBuf::from(s.trim())).filter(|p| p.is_dir());
        Self { remembered, root: Mutex::new(root) }
    }

    pub fn root(&self) -> Result<PathBuf> {
        self.root.lock().unwrap().clone().ok_or_else(|| AppError::Invalid("Open a folder first".into()))
    }

    pub fn set_root(&self, root: PathBuf) -> Result<()> {
        if let Some(dir) = self.remembered.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.remembered, root.display().to_string())?;
        *self.root.lock().unwrap() = Some(root);
        Ok(())
    }
}

/// `relative` inside `root`. No absolute paths or `..`, and symlinks can't lead outside.
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(AppError::Invalid("That path is outside the folder".into()));
    }
    let root = root.canonicalize()?;
    let path = root.join(relative);
    // The deepest part that exists must resolve inside the folder.
    let mut existing = path.as_path();
    while !existing.exists() {
        existing = existing.parent().unwrap_or(&root);
    }
    if !existing.canonicalize()?.starts_with(&root) {
        return Err(AppError::Invalid("That path is outside the folder".into()));
    }
    Ok(path)
}

pub fn list(root: &Path) -> Result<Listing> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // Symlinks aren't followed (they could point outside the folder).
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let path = item.path();
            let relative = path.strip_prefix(root).unwrap_or(&path).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            if kind.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                entries.push(Entry { path: relative, dir: true });
            } else {
                entries.push(Entry { path: relative, dir: false });
            }
        }
    }
    entries.sort_by_key(|e| e.path.to_lowercase());
    Ok(Listing { root: root.display().to_string(), entries, truncated })
}

pub fn read(root: &Path, relative: &str) -> Result<String> {
    let path = resolve(root, relative)?;
    if std::fs::metadata(&path)?.len() > MAX_FILE_BYTES {
        return Err(AppError::Invalid("That file is too large to open (over 10 MB)".into()));
    }
    String::from_utf8(std::fs::read(&path)?).map_err(|_| AppError::Invalid("That file isn't text".into()))
}

/// Writes through a temporary file, so a crash never leaves half a file. The temporary file
/// has a random name and is created exclusively (`O_EXCL`, which also refuses a symlink): a
/// planted file or symlink can't redirect the write outside the folder.
pub fn write(root: &Path, relative: &str, content: &str) -> Result<()> {
    use std::io::Write;
    let path = resolve(root, relative)?;
    let name = path.file_name().ok_or_else(|| AppError::Invalid("Not a file".into()))?.to_string_lossy();
    let temp = path.with_file_name(format!(".{name}.{}.onyx-tmp", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    Ok(written?)
}

/// A new empty file or folder; never replaces one that exists.
pub fn create(root: &Path, relative: &str, dir: bool) -> Result<()> {
    let path = resolve(root, relative)?;
    if path.exists() {
        return Err(AppError::Invalid(format!("{relative} already exists")));
    }
    if dir {
        std::fs::create_dir_all(&path)?;
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    }
    Ok(())
}

/// Renames or moves within the folder; never replaces what's at `to`.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<()> {
    let (from_path, to_path) = (resolve(root, from)?, resolve(root, to)?);
    if from.is_empty() {
        return Err(AppError::Invalid("Can't rename the folder itself".into()));
    }
    if to_path.exists() {
        return Err(AppError::Invalid(format!("{to} already exists")));
    }
    if to_path.starts_with(&from_path) {
        return Err(AppError::Invalid("Can't move a folder into itself".into()));
    }
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from_path, to_path)?;
    Ok(())
}

// ---- Commands ----

type State<'a> = tauri::State<'a, Workspace>;

/// F08: code in the IDE folder that uses a table or column.
#[tauri::command]
pub async fn code_references(workspace: State<'_>, schema: String, table: String, column: Option<String>) -> Result<crate::codeindex::Search> {
    let root = workspace.root()?;
    tokio::task::spawn_blocking(move || crate::codeindex::search(&root, &schema, &table, column.as_deref())).await.map_err(|e| AppError::Invalid(e.to_string()))?
}

/// Opens a file of the IDE folder at a line in the code editor.
#[tauri::command]
pub fn open_code(workspace: State<'_>, path: String, line: usize) -> Result<()> {
    let root = workspace.root()?;
    crate::codeindex::open_in_editor(&resolve(&root, &path)?, line)
}

/// The folder IDE mode shows, if one was opened.
#[tauri::command]
pub fn workspace_list(workspace: State<'_>) -> Result<Option<Listing>> {
    match workspace.root.lock().unwrap().clone() {
        Some(root) => list(&root).map(Some),
        None => Ok(None),
    }
}

/// A native folder dialog; the chosen folder becomes the workspace.
#[tauri::command]
pub async fn workspace_open(app: tauri::AppHandle, workspace: State<'_>) -> Result<Option<Listing>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Open a folder of SQL files").pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let root = path.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    workspace.set_root(root.clone())?;
    list(&root).map(Some)
}

#[tauri::command]
pub fn workspace_read(workspace: State<'_>, path: String) -> Result<String> {
    read(&workspace.root()?, &path)
}

#[tauri::command]
pub fn workspace_write(workspace: State<'_>, path: String, content: String) -> Result<()> {
    write(&workspace.root()?, &path, &content)
}

#[tauri::command]
pub fn workspace_create(workspace: State<'_>, path: String, dir: bool) -> Result<()> {
    create(&workspace.root()?, &path, dir)
}

#[tauri::command]
pub fn workspace_rename(workspace: State<'_>, from: String, to: String) -> Result<()> {
    rename(&workspace.root()?, &from, &to)
}

/// Shows the file in Finder (where it can also be moved to the Trash).
#[tauri::command]
pub fn workspace_reveal(workspace: State<'_>, path: String) -> Result<()> {
    let path = resolve(&workspace.root()?, &path)?;
    std::process::Command::new("/usr/bin/open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("onyx-ws-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_paths_inside_the_folder() {
        let root = folder();
        assert!(resolve(&root, "../etc/passwd").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "a/../../x").is_err());
        assert!(resolve(&root, "new/dir/file.sql").is_ok());
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        assert!(resolve(&root, "link/passwd").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planted_symlinks_cannot_redirect_a_save() {
        let root = folder();
        let outside = std::env::temp_dir().join(format!("onyx-outside-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&outside, "keep me").unwrap();
        std::fs::write(root.join("daily.sql"), "SELECT 1;").unwrap();
        // The old fixed temp name, pointed outside the folder.
        std::os::unix::fs::symlink(&outside, root.join(".daily.sql.onyx-tmp")).unwrap();
        write(&root, "daily.sql", "SELECT 2;").unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");
        assert_eq!(std::fs::read_to_string(root.join("daily.sql")).unwrap(), "SELECT 2;");
        // A save through a symlinked file that points outside is refused.
        std::os::unix::fs::symlink(&outside, root.join("link.sql")).unwrap();
        assert!(write(&root, "link.sql", "x").is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");
        std::fs::remove_file(&outside).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creates_lists_writes_and_renames() {
        let root = folder();
        create(&root, "reports", true).unwrap();
        create(&root, "reports/daily.sql", false).unwrap();
        assert!(create(&root, "reports/daily.sql", false).is_err(), "never replaces a file");
        write(&root, "reports/daily.sql", "SELECT 1;\n").unwrap();
        assert_eq!(read(&root, "reports/daily.sql").unwrap(), "SELECT 1;\n");
        create(&root, ".git", true).unwrap();
        create(&root, "node_modules/x.sql", false).unwrap();
        let listing = list(&root).unwrap();
        let paths: Vec<_> = listing.entries.iter().map(|e| (e.path.as_str(), e.dir)).collect();
        assert_eq!(paths, [("node_modules", true), ("reports", true), ("reports/daily.sql", false)]);

        create(&root, "top.sql", false).unwrap();
        assert!(rename(&root, "top.sql", "reports/daily.sql").is_err(), "never replaces a file");
        assert!(rename(&root, "reports", "reports/inner").is_err());
        rename(&root, "reports/daily.sql", "archive/2026.sql").unwrap();
        assert_eq!(read(&root, "archive/2026.sql").unwrap(), "SELECT 1;\n");
        assert!(!root.join("reports/daily.sql").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
