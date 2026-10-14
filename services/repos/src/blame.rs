//! Which commit last changed each line of a file.
//!
//! History is walked newest first, as `git blame` does: a line still present,
//! unchanged, in one of a commit's parents is handed to that parent; a line in
//! none of them was written by the commit. Following every parent, not just
//! the first, matters here: catch-up merges bring the default branch into a
//! pull request, and their lines belong to whoever wrote them on that branch.
//!
//! Reading is what costs: each commit's file is found by reading the trees
//! on the way to it, and each read is a round trip to the store or its cache.
//! So the walk reads ahead: the trees of the next [`READ_AHEAD`] commits,
//! level by level and each level at once, and then, at once, the texts of the
//! versions it will compare. The walk stops when every line has its commit,
//! after [`MAX_COMMITS`] commits, before more than the caller's reads of the
//! store, or once the caller's time is up; stopped early, a line goes to the
//! oldest commit the walk reached it in, and the answer is marked partial.
//!
//! A blame of a commit and path never changes, so `lib.rs` keeps the answer
//! by repository, commit and path ([`cache_url`]).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use g1t_contracts::repos::{Blame, BlameRange, Commit, EntryKind, TreeEntry};
use similar::{ChangeTag, TextDiff};
use worker::Result;

use crate::store::GitRepo;

/// How far back the history is searched. Lines older than this are given to
/// the oldest commit reached, and the answer is marked partial.
pub const MAX_COMMITS: u32 = 400;
/// Files larger than this are not blamed.
const MAX_FILE_BYTES: usize = 512 * 1024;
/// Commits whose trees and texts are read together, ahead of the walk.
const READ_AHEAD: usize = 32;
/// Reads of the store one blame makes at most. Each costs up to three
/// subrequests (a Cache API look, the store, a Cache API put), so this keeps
/// a call well inside the 10,000 a Worker invocation may make.
pub const MAX_READS: u32 = 2_500;

/// Where a blame is kept: by repository, the commit it was read at, and a
/// hash of the path. `v1`: a change to how lines are credited moves it.
pub fn cache_url(repo_id: &str, head: &str, path: &str) -> String {
    format!("https://blame.g1t.internal/v1/{repo_id}/{head}/{}", g1t_secrets::sha256_hex(path))
}

/// How long a blame is kept. One that ran to its end (the first commit, or
/// [`MAX_COMMITS`]) is the same every time, so for good; one cut short by
/// time or reads could do better on a quieter store, so briefly.
pub fn cache_control(blamed: &Blamed) -> &'static str {
    if blamed.cut_short { "max-age=600" } else { "max-age=31536000, immutable" }
}

/// A blame, and whether time or reads cut it short.
#[derive(Debug)]
pub struct Blamed {
    pub blame: Blame,
    pub cut_short: bool,
}

/// A version of the file: its lines, each ended by a newline, as the diff
/// compares them, and how many there are.
struct Text {
    joined: String,
    lines: usize,
}

impl Text {
    fn of(text: &str) -> Text {
        let mut joined = String::with_capacity(text.len() + 1);
        let mut lines = 0;
        // Every line ends in a newline, so a last line matches the same line elsewhere.
        for line in text.lines() {
            joined.push_str(line);
            joined.push('\n');
            lines += 1;
        }
        Text { joined, lines }
    }
}

/// Reads files out of commits, remembering trees and texts already read:
/// most commits share most of their trees.
struct Reader<'a, R: GitRepo> {
    repo: &'a R,
    trees: HashMap<String, Option<Vec<TreeEntry>>>,
    texts: HashMap<String, Option<Rc<Text>>>,
    /// Reads of the store so far, trees, texts and history.
    reads: u32,
}

