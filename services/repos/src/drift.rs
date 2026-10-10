//! How far branches have moved from the default branch, for Active branches
//! on a project's overview and the Branches page (`branch_drift`).
//!
//! The counts are `git rev-list --left-right --count main...branch`: every
//! commit one head reaches and the other does not, merges and what they
//! brought in included. The store lists histories by first parent only,
//! so a merge's other parents are read on their own as the walk reaches
//! them. The walk goes newest commit first from both
//! heads, marking each commit with the heads that reach it, as git does,
//! and stops once every commit still to look at is reached by both: what
//! lies below is shared and counts on neither side.
//!
//! The default branch's history is read once for every branch, and every
//! read is by commit hash, which the store keeps for good (store.rs); each
//! answer is kept by the pair of heads (lib.rs), so only heads that moved
//! cost a walk. Before 2026-10-08 the site did this itself: up to twenty
//! `log` calls per view, each with its own access check and store handle.
//!
//! Until 2026-10-09 the count gave up whenever a commit on one side only
//! had a parent the first-parent reads had not reached, which every merge
//! has: a branch whose default branch took a merge since it left showed no
//! counts, and that answer was kept for good.

use std::collections::{BinaryHeap, HashMap, HashSet};

use g1t_contracts::repos::{Commit, Drift};

use crate::store::GitRepo;

/// How much of the default branch's history is read first, once for every
/// branch.
pub const BASE_DEPTH: u32 = 120;
/// How much of a first-parent chain each further read takes: a branch
/// head's, or a merge's other parent's.
pub const STEP: u32 = 16;
/// Further reads for one branch before giving up on counting it: a branch
/// that left the default branch hundreds of commits or merges ago.
pub const MAX_READS: usize = 128;
/// Commits a walk may know of before giving up.
pub const MAX_COMMITS: usize = 4000;
/// Commits looked at after everything left is shared, in case a commit is
/// dated before its parent (rebased and amended commits keep their author
/// dates), as git's own walk does.
const SLOP: usize = 5;

/// Branches walked at once, and missing parents read at once.
const AT_ONCE: usize = 8;

/// A branch head's commit and drift, and whether the answer may be kept:
/// not when a read failed.
#[derive(Clone, Debug)]
pub struct Measured {
    pub commit: Option<Commit>,
    pub drift: Option<Drift>,
    pub settled: bool,
}

/// How one walk ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Walked {
    Counted(Drift),
    /// Past [`MAX_READS`] or [`MAX_COMMITS`]: no count, and that is the
    /// answer for this pair.
    TooFar,
    /// A read failed or found nothing: no count, and not to be kept.
    Failed,
}

/// The commits a walk knows: the default branch's history, shared by every
/// walk, and what this walk read itself.
struct Known<'a> {
    base: &'a HashMap<String, Commit>,
    own: HashMap<String, Commit>,
    reads: usize,
}

impl Known<'_> {
    fn get(&self, hash: &str) -> Option<&Commit> {
        self.own.get(hash).or_else(|| self.base.get(hash))
    }

    fn has(&self, hash: &str) -> bool {
        self.own.contains_key(hash) || self.base.contains_key(hash)
    }

    fn len(&self) -> usize {
        self.own.len() + self.base.len()
    }

    fn parents(&self, hash: &str) -> Vec<String> {
        self.get(hash).map(|commit| commit.parents.clone()).unwrap_or_default()
    }

    fn date(&self, hash: &str) -> String {
        self.get(hash).map(|commit| commit.authored_at.clone()).unwrap_or_default()
    }

    /// Reads the first-parent chain from each of `hashes` not yet known, at
    /// once. `Err` when a read failed or found nothing (the store lacks a
    /// commit another names), `Ok(false)` when that would pass
    /// [`MAX_READS`].
    async fn read<R: GitRepo>(&mut self, git: &R, hashes: &[String]) -> Result<bool, ()> {
        let mut wanted: Vec<&String> = Vec::new();
        for hash in hashes {
            if !self.has(hash) && !wanted.contains(&hash) {
                wanted.push(hash);
            }
        }
        if wanted.is_empty() {
            return Ok(true);
        }
        if self.reads + wanted.len() > MAX_READS {
            return Ok(false);
        }
        self.reads += wanted.len();
        let found = futures_util::future::join_all(wanted.iter().map(|hash| git.log(hash, STEP))).await;
        for read in found {
            match read {
                Ok(commits) if !commits.is_empty() => {
                    for commit in commits {
                        self.own.entry(commit.hash.clone()).or_insert(commit);
                    }
                }
                _ => return Err(()),
            }
        }
        Ok(true)
    }
}

