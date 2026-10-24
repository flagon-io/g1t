//! `get_contents`: what a repository holds at a path, at a branch, tag or
//! commit: a file's text, or a directory's entries with its README. What
//! an agent (or Ask g1t) reads to learn how a project builds and tests,
//! what a config says, or what a file does, without cloning it.
//!
//! The repos service reads it, as the caller may see it: `blob` for a
//! file, `tree` for a directory. A path that is not a file is tried as a
//! directory. The shaping is [`file`] and [`directory`], plain functions.

use g1t_contracts::repos::{BlobArgs, BlobView, EntryKind, GetArgs, Repo, RepoPath, TreeArgs, TreeView};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// The most of a file's text one answer carries; more is cut with a note.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// The most entries of a directory one answer lists.
pub const MAX_ENTRIES: usize = 1_000;

pub fn description() -> &'static str {
    "What a repository holds at a path, at `ref` (a branch, tag or commit; the default branch when left out). A file: its `text` (null for a binary file or one too large to show; at most 200,000 characters, the rest cut with a note), `size` in bytes and `html_url`. A directory (or the root, with no `path`): its `entries` (each `name`, `path` and `type`: dir, file, symlink or submodule) and its README's `text` when it has one. Read the root first to find README, CONTRIBUTING, package.json, Cargo.toml or a workflow under .g1t/workflows, then the files you need."
}

pub fn input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "repo": { "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." },
            "path": { "type": "string", "description": "A file or directory, such as README.md or src/lib; the root when left out." },
            "ref": { "type": "string", "description": "A branch, tag or commit; the default branch when left out." },
        },
        "required": ["repo"],
    })
}

fn kind(entry: EntryKind) -> &'static str {
    match entry {
        EntryKind::Tree => "dir",
        EntryKind::Blob | EntryKind::Exec => "file",
        EntryKind::Symlink => "symlink",
        EntryKind::Gitlink => "submodule",
    }
}

fn full_name(repo: &Repo) -> String {
    format!("{}/{}", repo.namespace, repo.name)
}

/// A file's answer.
pub fn file(site: &str, view: &BlobView) -> Value {
    let site = site.trim_end_matches('/');
    let text = view.text.as_ref().map(|text| {
        let total = text.chars().count();
        if total <= MAX_TEXT_CHARS {
            text.clone()
        } else {
            let kept: String = text.chars().take(MAX_TEXT_CHARS).collect();
            format!("{kept}\n[Cut: {} more characters.]", total - MAX_TEXT_CHARS)
        }
    });
    json!({
        "type": "file",
        "repo": full_name(&view.repo),
        "ref": view.git_ref,
        "path": view.path,
        "size": view.size,
        "binary": text.is_none(),
        "text": text,
        "html_url": format!("{site}/{}/blob/{}/{}", full_name(&view.repo), view.git_ref, view.path.trim_start_matches('/')),
    })
}

/// A directory's answer.
pub fn directory(site: &str, view: &TreeView) -> Value {
    let site = site.trim_end_matches('/');
    let base = view.path.trim_matches('/');
    let entries: Vec<Value> = view
        .entries
        .iter()
        .take(MAX_ENTRIES)
        .map(|entry| {
            let path = if base.is_empty() { entry.name.clone() } else { format!("{base}/{}", entry.name) };
            json!({ "name": entry.name, "path": path, "type": kind(entry.kind) })
        })
        .collect();
    let html_url = if base.is_empty() {
        format!("{site}/{}", full_name(&view.repo))
    } else {
        format!("{site}/{}/tree/{}/{base}", full_name(&view.repo), view.git_ref)
    };
    json!({
        "type": "dir",
        "repo": full_name(&view.repo),
        "ref": view.git_ref,
        "path": base,
        "entries": entries,
        "truncated": view.entries.len() > MAX_ENTRIES,
        "readme": view.readme.as_ref().map(|readme| json!({ "name": readme.name, "text": readme.text })),
        "html_url": html_url,
    })
}