impl<'a, R: GitRepo> Reader<'a, R> {
    /// Reads the trees not read yet, all at once.
    async fn read_trees(&mut self, hashes: Vec<String>) -> Result<()> {
        let wanted: Vec<String> = hashes
            .into_iter()
            .filter(|hash| !self.trees.contains_key(hash))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        self.reads += wanted.len() as u32;
        let found = futures_util::future::join_all(wanted.iter().map(|hash| self.repo.read_tree(hash))).await;
        for (hash, tree) in wanted.into_iter().zip(found) {
            self.trees.insert(hash, tree?);
        }
        Ok(())
    }

    /// Reads, level by level and each level at once, the trees on the way
    /// to `path` in each of `roots`.
    async fn read_paths(&mut self, roots: Vec<String>, path: &str) -> Result<()> {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        let mut level = roots;
        for (index, part) in parts.iter().enumerate() {
            self.read_trees(level.clone()).await?;
            if index + 1 == parts.len() {
                break;
            }
            level = level
                .iter()
                .filter_map(|hash| {
                    let entries = self.trees.get(hash)?.as_ref()?;
                    entries.iter().find(|entry| entry.name == *part && entry.kind == EntryKind::Tree).map(|entry| entry.hash.clone())
                })
                .collect();
        }
        Ok(())
    }

    /// Reads the texts not read yet, all at once.
    async fn read_texts(&mut self, blobs: Vec<String>) -> Result<()> {
        let wanted: Vec<String> =
            blobs.into_iter().filter(|blob| !self.texts.contains_key(blob)).collect::<HashSet<_>>().into_iter().collect();
        self.reads += wanted.len() as u32;
        let found = futures_util::future::join_all(wanted.iter().map(|blob| self.repo.read_blob(blob))).await;
        for (blob, bytes) in wanted.into_iter().zip(found) {
            let text = bytes?
                .filter(|bytes| bytes.len() <= MAX_FILE_BYTES && !bytes.contains(&0))
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .map(|text| Rc::new(Text::of(&text)));
            self.texts.insert(blob, text);
        }
        Ok(())
    }

