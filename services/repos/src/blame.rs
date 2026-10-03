//! Which commit last changed each line of a file.
//!
//! History is walked newest first, as `git blame` does: a line still present,
//! unchanged, in one of a commit's parents is handed to that parent; a line in
//! none of them was written by the commit. Following every parent, not just
//! the first, matters here: catch-up merges bring the default branch into a
//! pull request, and their lines belong to whoever wrote them on that branch.

use std::collections::HashMap;

use g1t_contracts::repos::{Blame, BlameRange, Commit, EntryKind, TreeEntry};
use similar::{ChangeTag, TextDiff};
use worker::Result;

use crate::store::GitRepo;

/// How far back the history is searched. Lines older than this are given to
/// the oldest commit reached, and the answer is marked partial.
const MAX_COMMITS: u32 = 400;
/// Files larger than this are not blamed.
const MAX_FILE_BYTES: usize = 512 * 1024;

/// Reads files out of commits, remembering trees and texts already read:
/// most commits share most of their trees.
struct Reader<'a, R: GitRepo> {
    repo: &'a R,
    trees: HashMap<String, Vec<TreeEntry>>,
    texts: HashMap<String, Option<String>>,
}

impl<'a, R: GitRepo> Reader<'a, R> {
    /// The blob hash of `path` in the tree `root`, if it is a file there.
    async fn blob_at(&mut self, root: &str, path: &str) -> Result<Option<String>> {
        let mut tree = root.to_owned();
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        for (index, part) in parts.iter().enumerate() {
            if !self.trees.contains_key(&tree) {
                let entries = self.repo.read_tree(&tree).await?.unwrap_or_default();
                self.trees.insert(tree.clone(), entries);
            }
            let Some(entry) = self.trees[&tree].iter().find(|entry| entry.name == *part) else {
                return Ok(None);
            };
            let last = index == parts.len() - 1;
            match (last, entry.kind == EntryKind::Tree) {
                (true, false) => return Ok(Some(entry.hash.clone())),
                (false, true) => tree = entry.hash.clone(),
                _ => return Ok(None),
            }
        }
        Ok(None)
    }

    /// The lines of a blob, or `None` if it is binary or too large.
    async fn lines(&mut self, blob: &str) -> Result<Option<Vec<String>>> {
        if !self.texts.contains_key(blob) {
            let text = self
                .repo
                .read_blob(blob)
                .await?
                .filter(|bytes| bytes.len() <= MAX_FILE_BYTES && !bytes.contains(&0))
                .and_then(|bytes| String::from_utf8(bytes).ok());
            self.texts.insert(blob.to_owned(), text);
        }
        Ok(self.texts[blob]
            .as_ref()
            .map(|text| text.lines().map(str::to_owned).collect()))
    }
}

/// For each line of `new`, the index of the same, unchanged line in `old`.
fn carried(old: &[String], new: &[String]) -> Vec<Option<usize>> {
    // Every line ends in a newline, so a last line matches the same line elsewhere.
    let text = |lines: &[String]| lines.iter().map(|line| format!("{line}\n")).collect::<String>();
    let (before, after) = (text(old), text(new));
    let diff = TextDiff::from_lines(&before, &after);
    let mut map = vec![None; new.len()];
    for change in diff.iter_all_changes() {
        if change.tag() == ChangeTag::Equal
            && let (Some(o), Some(n)) = (change.old_index(), change.new_index())
                && let Some(slot) = map.get_mut(n) {
                    *slot = Some(o);
                }
    }
    map
}

