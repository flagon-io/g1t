//! Listing a repository's files for services that index it, such as
//! search: every file on a branch, the files two commits differ in, and
//! the text of many blobs at once.
//!
//! Trees are read a level at a time, all of a level at once, and identical
//! subtrees are skipped by hash, so a push costs what it changed rather
//! than what the repository holds. Directories the caller names (vendored
//! code, build output) are never read at all.

use std::collections::{BTreeMap, BTreeSet};

use futures_util::future::{try_join, try_join_all};
use g1t_contracts::repos::{BlobText, EntryKind, FileEntry, FileList, MAX_LISTED_FILES, MAX_READ_BLOBS, TreeEntry};
use worker::Result;

use crate::store::GitRepo;

/// Whether an entry is a file whose text can be read: a blob, executable
/// or not. Symlinks and submodules are not.
fn is_file(entry: &TreeEntry) -> bool {
    matches!(entry.kind, EntryKind::Blob | EntryKind::Exec)
}

async fn entries<R: GitRepo>(repo: &R, tree: Option<&str>) -> Result<BTreeMap<String, TreeEntry>> {
    let Some(tree) = tree else {
        return Ok(BTreeMap::new());
    };
    Ok(repo
        .read_tree(tree)
        .await?
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.name.clone(), entry))
        .collect())
}

/// The files that differ between two trees, a level at a time, with
/// `hash` null for a file the newer tree no longer has. With no `old`,
/// every file of `new`. Directories named in `skip` are not entered.
pub async fn changed<R: GitRepo>(
    repo: &R,
    old: Option<&str>,
    new: &str,
    skip: &[String],
    limit: u32,
) -> Result<(Vec<FileEntry>, bool)> {
    let limit = limit.clamp(1, MAX_LISTED_FILES) as usize;
    let skipped = |name: &str| skip.iter().any(|dir| dir.eq_ignore_ascii_case(name));
    let mut files = Vec::new();
    let mut level = vec![(String::new(), old.map(str::to_owned), Some(new.to_owned()))];
    while !level.is_empty() {
        let read = try_join_all(level.iter().map(|(_, old_tree, new_tree)| async move {
            try_join(entries(repo, old_tree.as_deref()), entries(repo, new_tree.as_deref())).await
        }))
        .await?;
        let mut next = Vec::new();
        for ((prefix, _, _), (before, after)) in level.iter().zip(read) {
            let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
            for name in names {
                let (was, now) = (before.get(name), after.get(name));
                if was.map(|entry| (&entry.hash, entry.kind)) == now.map(|entry| (&entry.hash, entry.kind)) {
                    continue;
                }
                let path = format!("{prefix}{name}");
                let dir = |entry: Option<&TreeEntry>| {
                    entry.filter(|entry| entry.kind == EntryKind::Tree).map(|entry| entry.hash.clone())
                };
                let (old_dir, new_dir) = (dir(was), dir(now));
                if (old_dir.is_some() || new_dir.is_some()) && !skipped(name) {
                    next.push((format!("{path}/"), old_dir, new_dir));
                }
                let (old_file, new_file) = (was.filter(|e| is_file(e)), now.filter(|e| is_file(e)));
                if old_file.is_none() && new_file.is_none() {
                    continue;
                }
                if files.len() >= limit {
                    return Ok((files, true));
                }
                files.push(FileEntry {
                    path,
                    hash: new_file.map(|entry| entry.hash.clone()),
                });
            }
        }
        level = next;
    }
    Ok((files, false))
}

/// The commit a branch or commit names, and its tree.
pub async fn resolve<R: GitRepo>(repo: &R, git_ref: &str) -> Result<Option<(String, String)>> {
    Ok(repo
        .log(git_ref, 1)
        .await?
        .into_iter()
        .next()
        .map(|commit| (commit.hash, commit.tree_hash)))
}

/// Every file on `git_ref`, or what changed from `base` to it.
pub async fn list<R: GitRepo>(
    repo: &R,
    base: Option<&str>,
    head: &str,
    skip: &[String],
    limit: u32,
) -> Result<FileList> {
    let Some((commit, tree)) = resolve(repo, head).await? else {
        return Ok(FileList::default());
    };
    let base_tree = match base {
        Some(base) => resolve(repo, base).await?.map(|(_, tree)| tree),
        None => None,
    };
    let (files, truncated) = changed(repo, base_tree.as_deref(), &tree, skip, limit).await?;
    Ok(FileList {
        commit: Some(commit),
        files,
        truncated,
    })
}

