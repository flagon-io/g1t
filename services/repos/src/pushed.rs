//! `pushed`: what a push to a branch brought into it. Work asks after each
//! push, to mark merged the pull requests whose heads it brought in, as a
//! merge from the site would, and to close the issues its commits' messages
//! name after a closing keyword (work's pushed.rs).
//!
//! One walk from the new head, every parent followed, stopping at what the
//! branch held before: its first-parent line and those commits' parents,
//! read in one `log`. A commit off that line that the branch already held
//! (a side branch merged long ago) can be taken for new when the push
//! merges it again; the pull request heads found are therefore checked
//! against the old head exactly before they are said to have landed.

use std::collections::{HashMap, HashSet, VecDeque};

use g1t_contracts::repos::{Commit, MAX_PUSHED, Pushed, PushedArgs, PushedCommit};
use worker::Result;

use crate::store::{GitRepo, GitStore};
use crate::{MAX_ANCESTRY, Repos, descends_from};

/// How many commits of a side line one read brings: a merged branch's
/// commits come in one `log` rather than one read each.
const SIDE_READ: u32 = 50;

impl<S: GitStore> Repos<S> {
    pub(crate) async fn pushed(&self, a: PushedArgs) -> Result<Pushed> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(Pushed::default());
        };
        let git = self.read_git(&repo).await?;
        brought_in(&git, a).await
    }
}