/// Who last changed each line of `path` as of `head`. `None` if the file is
/// missing or not text.
pub async fn blame<R: GitRepo>(
    repo: &R,
    head: &str,
    path: &str,
) -> Result<Option<Blame>> {
    let history = repo.log(head, MAX_COMMITS).await?;
    let Some(first) = history.first() else {
        return Ok(None);
    };
    let mut reader = Reader {
        repo,
        trees: HashMap::new(),
        texts: HashMap::new(),
    };
    let Some(blob) = reader.blob_at(&first.tree_hash, path).await? else {
        return Ok(None);
    };
    let Some(lines) = reader.lines(&blob).await? else {
        return Ok(None);
    };
    let total = lines.len();
    let by_hash: HashMap<&str, &Commit> =
        history.iter().map(|commit| (commit.hash.as_str(), commit)).collect();

    // For each commit still to visit: (line in its version, line in the head's).
    let mut pending: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    pending.insert(first.hash.clone(), (0..total).map(|line| (line, line)).collect());
    let mut owner: Vec<Option<String>> = vec![None; total];
    let mut partial = false;

    // The log is newest first, so a commit is reached after its children.
    for commit in &history {
        let Some(mut lines_here) = pending.remove(&commit.hash) else {
            continue;
        };
        lines_here.sort_unstable();
        lines_here.dedup_by_key(|(_, final_line)| *final_line);
        let Some(blob) = reader.blob_at(&commit.tree_hash, path).await? else {
            continue;
        };
        let Some(text) = reader.lines(&blob).await? else {
            continue;
        };
        let mut unexplained = lines_here;
        for parent_hash in &commit.parents {
            if unexplained.is_empty() {
                break;
            }
            let Some(parent) = by_hash.get(parent_hash.as_str()) else {
                // Beyond the history read: these lines are at least this old.
                partial = true;
                continue;
            };
            let Some(parent_blob) = reader.blob_at(&parent.tree_hash, path).await? else {
                continue;
            };
            let handed: Vec<(usize, usize)> = if parent_blob == blob {
                std::mem::take(&mut unexplained)
            } else {
                let Some(parent_text) = reader.lines(&parent_blob).await? else {
                    continue;
                };
                let map = carried(&parent_text, &text);
                let (moved, kept): (Vec<_>, Vec<_>) = unexplained
                    .into_iter()
                    .partition(|(here, _)| map.get(*here).copied().flatten().is_some());
                unexplained = kept;
                moved
                    .into_iter()
                    .map(|(here, final_line)| (map[here].unwrap_or(here), final_line))
                    .collect()
            };
            if !handed.is_empty() {
                pending.entry(parent_hash.clone()).or_default().extend(handed);
            }
        }
        for (_, final_line) in unexplained {
            owner[final_line] = Some(commit.hash.clone());
        }
    }
    // Lines handed to commits older than the history read.
    if !pending.is_empty() {
        partial = true;
        let oldest = history.last().map(|commit| commit.hash.clone());
        for line in owner.iter_mut().filter(|line| line.is_none()) {
            *line = oldest.clone();
        }
    }

    let mut ranges: Vec<BlameRange> = Vec::new();
    for (index, hash) in owner.into_iter().enumerate() {
        let hash = hash.unwrap_or_else(|| first.hash.clone());
        let line = index as u32 + 1;
        match ranges.last_mut() {
            Some(range) if range.commit == hash => range.end = line,
            _ => ranges.push(BlameRange { start: line, end: line, commit: hash }),
        }
    }
    let mut commits: Vec<Commit> = Vec::new();
    for range in &ranges {
        if !commits.iter().any(|commit| commit.hash == range.commit)
            && let Some(commit) = by_hash.get(range.commit.as_str()) {
                commits.push((*commit).clone());
            }
    }
    Ok(Some(Blame {
        head: first.hash.clone(),
        ranges,
        commits,
        partial,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    #[test]
    fn unchanged_lines_are_carried_to_the_parent() {
        let map = carried(&lines("a\nb\nc"), &lines("a\nx\nb\nc"));
        assert_eq!(map, vec![Some(0), None, Some(1), Some(2)]);
    }

    #[test]
    fn a_changed_line_is_not_carried() {
        let map = carried(&lines("a\nb"), &lines("a\nB"));
        assert_eq!(map, vec![Some(0), None]);
    }
}
