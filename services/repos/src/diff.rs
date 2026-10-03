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
                if before.map(|e| &e.hash) == after.map(|e| &e.hash) {
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
                    });
                }
            }
        }
        level = next;
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((changes, false))
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
/// Returns the files and whether the result was cut short.
pub async fn compare_trees<R: GitRepo>(
    repo: &R,
    old_tree: Option<&str>,
    new_tree: &str,
) -> Result<(Vec<FileDiff>, bool)> {
    let (changes, mut truncated) = changed_files(repo, old_tree, new_tree).await?;
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
        let texts = match texts_read.next() {
            Some(texts) if lines < MAX_LINES => texts,
            _ => {
                truncated = true;
                None
            }
        };
        let (hunks, additions, deletions, binary) = match texts {
            Some((old, new)) => {
                let (hunks, additions, deletions) = line_diff(&old, &new);
                (hunks, additions, deletions, false)
            }
            None => (Vec::new(), 0, 0, true),
        };
        lines += hunks.iter().map(|hunk| hunk.lines.len()).sum::<usize>();
        files.push(FileDiff {
            path: change.path,
            status,
            additions,
            deletions,
            binary,
            hunks,
        });
    }
    Ok((files, truncated))
}
