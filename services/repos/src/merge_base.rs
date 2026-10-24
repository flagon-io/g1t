//! Where a pull request's head and the branch it merges into last agreed:
//! their best common ancestor, as `git merge-base` finds it, over every
//! parent of every commit.
//!
//! The store lists histories by first parent only (store.rs `log`). Until
//! 2026-10-22 the merge base was the head's nearest ancestor on the target
//! branch's first-parent line, which misses what the branch took in through
//! a merge commit's other parent. A branch made from another pull request's
//! branch, opened once that pull request had merged with a merge commit,
//! then got the commit the first branch left the target from: both sides
//! seemed to have changed the first pull request's files, so the test merge
//! and bringing the branch up to date answered with conflicts git did not
//! have, and no `pull_request` run started (flagon-io/g1t#365).
//!
//! The head's side is walked from its head over every parent down to the
//! target's first-parent line. Where the target took merges above the
//! newest commit of that line the head reaches, what those merges brought
//! in is walked too, down to the line, and any of the head's commits it
//! meets is shared. Of what is shared, the commits no other shared one
//! descends from are the best; the nearest the head is taken.

use std::collections::{HashMap, HashSet, VecDeque};

use g1t_contracts::repos::Commit;
use worker::Result;

use crate::MAX_ANCESTRY;
use crate::store::GitRepo;

/// How much of a first-parent chain each read of a merged branch takes.
const STEP: u32 = 16;
/// Reads of what the target merged in before giving up on looking further.
const MAX_READS: usize = 128;
/// Reads made at once.
const AT_ONCE: usize = 8;

/// The best common ancestor of a head and a target branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergeBase {
    pub hash: String,
    /// Its tree.
    pub tree: String,
    /// The head's commits the target has through a merge's other parent,
    /// not on its first-parent line: with that line, what the head shares.
    pub merged: HashSet<String>,
}

