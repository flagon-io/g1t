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
/// Files larger than this are listed without their lines, as too large.
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
/// Text larger than this (a lockfile, say) has its lines compared only when
/// few of them changed: comparing costs its size times the lines changed.
const LARGE_FILE_BYTES: usize = 512 * 1024;
const MAX_LARGE_FILE_CHANGES: usize = 5_000;
/// Reading stops after this much, as it does after `MAX_LINES` lines shown.
const MAX_READ_BYTES: usize = 24 * 1024 * 1024;
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
    changed_files_up_to(repo, old_root, new_root, MAX_FILES).await
}

/// [`changed_files`], cut short after `max_files` files.
async fn changed_files_up_to<R: GitRepo>(
    repo: &R,
    old_root: Option<&str>,
    new_root: &str,
    max_files: usize,
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
                    if changes.len() >= max_files {
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
    changed_entries_up_to(repo, old_tree, new_tree, MAX_FILES).await
}

/// [`changed_entries`], listing up to `max_files` files rather than the
/// comparison's limit: what a merge applies (merge_methods.rs).
pub async fn changed_entries_up_to<R: GitRepo>(
    repo: &R,
    old_tree: Option<&str>,
    new_tree: &str,
    max_files: usize,
) -> Result<(Vec<(String, Option<FileEntry>, Option<FileEntry>)>, bool)> {
    let (changes, truncated) = changed_files_up_to(repo, old_tree, new_tree, max_files).await?;
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

/// One side of a file, as read.
enum Side {
    Text(String),
    /// Binary or missing.
    Binary,
    TooLarge,
}

/// A blob as text, if it is text and not too large. A missing side is empty.
async fn text<R: GitRepo>(repo: &R, hash: Option<&str>) -> Result<Side> {
    let Some(hash) = hash else {
        return Ok(Side::Text(String::new()));
    };
    let Some(bytes) = repo.read_blob(hash).await? else {
        return Ok(Side::Binary);
    };
    if bytes.contains(&0) {
        return Ok(Side::Binary);
    }
    if bytes.len() > MAX_FILE_BYTES {
        return Ok(Side::TooLarge);
    }
    Ok(String::from_utf8(bytes).map_or(Side::Binary, Side::Text))
}

/// A file's line changes, or why it has none to show.
enum Read {
    Lines(Vec<Hunk>, u32, u32),
    Binary,
    TooLarge,
}

/// At least how many lines differ between two texts: the lines one has
/// more of than the other, counted without regard to order. Cheap, where
/// the line diff is not.
fn lines_changed_at_least(old: &str, new: &str) -> usize {
    let mut counts: std::collections::HashMap<&str, isize> = std::collections::HashMap::new();
    for line in old.lines() {
        *counts.entry(line).or_default() += 1;
    }
    for line in new.lines() {
        *counts.entry(line).or_default() -= 1;
    }
    counts.values().map(|count| count.unsigned_abs()).sum()
}

fn read_file(old: Side, new: Side) -> Read {
    match (old, new) {
        (Side::Binary, _) | (_, Side::Binary) => Read::Binary,
        (Side::TooLarge, _) | (_, Side::TooLarge) => Read::TooLarge,
        (Side::Text(old), Side::Text(new)) => {
            if old.len().max(new.len()) > LARGE_FILE_BYTES && lines_changed_at_least(&old, &new) > MAX_LARGE_FILE_CHANGES {
                return Read::TooLarge;
            }
            let (hunks, additions, deletions) = line_diff(&old, &new);
            Read::Lines(hunks, additions, deletions)
        }
    }
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
/// Files are read in order until about `MAX_LINES` changed lines (or
/// `MAX_READ_BYTES`) have been read; the ones after that are listed without
/// their lines, marked `omitted`, and are read by asking for them by path
/// (`only`), which reads just them.
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
    let (mut lines, mut bytes) = (0, 0);
    // Contents are read a batch at a time, all of a batch at once.
    let mut files_read: Vec<Read> = Vec::with_capacity(changes.len());
    for batch in changes.chunks(READS_AT_ONCE) {
        let read = try_join_all(batch.iter().map(|change| async move {
            try_join(
                text(repo, change.old.as_deref()),
                text(repo, change.new.as_deref()),
            )
            .await
        }))
        .await?;
        for (old, new) in read {
            for side in [&old, &new] {
                bytes += match side {
                    Side::Text(text) => text.len(),
                    Side::Binary => 0,
                    Side::TooLarge => MAX_FILE_BYTES,
                };
            }
            let file = read_file(old, new);
            if let Read::Lines(hunks, _, _) = &file {
                lines += hunks.iter().map(|hunk| hunk.lines.len()).sum::<usize>();
            }
            files_read.push(file);
        }
        if lines >= MAX_LINES || bytes >= MAX_READ_BYTES {
            break;
        }
    }
    let mut files_read = files_read.into_iter();
    lines = 0;
    for change in changes {
        let status = match (&change.old, &change.new) {
            (None, _) => FileStatus::Added,
            (_, None) => FileStatus::Deleted,
            _ => FileStatus::Modified,
        };
        // Past the limit (not read, or read but not shown) or read.
        let (read, omitted) = match files_read.next() {
            Some(read) if lines < MAX_LINES => (Some(read), false),
            _ => (None, true),
        };
        let (hunks, additions, deletions, binary, too_large) = match read {
            Some(Read::Lines(hunks, additions, deletions)) => (hunks, additions, deletions, false, false),
            Some(Read::Binary) => (Vec::new(), 0, 0, true, false),
            Some(Read::TooLarge) => (Vec::new(), 0, 0, false, true),
            None => (Vec::new(), 0, 0, false, false),
        };
        lines += hunks.iter().map(|hunk| hunk.lines.len()).sum::<usize>();
        files.push(FileDiff {
            path: change.path,
            status,
            additions,
            deletions,
            binary,
            too_large,
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
        async fn fork(&self, _target_key: &str, _default_branch_only: bool) -> Result<()> {
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
        assert!(files[3].binary && !files[3].too_large && !files[3].omitted);
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

    /// A tree with one file, `lock`, as `blob` has it.
    fn one_file(fake: &mut Fake, root: &str, blob: &str, bytes: Vec<u8>) {
        fake.blobs.insert(blob.into(), bytes);
        fake.trees.insert(root.into(), vec![TreeEntry { name: "lock".into(), hash: blob.into(), kind: EntryKind::Blob }]);
    }

    /// A lockfile's worth of lines, `n` of them, numbered from `from`.
    fn lockfile(n: usize, from: usize) -> String {
        (from..from + n).map(|i| format!("    \"node_modules/package-{i}\": {{ \"version\": \"1.0.{i}\" }},\n")).collect()
    }

    #[test]
    fn a_large_text_file_with_a_small_change_has_its_lines() {
        let old = lockfile(20_000, 0);
        assert!(old.len() > LARGE_FILE_BYTES);
        let new = old.replacen("\"1.0.7\"", "\"1.0.8\"", 1);
        let mut fake = Fake::default();
        one_file(&mut fake, "old", "a", old.into_bytes());
        one_file(&mut fake, "new", "b", new.into_bytes());
        let (files, _) = run(compare_trees(&fake, Some("old"), "new", None)).unwrap();
        let file = &files[0];
        assert!(!file.binary && !file.too_large && !file.omitted);
        assert_eq!((file.additions, file.deletions), (1, 1));
        assert_eq!(file.hunks.len(), 1);
    }

    #[test]
    fn a_large_text_file_mostly_rewritten_is_too_large_not_binary() {
        let mut fake = Fake::default();
        one_file(&mut fake, "old", "a", lockfile(20_000, 0).into_bytes());
        one_file(&mut fake, "new", "b", lockfile(20_000, 10_000).into_bytes());
        let (files, _) = run(compare_trees(&fake, Some("old"), "new", None)).unwrap();
        let file = &files[0];
        assert!(file.too_large && !file.binary && file.hunks.is_empty());
    }

    #[test]
    fn text_past_the_size_limit_is_too_large_not_binary() {
        let mut fake = Fake::default();
        one_file(&mut fake, "new", "b", vec![b'a'; MAX_FILE_BYTES + 1]);
        let (files, _) = run(compare_trees(&fake, None, "new", None)).unwrap();
        assert!(files[0].too_large && !files[0].binary);
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