/// [`Repos::pushed`] on one repository's commits.
pub(crate) async fn brought_in<R: GitRepo>(git: &R, a: PushedArgs) -> Result<Pushed> {
    let before = match &a.before {
        Some(before) => git.log(before, MAX_ANCESTRY).await?,
        None => Vec::new(),
    };
    // What the branch held: its line, and where each commit on it came from.
    let mut held: HashSet<&str> = HashSet::new();
    for commit in &before {
        held.insert(commit.hash.as_str());
        held.extend(commit.parents.iter().map(String::as_str));
    }
    let mut known: HashMap<String, Commit> = git
        .log(&a.after, MAX_PUSHED as u32 + 1)
        .await?
        .into_iter()
        .map(|commit| (commit.hash.clone(), commit))
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut new: Vec<Commit> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([a.after.clone()]);
    while let Some(hash) = queue.pop_front() {
        if held.contains(hash.as_str()) || !seen.insert(hash.clone()) {
            continue;
        }
        if new.len() >= MAX_ANCESTRY as usize {
            break;
        }
        if !known.contains_key(&hash) {
            for commit in git.log(&hash, SIDE_READ).await? {
                known.entry(commit.hash.clone()).or_insert(commit);
            }
        }
        let Some(commit) = known.get(&hash) else { continue };
        queue.extend(commit.parents.iter().cloned());
        new.push(commit.clone());
    }
    let brought: HashSet<&str> = new.iter().map(|commit| commit.hash.as_str()).collect();
    let mut landed = Vec::new();
    for head in &a.heads {
        if landed.contains(head) || !brought.contains(head.as_str()) {
            continue;
        }
        // Taken for new, but held all along off the old line.
        if !before.is_empty() && descends_from(git, &before, head).await? {
            continue;
        }
        landed.push(head.clone());
    }
    // A new branch brought nothing to tell anyone about: its commits were
    // pushed elsewhere first, or are the repository's first.
    let commits = if a.messages && a.before.is_some() {
        new.iter()
            .take(MAX_PUSHED)
            .rev()
            .map(|commit| PushedCommit { hash: commit.hash.clone(), message: commit.message.clone() })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Pushed { landed, commits })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, GitAccess, Signature, TreeEntry};

    use super::*;
    use crate::store::Scope;

    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: format!("t{hash}"),
            message: format!("commit {hash}"),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parents.iter().map(|&p| p.to_owned()).collect(),
            authored_at: "2026-10-14T00:00:00.000Z".into(),
        }
    }

    /// Commits by hash; `log` follows first parents only, as the store
    /// does, and `parents` answers for any commit. Counts `log` reads.
    #[derive(Default)]
    struct Fake {
        commits: HashMap<String, Commit>,
        logs: RefCell<u32>,
    }

    impl Fake {
        fn with(commits: Vec<Commit>) -> Fake {
            Fake { commits: commits.into_iter().map(|c| (c.hash.clone(), c)).collect(), ..Fake::default() }
        }
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
            *self.logs.borrow_mut() += 1;
            let mut out = Vec::new();
            let mut at = self.commits.get(git_ref);
            while let Some(commit) = at {
                if out.len() as u32 >= limit {
                    break;
                }
                out.push(commit.clone());
                at = commit.parents.first().and_then(|parent| self.commits.get(parent));
            }
            Ok(out)
        }
        async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
        }
        async fn read_tree(&self, _tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            Ok(None)
        }
        async fn read_blob(&self, _blob_hash: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str, _default_branch_only: bool) -> Result<()> {
            Ok(())
        }
    }

    fn args(before: Option<&str>, after: &str, heads: &[&str]) -> PushedArgs {
        PushedArgs {
            repo_id: "rep_1".into(),
            before: before.map(str::to_owned),
            after: after.into(),
            heads: heads.iter().map(|&h| h.to_owned()).collect(),
            messages: true,
        }
    }

    fn hashes(pushed: &Pushed) -> Vec<&str> {
        pushed.commits.iter().map(|c| c.hash.as_str()).collect()
    }

    /// m1 ← m2 on main; f1 ← f2 a branch off m2.
    fn history() -> Vec<Commit> {
        vec![commit("m1", &[]), commit("m2", &["m1"]), commit("f1", &["m2"]), commit("f2", &["f1"])]
    }

    #[test]
    fn a_fast_forward_brings_in_the_branch_and_its_head() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(Some("m2"), "f2", &["f2", "f1", "m2"]))).unwrap();
        // f1 is a head too (a pull request stacked under the other).
        assert_eq!(pushed.landed, vec!["f2", "f1"]);
        assert_eq!(hashes(&pushed), vec!["f1", "f2"]);
    }

    #[test]
    fn a_merge_commit_brings_in_its_second_parent() {
        let mut commits = history();
        commits.extend([commit("m3", &["m2"]), commit("x", &["m3", "f2"])]);
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m3"), "x", &["f2"]))).unwrap();
        assert_eq!(pushed.landed, vec!["f2"]);
        assert_eq!(hashes(&pushed), vec!["f1", "f2", "x"]);
    }

    #[test]
    fn a_head_the_branch_already_held_did_not_land() {
        // g ← h merged into main long ago (m3); main went on to m4. A pull
        // request whose head is still g, and a push that merges g again.
        let commits = vec![
            commit("m1", &[]),
            commit("g", &["m1"]),
            commit("h", &["g"]),
            commit("m2", &["m1"]),
            commit("m3", &["m2", "h"]),
            commit("m4", &["m3"]),
            commit("y", &["m4", "g"]),
        ];
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m4"), "y", &["g", "m4"]))).unwrap();
        assert!(pushed.landed.is_empty());
        // A head that was never pushed elsewhere is not looked for at all.
        assert!(!hashes(&pushed).contains(&"m4"));
    }

    #[test]
    fn nothing_new_lands_nothing() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(Some("f2"), "f2", &["f2"]))).unwrap();
        assert!(pushed.landed.is_empty() && pushed.commits.is_empty());
        // Moving back (a force push to an older commit) brings nothing in.
        let back = run(brought_in(&git, args(Some("f2"), "m2", &["m2"]))).unwrap();
        assert!(back.landed.is_empty() && back.commits.is_empty());
    }

    #[test]
    fn a_new_branch_lists_no_messages() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(None, "f2", &["f2"]))).unwrap();
        assert_eq!(pushed.landed, vec!["f2"]);
        assert!(pushed.commits.is_empty());
    }

    #[test]
    fn a_merged_branch_is_read_in_one_go() {
        // Twenty commits on a side branch merged in: one read of main and
        // one of the side line, not one per commit.
        let mut commits = vec![commit("m1", &[]), commit("m2", &["m1"])];
        commits.push(commit("s1", &["m1"]));
        for i in 2..=20 {
            commits.push(commit(&format!("s{i}"), &[&format!("s{}", i - 1)]));
        }
        commits.push(commit("x", &["m2", "s20"]));
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m2"), "x", &[]))).unwrap();
        assert_eq!(pushed.commits.len(), 21);
        assert_eq!(*git.logs.borrow(), 3);
    }
}