/// The text of each blob asked for, in order: none for one that is
/// missing, larger than `max_bytes`, or binary.
pub async fn read<R: GitRepo>(repo: &R, hashes: &[String], max_bytes: u32) -> Result<Vec<BlobText>> {
    let hashes: Vec<&String> = hashes.iter().take(MAX_READ_BLOBS).collect();
    let mut out = Vec::with_capacity(hashes.len());
    // A few at a time: each read is a round trip, and a batch of large
    // blobs held at once would not fit in memory.
    for group in hashes.chunks(8) {
        let read = try_join_all(group.iter().map(|hash| repo.read_blob(hash))).await?;
        for (hash, bytes) in group.iter().zip(read) {
            let size = bytes.as_ref().map_or(0, |bytes| bytes.len() as u64);
            let text = bytes
                .filter(|bytes| bytes.len() <= max_bytes as usize && !bytes.contains(&0))
                .and_then(|bytes| String::from_utf8(bytes).ok());
            out.push(BlobText {
                hash: (*hash).clone(),
                size,
                text,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, Commit, GitAccess, Signature};

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
        blobs: HashMap<String, Vec<u8>>,
        commits: HashMap<String, Commit>,
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, _limit: u32) -> Result<Vec<Commit>> {
            Ok(self.commits.get(git_ref).cloned().into_iter().collect())
        }
        async fn parents(&self, _commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(None)
        }
        async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            Ok(self.trees.get(tree_hash).cloned())
        }
        async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.blobs.get(blob_hash).cloned())
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str) -> Result<()> {
            Ok(())
        }
    }

    fn entry(name: &str, hash: &str, kind: EntryKind) -> TreeEntry {
        TreeEntry {
            name: name.into(),
            hash: hash.into(),
            kind,
        }
    }

    fn commit(hash: &str, tree: &str) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: tree.into(),
            message: String::new(),
            author: Signature { name: String::new(), email: String::new() },
            parents: Vec::new(),
            authored_at: String::new(),
        }
    }

    /// Two commits: c1 has README, src/a.rs, node_modules/x.js; c2 changes
    /// src/a.rs, deletes README, adds src/b.rs and a symlink.
    fn repo() -> Fake {
        let mut fake = Fake::default();
        fake.trees.insert("src1".into(), vec![entry("a.rs", "a1", EntryKind::Blob)]);
        fake.trees.insert("nm".into(), vec![entry("x.js", "x1", EntryKind::Blob)]);
        fake.trees.insert(
            "root1".into(),
            vec![
                entry("README.md", "r1", EntryKind::Blob),
                entry("src", "src1", EntryKind::Tree),
                entry("node_modules", "nm", EntryKind::Tree),
            ],
        );
        fake.trees.insert(
            "src2".into(),
            vec![entry("a.rs", "a2", EntryKind::Blob), entry("b.rs", "b1", EntryKind::Exec)],
        );
        fake.trees.insert(
            "root2".into(),
            vec![
                entry("src", "src2", EntryKind::Tree),
                entry("node_modules", "nm", EntryKind::Tree),
                entry("link", "l1", EntryKind::Symlink),
            ],
        );
        fake.commits.insert("c1".into(), commit("c1", "root1"));
        fake.commits.insert("c2".into(), commit("c2", "root2"));
        fake.commits.insert("main".into(), commit("c2", "root2"));
        fake
    }

    fn paths(list: &FileList) -> Vec<(String, Option<String>)> {
        list.files.iter().map(|f| (f.path.clone(), f.hash.clone())).collect()
    }

    #[test]
    fn lists_every_file_but_skipped_directories() {
        let fake = repo();
        let listed = run(list(&fake, None, "c1", &["node_modules".into()], 100)).unwrap();
        assert_eq!(listed.commit.as_deref(), Some("c1"));
        assert_eq!(
            paths(&listed),
            vec![("README.md".into(), Some("r1".into())), ("src/a.rs".into(), Some("a1".into()))]
        );
    }

    #[test]
    fn lists_only_what_changed() {
        let fake = repo();
        let listed = run(list(&fake, Some("c1"), "c2", &[], 100)).unwrap();
        assert_eq!(
            paths(&listed),
            vec![
                ("README.md".into(), None),
                ("src/a.rs".into(), Some("a2".into())),
                ("src/b.rs".into(), Some("b1".into())),
            ]
        );
        assert!(!listed.truncated);
    }

    #[test]
    fn says_when_the_list_was_cut_short() {
        let fake = repo();
        let listed = run(list(&fake, Some("c1"), "c2", &[], 2)).unwrap();
        assert_eq!(listed.files.len(), 2);
        assert!(listed.truncated);
    }

    #[test]
    fn reads_text_but_not_binaries_or_large_blobs() {
        let mut fake = repo();
        fake.blobs.insert("t".into(), b"fn main() {}\n".to_vec());
        fake.blobs.insert("bin".into(), vec![0, 1, 2]);
        fake.blobs.insert("big".into(), vec![b'a'; 64]);
        let read = run(read(&fake, &["t".into(), "bin".into(), "big".into(), "gone".into()], 32)).unwrap();
        let texts: Vec<Option<&str>> = read.iter().map(|b| b.text.as_deref()).collect();
        assert_eq!(texts, vec![Some("fn main() {}\n"), None, None, None]);
        assert_eq!(read[2].size, 64);
    }
}