const BRANCH: u8 = 1;
const MAIN: u8 = 2;
const BOTH: u8 = BRANCH | MAIN;

/// Commits `branch` reaches that `main` does not (ahead), and the other way
/// round (behind), with `branch`'s own commit when it was read. `base` is
/// what was read of `main`'s history; the walk reads anything else it needs.
pub async fn count<R: GitRepo>(git: &R, base: &HashMap<String, Commit>, branch: &str, main: &str) -> (Option<Commit>, Walked) {
    let mut known = Known { base, own: HashMap::new(), reads: 0 };
    let walked = walk(git, &mut known, branch, main).await;
    (known.get(branch).cloned(), walked)
}

async fn walk<R: GitRepo>(git: &R, known: &mut Known<'_>, branch: &str, main: &str) -> Walked {
    match known.read(git, &[branch.to_owned(), main.to_owned()]).await {
        Ok(true) => {}
        Ok(false) => return Walked::TooFar,
        Err(()) => return Walked::Failed,
    }
    let mut marks: HashMap<String, u8> = HashMap::new();
    // Newest first; ties by hash, which only decides the order.
    let mut queue: BinaryHeap<(String, String)> = BinaryHeap::new();
    let mut queued: HashSet<String> = HashSet::new();
    for (head, mark) in [(branch, BRANCH), (main, MAIN)] {
        *marks.entry(head.to_owned()).or_default() |= mark;
        if queued.insert(head.to_owned()) {
            queue.push((known.date(head), head.to_owned()));
        }
    }
    let mut slop = SLOP;
    while !queue.is_empty() {
        if queue.iter().all(|(_, hash)| marks.get(hash) == Some(&BOTH)) {
            if slop == 0 {
                break;
            }
            slop -= 1;
        }
        let Some((_, hash)) = queue.pop() else { break };
        queued.remove(&hash);
        let parents = known.parents(&hash);
        if parents.iter().any(|parent| !known.has(parent)) {
            // This commit's missing parents, and a few more that commits
            // waiting will need, in one round of reads.
            let mut wanted: Vec<String> = parents.iter().filter(|parent| !known.has(parent)).cloned().collect();
            let mut waiting: Vec<String> = queue
                .iter()
                .flat_map(|(_, waiting)| known.parents(waiting))
                .filter(|parent| !known.has(parent) && !wanted.contains(parent))
                .collect();
            waiting.sort();
            waiting.dedup();
            wanted.extend(waiting.into_iter().take(AT_ONCE.saturating_sub(1)));
            let read = match known.read(git, &wanted).await {
                // Too many with the others' parents: this one's alone.
                Ok(false) => known.read(git, &parents).await,
                read => read,
            };
            match read {
                Ok(true) => {}
                Ok(false) => return Walked::TooFar,
                Err(()) => return Walked::Failed,
            }
        }
        if known.len() > MAX_COMMITS {
            return Walked::TooFar;
        }
        let mark = marks.get(&hash).copied().unwrap_or_default();
        for parent in parents {
            let before = marks.get(&parent).copied().unwrap_or_default();
            if before | mark == before {
                continue;
            }
            marks.insert(parent.clone(), before | mark);
            // A commit that gains a mark after it was looked at is looked
            // at again, so the mark reaches what is below it.
            if queued.insert(parent.clone()) {
                queue.push((known.date(&parent), parent));
            }
        }
    }
    let ahead = marks.values().filter(|&&mark| mark == BRANCH).count() as u32;
    let behind = marks.values().filter(|&&mark| mark == MAIN).count() as u32;
    Walked::Counted(Drift { ahead, behind })
}

