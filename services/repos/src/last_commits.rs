//! Which commit last changed each entry of a directory, for the file list.
//!
//! History is walked newest first along the first-parent chain. Each commit
//! is compared with its parent only where the directory itself changed (its
//! tree hash differs), so the walk reads a tree only for the commits that
//! touched it. An entry is given the newest commit after which its hash is
//! no longer the same; one that never changes within the walk is given the
//! first commit there is, once the walk reaches it.
//!
//! A walk is never thrown away. What it found is remembered as
//! [`Progress`] per repository, ref and path ([`Memo`]), with the head it
//! started from and, when it had to stop, the commit to go on from:
//!
//! - The same head again goes on from where the last walk stopped, so a
//!   long history is walked to its first commit over as many calls as it
//!   takes, each within the Worker's limits ([`MAX_READS`]).
//! - A new head walks only back to the remembered one, when that is on its
//!   first-parent chain: an entry whose hash did not change in between keeps
//!   the commit remembered for it. A push then costs only its own commits.
//!   When the remembered head never comes up (a force-push), the walk is a
//!   full one.

use std::collections::{HashMap, HashSet};

use g1t_contracts::repos::{Commit, EntryKind, LastCommit, TreeEntry};
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::shared::Shared;
use crate::store::GitRepo;

/// Reads of the store one call makes at most. Each costs up to three
/// subrequests (a Cache API look, the store, a Cache API put), so this
/// keeps a call well inside the 10,000 a Worker invocation may make, with
/// room for the rest of the request. A repository's root takes about one
/// read per commit, so a call walks some 2,000 commits, and the next call
/// goes on from there.
pub const MAX_READS: u32 = 2_500;
/// Commits whose trees are read together, ahead of the walk: each read is a
/// round trip to the store, so reading them one by one is what is slow.
const READ_AHEAD: usize = 24;
/// Commits of history read at a time.
const PAGE: u32 = 48;

/// What walks found for a directory, from `head`: kept between walks.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Progress {
    /// The commit the walks started from.
    pub head: String,
    /// The entries given their commit.
    pub found: Vec<LastCommit>,
    /// The entries not given one yet.
    pub open: Vec<String>,
    /// The commit to go on from while some are open: the newest not yet
    /// compared with its parent. `None` once no walk can find more.
    pub at: Option<String>,
}

impl Progress {
    pub fn complete(&self) -> bool {
        self.open.is_empty()
    }

    /// Whether no walk could find more.
    pub fn settled(&self) -> bool {
        self.open.is_empty() || self.at.is_none()
    }
}

/// One call's walk: where it got to, and how many reads of the store it made.
pub struct Walk {
    pub progress: Progress,
    pub reads: u32,
}

/// Reads trees, remembering those already read: commits share most of them.
struct Trees<'a, R: GitRepo> {
    repo: &'a R,
    read: HashMap<String, Option<Vec<TreeEntry>>>,
    /// Reads of the store so far, trees and history.
    reads: u32,
}

impl<'a, R: GitRepo> Trees<'a, R> {
    async fn log(&mut self, from: &str) -> Result<Vec<Commit>> {
        self.reads += 1;
        self.repo.log(from, PAGE).await
    }

    /// Reads the trees not read yet, all at once.
    async fn prefetch(&mut self, hashes: impl IntoIterator<Item = String>) -> Result<()> {
        let mut wanted: Vec<String> = hashes.into_iter().filter(|hash| !self.read.contains_key(hash)).collect();
        wanted.sort();
        wanted.dedup();
        self.reads += wanted.len() as u32;
        let found = futures_util::future::join_all(wanted.iter().map(|hash| self.repo.read_tree(hash))).await;
        for (hash, tree) in wanted.into_iter().zip(found) {
            self.read.insert(hash, tree?);
        }
        Ok(())
    }

    /// Reads, level by level and each level at once, the trees on the way
    /// to `path` in each of `roots`, and the directory itself.
    async fn prefetch_dirs(&mut self, roots: Vec<String>, path: &str) -> Result<()> {
        let mut level = roots;
        for segment in path.split('/').filter(|segment| !segment.is_empty()) {
            self.prefetch(level.clone()).await?;
            level = level
                .iter()
                .filter_map(|hash| {
                    self.read.get(hash)?.as_ref()?.iter().find(|entry| entry.name == segment && entry.kind == EntryKind::Tree).map(|entry| entry.hash.clone())
                })
                .collect();
        }
        self.prefetch(level).await
    }