/// The best common ancestor of the head of `history` (its first-parent
/// chain, read from `head_repo`) and of `target_history` (the target
/// branch's, from `target_repo`); `line` is `target_history` as a set.
/// `None` when they share nothing within [`MAX_ANCESTRY`] commits.
pub(crate) async fn merge_base<H: GitRepo, T: GitRepo>(
    head_repo: &H,
    history: &[Commit],
    target_repo: &T,
    target_history: &[Commit],
    line: &HashSet<String>,
) -> Result<Option<MergeBase>> {
    let Some(head) = history.first() else {
        return Ok(None);
    };
    // The head's side: every commit off the line, in the order met, with
    // its parents, and the commits of the line it reaches.
    let known: HashMap<&str, &[String]> = history.iter().map(|commit| (commit.hash.as_str(), commit.parents.as_slice())).collect();
    let mut order: Vec<String> = Vec::new();
    let mut parents_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut reached: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::from([head.hash.clone()]);
    while let Some(hash) = queue.pop_front() {
        if !seen.insert(hash.clone()) {
            continue;
        }
        if line.contains(&hash) {
            reached.insert(hash);
            continue;
        }
        if seen.len() > MAX_ANCESTRY as usize {
            break;
        }
        let parents = match known.get(hash.as_str()) {
            Some(parents) => parents.to_vec(),
            None => head_repo.parents(&hash).await?.unwrap_or_default(),
        };
        queue.extend(parents.iter().cloned());
        order.push(hash.clone());
        parents_of.insert(hash, parents);
    }
    // The newest commit of the line the head reaches.
    let Some(newest) = target_history.iter().position(|commit| reached.contains(&commit.hash)) else {
        return Ok(None);
    };
    let on_line = &target_history[newest];

    // What the target merged in above it, walked down to the line; the
    // head's commits it meets are shared.
    let mut commits: HashMap<String, Commit> = HashMap::new();
    let mut frontier: Vec<String> = target_history[..newest].iter().flat_map(|commit| commit.parents.iter().skip(1).cloned()).collect();
    let mut hits: HashSet<String> = HashSet::new();
    if !parents_of.is_empty() {
        let mut walked: HashSet<String> = HashSet::new();
        let mut reads = 0;
        'walk: while !frontier.is_empty() {
            let mut wanted: Vec<String> = Vec::new();
            while let Some(hash) = frontier.pop() {
                if line.contains(&hash) || walked.contains(&hash) {
                    continue;
                }
                if parents_of.contains_key(&hash) {
                    walked.insert(hash.clone());
                    hits.insert(hash);
                    continue;
                }
                match commits.get(&hash) {
                    Some(commit) => {
                        walked.insert(hash.clone());
                        if walked.len() > MAX_ANCESTRY as usize {
                            break 'walk;
                        }
                        frontier.extend(commit.parents.iter().cloned());
                    }
                    None if !wanted.contains(&hash) => wanted.push(hash),
                    None => {}
                }
            }
            if wanted.is_empty() || reads >= MAX_READS {
                break;
            }
            // The rest wait for the next round.
            let later = wanted.split_off(wanted.len().min(AT_ONCE).min(MAX_READS - reads));
            reads += wanted.len();
            let found = futures_util::future::try_join_all(wanted.iter().map(|hash| target_repo.log(hash, STEP))).await?;
            for (hash, chain) in wanted.iter().zip(found) {
                if chain.is_empty() {
                    // The store lacks it: nothing to follow below.
                    walked.insert(hash.clone());
                }
                for commit in chain {
                    commits.entry(commit.hash.clone()).or_insert(commit);
                }
            }
            frontier = wanted;
            frontier.extend(later);
        }
    }

    // Of what is shared, what no other shared commit descends from: the
    // one nearest the head, where the line's commit is below it; else the
    // line's commit, as when nothing was merged in.
    let mut below: HashSet<String> = HashSet::new();
    for hit in &hits {
        let mut stack: Vec<String> = parents_of.get(hit).cloned().unwrap_or_default();
        while let Some(hash) = stack.pop() {
            if below.insert(hash.clone()) {
                stack.extend(parents_of.get(&hash).into_iter().flatten().cloned());
            }
        }
    }
    let merged: HashSet<String> = hits.iter().chain(&below).filter(|hash| parents_of.contains_key(*hash)).cloned().collect();
    let best = match below.contains(&on_line.hash) {
        true => order.iter().find(|hash| hits.contains(*hash) && !below.contains(*hash)),
        false => None,
    };
    let tree = match best {
        Some(hash) => match history.iter().chain(commits.values()).find(|commit| commit.hash == *hash) {
            Some(commit) => Some(commit.tree_hash.clone()),
            None => match read_tree_of(target_repo, hash).await? {
                Some(tree) => Some(tree),
                None => read_tree_of(head_repo, hash).await?,
            },
        },
        None => None,
    };
    let (hash, tree) = match (best, tree) {
        (Some(hash), Some(tree)) => (hash.clone(), tree),
        _ => (on_line.hash.clone(), on_line.tree_hash.clone()),
    };
    Ok(Some(MergeBase { hash, tree, merged }))
}

