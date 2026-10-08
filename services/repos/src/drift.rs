//! How far branches have moved from the default branch, for Active branches
//! on a project's overview and the Branches page (`branch_drift`).
//!
//! Each branch head's history and the default branch's are read to a depth,
//! in turn deeper, until they meet; the default branch's history is read
//! once per depth for every branch. Histories are read by commit hash, which
//! the store keeps for good (store.rs), and each answer is kept by the pair
//! of heads (lib.rs), so only heads that moved cost a walk. Before
//! 2026-10-08 the site did this itself: up to twenty `log` calls per view,
//! each with its own access check and store handle.

use std::collections::{HashMap, HashSet};

use g1t_contracts::repos::{Commit, Drift};
use worker::Result;

use crate::store::GitRepo;

/// How deep each history is read, in turn: (branch, default branch). Most
/// branches are a few commits ahead of where they left a default branch
/// that has moved on a little; one left long ago needs the default
/// branch's history further back; one far from both reads both deeply.
/// Past the last, there is no answer.
pub const DEPTHS: [(u32, u32); 4] = [(12, 120), (40, 120), (40, 1000), (1000, 1000)];

/// Branches read at once.
const AT_ONCE: usize = 8;

/// A branch head's commit and drift, and whether the answer may be kept:
/// not when a read failed.
#[derive(Clone, Debug)]
pub struct Measured {
    pub commit: Option<Commit>,
    pub drift: Option<Drift>,
    pub settled: bool,
}

/// Commits `branch` has that `main` does not (ahead) and the other way
/// round (behind), from what was read of the two histories (`commits`, in
/// any order, repeats allowed). `None` when either head is missing, or when
/// a commit only one side reaches has a parent that was not read: that
/// parent's history could change either count.
pub fn drift<'a>(branch: &str, main: &str, commits: impl IntoIterator<Item = &'a Commit>) -> Option<Drift> {
    let mut parents: HashMap<&str, &[String]> = HashMap::new();
    for commit in commits {
        parents.insert(commit.hash.as_str(), commit.parents.as_slice());
    }
    if !parents.contains_key(branch) || !parents.contains_key(main) {
        return None;
    }
    let from_branch = reach(branch, &parents);
    let from_main = reach(main, &parents);
    let (mut ahead, mut behind) = (0, 0);
    for (hash, above) in &parents {
        let on_branch = from_branch.contains(hash);
        if on_branch == from_main.contains(hash) {
            continue;
        }
        if above.iter().any(|parent| !parents.contains_key(parent.as_str())) {
            return None;
        }
        if on_branch {
            ahead += 1;
        } else {
            behind += 1;
        }
    }
    Some(Drift { ahead, behind })
}

/// Every commit read that `head` descends from, itself included.
fn reach<'a>(head: &'a str, parents: &HashMap<&'a str, &'a [String]>) -> HashSet<&'a str> {
    let mut seen = HashSet::from([head]);
    let mut next = vec![head];
    while let Some(hash) = next.pop() {
        for parent in parents.get(hash).copied().unwrap_or_default() {
            if let Some((&known, _)) = parents.get_key_value(parent.as_str())
                && seen.insert(known)
            {
                next.push(known);
            }
        }
    }
    seen
}

/// What was read of one branch's history so far.
struct Reading {
    commits: Vec<Commit>,
    depth: u32,
    answer: Option<Measured>,
}

