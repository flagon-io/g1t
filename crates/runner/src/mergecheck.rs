//! Finds out whether a pull request merges cleanly into the branch it
//! targets, and if not, which files conflict. No agent runs and nothing is
//! pushed: the two commits are merged in memory with `git merge-tree`, or,
//! where that is not available, in a throwaway checkout.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `MERGECHECK_PULL`, `MERGECHECK_TOKEN`: where and how to report.
//! - `G1T_USER`, `G1T_TOKEN`: to read the repository and the change.
//! - `BASE_REMOTE`, `BASE_COMMIT`: the repository and the commit to merge into.
//! - `HEAD_REMOTE`, `HEAD_BRANCH`, `HEAD_COMMIT`: where the change is.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::checks::redact;
use crate::{WORKDIR, auth_option, env, git};

/// The paths `git merge-tree --write-tree --name-only` lists as conflicting:
/// the lines after the tree on the first line, up to the blank line before
/// any messages.
pub(crate) fn merge_tree_conflicts(output: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in output.lines().skip(1) {
        if line.trim().is_empty() {
            break;
        }
        let path = line.trim().to_owned();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(12)]
}

/// The conflicting files, empty when it merges cleanly.
fn probe(auth: &str) -> Result<Vec<String>> {
    let base_remote = env("BASE_REMOTE")?;
    let base = env("BASE_COMMIT")?;
    let head_remote = env("HEAD_REMOTE")?;
    let head_branch = env("HEAD_BRANCH")?;
    let head = env("HEAD_COMMIT")?;
    std::fs::create_dir_all("/work")?;
    let workdir = Path::new(WORKDIR);
    crate::clone::clone(Path::new("/work"), auth, &["--no-checkout"], &base_remote, WORKDIR).context("could not clone the repository")?;
    let base_branch = git(workdir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    crate::clone::ensure(workdir, auth, "origin", &base_branch, &base)?;
    crate::clone::fetch(workdir, auth, &head_remote, &head_branch).context("could not fetch the pull request's change")?;
    crate::clone::ensure(workdir, auth, &head_remote, &head_branch, &head)?;
    // Shallow: deep enough for the two to share a commit to merge from.
    if crate::clone::has(workdir, &base) && crate::clone::has(workdir, &head) {
        crate::clone::share_history(workdir, auth, &[("origin", base_branch.as_str()), (head_remote.as_str(), head_branch.as_str())], &base, &head)?;
    }
    for (commit, what) in [(&base, "the target branch's commit"), (&head, "the change's commit")] {
        let present = Command::new("git")
            .current_dir(workdir)
            .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .status()
            .is_ok_and(|status| status.success());
        if !present {
            bail!("{what} {} is no longer there; it has moved since", short(commit));
        }
    }

    // In memory: git 2.38 and later.
    let merged = Command::new("git")
        .current_dir(workdir)
        .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", &base, &head])
        .output()
        .context("could not run git")?;
    match merged.status.code() {
        Some(0) => return Ok(Vec::new()),
        Some(1) => return Ok(merge_tree_conflicts(&String::from_utf8_lossy(&merged.stdout))),
        _ => {}
    }

    // Otherwise in a throwaway checkout.
    git(workdir, &["config", "user.name", "g1t merge check"])?;
    git(workdir, &["config", "user.email", "mergecheck@g1t.sh"])?;
    git(workdir, &["checkout", "--quiet", "--detach", &base])?;
    let clean = Command::new("git")
        .current_dir(workdir)
        .args(["merge", "--no-commit", "--no-ff", "--quiet", &head])
        .output()
        .is_ok_and(|output| output.status.success());
    if clean {
        return Ok(Vec::new());
    }
    let files: Vec<String> = git(workdir, &["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .map(str::to_owned)
        .collect();
    if files.is_empty() {
        bail!("the merge failed for a reason other than a conflict");
    }
    Ok(files)
}

fn report(api: &str, pull: &str, token: &str, mut body: serde_json::Value) -> Result<()> {
    body["token"] = token.into();
    ureq::post(&format!("{api}/mergechecks/{pull}"))
        .send_json(body)
        .context("could not report the merge check")?;
    Ok(())
}

pub fn main() -> i32 {
    let (api, pull, token) = match (env("G1T_API"), env("MERGECHECK_PULL"), env("MERGECHECK_TOKEN")) {
        (Ok(api), Ok(pull), Ok(token)) => (api, pull, token),
        _ => {
            eprintln!("g1t-runner: G1T_API, MERGECHECK_PULL and MERGECHECK_TOKEN must be set");
            return 2;
        }
    };
    let secrets: Vec<String> = ["G1T_TOKEN", "MERGECHECK_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    let found = env("G1T_USER")
        .and_then(|user| Ok(auth_option(&user, &env("G1T_TOKEN")?)))
        .and_then(|auth| probe(&auth));
    let body = match found {
        Ok(conflicts) => serde_json::json!({ "conflicts": conflicts }),
        Err(error) => serde_json::json!({ "error": redact(&format!("{error:#}"), &secrets) }),
    };
    match report(&api, &pull, &token, body) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicting_paths_are_read_from_merge_tree() {
        let output = "4b825dc642cb6eb9a060e54bf8d69288fbee4904\nsrc/a.rs\nsrc/b.rs\nsrc/a.rs\n\nAuto-merging src/a.rs\n";
        assert_eq!(merge_tree_conflicts(output), ["src/a.rs", "src/b.rs"]);
        assert!(merge_tree_conflicts("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n").is_empty());
    }
}
