//! How a sandbox clones and fetches: shallow, and deeper only when it needs
//! to be. A sandbox's work starts from one commit (an agent's branch, the
//! commit checks run on, a build), so the history behind it is usually
//! never read; a full clone of g1t took 5.4 s against 3.8 s at depth 1
//! (docs/ARTIFACTS.md, R8). Work that merges (catching up, the merge queue,
//! a merge check, a review's diff) deepens until the two sides share a
//! commit, and fetches everything only as the last resort.
//!
//! Environment, for the operator or a self-hosted runner:
//!
//! - `G1T_CLONE_DEPTH`: commits to clone (default 1); `0` or `full`
//!   clones everything, as before.
//! - `G1T_CLONE_FILTER=blob:none`: a blobless clone as well, whose files
//!   are fetched as they are read. Off by default: Cloudflare Artifacts
//!   documents partial clone as unsupported over protocol v1, and it is
//!   cheaper only when few files are read.

use std::path::Path;
use std::process::Command;

use anyhow::Result;

use crate::git;

/// How deep each step of `share_history` goes before fetching everything.
const DEEPEN: [u32; 3] = [50, 500, 5000];

/// The clone's depth and filter options, from the environment.
pub(crate) fn clone_options() -> Vec<String> {
    options(std::env::var("G1T_CLONE_DEPTH").ok().as_deref(), std::env::var("G1T_CLONE_FILTER").ok().as_deref())
}

fn options(depth: Option<&str>, filter: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    match depth.map(str::trim) {
        Some("0") | Some("full") => {}
        Some(n) if n.parse::<u32>().is_ok_and(|n| n > 0) => out.push(format!("--depth={n}")),
        _ => out.push("--depth=1".to_owned()),
    }
    if filter.map(str::trim) == Some("blob:none") {
        out.push("--filter=blob:none".to_owned());
    }
    out
}

/// The depth option for a fetch into the clone: as shallow as the clone,
/// or nothing for a full one (a fetch into a shallow clone without one
/// would bring the branch's whole history).
pub(crate) fn fetch_options() -> Vec<String> {
    clone_options().into_iter().filter(|o| o.starts_with("--depth")).collect()
}

/// `git clone` with the clone options: `git -c <auth> clone --quiet
/// <options> <extra> <remote> <into>`.
pub(crate) fn clone(dir: &Path, auth: &str, extra: &[&str], remote: &str, into: &str) -> Result<String> {
    let options = clone_options();
    let mut args: Vec<&str> = vec!["-c", auth, "clone", "--quiet"];
    args.extend(options.iter().map(String::as_str));
    args.extend(extra);
    args.extend([remote, into]);
    git(dir, &args)
}

/// `git fetch --quiet <depth> <remote> <refspec>`, as shallow as the clone.
pub(crate) fn fetch(dir: &Path, auth: &str, remote: &str, refspec: &str) -> Result<String> {
    let options = fetch_options();
    let mut args: Vec<&str> = vec!["-c", auth, "fetch", "--quiet"];
    args.extend(options.iter().map(String::as_str));
    args.extend([remote, refspec]);
    git(dir, &args)
}

/// Whether the clone is shallow.
pub(crate) fn is_shallow(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-shallow-repository"]).is_ok_and(|out| out == "true")
}

/// Whether `commit` is in the clone.
pub(crate) fn has(dir: &Path, commit: &str) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
        .status()
        .is_ok_and(|status| status.success())
}