/// Each of `heads` measured against `base`, in the order given.
pub async fn measure<R: GitRepo>(git: &R, base: &str, heads: &[String]) -> Vec<Measured> {
    let mut readings: Vec<Reading> = heads.iter().map(|_| Reading { commits: Vec::new(), depth: 0, answer: None }).collect();
    // The default branch's history, read once per depth and not deeper
    // once a read reached its start.
    let mut main: Option<(u32, Vec<Commit>)> = None;
    let mut main_failed = false;
    for (branch_depth, main_depth) in DEPTHS {
        if readings.iter().all(|reading| reading.answer.is_some()) {
            break;
        }
        let deeper = match &main {
            Some((read_to, commits)) => *read_to < main_depth && commits.len() as u32 >= *read_to,
            None => true,
        };
        if deeper && !main_failed {
            match git.log(base, main_depth).await {
                Ok(commits) if !commits.is_empty() => main = Some((main_depth, commits)),
                _ => main_failed = true,
            }
        }
        let Some((_, main_commits)) = &main else {
            for reading in readings.iter_mut().filter(|reading| reading.answer.is_none()) {
                reading.answer = Some(Measured { commit: None, drift: None, settled: false });
            }
            break;
        };
        let open: Vec<usize> = (0..heads.len()).filter(|&index| readings[index].answer.is_none()).collect();
        for chunk in open.chunks(AT_ONCE) {
            let reads = futures_util::future::join_all(chunk.iter().map(|&index| {
                let reading = &readings[index];
                // Read again only when deeper, and only when the last read
                // did not already reach the start.
                let again = reading.depth == 0 || (branch_depth > reading.depth && reading.commits.len() as u32 >= reading.depth);
                let head = heads[index].as_str();
                async move { if again { Some(git.log(head, branch_depth).await) } else { None } }
            }))
            .await;
            for (&index, read) in chunk.iter().zip(reads) {
                let reading = &mut readings[index];
                match read {
                    Some(Ok(commits)) if !commits.is_empty() => {
                        reading.commits = commits;
                        reading.depth = branch_depth;
                    }
                    Some(_) => {
                        reading.answer = Some(Measured { commit: None, drift: None, settled: false });
                        continue;
                    }
                    None => {}
                }
                let head = heads[index].as_str();
                if let Some(counted) = drift(head, base, main_commits.iter().chain(reading.commits.iter())) {
                    reading.answer = Some(Measured { commit: reading.commits.first().cloned(), drift: Some(counted), settled: true });
                }
            }
        }
        if main_failed {
            break;
        }
    }
    readings
        .into_iter()
        .map(|reading| {
            reading.answer.unwrap_or_else(|| Measured {
                commit: reading.commits.first().cloned(),
                drift: None,
                // Read to the last depth without meeting: that is the answer
                // for this pair, and it will not change.
                settled: !main_failed && reading.depth > 0,
            })
        })
        .collect()
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
            message: format!("commit {hash}\n\nbody"),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parents.iter().map(|&p| p.to_owned()).collect(),
            authored_at: String::new(),
        }
    }

    /// Commits by hash; `log` follows first parents. Counts each read.
    #[derive(Default)]
    struct Fake {
        commits: HashMap<String, Commit>,
        reads: RefCell<Vec<(String, u32)>>,
        fail: Option<String>,
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
            self.reads.borrow_mut().push((git_ref.to_owned(), limit));
            if self.fail.as_deref() == Some(git_ref) {
                return Err(worker::Error::RustError("store busy".into()));
            }
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
        async fn parents(&self, _commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(None)
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
        async fn fork(&self, _target_key: &str) -> Result<()> {
            Ok(())
        }
    }

    /// m1 ← m2 ← m3 on main; b1 ← b2 branched from m2.
    fn forked() -> Vec<Commit> {
        vec![commit("m1", &[]), commit("m2", &["m1"]), commit("m3", &["m2"]), commit("b1", &["m2"]), commit("b2", &["b1"])]
    }

    /// A straight line of `n` commits named `{prefix}{i}`, the first on `from`.
    fn line(prefix: &str, from: Option<&str>, n: usize) -> Vec<Commit> {
        (1..=n)
            .map(|i| {
                let parent = if i == 1 { from.map(str::to_owned) } else { Some(format!("{prefix}{}", i - 1)) };
                commit(&format!("{prefix}{i}"), &parent.iter().map(String::as_str).collect::<Vec<_>>())
            })
            .collect()
    }

    #[test]
    fn counts_both_sides_from_where_they_forked() {
        assert_eq!(drift("b2", "m3", &forked()), Some(Drift { ahead: 2, behind: 1 }));
        assert_eq!(drift("m3", "m3", &forked()), Some(Drift { ahead: 0, behind: 0 }));
    }

    #[test]
    fn a_merge_from_main_is_not_ahead() {
        // b3 merges m3 into the branch.
        let mut history = forked();
        history.push(commit("b3", &["b2", "m3"]));
        assert_eq!(drift("b3", "m3", &history), Some(Drift { ahead: 3, behind: 0 }));
    }

    #[test]
    fn no_answer_when_the_histories_were_not_read_far_enough() {
        let history = vec![commit("m3", &["m2"]), commit("b2", &["b1"])];
        assert_eq!(drift("b2", "m3", &history), None);
        assert_eq!(drift("b9", "m3", &forked()), None);
    }

    #[test]
    fn measures_every_head_with_one_read_of_main() {
        let git = Fake::with(forked());
        let found = run(measure(&git, "m3", &["b2".to_owned(), "m2".to_owned(), "m3".to_owned()]));
        assert_eq!(found[0].drift, Some(Drift { ahead: 2, behind: 1 }));
        assert_eq!(found[0].commit.as_ref().map(|c| c.hash.as_str()), Some("b2"));
        assert_eq!(found[1].drift, Some(Drift { ahead: 0, behind: 1 }));
        assert_eq!(found[2].drift, Some(Drift { ahead: 0, behind: 0 }));
        assert!(found.iter().all(|m| m.settled));
        let reads = git.reads.borrow();
        assert_eq!(reads.iter().filter(|(hash, _)| hash == "m3").count(), 2, "main once, plus m3 as a head: {reads:?}");
        assert!(reads.iter().all(|(_, depth)| *depth == 12 || *depth == 120));
    }

    #[test]
    fn reads_deeper_only_for_a_branch_that_needs_it() {
        // main: 150 commits; "long" is 30 ahead of m100 (50 behind); "short" is 1 ahead of m149.
        let mut history = line("m", None, 150);
        history.extend(line("l", Some("m100"), 30));
        history.push(commit("s1", &["m149"]));
        let git = Fake::with(history);
        let found = run(measure(&git, "m150", &["l30".to_owned(), "s1".to_owned()]));
        assert_eq!(found[0].drift, Some(Drift { ahead: 30, behind: 50 }));
        assert_eq!(found[1].drift, Some(Drift { ahead: 1, behind: 1 }));
        let reads = git.reads.borrow();
        assert_eq!(reads.iter().filter(|(hash, _)| hash == "s1").count(), 1);
        assert_eq!(*reads.iter().filter(|(hash, _)| hash == "l30").map(|(_, depth)| depth).max().unwrap(), 40);
        assert!(!reads.iter().any(|(_, depth)| *depth == 1000), "{reads:?}");
    }

    #[test]
    fn unrelated_histories_read_to_their_start_count_every_commit() {
        let mut history = line("m", None, 3);
        history.extend(line("x", None, 2));
        let git = Fake::with(history);
        let found = run(measure(&git, "m3", &["x2".to_owned()]));
        assert_eq!(found[0].drift, Some(Drift { ahead: 2, behind: 3 }));
        assert_eq!(found[0].commit.as_ref().map(|c| c.hash.as_str()), Some("x2"));
        assert!(found[0].settled);
        // Both reached their start at the first depth: never read again.
        assert_eq!(git.reads.borrow().len(), 2);
    }

    #[test]
    fn past_the_last_depth_the_answer_is_settled_without_a_count() {
        // The branch is 1,200 commits long: no depth reaches where it left main.
        let mut history = line("m", None, 3);
        history.extend(line("x", Some("m1"), 1200));
        let git = Fake::with(history);
        let found = run(measure(&git, "m3", &["x1200".to_owned()]));
        assert_eq!(found[0].drift, None);
        assert_eq!(found[0].commit.as_ref().map(|c| c.hash.as_str()), Some("x1200"));
        assert!(found[0].settled);
    }

    #[test]
    fn a_failed_read_is_not_kept() {
        let mut git = Fake::with(forked());
        git.fail = Some("b2".into());
        let found = run(measure(&git, "m3", &["b2".to_owned(), "b1".to_owned()]));
        assert!(!found[0].settled);
        assert_eq!(found[1].drift, Some(Drift { ahead: 1, behind: 1 }));
        assert!(found[1].settled);
        git.fail = Some("m3".into());
        let found = run(measure(&git, "m3", &["b2".to_owned()]));
        assert!(!found[0].settled);
    }
}