/// Each of `heads` measured against `base`, in the order given.
pub async fn measure<R: GitRepo>(git: &R, base: &str, heads: &[String]) -> Vec<Measured> {
    if heads.is_empty() {
        return Vec::new();
    }
    let main: HashMap<String, Commit> = match git.log(base, BASE_DEPTH).await {
        Ok(commits) if !commits.is_empty() => commits.into_iter().map(|commit| (commit.hash.clone(), commit)).collect(),
        _ => return heads.iter().map(|_| Measured { commit: None, drift: None, settled: false }).collect(),
    };
    let mut out = Vec::with_capacity(heads.len());
    for chunk in heads.chunks(AT_ONCE) {
        let walks = futures_util::future::join_all(chunk.iter().map(|head| count(git, &main, head, base))).await;
        out.extend(walks.into_iter().map(|(commit, walked)| match walked {
            Walked::Counted(drift) => Measured { commit, drift: Some(drift), settled: true },
            Walked::TooFar => Measured { commit, drift: None, settled: true },
            Walked::Failed => Measured { commit, drift: None, settled: false },
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, BranchDrift, BranchDrifts, GitAccess, Signature, TreeEntry};
    use worker::Result;

    use super::*;
    use crate::store::Scope;

    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    /// A date `t` seconds into a day, as the store writes them.
    fn at(t: u32) -> String {
        format!("2026-10-{:02}T{:02}:{:02}:{:02}.000Z", 1 + t / 86_400, t % 86_400 / 3600, t % 3600 / 60, t % 60)
    }

    fn commit(hash: &str, parents: &[&str], t: u32) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: format!("t{hash}"),
            message: format!("commit {hash}\n\nbody"),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parents.iter().map(|&p| p.to_owned()).collect(),
            authored_at: at(t),
        }
    }

    /// Commits by hash; `log` follows first parents only, as the store
    /// does. Counts each read.
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

        fn reads_of(&self, hash: &str) -> usize {
            self.reads.borrow().iter().filter(|(read, _)| read == hash).count()
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

    /// A straight line of `n` commits named `{prefix}{i}`, the first on
    /// `from`, dated `t0 + i * 10`.
    fn line(prefix: &str, from: Option<&str>, n: usize, t0: u32) -> Vec<Commit> {
        (1..=n)
            .map(|i| {
                let parent = if i == 1 { from.map(str::to_owned) } else { Some(format!("{prefix}{}", i - 1)) };
                commit(&format!("{prefix}{i}"), &parent.iter().map(String::as_str).collect::<Vec<_>>(), t0 + i as u32 * 10)
            })
            .collect()
    }

    fn one(git: &Fake, main: &str, head: &str) -> Measured {
        run(measure(git, main, &[head.to_owned()])).remove(0)
    }

    fn counted(ahead: u32, behind: u32) -> Option<Drift> {
        Some(Drift { ahead, behind })
    }

    /// m1 ← m2 ← m3 on main.
    fn main3() -> Vec<Commit> {
        line("m", None, 3, 0)
    }

    #[test]
    fn one_ahead_of_a_default_branch_that_has_not_moved() {
        let mut history = main3();
        history.push(commit("f1", &["m3"], 100));
        let found = one(&Fake::with(history), "m3", "f1");
        assert_eq!(found.drift, counted(1, 0));
        assert_eq!(found.commit.map(|c| c.hash), Some("f1".into()));
        assert!(found.settled);
    }

    #[test]
    fn behind_only_and_level() {
        let git = Fake::with(main3());
        assert_eq!(one(&git, "m3", "m2").drift, counted(0, 1));
        assert_eq!(one(&git, "m3", "m1").drift, counted(0, 2));
        let level = one(&git, "m3", "m3");
        assert_eq!(level.drift, counted(0, 0));
        assert!(level.settled);
    }

    #[test]
    fn diverged_counts_both_sides_from_where_they_forked() {
        // b1 ← b2 left main at m2; main went on to m3.
        let mut history = main3();
        history.extend([commit("b1", &["m2"], 25), commit("b2", &["b1"], 26)]);
        assert_eq!(one(&Fake::with(history), "m3", "b2").drift, counted(2, 1));
    }

    /// flagon-io/hello on 2026-10-08: `farewell` (bab14ff) is one commit on
    /// the first commit (c2ef68d). Main took a merge whose first parent is
    /// the branch merged (69796cb) and whose second is main as it was
    /// (ebbaeb2), so main's first-parent history never lists ebbaeb2. The
    /// old count gave up on that merge at every depth and kept "no count".
    #[test]
    fn a_merge_on_the_default_branch_does_not_hide_the_counts() {
        let history = vec![
            commit("root", &[], 0),
            commit("farewell", &["root"], 5),
            commit("old1", &["root"], 10),
            commit("old2", &["old1"], 20),
            commit("wave", &["old1"], 25),
            commit("merge", &["wave", "old2"], 30),
            commit("new1", &["merge"], 40),
        ];
        let git = Fake::with(history);
        let found = one(&git, "new1", "farewell");
        // Behind: old1, old2, wave, merge, new1.
        assert_eq!(found.drift, counted(1, 5));
        assert!(found.settled);
        assert_eq!(git.reads_of("old2"), 1, "the merge's other parent is read on its own");
    }

    #[test]
    fn merges_on_both_sides() {
        // main: root ← m1 ← m2 ← m3 (merges pull p1, made on m1).
        // branch: b1 on m1, b2 merges m2 into it, b3 on b2.
        let history = vec![
            commit("root", &[], 0),
            commit("m1", &["root"], 10),
            commit("m2", &["m1"], 20),
            commit("p1", &["m1"], 15),
            commit("m3", &["m2", "p1"], 40),
            commit("b1", &["m1"], 12),
            commit("b2", &["b1", "m2"], 30),
            commit("b3", &["b2"], 35),
        ];
        // Ahead: b1, b2, b3. Behind: p1, m3 (m2 came in with b2's merge).
        assert_eq!(one(&Fake::with(history), "m3", "b3").drift, counted(3, 2));
    }

    #[test]
    fn a_pull_merged_and_built_on() {
        // b1 merged into main by m2; b2 on b1 after.
        let history = vec![
            commit("m0", &[], 0),
            commit("m1", &["m0"], 10),
            commit("b1", &["m0"], 15),
            commit("m2", &["m1", "b1"], 20),
            commit("b2", &["b1"], 30),
        ];
        // b1 is on both; ahead b2, behind m1 and m2.
        assert_eq!(one(&Fake::with(history), "m2", "b2").drift, counted(1, 2));
    }

    #[test]
    fn a_fork_point_past_the_first_read() {
        // Main moved 300 commits since l1..l5 left it at m10.
        let mut history = line("m", None, 310, 0);
        history.extend(line("l", Some("m10"), 5, 100));
        let git = Fake::with(history);
        let found = one(&git, "m310", "l5");
        assert_eq!(found.drift, counted(5, 300));
        assert!(found.settled);
        assert_eq!(git.reads_of("m310"), 1, "{:?}", git.reads.borrow());
    }

    #[test]
    fn a_fork_point_with_merges_past_the_first_read() {
        // 200 pulls merged into main since the branch left m0, each a
        // commit on the main it was made from.
        let mut history = vec![commit("m0", &[], 0)];
        for i in 1..=200u32 {
            let before = format!("m{}", i - 1);
            history.push(commit(&format!("p{i}"), &[&before], i * 10 + 5));
            history.push(commit(&format!("m{i}"), &[&before, &format!("p{i}")], i * 10 + 8));
        }
        history.push(commit("b1", &["m0"], 3));
        let git = Fake::with(history);
        let found = one(&git, "m200", "b1");
        // Everything on main but m0: 200 merges and 200 pulls. Each pull is
        // a read of its own, more than a walk may make.
        assert_eq!(found.drift, None);
        assert!(found.settled);
        // The same shape, 20 pulls deep, is counted.
        let mut history = vec![commit("m0", &[], 0)];
        for i in 1..=20u32 {
            let before = format!("m{}", i - 1);
            history.push(commit(&format!("p{i}"), &[&before], i * 10 + 5));
            history.push(commit(&format!("m{i}"), &[&before, &format!("p{i}")], i * 10 + 8));
        }
        history.push(commit("b1", &["m0"], 3));
        assert_eq!(one(&Fake::with(history), "m20", "b1").drift, counted(1, 40));
    }

    #[test]
    fn too_far_is_settled_without_a_count() {
        // The branch is 3,000 commits long: more reads than a walk may make.
        let mut history = main3();
        history.extend(line("x", Some("m1"), 3000, 100));
        let found = one(&Fake::with(history), "m3", "x3000");
        assert_eq!(found.drift, None);
        assert_eq!(found.commit.map(|c| c.hash), Some("x3000".into()));
        assert!(found.settled);
    }

    #[test]
    fn a_commit_dated_before_its_parent() {
        // b1 was rebased onto m5 and kept its author date, older than
        // every commit on main.
        let mut history = line("m", None, 5, 100);
        history.push(commit("b1", &["m5"], 1));
        assert_eq!(one(&Fake::with(history.clone()), "m5", "b1").drift, counted(1, 0));
        history.push(commit("m6", &["m5"], 500));
        assert_eq!(one(&Fake::with(history), "m6", "b1").drift, counted(1, 1));
    }

    #[test]
    fn unrelated_histories_count_every_commit() {
        let mut history = main3();
        history.extend(line("x", None, 2, 0));
        let found = one(&Fake::with(history), "m3", "x2");
        assert_eq!(found.drift, counted(2, 3));
        assert!(found.settled);
    }

    #[test]
    fn the_default_branch_is_read_once_for_every_head() {
        let mut history = main3();
        history.extend([commit("b1", &["m2"], 25), commit("b2", &["b1"], 26), commit("f1", &["m3"], 40)]);
        let git = Fake::with(history);
        let heads: Vec<String> = ["b2", "m2", "m3", "f1"].map(str::to_owned).into();
        let found = run(measure(&git, "m3", &heads));
        let drifts: Vec<_> = found.iter().map(|m| m.drift).collect();
        assert_eq!(drifts, [counted(2, 1), counted(0, 1), counted(0, 0), counted(1, 0)]);
        assert!(found.iter().all(|m| m.settled));
        assert_eq!(git.reads.borrow().iter().filter(|(hash, depth)| hash == "m3" && *depth == BASE_DEPTH).count(), 1);
    }

    #[test]
    fn a_failed_read_is_not_kept() {
        let mut history = main3();
        history.extend([commit("b1", &["m2"], 25), commit("b2", &["b1"], 26)]);
        let mut git = Fake::with(history);
        git.fail = Some("b2".into());
        let found = run(measure(&git, "m3", &["b2".to_owned(), "b1".to_owned()]));
        assert!(!found[0].settled);
        assert_eq!(found[0].drift, None);
        assert_eq!(found[1].drift, counted(1, 1));
        assert!(found[1].settled);
        git.fail = Some("m3".into());
        let found = one(&git, "m3", "b2");
        assert!(!found.settled);
        // A head the store does not have (yet) is not kept either.
        git.fail = None;
        assert!(!one(&git, "m3", "nope").settled);
    }

    /// The answer as the site reads it (packages/contracts/src/repos.ts
    /// `BranchDrifts`, apps/web/app/lib/branches.ts): the same field names,
    /// or every count is silently dropped.
    #[test]
    fn the_answer_has_the_names_the_site_reads() {
        let answer = BranchDrifts {
            base: Some(commit("m3", &["m2"], 30)),
            branches: vec![BranchDrift { head: "f1".into(), commit: Some(commit("f1", &["m3"], 40)), drift: counted(1, 0) }],
        };
        let json = serde_json::to_value(&answer).unwrap();
        let branch = &json["branches"][0];
        assert_eq!(branch["head"], "f1");
        assert_eq!(branch["drift"], serde_json::json!({ "ahead": 1, "behind": 0 }));
        assert_eq!(branch["commit"]["authoredAt"], at(40));
        assert_eq!(branch["commit"]["treeHash"], "tf1");
        assert_eq!(json["base"]["hash"], "m3");
        let none = serde_json::to_value(BranchDrift { head: "x".into(), commit: None, drift: None }).unwrap();
        assert_eq!(none, serde_json::json!({ "head": "x", "commit": null, "drift": null }));
    }
}