    async fn get(&mut self, hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        if let Some(found) = self.read.get(hash) {
            return Ok(found.clone());
        }
        self.reads += 1;
        let found = self.repo.read_tree(hash).await?;
        self.read.insert(hash.to_owned(), found.clone());
        Ok(found)
    }

    /// The tree hash of `path` in a commit's root tree; the root for an empty path.
    async fn dir(&mut self, root: &str, path: &str) -> Result<Option<String>> {
        let mut hash = root.to_owned();
        for segment in path.split('/').filter(|segment| !segment.is_empty()) {
            let Some(entries) = self.get(&hash).await? else {
                return Ok(None);
            };
            match entries.into_iter().find(|entry| entry.name == segment && entry.kind == EntryKind::Tree) {
                Some(entry) => hash = entry.hash,
                None => return Ok(None),
            }
        }
        Ok(Some(hash))
    }

    async fn entries(&mut self, dir: Option<&str>) -> Result<HashMap<String, String>> {
        let Some(dir) = dir else {
            return Ok(HashMap::new());
        };
        Ok(self.get(dir).await?.unwrap_or_default().into_iter().map(|entry| (entry.name, entry.hash)).collect())
    }
}

/// Where a walk stands: the history ahead from the commit it is at, and
/// that commit's directory and entries.
struct Cursor {
    history: Vec<Commit>,
    index: usize,
    /// The trees of history before this index have been read ahead.
    read_ahead_to: usize,
    dir: Option<String>,
    current: HashMap<String, String>,
}

impl Cursor {
    /// At the commit `from`, or `None` when there is no such commit.
    async fn at<R: GitRepo>(trees: &mut Trees<'_, R>, from: &str, path: &str) -> Result<Option<Cursor>> {
        let history = trees.log(from).await?;
        let Some(first) = history.first() else {
            return Ok(None);
        };
        let dir = trees.dir(&first.tree_hash.clone(), path).await?;
        let current = trees.entries(dir.as_deref()).await?;
        Ok(Some(Cursor { history, index: 0, read_ahead_to: 0, dir, current }))
    }

    fn commit(&self) -> &Commit {
        &self.history[self.index]
    }
}

