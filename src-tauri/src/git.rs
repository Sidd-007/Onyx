//! Git in IDE mode: status, diffs, staging and commits for the workspace folder's repository,
//! through the git command line (so the user's config, hooks and credentials apply).
//! Nothing here discards changes or rewrites history.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, Result};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Relative to the workspace folder.
    pub path: String,
    /// `git status --porcelain` codes: index (staged) and worktree.
    pub index: char,
    pub worktree: char,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

async fn git(dir: &Path, args: &[&str]) -> Result<(bool, String, String)> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| AppError::Invalid(format!("Couldn't run git: {e}")))?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).trim().to_owned()))
}

async fn ok(dir: &Path, args: &[&str]) -> Result<String> {
    match git(dir, args).await? {
        (true, out, _) => Ok(out),
        (false, _, err) => Err(AppError::Invalid(if err.is_empty() { "git failed".into() } else { err })),
    }
}

type Parsed = (Option<String>, u32, u32, Vec<(char, char, String)>);

/// Parses `git status --porcelain=v1 -b -z`: the branch, ahead/behind, and each file's codes and path (relative to the repository's top).
pub fn parse_status(text: &str) -> Parsed {
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let (mut branch, mut ahead, mut behind) = (None, 0, 0);
    let mut files = Vec::new();
    while let Some(p) = parts.next() {
        if let Some(head) = p.strip_prefix("## ") {
            let name = head.split("...").next().unwrap_or(head);
            let name = name.strip_prefix("No commits yet on ").unwrap_or(name);
            branch = (!name.starts_with("HEAD (no branch)")).then(|| name.to_owned());
            if let Some(i) = head.find('[') {
                for piece in head[i + 1..].trim_end_matches(']').split(", ") {
                    if let Some(n) = piece.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = piece.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let mut chars = p.chars();
        let (x, y) = (chars.next().unwrap_or(' '), chars.next().unwrap_or(' '));
        let path = p.get(3..).unwrap_or_default().to_owned();
        // Renames carry the old path as the next entry.
        if x == 'R' || x == 'C' {
            parts.next();
        }
        files.push((x, y, path));
    }
    (branch, ahead, behind, files)
}

/// The repository's top folder, and the workspace's place in it (`""` or `sub/dir/`).
async fn locate(root: &Path) -> Result<(PathBuf, String)> {
    let top = ok(root, &["rev-parse", "--show-toplevel"]).await.map_err(|_| AppError::Invalid("This folder isn't in a git repository".into()))?;
    let top = PathBuf::from(top.trim());
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let top_c = top.canonicalize().unwrap_or_else(|_| top.clone());
    let prefix = canonical.strip_prefix(&top_c).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((top, if prefix.is_empty() { prefix } else { format!("{prefix}/") }))
}

/// Status of the files under the workspace folder. `None` when it isn't in a repository.
pub async fn status(root: &Path) -> Result<Option<Status>> {
    let Ok((top, prefix)) = locate(root).await else { return Ok(None) };
    let text = ok(&top, &["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all", "--", root.to_str().unwrap_or(".")]).await?;
    let (branch, ahead, behind, files) = parse_status(&text);
    let files = files
        .into_iter()
        .filter_map(|(index, worktree, path)| path.strip_prefix(&prefix).map(|p| FileStatus { path: p.to_owned(), index, worktree }))
        .collect();
    Ok(Some(Status { branch, ahead, behind, files }))
}

fn checked(paths: &[String]) -> Result<()> {
    if paths.iter().any(|p| p.is_empty() || p.starts_with('/') || p.split('/').any(|s| s == "..")) {
        return Err(AppError::Invalid("Paths must be inside the folder".into()));
    }
    Ok(())
}

/// A file's diff: staged (index vs HEAD) or not (worktree vs index). Untracked files show whole.
pub async fn diff(root: &Path, path: &str, staged: bool) -> Result<String> {
    checked(&[path.to_owned()])?;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let out = ok(root, &args).await?;
    if !out.is_empty() || staged {
        return Ok(out);
    }
    // Untracked: `--no-index` exits 1 when files differ, which is the point.
    let (_, out, _) = git(root, &["diff", "--no-color", "--no-index", "--", "/dev/null", path]).await?;
    Ok(out)
}

pub async fn stage(root: &Path, paths: &[String]) -> Result<()> {
    checked(paths)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    ok(root, &args).await.map(drop)
}

pub async fn unstage(root: &Path, paths: &[String]) -> Result<()> {
    checked(paths)?;
    let mut args = vec!["reset", "-q", "--"];
    args.extend(paths.iter().map(String::as_str));
    if ok(root, &args).await.is_ok() {
        return Ok(());
    }
    // No commits yet: there is no HEAD to reset to. This only touches the index; files stay.
    let mut args = vec!["rm", "--cached", "-q", "-r", "--"];
    args.extend(paths.iter().map(String::as_str));
    ok(root, &args).await.map(drop)
}

/// Commits what's staged. Returns git's one-line summary.
pub async fn commit(root: &Path, message: &str) -> Result<String> {
    if message.trim().is_empty() {
        return Err(AppError::Invalid("Write a commit message".into()));
    }
    let out = ok(root, &["commit", "-m", message]).await?;
    Ok(out.lines().next().unwrap_or_default().to_owned())
}

// ---- Commands ----

type State<'a> = tauri::State<'a, crate::workspace::Workspace>;

#[tauri::command]
pub async fn git_status(workspace: State<'_>) -> Result<Option<Status>> {
    status(&workspace.root()?).await
}

#[tauri::command]
pub async fn git_diff(workspace: State<'_>, path: String, staged: bool) -> Result<String> {
    diff(&workspace.root()?, &path, staged).await
}

#[tauri::command]
pub async fn git_stage(workspace: State<'_>, paths: Vec<String>) -> Result<()> {
    stage(&workspace.root()?, &paths).await
}

#[tauri::command]
pub async fn git_unstage(workspace: State<'_>, paths: Vec<String>) -> Result<()> {
    unstage(&workspace.root()?, &paths).await
}

#[tauri::command]
pub async fn git_commit(workspace: State<'_>, message: String) -> Result<String> {
    commit(&workspace.root()?, &message).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let (branch, ahead, behind, files) = parse_status("## main...origin/main [ahead 2, behind 1]\0M  a.sql\0 M b.sql\0R  new.sql\0old.sql\0?? c.sql\0");
        assert_eq!((branch.as_deref(), ahead, behind), (Some("main"), 2, 1));
        assert_eq!(files, [('M', ' ', "a.sql".into()), (' ', 'M', "b.sql".into()), ('R', ' ', "new.sql".into()), ('?', '?', "c.sql".into())]);
        assert_eq!(parse_status("## No commits yet on main\0").0.as_deref(), Some("main"));
    }

    /// A scratch repository in a temp folder: status, stage, diff, commit, unstage.
    #[tokio::test]
    async fn works_in_a_scratch_repository() {
        let dir = std::env::temp_dir().join(format!("onyx_git_{}", uuid::Uuid::new_v4().simple()));
        let root = dir.join("sql");
        std::fs::create_dir_all(&root).unwrap();
        ok(&dir, &["init", "-q", "-b", "main"]).await.unwrap();
        ok(&dir, &["config", "user.email", "test@example.com"]).await.unwrap();
        ok(&dir, &["config", "user.name", "Onyx test"]).await.unwrap();
        ok(&dir, &["config", "commit.gpgsign", "false"]).await.unwrap();
        std::fs::write(root.join("a.sql"), "SELECT 1;\n").unwrap();
        std::fs::write(dir.join("outside.txt"), "x").unwrap();

        let s = status(&root).await.unwrap().unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.files, [FileStatus { path: "a.sql".into(), index: '?', worktree: '?' }], "only files under the workspace");
        assert!(diff(&root, "a.sql", false).await.unwrap().contains("+SELECT 1;"));

        stage(&root, &["a.sql".into()]).await.unwrap();
        unstage(&root, &["a.sql".into()]).await.unwrap();
        assert_eq!(status(&root).await.unwrap().unwrap().files[0].index, '?');
        stage(&root, &["a.sql".into()]).await.unwrap();
        assert!(commit(&root, "Add a").await.unwrap().contains("Add a"));

        std::fs::write(root.join("a.sql"), "SELECT 2;\n").unwrap();
        assert!(diff(&root, "a.sql", false).await.unwrap().contains("+SELECT 2;"));
        assert!(stage(&root, &["../outside.txt".into()]).await.is_err());
        assert!(commit(&root, " ").await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