/// A commit's tree, read by its hash.
async fn read_tree_of<R: GitRepo>(repo: &R, hash: &str) -> Result<Option<String>> {
    Ok(repo.log(hash, 1).await?.into_iter().find(|commit| commit.hash == hash).map(|commit| commit.tree_hash))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use g1t_contracts::repos::{Branch, GitAccess, Signature, TreeEntry};

    use super::*;
    use crate::store::Scope;

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: format!("t{hash}"),
            message: hash.into(),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parents.iter().map(|&parent| parent.to_owned()).collect(),
            authored_at: String::new(),
        }
    }

    /// Commits by hash; `log` follows first parents only, as the store
    /// does. Counts reads by `log`.
    #[derive(Default)]
    struct Fake {
        commits: HashMap<String, Commit>,
        logs: RefCell<usize>,
    }

    impl Fake {
        fn with(commits: &[(&str, &[&str])]) -> Fake {
            let commits = commits.iter().map(|(hash, parents)| ((*hash).to_owned(), commit(hash, parents))).collect();
            Fake { commits, ..Fake::default() }
        }

        fn history(&self, head: &str) -> Vec<Commit> {
            let mut out = Vec::new();
            let mut at = self.commits.get(head);
            while let Some(commit) = at {
                out.push(commit.clone());
                at = commit.parents.first().and_then(|parent| self.commits.get(parent));
            }
            out
        }

        /// The merge base of `head` and `base`, read as a pull request's is.
        fn merge_base(&self, head: &str, base: &str) -> Option<MergeBase> {
            let (history, target) = (self.history(head), self.history(base));
            let line = target.iter().map(|commit| commit.hash.clone()).collect();
            block_on(merge_base(self, &history, self, &target, &line)).unwrap()
        }
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> worker::Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> worker::Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> worker::Result<Vec<Commit>> {
            *self.logs.borrow_mut() += 1;
            Ok(self.history(git_ref).into_iter().take(limit as usize).collect())
        }
        async fn parents(&self, commit_hash: &str) -> worker::Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
        }
        async fn read_tree(&self, _tree_hash: &str) -> worker::Result<Option<Vec<TreeEntry>>> {
            Ok(None)
        }
        async fn read_blob(&self, _blob_hash: &str) -> worker::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> worker::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str, _default_branch_only: bool) -> worker::Result<()> {
            Ok(())
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
        }
    }

    fn set(hashes: &[&str]) -> HashSet<String> {
        hashes.iter().map(|&hash| hash.to_owned()).collect()
    }

    #[test]
    fn a_branch_off_the_target_meets_it_where_it_left() {
        // main: m0 - m1; the branch: m0 - h1 - h2.
        let fake = Fake::with(&[("m0", &[]), ("m1", &["m0"]), ("h1", &["m0"]), ("h2", &["h1"])]);
        let found = fake.merge_base("h2", "m1").unwrap();
        assert_eq!((found.hash.as_str(), found.tree.as_str()), ("m0", "tm0"));
        assert!(found.merged.is_empty());
    }

    #[test]
    fn a_branch_made_from_a_pull_request_that_merged_with_a_merge_commit_meets_it_at_that_pull_request_s_head() {
        // #360's branch: m0 - p1; #361's, made from it: p1 - s1 - s2. Main
        // took another change (m1), then #360 as a merge commit (M).
        let fake = Fake::with(&[("m0", &[]), ("p1", &["m0"]), ("s1", &["p1"]), ("s2", &["s1"]), ("m1", &["m0"]), ("M", &["m1", "p1"])]);
        let found = fake.merge_base("s2", "M").unwrap();
        assert_eq!((found.hash.as_str(), found.tree.as_str()), ("p1", "tp1"));
        assert_eq!(found.merged, set(&["p1"]));
    }

    #[test]
    fn the_first_pull_request_s_later_commits_are_followed_down_to_where_the_second_left_it() {
        // #360 took p2 after #361 was made from p1, and merged at p2.
        let fake = Fake::with(&[
            ("m0", &[]),
            ("p0", &["m0"]),
            ("p1", &["p0"]),
            ("p2", &["p1"]),
            ("s1", &["p1"]),
            ("m1", &["m0"]),
            ("M", &["m1", "p2"]),
            ("m2", &["M"]),
        ]);
        let found = fake.merge_base("s1", "m2").unwrap();
        assert_eq!(found.hash, "p1");
        assert_eq!(found.merged, set(&["p1", "p0"]));
    }

    #[test]
    fn a_branch_that_merged_the_target_in_meets_it_at_its_head() {
        // As #361 did to start its checks: s2 merged M in.
        let fake =
            Fake::with(&[("m0", &[]), ("p1", &["m0"]), ("s1", &["p1"]), ("m1", &["m0"]), ("M", &["m1", "p1"]), ("s2", &["s1", "M"])]);
        assert_eq!(fake.merge_base("s2", "M").unwrap().hash, "M");
    }

    #[test]
    fn merges_below_where_the_branch_left_are_not_read() {
        // A merge of another branch (o1) into main before h1 left it.
        let fake = Fake::with(&[("m0", &[]), ("o1", &["m0"]), ("M", &["m0", "o1"]), ("h1", &["M"]), ("m1", &["M"])]);
        let found = fake.merge_base("h1", "m1").unwrap();
        assert_eq!(found.hash, "M");
        assert_eq!(*fake.logs.borrow(), 0);
    }

    #[test]
    fn what_else_the_target_merged_is_walked_past() {
        // Main merged o1 (unrelated) above where the branch left.
        let fake = Fake::with(&[("m0", &[]), ("o1", &["m0"]), ("h1", &["m0"]), ("M", &["m0", "o1"])]);
        let found = fake.merge_base("h1", "M").unwrap();
        assert_eq!(found.hash, "m0");
        assert!(found.merged.is_empty());
    }

    #[test]
    fn histories_that_share_nothing_have_no_merge_base() {
        let fake = Fake::with(&[("a", &[]), ("b", &[])]);
        assert_eq!(fake.merge_base("a", "b"), None);
    }
}