/// The last commit of each entry of `path` at the commit `head`, going on
/// from `kept` (what earlier walks of the same ref and path found). The
/// walk stops, for the next call to go on from, once `out_of_time` says so
/// (asked between batches, after some progress) or before it would make
/// more than `max_reads` reads of the store.
pub async fn last_commits<R: GitRepo>(
    repo: &R,
    head: &str,
    path: &str,
    kept: Option<Progress>,
    out_of_time: &dyn Fn() -> bool,
    max_reads: u32,
) -> Result<Walk> {
    let mut trees = Trees { repo, read: HashMap::new(), reads: 0 };
    let segments = path.split('/').filter(|segment| !segment.is_empty()).count();
    // The most a batch read ahead reads, and a page of history.
    let batch = (READ_AHEAD * (segments + 1)) as u32 + 1;
    let mut found: Vec<LastCommit> = Vec::new();
    let mut open: Vec<String> = Vec::new();
    // An earlier walk from another head, to stop at if it comes up.
    let mut stop_at: Option<Progress> = None;
    let fresh;
    let start = match kept {
        Some(kept) if kept.head == head => {
            let Some(at) = kept.at.clone().filter(|_| !kept.open.is_empty()) else {
                return Ok(Walk { progress: kept, reads: 0 });
            };
            found = kept.found;
            open = kept.open;
            fresh = false;
            at
        }
        other => {
            stop_at = other;
            fresh = true;
            head.to_owned()
        }
    };
    let Some(mut cursor) = Cursor::at(&mut trees, &start, path).await? else {
        // An unknown head has nothing. A commit to go on from that cannot
        // be read any more leaves what is open unknown.
        return Ok(Walk { progress: Progress { head: head.to_owned(), found, open, at: None }, reads: trees.reads });
    };
    if fresh {
        open = cursor.current.keys().cloned().collect();
    }
    let give = |found: &mut Vec<LastCommit>, name: String, commit: &Commit| found.push(LastCommit { name, commit: commit.clone() });
    let mut walked = 0u32;
    // Whether the walk had to stop with more to find.
    let mut stopped = false;
    while !open.is_empty() {
        // The head an earlier walk started from: what has not changed
        // since keeps what that walk found for it.
        if stop_at.as_ref().is_some_and(|kept| kept.head == cursor.commit().hash) {
            let Some(kept) = stop_at.take() else { break };
            let given: HashMap<&str, &LastCommit> = kept.found.iter().map(|last| (last.name.as_str(), last)).collect();
            let kept_open: HashSet<&str> = kept.open.iter().map(String::as_str).collect();
            let mut rest = Vec::new();
            for name in open.drain(..) {
                match given.get(name.as_str()) {
                    Some(last) => found.push((*last).clone()),
                    None => rest.push(name),
                }
            }
            open = rest;
            // The rest were still open for that walk too: go on from where
            // it stopped rather than walk the same history again. Otherwise
            // (it did not know them) the walk goes on from here.
            if !open.is_empty() && open.iter().all(|name| kept_open.contains(name.as_str())) {
                let next = match &kept.at {
                    Some(at) => Cursor::at(&mut trees, at, path).await?,
                    None => None,
                };
                // None: that walk found all there was to find.
                let Some(next) = next else { break };
                cursor = next;
            }
            continue;
        }
        let needs_page = cursor.index + 1 >= cursor.history.len() && !cursor.commit().parents.is_empty();
        let needs_read_ahead = cursor.index >= cursor.read_ahead_to;
        if (needs_page || needs_read_ahead) && walked > 0 && (out_of_time() || trees.reads + batch > max_reads) {
            stopped = true;
            break;
        }
        // The next page once the walk reaches the end of this one.
        if needs_page {
            let parent = cursor.commit().parents[0].clone();
            let more = trees.log(&parent).await?;
            // What is behind the walk is not needed again.
            cursor.history.drain(..cursor.index);
            cursor.read_ahead_to = cursor.read_ahead_to.saturating_sub(cursor.index);
            cursor.index = 0;
            cursor.history.extend(more);
        }
        if cursor.index >= cursor.read_ahead_to {
            // Nor are the trees already compared.
            trees.read.clear();
            let ahead = cursor.history.iter().skip(cursor.index + 1).take(READ_AHEAD).map(|commit| commit.tree_hash.clone()).collect();
            trees.prefetch_dirs(ahead, path).await?;
            cursor.read_ahead_to = cursor.index + READ_AHEAD;
        }
        let commit = cursor.commit().clone();
        let Some(parent) = cursor.history.get(cursor.index + 1).cloned() else {
            // The oldest commit there is. If it is the first commit, what
            // is left was added by it; if its parent could not be read,
            // what is left is not known.
            if commit.parents.is_empty() {
                for name in open.drain(..) {
                    give(&mut found, name, &commit);
                }
            }
            break;
        };
        cursor.index += 1;
        walked += 1;
        let parent_dir = trees.dir(&parent.tree_hash, path).await?;
        if parent_dir == cursor.dir {
            continue;
        }
        let before = trees.entries(parent_dir.as_deref()).await?;
        let (changed, still): (Vec<String>, Vec<String>) = open.into_iter().partition(|name| before.get(name) != cursor.current.get(name));
        for name in changed {
            give(&mut found, name, &commit);
        }
        open = still;
        cursor.dir = parent_dir;
        cursor.current = before;
    }
    let at = (stopped && !open.is_empty()).then(|| cursor.commit().hash.clone());
    Ok(Walk { progress: Progress { head: head.to_owned(), found, open, at }, reads: trees.reads })
}

/// Where the progress for a ref and path of a repository is kept: in this
/// colo's cache, and shared between colos when the service has `GIT_CACHE`
/// (shared.rs).
pub struct Memo {
    colo_url: String,
    shared_key: String,
}

/// How long progress is kept after its last walk.
const MEMO_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