    /// The blob hash of `path` in the tree `root`, if it is a file there.
    async fn blob_at(&mut self, root: &str, path: &str) -> Result<Option<String>> {
        let mut tree = root.to_owned();
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        for (index, part) in parts.iter().enumerate() {
            if !self.trees.contains_key(&tree) {
                self.read_trees(vec![tree.clone()]).await?;
            }
            let Some(entry) = self.trees[&tree].as_ref().and_then(|entries| entries.iter().find(|entry| entry.name == *part)) else {
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

    /// A version's text, or `None` if it is binary or too large.
    async fn text(&mut self, blob: &str) -> Result<Option<Rc<Text>>> {
        if !self.texts.contains_key(blob) {
            self.read_texts(vec![blob.to_owned()]).await?;
        }
        Ok(self.texts[blob].clone())
    }

    /// Reads ahead for `commits`: the trees to `path` in each, then the
    /// texts of each version that differs from the next commit's (its
    /// parent on the walk), which are the ones the walk compares.
    async fn read_ahead(&mut self, commits: &[Commit], path: &str) -> Result<()> {
        self.read_paths(commits.iter().map(|commit| commit.tree_hash.clone()).collect(), path).await?;
        let mut blobs = Vec::with_capacity(commits.len());
        for commit in commits {
            blobs.push(self.blob_at(&commit.tree_hash, path).await?);
        }
        let mut wanted = Vec::new();
        for pair in blobs.windows(2) {
            if let [Some(child), Some(parent)] = pair
                && child != parent
            {
                wanted.push(child.clone());
                wanted.push(parent.clone());
            }
        }
        self.read_texts(wanted).await
    }
}

/// For each line of `new`, the index of the same, unchanged line in `old`.
fn carried(old: &Text, new: &Text) -> Vec<Option<usize>> {
    let diff = TextDiff::from_lines(&old.joined, &new.joined);
    let mut map = vec![None; new.lines];
    for change in diff.iter_all_changes() {
        if change.tag() == ChangeTag::Equal
            && let (Some(o), Some(n)) = (change.old_index(), change.new_index())
            && let Some(slot) = map.get_mut(n)
        {
            *slot = Some(o);
        }
    }
    map
}

/// Who last changed each line of `path` as of `head`. `None` if the file is
/// missing or not text. The walk stops before more than `max_reads` reads of
/// the store, or once `out_of_time` says so (asked between read-aheads,
/// after the first).
pub async fn blame<R: GitRepo>(
    repo: &R,
    head: &str,
    path: &str,
    out_of_time: &dyn Fn() -> bool,
    max_reads: u32,
) -> Result<Option<Blamed>> {
    let history = repo.log(head, MAX_COMMITS).await?;
    let Some(first) = history.first() else {
        return Ok(None);
    };
    let mut reader = Reader {
        repo,
        trees: HashMap::new(),
        texts: HashMap::new(),
        reads: 1,
    };
    // The first read-ahead also finds the file at the head.
    let first_window = &history[..history.len().min(READ_AHEAD + 1)];
    reader.read_ahead(first_window, path).await?;
    let mut read_ahead_to = first_window.len();
    let Some(blob) = reader.blob_at(&first.tree_hash, path).await? else {
        return Ok(None);
    };
    let Some(text) = reader.text(&blob).await? else {
        return Ok(None);
    };
    let total = text.lines;
    let by_hash: HashMap<&str, &Commit> = history.iter().map(|commit| (commit.hash.as_str(), commit)).collect();
    let segments = path.split('/').filter(|part| !part.is_empty()).count();
    // The most one read-ahead reads: every tree on the way, two texts each.
    let window_reads = (READ_AHEAD * (segments + 2)) as u32;

    // For each commit still to visit: (line in its version, line in the head's).
    let mut pending: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    pending.insert(first.hash.clone(), (0..total).map(|line| (line, line)).collect());
    let mut owner: Vec<Option<String>> = vec![None; total];
    let mut partial = false;
    let mut cut_short = false;

    // The log is newest first, so a commit is reached after its children.
    for (index, commit) in history.iter().enumerate() {
        if pending.is_empty() {
            break;
        }
        if index + 1 >= read_ahead_to && read_ahead_to < history.len() {
            if out_of_time() || reader.reads + window_reads > max_reads {
                cut_short = true;
                break;
            }
            let window = &history[index..history.len().min(index + READ_AHEAD + 1)];
            reader.read_ahead(window, path).await?;
            read_ahead_to = index + window.len();
        }
        let Some(mut lines_here) = pending.remove(&commit.hash) else {
            continue;
        };
        lines_here.sort_unstable();
        lines_here.dedup_by_key(|(_, final_line)| *final_line);
        let Some(blob) = reader.blob_at(&commit.tree_hash, path).await? else {
            continue;
        };
        // Read only when a parent's version differs.
        let mut text: Option<Rc<Text>> = None;
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
                if text.is_none() {
                    text = reader.text(&blob).await?;
                }
                let (Some(here), Some(parent_text)) = (&text, reader.text(&parent_blob).await?) else {
                    // A version that is not text: its lines are taken as
                    // this commit's.
                    continue;
                };
                let map = carried(&parent_text, here);
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
    // Lines the walk did not finish with: each goes to the oldest commit it
    // was followed to.
    if !pending.is_empty() {
        partial = true;
        for (hash, lines) in pending {
            for (_, final_line) in lines {
                if owner[final_line].is_none() {
                    owner[final_line] = Some(hash.clone());
                }
            }
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
            && let Some(commit) = by_hash.get(range.commit.as_str())
        {
            commits.push((*commit).clone());
        }
    }
    Ok(Some(Blamed {
        blame: Blame {
            head: first.hash.clone(),
            ranges,
            commits,
            partial,
        },
        cut_short,
    }))
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
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

    fn text(text: &str) -> Text {
        Text::of(text)
    }

    #[test]
    fn unchanged_lines_are_carried_to_the_parent() {
        let map = carried(&text("a\nb\nc"), &text("a\nx\nb\nc"));
        assert_eq!(map, vec![Some(0), None, Some(1), Some(2)]);
    }

    #[test]
    fn a_changed_line_is_not_carried() {
        let map = carried(&text("a\nb"), &text("a\nB"));
        assert_eq!(map, vec![Some(0), None]);
    }

    #[test]
    fn a_last_line_without_a_newline_matches_one_with() {
        let map = carried(&text("a\nb\n"), &text("a\nb"));
        assert_eq!(map, vec![Some(0), Some(1)]);
    }

    /// A repository whose history is `src/f.txt` growing a line per commit.
    #[derive(Default)]
    struct Fake {
        trees: HashMap<String, Vec<TreeEntry>>,
        blobs: HashMap<String, String>,
        history: Vec<Commit>,
        trees_read: RefCell<Vec<String>>,
        blobs_read: RefCell<Vec<String>>,
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
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
        async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
            self.blobs_read.borrow_mut().push(blob_hash.to_owned());
            Ok(self.blobs.get(blob_hash).map(|text| text.as_bytes().to_vec()))
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str, _default_branch_only: bool) -> Result<()> {
            Ok(())
        }
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

    /// `commits` commits, newest first: commit n appends line n to
    /// `src/f.txt`. Every tenth commit only touches `README.md` beside it,
    /// so `src` stays the same tree there. The repository root changes in
    /// every commit.
    fn growing(commits: usize) -> Fake {
        let mut fake = Fake::default();
        let mut lines: Vec<String> = Vec::new();
        for n in 0..commits {
            let changes_file = n == 0 || n % 10 != 0;
            if changes_file {
                lines.push(format!("line {n}"));
            }
            let blob = format!("b{}", lines.len());
            fake.blobs.insert(blob.clone(), lines.join("\n"));
            let src = format!("s{}", lines.len());
            fake.trees.insert(src.clone(), vec![TreeEntry { name: "f.txt".into(), hash: blob, kind: EntryKind::Blob }]);
            let root = format!("r{n}");
            fake.trees.insert(
                root.clone(),
                vec![
                    TreeEntry { name: "README.md".into(), hash: format!("readme{n}"), kind: EntryKind::Blob },
                    TreeEntry { name: "src".into(), hash: src, kind: EntryKind::Tree },
                ],
            );
            let parent = (n > 0).then(|| format!("c{}", n - 1));
            fake.history.insert(0, commit(&format!("c{n}"), &root, parent.as_deref()));
        }
        fake
    }

    fn owners(blame: &Blame) -> Vec<(u32, u32, String)> {
        blame.ranges.iter().map(|range| (range.start, range.end, range.commit.clone())).collect()
    }

    #[test]
    fn each_line_goes_to_the_commit_that_wrote_it() {
        let fake = growing(5);
        let blamed = run(blame(&fake, "main", "src/f.txt", &|| false, MAX_READS)).unwrap().unwrap();
        assert!(!blamed.cut_short && !blamed.blame.partial);
        assert_eq!(blamed.blame.head, "c4");
        assert_eq!(
            owners(&blamed.blame),
            (0..5).map(|n| (n + 1, n + 1, format!("c{n}"))).collect::<Vec<_>>()
        );
        assert_eq!(blamed.blame.commits.len(), 5);
    }

    #[test]
    fn a_missing_or_binary_file_has_no_blame() {
        let mut fake = growing(3);
        assert!(run(blame(&fake, "main", "src/nope.txt", &|| false, MAX_READS)).unwrap().is_none());
        assert!(run(blame(&fake, "unknown", "src/f.txt", &|| false, MAX_READS)).unwrap().is_none());
        fake.blobs.insert("b3".into(), "a\0b".into());
        assert!(run(blame(&fake, "main", "src/f.txt", &|| false, MAX_READS)).unwrap().is_none());
    }

    #[test]
    fn each_tree_and_text_is_read_once() {
        let fake = growing(60);
        let blamed = run(blame(&fake, "main", "src/f.txt", &|| false, MAX_READS)).unwrap().unwrap();
        assert!(!blamed.cut_short);
        let trees = fake.trees_read.borrow();
        assert_eq!(trees.len(), trees.iter().collect::<HashSet<_>>().len(), "no tree is read twice");
        let blobs = fake.blobs_read.borrow();
        assert_eq!(blobs.len(), blobs.iter().collect::<HashSet<_>>().len(), "no text is read twice");
        // Each root, and each distinct `src`, once.
        assert_eq!(trees.len(), 60 + 55);
    }

    #[test]
    fn the_walk_stops_once_every_line_has_its_commit() {
        // The newest 30 commits rewrite the whole file, so nothing older is needed.
        let mut fake = growing(200);
        fake.blobs.insert("b181".into(), "only line".into());
        let blamed = run(blame(&fake, "main", "src/f.txt", &|| false, MAX_READS)).unwrap().unwrap();
        assert_eq!(owners(&blamed.blame), vec![(1, 1, "c199".to_owned())]);
        assert!(fake.trees_read.borrow().len() < 2 * (READ_AHEAD + 1) * 2, "read only the first read-ahead or two");
    }

    #[test]
    fn out_of_time_stops_the_walk_and_credits_the_oldest_commit_reached() {
        let fake = growing(100);
        let asked = Cell::new(0);
        let out_of_time = || {
            asked.set(asked.get() + 1);
            true
        };
        let blamed = run(blame(&fake, "main", "src/f.txt", &out_of_time, MAX_READS)).unwrap().unwrap();
        assert!(blamed.cut_short && blamed.blame.partial);
        assert_eq!(asked.get(), 1, "asked once, after the first read-ahead");
        // The newest lines still have their own commits; the rest stop at
        // the last commit of the first read-ahead.
        let ranges = owners(&blamed.blame);
        assert_eq!(ranges.last().unwrap().2, "c99");
        let reached = format!("c{}", 99 - READ_AHEAD);
        assert_eq!(ranges[0].2, reached);
        assert_eq!(cache_control(&blamed), "max-age=600");
    }

    #[test]
    fn reads_are_bounded() {
        let fake = growing(300);
        let max = 150;
        let blamed = run(blame(&fake, "main", "src/f.txt", &|| false, max)).unwrap().unwrap();
        assert!(blamed.cut_short && blamed.blame.partial);
        let reads = fake.trees_read.borrow().len() + fake.blobs_read.borrow().len() + 1;
        assert!(reads <= max as usize, "{reads} reads, at most {max}");
    }

    #[test]
    fn a_history_longer_than_is_read_is_partial_but_kept_for_good() {
        let fake = growing(MAX_COMMITS as usize + 20);
        let blamed = run(blame(&fake, "main", "src/f.txt", &|| false, 100_000)).unwrap().unwrap();
        assert!(blamed.blame.partial && !blamed.cut_short);
        assert_eq!(cache_control(&blamed), "max-age=31536000, immutable");
    }

    #[test]
    fn a_blame_is_kept_by_repository_commit_and_path() {
        let url = cache_url("repo_1", "abc", "src/f.txt");
        assert!(url.starts_with("https://blame.g1t.internal/v1/repo_1/abc/"));
        assert_ne!(url, cache_url("repo_1", "abc", "src/g.txt"));
        assert_ne!(url, cache_url("repo_1", "abd", "src/f.txt"));
        assert_ne!(url, cache_url("repo_2", "abc", "src/f.txt"));
        // A path never reaches the URL as it is.
        assert!(!cache_url("r", "h", "a/../b?x#y").contains(".."));
    }
}