pub async fn run(services: &Services, viewer: &Viewer, repo: &RepoPath, input: &Value) -> Result<Outcome<Value>> {
    let site = services.addresses.site.clone();
    let path = input["path"].as_str().unwrap_or_default().trim().trim_matches('/').to_owned();
    let git_ref = input["ref"].as_str().map(str::trim).filter(|git_ref| !git_ref.is_empty()).map(str::to_owned);
    let tree = |tree_path: String, git_ref: Option<String>| TreeArgs { path: repo.clone(), viewer: viewer.clone(), git_ref, tree_path };
    if !path.is_empty() {
        // A file needs a ref: the default branch, unless one was given.
        let git_ref = match &git_ref {
            Some(git_ref) => git_ref.clone(),
            None => {
                let found: Outcome<Repo> =
                    g1t_kit::call(&services.repos, "get", &GetArgs { path: repo.clone(), viewer: viewer.clone() }).await?;
                match found {
                    Outcome::Ok(found) => found.default_branch,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                }
            }
        };
        let blob: Outcome<BlobView> = g1t_kit::call(
            &services.repos,
            "blob",
            &BlobArgs { path: repo.clone(), viewer: viewer.clone(), git_ref: git_ref.clone(), file_path: path.clone() },
        )
        .await?;
        if let Outcome::Ok(view) = blob {
            return Ok(Outcome::Ok(file(&site, &view)));
        }
        // Not a file: a directory, or nothing.
        let listed: Outcome<TreeView> = g1t_kit::call(&services.repos, "tree", &tree(path.clone(), Some(git_ref))).await?;
        return Ok(match listed {
            Outcome::Ok(view) => Outcome::Ok(directory(&site, &view)),
            Outcome::Fail(failure) if failure.code == FailureCode::NotFound => {
                Outcome::fail(FailureCode::NotFound, format!("{}/{} has no file or directory {path}.", repo.namespace, repo.name))
            }
            Outcome::Fail(failure) => Outcome::Fail(failure),
        });
    }
    let listed: Outcome<TreeView> = g1t_kit::call(&services.repos, "tree", &tree(String::new(), git_ref)).await?;
    Ok(match listed {
        Outcome::Ok(view) => Outcome::Ok(directory(&site, &view)),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::{Readme, TreeEntry};

    fn repo() -> Repo {
        serde_json::from_value(json!({
            "id": "rep_1", "namespace": "acme", "name": "web", "isPrivate": false,
            "ownerId": "wsp_1", "defaultBranch": "main", "forkOf": null, "createdAt": "2026-01-01T00:00:00Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_file_is_its_text_and_where_it_is() {
        let view =
            BlobView { repo: repo(), git_ref: "main".into(), path: "CONTRIBUTING.md".into(), size: 12, text: Some("npm test\n".into()) };
        let shown = file("https://g1t.sh/", &view);
        assert_eq!(shown["type"], "file");
        assert_eq!(shown["text"], "npm test\n");
        assert_eq!(shown["binary"], false);
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/web/blob/main/CONTRIBUTING.md");
        let binary = file("https://g1t.sh", &BlobView { text: None, ..view });
        assert_eq!(binary["binary"], true);
        assert!(binary["text"].is_null());
    }

    #[test]
    fn a_huge_file_is_cut_with_a_note() {
        let text = "x".repeat(MAX_TEXT_CHARS + 10);
        let view = BlobView { repo: repo(), git_ref: "main".into(), path: "big.txt".into(), size: text.len() as u64, text: Some(text) };
        let shown = file("https://g1t.sh", &view);
        assert!(shown["text"].as_str().unwrap().ends_with("[Cut: 10 more characters.]"));
    }

    #[test]
    fn a_directory_lists_its_entries_and_readme() {
        let view = TreeView {
            repo: repo(),
            git_ref: "main".into(),
            path: "".into(),
            head: None,
            entries: vec![
                TreeEntry { name: "src".into(), hash: "a".into(), kind: EntryKind::Tree },
                TreeEntry { name: "README.md".into(), hash: "b".into(), kind: EntryKind::Blob },
            ],
            readme: Some(Readme { name: "README.md".into(), text: Some("# Web".into()) }),
        };
        let shown = directory("https://g1t.sh", &view);
        assert_eq!(
            shown["entries"],
            json!([{ "name": "src", "path": "src", "type": "dir" }, { "name": "README.md", "path": "README.md", "type": "file" }])
        );
        assert_eq!(shown["readme"]["text"], "# Web");
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/web");
        let nested = directory("https://g1t.sh", &TreeView { path: "src".into(), readme: None, ..view });
        assert_eq!(nested["entries"][0]["path"], "src/src");
        assert_eq!(nested["html_url"], "https://g1t.sh/acme/web/tree/main/src");
    }
}