fn merge_base(dir: &Path, a: &str, b: &str) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(["merge-base", a, b])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Deepens a shallow clone until `a` and `b` (commits, or refs such as
/// `HEAD`) share a commit, so they can be compared or merged: each of
/// `sources` (remote, branch) fetched deeper, then fully. `FETCH_HEAD`
/// ends on the last source's branch, so list the one a caller reads as
/// `FETCH_HEAD` last. A full clone, or one where they already share a
/// commit, fetches nothing.
pub(crate) fn share_history(dir: &Path, auth: &str, sources: &[(&str, &str)], a: &str, b: &str) -> Result<()> {
    if !is_shallow(dir) || merge_base(dir, a, b) {
        return Ok(());
    }
    for depth in DEEPEN {
        for (remote, branch) in sources {
            git(dir, &["-c", auth, "fetch", "--quiet", &format!("--deepen={depth}"), remote, branch])?;
        }
        if merge_base(dir, a, b) || !is_shallow(dir) {
            return Ok(());
        }
    }
    for (remote, branch) in sources {
        // "--unshallow on a complete repository" once the first has done it.
        let _ = git(dir, &["-c", auth, "fetch", "--quiet", "--unshallow", remote, branch]);
    }
    Ok(())
}

/// Makes sure `commit` is in the clone: fetched by name, which servers
/// allow for commits on their branches, else the whole of `branch`.
pub(crate) fn ensure(dir: &Path, auth: &str, remote: &str, branch: &str, commit: &str) -> Result<()> {
    if has(dir, commit) {
        return Ok(());
    }
    let _ = fetch(dir, auth, remote, commit);
    if has(dir, commit) {
        return Ok(());
    }
    if is_shallow(dir) {
        let _ = git(dir, &["-c", auth, "fetch", "--quiet", "--unshallow", remote, branch]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shallow_by_default_full_or_blobless_when_asked() {
        assert_eq!(options(None, None), ["--depth=1"]);
        assert_eq!(options(Some("50"), None), ["--depth=50"]);
        assert_eq!(options(Some("0"), None), Vec::<String>::new());
        assert_eq!(options(Some("full"), Some("blob:none")), ["--filter=blob:none"]);
        assert_eq!(options(Some("nonsense"), Some("tree:0")), ["--depth=1"]);
        assert_eq!(options(None, Some("blob:none")), ["--depth=1", "--filter=blob:none"]);
    }

    /// Clones a repository of its own with history, shallow, and deepens it
    /// until a branch merges, where git is installed.
    #[test]
    fn a_shallow_clone_deepens_until_two_branches_share_a_commit() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("g1t-clone-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(&origin, &["init", "--quiet", "-b", "main"]);
        run(&origin, &["config", "user.name", "t"]);
        run(&origin, &["config", "user.email", "t@example.com"]);
        run(&origin, &["config", "uploadpack.allowReachableSHA1InWant", "true"]);
        for i in 0..12 {
            std::fs::write(origin.join("f.txt"), format!("{i}\n")).unwrap();
            run(&origin, &["add", "f.txt"]);
            run(&origin, &["commit", "--quiet", "-m", &format!("c{i}")]);
        }
        run(&origin, &["branch", "side", "HEAD~10"]);
        run(&origin, &["checkout", "--quiet", "side"]);
        std::fs::write(origin.join("g.txt"), "side\n").unwrap();
        run(&origin, &["add", "g.txt"]);
        run(&origin, &["commit", "--quiet", "-m", "side"]);
        run(&origin, &["checkout", "--quiet", "main"]);

        let url = format!("file://{}", origin.display().to_string().replace('\\', "/"));
        let auth = "http.extraHeader=X-Test: 1";
        clone(&root, auth, &["--branch", "main"], &url, "work").unwrap();
        let work = root.join("work");
        assert!(is_shallow(&work));
        assert_eq!(git(&work, &["rev-list", "--count", "HEAD"]).unwrap(), "1");
        fetch(&work, auth, &url, "side").unwrap();
        assert!(!merge_base(&work, "HEAD", "FETCH_HEAD"));
        share_history(&work, auth, &[(&url, "main"), (&url, "side")], "HEAD", "FETCH_HEAD").unwrap();
        assert!(merge_base(&work, "HEAD", "FETCH_HEAD"));
        // FETCH_HEAD is still the side branch, the last source.
        assert_eq!(git(&work, &["log", "-1", "--format=%s", "FETCH_HEAD"]).unwrap(), "side");
        let _ = std::fs::remove_dir_all(&root);
    }
}
