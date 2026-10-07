//! Which commit last changed each entry of a directory, for the file list.
//!
//! History is walked newest first along the first-parent chain. Each commit
//! is compared with its parent only where the directory itself changed (its
//! tree hash differs), so the walk reads a tree only for the commits that
//! touched it. An entry is given the newest commit after which its hash is
//! no longer the same; one that never changes within the walk is given the
//! oldest commit reached if that is the root, and nothing otherwise.

use std::collections::HashMap;

use g1t_contracts::repos::{Commit, EntryKind, LastCommit, TreeEntry};
use worker::Result;

use crate::store::GitRepo;

/// How far back the history is walked.
pub const MAX_COMMITS: u32 = 300;
/// Commits whose trees are read together, ahead of the walk: each read is a
/// round trip to the store, so reading them one by one is what is slow.
const READ_AHEAD: usize = 24;
/// Commits of history read at a time.
const PAGE: u32 = 48;

/// Reads trees, remembering those already read: commits share most of them.
struct Trees<'a, R: GitRepo> {
    repo: &'a R,
    read: HashMap<String, Option<Vec<TreeEntry>>>,
}

impl<'a, R: GitRepo> Trees<'a, R> {
    /// Reads the trees not read yet, all at once.
    async fn prefetch(&mut self, hashes: impl IntoIterator<Item = String>) -> Result<()> {
        let mut wanted: Vec<String> = hashes.into_iter().filter(|hash| !self.read.contains_key(hash)).collect();
        wanted.sort();
        wanted.dedup();
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

/// The last commit of each entry of `path` at `git_ref`, and whether every
/// entry was given one. `out_of_time` is asked between batches; once it
/// says so the walk stops with what it has, incomplete.
pub async fn last_commits<R: GitRepo>(
    repo: &R,
    git_ref: &str,
    path: &str,
    out_of_time: &dyn Fn() -> bool,
) -> Result<(Vec<LastCommit>, bool)> {
    // History a page at a time, so a walk that is out of time stops
    // between pages rather than after reading all of it.
    let mut history = repo.log(git_ref, PAGE).await?;
    let Some(head) = history.first().cloned() else {
        return Ok((Vec::new(), true));
    };
    let mut trees = Trees { repo, read: HashMap::new() };
    let mut dir = trees.dir(&head.tree_hash, path).await?;
    let mut current = trees.entries(dir.as_deref()).await?;
    let mut open: Vec<String> = current.keys().cloned().collect();
    let mut found: Vec<LastCommit> = Vec::new();
    let give = |found: &mut Vec<LastCommit>, name: String, commit: &Commit| found.push(LastCommit { name, commit: commit.clone() });
    let mut index = 0;
    while !open.is_empty() && index < history.len() {
        // Read the next page once the walk reaches the end of this one.
        if index + 1 >= history.len() && history.len() < MAX_COMMITS as usize && !out_of_time() {
            if let Some(parent) = history.last().and_then(|commit| commit.parents.first()).cloned() {
                let more = repo.log(&parent, PAGE).await?;
                history.extend(more);
            }
        }
        if index % READ_AHEAD == 0 {
            if index > 0 && out_of_time() {
                break;
            }
            let ahead = history.iter().skip(index + 1).take(READ_AHEAD).map(|commit| commit.tree_hash.clone()).collect();
            trees.prefetch_dirs(ahead, path).await?;
        }
        let commit = history[index].clone();
        let Some(parent) = history.get(index + 1).cloned() else {
            // The oldest commit read. If it is the first commit there is,
            // what is left was added by it.
            if commit.parents.is_empty() {
                for name in open.drain(..) {
                    give(&mut found, name, &commit);
                }
            }
            break;
        };
        index += 1;
        let parent_dir = trees.dir(&parent.tree_hash, path).await?;
        if parent_dir == dir {
            continue;
        }
        let before = trees.entries(parent_dir.as_deref()).await?;
        let (changed, still): (Vec<String>, Vec<String>) = open.into_iter().partition(|name| before.get(name) != current.get(name));
        for name in changed {
            give(&mut found, name, &commit);
        }
        open = still;
        dir = parent_dir;
        current = before;
    }
    let complete = open.is_empty();
    Ok((found, complete))
}

#[cfg(test)]
mod tests {
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
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
            // A branch name starts at the head; a hash at that commit; anything else is unknown.
            let start = if git_ref == "main" { Some(0) } else { self.history.iter().position(|commit| commit.hash == git_ref) };
            Ok(start.map(|start| self.history.iter().skip(start).take(limit as usize).cloned().collect()).unwrap_or_default())
        }
        async fn parents(&self, _commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(None)
        }
        async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
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

    fn by_name(found: Vec<LastCommit>) -> HashMap<String, String> {
        found.into_iter().map(|last| (last.name, last.commit.hash)).collect()
    }

    #[test]
    fn each_root_entry_gets_the_newest_commit_that_changed_it() {
        let (found, complete) = run(last_commits(&repo(), "main", "", &|| false)).unwrap();
        assert!(complete);
        let found = by_name(found);
        assert_eq!(found["README.md"], "c3");
        assert_eq!(found["src"], "c2");
    }

    #[test]
    fn a_subdirectory_is_walked_by_its_own_tree() {
        let (found, complete) = run(last_commits(&repo(), "main", "src", &|| false)).unwrap();
        assert!(complete);
        assert_eq!(by_name(found)["a.rs"], "c2");
    }

    #[test]
    fn an_entry_unchanged_since_the_first_commit_belongs_to_it() {
        let mut fake = repo();
        fake.trees.insert("root2".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        fake.trees.insert("root3".into(), vec![entry("README.md", "r2", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        let (found, complete) = run(last_commits(&fake, "main", "", &|| false)).unwrap();
        assert!(complete);
        assert_eq!(by_name(found)["src"], "c1");
    }

    #[test]
    fn a_walk_cut_short_leaves_the_rest_unknown() {
        let mut fake = repo();
        // c1 has a parent the walk never reaches.
        fake.history[2].parents = vec!["c0".into()];
        fake.trees.insert("root2".into(), vec![entry("README.md", "r1", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        fake.trees.insert("root3".into(), vec![entry("README.md", "r2", EntryKind::Blob), entry("src", "src1", EntryKind::Tree)]);
        let (found, complete) = run(last_commits(&fake, "main", "", &|| false)).unwrap();
        assert!(!complete);
        let found = by_name(found);
        assert_eq!(found["README.md"], "c3");
        assert!(!found.contains_key("src"));
    }
}
