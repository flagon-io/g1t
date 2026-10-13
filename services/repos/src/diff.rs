//! Comparing two commits: which files changed, and how.
//!
//! Trees are walked together and identical subtrees are skipped by hash, so
//! the cost follows the size of the change rather than the repository.

use std::collections::BTreeMap;

use g1t_contracts::repos::{DiffLine, EntryKind, FileDiff, FileStatus, Hunk, LineKind, TreeEntry};
use futures_util::future::{try_join, try_join_all};
use similar::{ChangeTag, TextDiff};
use worker::Result;

use crate::store::GitRepo;

/// Beyond these the comparison is cut short and marked truncated.
const MAX_FILES: usize = 300;
const MAX_LINES: usize = 20_000;
/// Files larger than this are listed without their lines.
const MAX_FILE_BYTES: usize = 512 * 1024;
const CONTEXT_LINES: usize = 3;

/// A file that differs between the two trees.
struct Change {
    path: String,
    old: Option<String>,
    new: Option<String>,
    old_kind: Option<EntryKind>,
    new_kind: Option<EntryKind>,
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

/// How many files' contents are read at once.
const READS_AT_ONCE: usize = 16;

/// Collects the files that differ between two trees. Each level of the
/// trees is read at once, since every read is a round trip to the store
/// and the levels' trees do not depend on each other.
async fn changed_files<R: GitRepo>(
    repo: &R,
    old_root: Option<&str>,
    new_root: &str,
) -> Result<(Vec<Change>, bool)> {
    let mut changes = Vec::new();
    let mut level = vec![(
        String::new(),
        old_root.map(str::to_owned),
        Some(new_root.to_owned()),
    )];
    while !level.is_empty() {
        let read = try_join_all(level.iter().map(|(_, old_tree, new_tree)| async move {
            let (old, new) = try_join(
                entries(repo, old_tree.as_deref()),
                entries(repo, new_tree.as_deref()),
            )
            .await?;
            Ok::<_, worker::Error>((old, new))
        }))
        .await?;
        let mut next = Vec::new();
        for ((prefix, _, _), (old, new)) in level.iter().zip(read) {
            let names: std::collections::BTreeSet<&String> = old.keys().chain(new.keys()).collect();
            for name in names {
                let (before, after) = (old.get(name), new.get(name));
                // A file made executable keeps its hash, and is still a change.
                if before.map(|e| (&e.hash, e.kind)) == after.map(|e| (&e.hash, e.kind)) {
                    continue;
                }
                let path = format!("{prefix}{name}");
                let subtree = |entry: Option<&TreeEntry>| {
                    entry
                        .filter(|entry| entry.kind == EntryKind::Tree)
                        .map(|entry| entry.hash.clone())
                };
                let file = |entry: Option<&TreeEntry>| {
                    entry
                        .filter(|entry| entry.kind != EntryKind::Tree)
                        .map(|entry| entry.hash.clone())
                };
                let file_kind = |entry: Option<&TreeEntry>| entry.map(|entry| entry.kind).filter(|kind| *kind != EntryKind::Tree);
                let (old_dir, new_dir) = (subtree(before), subtree(after));
                if old_dir.is_some() || new_dir.is_some() {
                    next.push((format!("{path}/"), old_dir, new_dir));
                }
                let (old_file, new_file) = (file(before), file(after));
                if old_file.is_some() || new_file.is_some() {
                    if changes.len() >= MAX_FILES {
                        changes.sort_by(|a: &Change, b: &Change| a.path.cmp(&b.path));
                        return Ok((changes, true));
                    }
                    changes.push(Change {
                        path,
                        old: old_file,
                        new: new_file,
                        old_kind: file_kind(before),
                        new_kind: file_kind(after),
                    });
                }
            }
        }
        level = next;
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((changes, false))
}

/// The paths of the files that differ between two trees, without reading
/// any file: what is needed to see whether two changes touch the same
/// files. Returns the paths and whether the list was cut short.
pub async fn changed_paths<R: GitRepo>(
    repo: &R,
    old_tree: Option<&str>,
    new_tree: &str,
) -> Result<(Vec<String>, bool)> {
    let (changes, truncated) = changed_files(repo, old_tree, new_tree).await?;
    Ok((changes.into_iter().map(|change| change.path).collect(), truncated))
}

/// A file as one tree has it: its kind and blob.
pub type FileEntry = (EntryKind, String);

/// The files that differ between two trees, each as it was and as it is
/// (`None` where it is not there), without reading any file. Returns them
/// by path and whether the list was cut short.
pub async fn changed_entries<R: GitRepo>(
    repo: &R,
    old_tree: Option<&str>,
    new_tree: &str,
) -> Result<(Vec<(String, Option<FileEntry>, Option<FileEntry>)>, bool)> {
    let (changes, truncated) = changed_files(repo, old_tree, new_tree).await?;
    let entries = changes
        .into_iter()
        .map(|change| {
            let old = change.old_kind.zip(change.old);
            let new = change.new_kind.zip(change.new);
            (change.path, old, new)
        })
        .collect();
    Ok((entries, truncated))
}

/// The text of a blob, or `None` if it is binary, too large or missing.
async fn text<R: GitRepo>(repo: &R, hash: Option<&str>) -> Result<Option<String>> {
    let Some(hash) = hash else {
        return Ok(Some(String::new()));
    };
    let Some(bytes) = repo.read_blob(hash).await? else {
        return Ok(None);
    };
    if bytes.len() > MAX_FILE_BYTES || bytes.contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

fn line_diff(old: &str, new: &str) -> (Vec<Hunk>, u32, u32) {
    let diff = TextDiff::from_lines(old, new);
    let (mut additions, mut deletions) = (0, 0);
    let hunks = diff
        .grouped_ops(CONTEXT_LINES)
        .iter()
        .map(|group| Hunk {
            lines: group
                .iter()
                .flat_map(|op| diff.iter_changes(op))
                .map(|change| {
                    let kind = match change.tag() {
                        ChangeTag::Equal => LineKind::Context,
                        ChangeTag::Insert => {
                            additions += 1;
                            LineKind::Add
                        }
                        ChangeTag::Delete => {
                            deletions += 1;
                            LineKind::Delete
                        }
                    };
                    DiffLine {
                        kind,
                        old: change.old_index().map(|index| index as u32 + 1),
                        new: change.new_index().map(|index| index as u32 + 1),
                        text: change.value().trim_end_matches(['\r', '\n']).to_owned(),
                    }
                })
                .collect(),
        })
        .collect();
    (hunks, additions, deletions)
}

/// The files that differ between two trees, with their line changes.
/// Returns the files and whether the list of files was cut short.
///
/// Files are read in order until about `MAX_LINES` lines have been read;
/// the ones after that are listed without their lines, marked `omitted`,
/// and are read by asking for them by path (`only`), which reads just them.
pub async fn compare_trees<R: GitRepo>(
    repo: &R,
    old_tree: Option<&str>,
    new_tree: &str,
    only: Option<&[String]>,
) -> Result<(Vec<FileDiff>, bool)> {
    let (mut changes, truncated) = changed_files(repo, old_tree, new_tree).await?;
    if let Some(only) = only {
        changes.retain(|change| only.contains(&change.path));
    }
    let mut files = Vec::with_capacity(changes.len());
    let mut lines = 0;
    // Contents are read a batch at a time, all of a batch at once.
    let mut texts_read: Vec<Option<(String, String)>> = Vec::with_capacity(changes.len());
    for batch in changes.chunks(READS_AT_ONCE) {
        let read = try_join_all(batch.iter().map(|change| async move {
            let (old, new) = try_join(
                text(repo, change.old.as_deref()),
                text(repo, change.new.as_deref()),
            )
            .await?;
            Ok::<_, worker::Error>(old.zip(new))
        }))
        .await?;
        lines += read
            .iter()
            .flatten()
            .map(|(old, new)| old.lines().count().max(new.lines().count()))
            .sum::<usize>();
        texts_read.extend(read);
        if lines >= MAX_LINES {
            break;
        }
    }
    let mut texts_read = texts_read.into_iter();
    lines = 0;
    for change in changes {
        let status = match (&change.old, &change.new) {
            (None, _) => FileStatus::Added,
            (_, None) => FileStatus::Deleted,
            _ => FileStatus::Modified,
        };
        // Past the limit (not read at all), or read: its two sides, or
        // nothing when it is binary or too large.
        let (texts, omitted) = match texts_read.next() {
            Some(texts) if lines < MAX_LINES => (texts, false),
            _ => (None, true),
        };
        let (hunks, additions, deletions, binary) = match texts {
            Some((old, new)) => {
                let (hunks, additions, deletions) = line_diff(&old, &new);
                (hunks, additions, deletions, false)
            }
            None => (Vec::new(), 0, 0, !omitted),
        };
        lines += hunks.iter().map(|hunk| hunk.lines.len()).sum::<usize>();
        files.push(FileDiff {
            path: change.path,
            status,
            additions,
            deletions,
            binary,
            hunks,
            omitted,
        });
    }
    Ok((files, truncated))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, Commit, GitAccess};

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
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, _git_ref: &str, _limit: u32) -> Result<Vec<Commit>> {
            Ok(Vec::new())
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

    /// A tree that adds `count` files of `lines` lines each, f000 onward,
    /// then a binary one, `zz.bin`.
    fn added(count: usize, lines: usize) -> Fake {
        let mut fake = Fake::default();
        let mut entries = Vec::new();
        for n in 0..count {
            let hash = format!("b{n}");
            fake.blobs.insert(hash.clone(), "line\n".repeat(lines).into_bytes());
            entries.push(TreeEntry { name: format!("f{n:03}"), hash, kind: EntryKind::Blob });
        }
        fake.blobs.insert("bin".into(), vec![0, 1, 2]);
        entries.push(TreeEntry { name: "zz.bin".into(), hash: "bin".into(), kind: EntryKind::Blob });
        fake.trees.insert("root".into(), entries);
        fake
    }

    #[test]
    fn a_small_change_has_every_files_lines() {
        let fake = added(3, 10);
        let (files, truncated) = run(compare_trees(&fake, None, "root", None)).unwrap();
        assert!(!truncated);
        assert_eq!(files.len(), 4);
        assert!(files[..3].iter().all(|f| !f.omitted && !f.binary && f.additions == 10));
        assert!(files[3].binary && !files[3].omitted);
    }

    #[test]
    fn files_past_the_line_limit_are_listed_as_omitted_not_binary() {
        // 40 files of 1,000 lines: about 20 of them fit.
        let fake = added(40, 1_000);
        let (files, truncated) = run(compare_trees(&fake, None, "root", None)).unwrap();
        assert!(!truncated, "every file is listed");
        assert_eq!(files.len(), 41);
        let read = files.iter().filter(|f| !f.omitted).count();
        assert!((MAX_LINES / 1_000..=MAX_LINES / 1_000 + READS_AT_ONCE).contains(&read), "{read} read");
        let last = files.last().unwrap();
        assert!(last.omitted && !last.binary && last.hunks.is_empty() && last.additions == 0);
    }

    #[test]
    fn an_omitted_file_is_read_when_asked_for_by_path() {
        let fake = added(40, 1_000);
        let only = ["f039".to_owned(), "missing".to_owned()];
        let (files, _) = run(compare_trees(&fake, None, "root", Some(&only))).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "f039");
        assert!(!files[0].omitted);
        assert_eq!(files[0].additions, 1_000);
    }
}