impl Memo {
    pub fn new(repo_id: &str, git_ref: &str, path: &str) -> Memo {
        let what = g1t_secrets::sha256_hex(&format!("{git_ref}\n{path}"));
        Memo {
            colo_url: format!("https://last-commits.g1t.internal/progress/v1/{repo_id}/{what}"),
            shared_key: format!("last-commits:{repo_id}:{what}"),
        }
    }

    /// The progress kept, this colo's first. A failure to read is none.
    pub async fn get(&self, shared: Option<&Shared>) -> Option<Progress> {
        if let Ok(Some(mut response)) = worker::Cache::default().get(self.colo_url.as_str(), false).await
            && let Ok(progress) = response.json::<Progress>().await
        {
            return Some(progress);
        }
        let bytes = shared?.get(&self.shared_key).await?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Keeps `progress` here and in the shared store. A failure only costs
    /// a longer walk later.
    pub async fn keep(&self, shared: Option<&Shared>, progress: &Progress) {
        let Ok(bytes) = serde_json::to_vec(progress) else {
            return;
        };
        let colo = async {
            if let Ok(mut response) = worker::Response::from_bytes(bytes.clone()) {
                let _ = response.headers_mut().set("cache-control", &format!("max-age={MEMO_TTL_SECONDS}"));
                let _ = worker::Cache::default().put(self.colo_url.as_str(), response).await;
            }
        };
        let shared_put = async {
            if let Some(shared) = shared {
                shared.put(&self.shared_key, &bytes, MEMO_TTL_SECONDS).await;
            }
        };
        futures_util::future::join(colo, shared_put).await;
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, GitAccess, Signature};

    use super::*;
    use crate::store::Scope;

    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    #[derive(Default)]
    struct Fake {
        trees: HashMap<String, Vec<TreeEntry>>,
        history: Vec<Commit>,
        /// Every tree read, in order.
        trees_read: RefCell<Vec<String>>,
        /// Where each history read started.
        logs_read: RefCell<Vec<String>>,
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
            self.logs_read.borrow_mut().push(git_ref.to_owned());
            // A branch name starts at the head; a hash at that commit; anything else is unknown.
            let start = if git_ref == "main" { Some(0) } else { self.history.iter().position(|commit| commit.hash == git_ref) };
            Ok(start.map(|start| self.history.iter().skip(start).take(limit as usize).cloned().collect()).unwrap_or_default())
        }
        async fn parents(&self, _commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(None)
        }
        async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            self.trees_read.borrow_mut().push(tree_hash.to_owned());
            Ok(self.trees.get(tree_hash).cloned())
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

    fn entry(name: &str, hash: &str, kind: EntryKind) -> TreeEntry {
        TreeEntry { name: name.into(), hash: hash.into(), kind }
    }

    fn commit(hash: &str, tree: &str, parent: Option<&str>) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: tree.into(),
            message: format!("commit {hash}"),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parent.map(|p| vec![p.to_owned()]).unwrap_or_default(),
            authored_at: String::new(),
        }
    }

    /// c1 adds README and src/a.rs; c2 changes src/a.rs; c3 changes README.
    fn repo() -> Fake {
        let mut fake = Fake::default();
        fake.trees.insert("src1".into(), vec![entry("a.rs", "a1", EntryKind::Blob)]);
        fake.trees.insert("src2".into(), vec![entry("a.rs", "a2", EntryKind::Blob)]);
        fake.trees.insert("root1".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        fake.trees.insert("root2".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src2", EntryKind::Tree)]);
        fake.trees.insert("root3".into(), vec![entry("README.md", "r2", EntryKind::Blob), entry("src", "src2", EntryKind::Tree)]);
        fake.history = vec![commit("c3", "root3", Some("c2")), commit("c2", "root2", Some("c1")), commit("c1", "root1", None)];
        fake
    }

    /// A long history, newest first: `.dockerignore` is added by the first
    /// commit and never changed; `README.md` changes in every commit after
    /// it, under a tree of its own (`t<n>`).
    fn long(commits: usize) -> Fake {
        let mut fake = Fake::default();
        for n in 0..commits {
            let tree = vec![entry(".dockerignore", "ignore", EntryKind::Blob), entry("README.md", &format!("r{n}"), EntryKind::Blob)];
            fake.trees.insert(format!("t{n}"), tree);
            let parent = (n > 0).then(|| format!("c{}", n - 1));
            fake.history.insert(0, commit(&format!("c{n}"), &format!("t{n}"), parent.as_deref()));
        }
        fake
    }

    /// Adds commits on top: each changes README.md; `touch_new` also adds `NEW`.
    fn push(fake: &mut Fake, commits: usize, touch_new: bool) {
        let first = fake.history.len();
        for n in first..first + commits {
            let mut tree = vec![entry(".dockerignore", "ignore", EntryKind::Blob), entry("README.md", &format!("r{n}"), EntryKind::Blob)];
            if touch_new {
                tree.push(entry("NEW", "new", EntryKind::Blob));
            }
            fake.trees.insert(format!("t{n}"), tree);
            fake.history.insert(0, commit(&format!("c{n}"), &format!("t{n}"), Some(&format!("c{}", n - 1))));
        }
    }

    fn walk(fake: &Fake, head: &str, path: &str, kept: Option<Progress>) -> Progress {
        run(last_commits(fake, head, path, kept, &|| false, MAX_READS)).unwrap().progress
    }

    fn by_name(found: &[LastCommit]) -> HashMap<String, String> {
        found.iter().map(|last| (last.name.clone(), last.commit.hash.clone())).collect()
    }

    #[test]
    fn each_root_entry_gets_the_newest_commit_that_changed_it() {
        let found = walk(&repo(), "c3", "", None);
        assert!(found.complete());
        let found = by_name(&found.found);
        assert_eq!(found["README.md"], "c3");
        assert_eq!(found["src"], "c2");
    }

    #[test]
    fn a_subdirectory_is_walked_by_its_own_tree() {
        let found = walk(&repo(), "c3", "src", None);
        assert!(found.complete());
        assert_eq!(by_name(&found.found)["a.rs"], "c2");
    }

    #[test]
    fn an_entry_unchanged_since_the_first_commit_belongs_to_it() {
        let mut fake = repo();
        fake.trees.insert("root2".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        fake.trees.insert("root3".into(), vec![entry("README.md", "r2", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        let found = walk(&fake, "c3", "", None);
        assert!(found.complete());
        assert_eq!(by_name(&found.found)["src"], "c1");
    }

    #[test]
    fn history_that_cannot_be_read_leaves_the_rest_unknown_for_good() {
        let mut fake = repo();
        // c1 has a parent the walk never reaches.
        fake.history[2].parents = vec!["c0".into()];
        fake.trees.insert("root2".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        fake.trees.insert("root3".into(), vec![entry("README.md", "r2", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        let found = walk(&fake, "c3", "", None);
        assert!(!found.complete());
        assert!(found.settled(), "no later walk can find more");
        let names = by_name(&found.found);
        assert_eq!(names["README.md"], "c3");
        assert!(!names.contains_key("src"));
    }

    #[test]
    fn an_entry_older_than_a_thousand_commits_resolves() {
        let fake = long(1_200);
        let found = walk(&fake, "c1199", "", None);
        assert!(found.complete());
        let names = by_name(&found.found);
        assert_eq!(names[".dockerignore"], "c0");
        assert_eq!(names["README.md"], "c1199");
    }

    #[test]
    fn a_walk_out_of_reads_stops_and_the_next_goes_on_from_there() {
        let fake = long(1_000);
        let first = run(last_commits(&fake, "c999", "", None, &|| false, 300)).unwrap();
        assert!(first.reads <= 300, "{} reads", first.reads);
        assert!(!first.progress.settled());
        let at = first.progress.at.clone().unwrap();
        assert_ne!(at, "c999");
        let mut progress = first.progress;
        let mut calls = 1;
        while !progress.settled() {
            fake.trees_read.borrow_mut().clear();
            let next = run(last_commits(&fake, "c999", "", Some(progress), &|| false, 300)).unwrap();
            assert!(next.reads <= 300);
            // The next call starts where the last one stopped.
            assert!(!fake.trees_read.borrow().contains(&"t999".to_owned()));
            progress = next.progress;
            calls += 1;
        }
        assert!(calls >= 3);
        assert!(progress.complete());
        assert_eq!(by_name(&progress.found)[".dockerignore"], "c0");
    }

    #[test]
    fn three_thousand_commits_take_two_calls_within_the_read_limit() {
        let fake = long(3_000);
        let first = run(last_commits(&fake, "c2999", "", None, &|| false, MAX_READS)).unwrap();
        assert!(first.reads <= MAX_READS);
        assert!(!first.progress.settled());
        let second = run(last_commits(&fake, "c2999", "", Some(first.progress), &|| false, MAX_READS)).unwrap();
        assert!(second.reads <= MAX_READS);
        assert!(second.progress.complete());
        assert_eq!(by_name(&second.progress.found)[".dockerignore"], "c0");
    }

    #[test]
    fn out_of_time_stops_after_some_progress() {
        let fake = long(500);
        let found = run(last_commits(&fake, "c499", "", None, &|| true, MAX_READS)).unwrap().progress;
        assert!(!found.settled());
        assert_eq!(by_name(&found.found)["README.md"], "c499");
    }

    #[test]
    fn a_new_head_reads_only_the_commits_since_the_remembered_one() {
        let mut fake = long(600);
        let before = walk(&fake, "c599", "", None);
        assert!(before.complete());
        push(&mut fake, 3, true);
        fake.trees_read.borrow_mut().clear();
        fake.logs_read.borrow_mut().clear();
        let after = walk(&fake, "c602", "", Some(before));
        assert!(after.complete());
        let names = by_name(&after.found);
        assert_eq!(names[".dockerignore"], "c0", "kept from the earlier walk");
        assert_eq!(names["README.md"], "c602");
        assert_eq!(names["NEW"], "c600");
        // One page of history and one batch of trees read ahead, not 600.
        let read = fake.trees_read.borrow();
        assert!(read.len() <= READ_AHEAD + 1, "{read:?}");
        assert!(!read.contains(&"t500".to_owned()));
        assert_eq!(fake.logs_read.borrow().len(), 1);
    }

    #[test]
    fn a_new_head_goes_on_from_where_an_unfinished_walk_stopped() {
        let mut fake = long(1_000);
        let first = run(last_commits(&fake, "c999", "", None, &|| false, 300)).unwrap().progress;
        assert!(!first.settled());
        let stopped_at = first.at.clone().unwrap();
        push(&mut fake, 2, false);
        fake.logs_read.borrow_mut().clear();
        let next = run(last_commits(&fake, "c1001", "", Some(first), &|| false, MAX_READS)).unwrap().progress;
        assert!(next.complete());
        assert_eq!(by_name(&next.found)[".dockerignore"], "c0");
        assert_eq!(by_name(&next.found)["README.md"], "c1001");
        // From the new head, then straight to where the first walk stopped.
        assert_eq!(fake.logs_read.borrow()[..2], ["c1001".to_owned(), stopped_at]);
    }

    #[test]
    fn a_force_push_walks_the_whole_history_again() {
        let mut fake = long(400);
        let before = walk(&fake, "c399", "", None);
        assert!(before.complete());
        // A new history: .dockerignore is different in its first commit, and
        // the remembered head is not on it.
        let mut rewritten = long(450);
        for commit in &mut rewritten.history {
            commit.hash = format!("x{}", commit.hash);
            commit.parents = commit.parents.iter().map(|parent| format!("x{parent}")).collect();
        }
        rewritten.trees.get_mut("t0").unwrap()[0].hash = "old-ignore".into();
        for tree in (1..450).map(|n| format!("t{n}")) {
            rewritten.trees.get_mut(&tree).unwrap()[0].hash = "new-ignore".into();
        }
        fake = rewritten;
        let after = walk(&fake, "xc449", "", Some(before));
        assert!(after.complete());
        let names = by_name(&after.found);
        assert_eq!(names[".dockerignore"], "xc1", "found by walking, not kept from the old history");
        assert_eq!(names["README.md"], "xc449");
        assert!(fake.trees_read.borrow().contains(&"t1".to_owned()));
    }

    #[test]
    fn the_same_head_again_reads_nothing() {
        let fake = repo();
        let before = walk(&fake, "c3", "", None);
        fake.trees_read.borrow_mut().clear();
        let again = run(last_commits(&fake, "c3", "", Some(before), &|| false, MAX_READS)).unwrap();
        assert_eq!(again.reads, 0);
        assert!(again.progress.complete());
    }
}
