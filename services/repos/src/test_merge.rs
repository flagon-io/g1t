//! A pull request's test merge commit, as GitHub makes one for every open
//! pull request: `refs/pull/<number>/head` at the pull request's head, and
//! `refs/pull/<number>/merge` at a commit merging that head into the tip of
//! the branch it targets. `pull_request` runs build that commit.
//!
//! It is made here, without a sandbox. A fork's head is first copied into
//! the repository (only the objects it lacks travel). Files only one side
//! changed since the two last agreed are taken from that side, as catching
//! up does (catch_up.rs); a file both changed is merged line by line, the
//! way git merges text, and changes to the same or neighbouring lines that
//! differ are a conflict, as is a binary file both changed differently.
//! Then there is no merge commit, as on GitHub, and the merge ref goes.
//!
//! What g1t cannot merge itself (a file one side renamed or deleted and the
//! other changed, a file against a directory, a change too large to list)
//! is answered as unavailable, and the caller decides what to do without it.

use std::collections::{BTreeSet, HashMap};

use futures_util::future::{try_join, try_join_all};
use g1t_contracts::repos::{EntryKind, PullMergeRef, PullMergeRefArgs, TreeEntry, pull_head_ref, pull_merge_ref};
use g1t_contracts::time::parse_rfc3339;
use g1t_scan::pack::{ObjectKind, object_id, write_pack};
use similar::{Algorithm, DiffTag, capture_diff_slices};
use worker::Result;

use crate::catch_up::{Change, Signature, ancestors, commit_object, merge_tree, overlapping, read_dirs};
use crate::diff::{FileEntry, changed_entries};
use crate::registry::store_key;
use crate::store::{GitRepo, GitStore, Scope};
use crate::{MAX_ANCESTRY, Repos, descends_from, land, nearest_ancestor_in, refs};

/// Files larger than this are not merged line by line.
pub(crate) const MAX_MERGE_BYTES: usize = 1024 * 1024;
const ZERO_ID: &str = "0000000000000000000000000000000000000000";

/// One side's change to the base: its lines `start..end` become `lines`.
#[derive(Debug)]
struct Hunk<'a> {
    start: usize,
    end: usize,
    lines: Vec<&'a str>,
}

/// What `side` changed of `base`, as hunks in order, with no two touching.
fn hunks<'a>(base: &[&'a str], side: &[&'a str]) -> Vec<Hunk<'a>> {
    let mut out: Vec<Hunk<'a>> = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, base, side) {
        let (tag, old, new) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        let lines = side[new].to_vec();
        match out.last_mut() {
            Some(last) if last.end == old.start => {
                last.end = old.end;
                last.lines.extend(lines);
            }
            _ => out.push(Hunk { start: old.start, end: old.end, lines }),
        }
    }
    out
}

/// The base's lines `start..end` with `hunks` (all inside them) applied.
fn apply<'a>(base: &[&'a str], hunks: &[Hunk<'a>], start: usize, end: usize) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut at = start;
    for hunk in hunks {
        out.extend_from_slice(&base[at..hunk.start]);
        out.extend_from_slice(&hunk.lines);
        at = hunk.end;
    }
    out.extend_from_slice(&base[at..end]);
    out
}

/// Merges two texts that each changed `base`, as git does: a change only
/// one side made is taken, and where the two sides' changes overlap or
/// touch (no unchanged line between them) they must be the same. `None`
/// when they conflict.
pub(crate) fn merge_text(base: &str, ours: &str, theirs: &str) -> Option<String> {
    fn lines(text: &str) -> Vec<&str> {
        text.split_inclusive('\n').collect()
    }
    let (base, ours, theirs) = (lines(base), lines(ours), lines(theirs));
    let (mine, other) = (hunks(&base, &ours), hunks(&base, &theirs));
    let mut out = String::new();
    let (mut i, mut j, mut at) = (0, 0, 0);
    while i < mine.len() || j < other.len() {
        // The earliest change starts a run; every change that overlaps or
        // touches the run joins it.
        let first = if j >= other.len() || (i < mine.len() && mine[i].start <= other[j].start) { &mine[i] } else { &other[j] };
        let (start, mut end) = (first.start, first.end);
        let (from_mine, from_other) = (i, j);
        loop {
            if i < mine.len() && mine[i].start <= end {
                end = end.max(mine[i].end);
                i += 1;
            } else if j < other.len() && other[j].start <= end {
                end = end.max(other[j].end);
                j += 1;
            } else {
                break;
            }
        }
        let (mine_run, other_run) = (&mine[from_mine..i], &other[from_other..j]);
        let merged = match (mine_run.is_empty(), other_run.is_empty()) {
            (false, true) => apply(&base, mine_run, start, end),
            (true, false) => apply(&base, other_run, start, end),
            _ => {
                let (a, b) = (apply(&base, mine_run, start, end), apply(&base, other_run, start, end));
                if a != b {
                    return None;
                }
                a
            }
        };
        out.extend(base[at..start].iter().copied());
        out.extend(merged);
        at = end;
    }
    out.extend(base[at..].iter().copied());
    Some(out)
}

/// What becomes of one path in the merge, the base branch's tree being
/// where the merge starts.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Put the pull request's version there (`None`: remove it).
    Take(Option<FileEntry>),
    /// Both changed the file: merge the three texts, as `kind`.
    Content { kind: EntryKind, base: Option<String>, ours: String, theirs: String },
}

/// What the files each side changed since the merge base come to, without
/// reading any file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Steps(Vec<(String, Step)>),
    Conflict(Vec<String>),
    Unsupported(String),
}

fn text_kind(kind: EntryKind) -> bool {
    matches!(kind, EntryKind::Blob | EntryKind::Exec)
}

type Changed = (String, Option<FileEntry>, Option<FileEntry>);

/// The steps that make the merge, from the files the pull request
/// (`ours`) and the base branch (`theirs`) changed since they last agreed.
pub(crate) fn plan(ours: &[Changed], theirs: &[Changed]) -> Plan {
    let their: HashMap<&str, &Changed> = theirs.iter().map(|change| (change.0.as_str(), change)).collect();
    let paths = |changes: &[Changed]| changes.iter().map(|change| change.0.clone()).collect::<Vec<_>>();
    // A file on one side where the other has a directory.
    let ours_paths = paths(ours);
    if let Some(met) = overlapping(&ours_paths, &paths(theirs)).into_iter().find(|path| !their.contains_key(path.as_str()) || !ours_paths.contains(path)) {
        return Plan::Unsupported(format!("{met} is a file on one side and a directory on the other"));
    }
    let mut steps = Vec::new();
    let mut conflicts = Vec::new();
    for (path, base, mine) in ours {
        let Some((_, _, other)) = their.get(path.as_str()) else {
            steps.push((path.clone(), Step::Take(mine.clone())));
            continue;
        };
        // Both made it the same, or the base branch's is already there.
        if mine == other {
            continue;
        }
        let (Some(mine), Some(other)) = (mine, other) else {
            return Plan::Unsupported(format!("{path} was deleted or renamed on one side and changed on the other"));
        };
        let base_kind = base.as_ref().map(|(kind, _)| *kind);
        let kind = if mine.0 == other.0 {
            mine.0
        } else if base_kind == Some(mine.0) {
            other.0
        } else if base_kind == Some(other.0) {
            mine.0
        } else {
            conflicts.push(path.clone());
            continue;
        };
        if mine.1 == other.1 {
            steps.push((path.clone(), Step::Take(Some((kind, mine.1.clone())))));
            continue;
        }
        if !text_kind(mine.0) || !text_kind(other.0) || base_kind.is_some_and(|kind| !text_kind(kind)) {
            conflicts.push(path.clone());
            continue;
        }
        steps.push((
            path.clone(),
            Step::Content { kind, base: base.as_ref().map(|(_, hash)| hash.clone()), ours: mine.1.clone(), theirs: other.1.clone() },
        ));
    }
    if conflicts.is_empty() { Plan::Steps(steps) } else { Plan::Conflict(conflicts) }
}

/// What GitHub's test merge commits say.
pub(crate) fn message(head: &str, base: &str) -> String {
    format!("Merge {head} into {base}")
}

/// A merge, worked out.
enum Made {
    Merged { commit: String, objects: Vec<(ObjectKind, Vec<u8>)> },
    Conflict(Vec<String>),
    Unsupported(String),
}

/// A blob's text, for merging: `Err(true)` when it is binary, `Err(false)`
/// when it is too large or missing.
pub(crate) fn as_text(bytes: Option<Vec<u8>>) -> std::result::Result<String, bool> {
    let bytes = bytes.ok_or(false)?;
    if bytes.len() > MAX_MERGE_BYTES {
        return Err(false);
    }
    if bytes.contains(&0) {
        return Err(true);
    }
    String::from_utf8(bytes).map_err(|_| true)
}

/// When a merge of two commits says it was made: the later of their
/// dates, so that the same two always make the same commit, however many
/// events ask for it, and a merge ref that is already right stays.
fn merged_at(head: &g1t_contracts::repos::Commit, base: &g1t_contracts::repos::Commit) -> u64 {
    let at = |commit: &g1t_contracts::repos::Commit| parse_rfc3339(&commit.authored_at).unwrap_or(0) / 1000;
    at(head).max(at(base))
}

/// Merges `head` into `base`, both in `git`.
async fn make<R: GitRepo>(git: &R, base: &str, head: &str) -> Result<Made> {
    let (head_log, base_log) = try_join(git.log(head, MAX_ANCESTRY), git.log(base, MAX_ANCESTRY)).await?;
    let (Some(head_commit), Some(base_commit)) = (head_log.first(), base_log.first()) else {
        return Ok(Made::Unsupported("the head or the base commit could not be read".to_owned()));
    };
    let seconds = merged_at(head_commit, base_commit);
    let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    let tree = if descends_from(git, &head_log, base).await? {
        head_commit.tree_hash.clone()
    } else {
        let shared = base_log.iter().map(|commit| commit.hash.clone()).collect();
        let merge_base = nearest_ancestor_in(git, &head_log, &shared).await?;
        let Some(merge_base_tree) = merge_base.and_then(|hash| base_log.iter().find(|commit| commit.hash == hash)).map(|commit| commit.tree_hash.clone()) else {
            return Ok(Made::Unsupported("g1t could not find where the head left the base branch".to_owned()));
        };
        let ((ours, ours_cut), (theirs, theirs_cut)) = try_join(
            changed_entries(git, Some(&merge_base_tree), &head_commit.tree_hash),
            changed_entries(git, Some(&merge_base_tree), &base_commit.tree_hash),
        )
        .await?;
        if ours_cut || theirs_cut {
            return Ok(Made::Unsupported("the change is too large to merge without a sandbox".to_owned()));
        }
        let steps = match plan(&ours, &theirs) {
            Plan::Steps(steps) => steps,
            Plan::Conflict(paths) => return Ok(Made::Conflict(paths)),
            Plan::Unsupported(why) => return Ok(Made::Unsupported(why)),
        };
        // Files both changed, merged line by line.
        let read = try_join_all(steps.iter().map(|(_, step)| async move {
            let Step::Content { base, ours, theirs, .. } = step else { return Ok(None) };
            let base = async {
                match base {
                    Some(hash) => git.read_blob(hash).await,
                    None => Ok(Some(Vec::new())),
                }
            };
            let (base, (ours, theirs)) = try_join(base, try_join(git.read_blob(ours), git.read_blob(theirs))).await?;
            Ok::<_, worker::Error>(Some((base, ours, theirs)))
        }))
        .await?;
        let mut changes = Vec::new();
        let mut conflicts = Vec::new();
        for ((path, step), texts) in steps.into_iter().zip(read) {
            match (step, texts) {
                (Step::Take(entry), _) => changes.push(Change { path, entry }),
                (Step::Content { kind, .. }, Some((base, ours, theirs))) => {
                    let texts = (as_text(base), as_text(ours), as_text(theirs));
                    let (Ok(base), Ok(ours), Ok(theirs)) = texts else {
                        if matches!(texts, (Err(true), _, _) | (_, Err(true), _) | (_, _, Err(true))) {
                            conflicts.push(path);
                            continue;
                        }
                        return Ok(Made::Unsupported(format!("{path} is too large to merge without a sandbox")));
                    };
                    match merge_text(&base, &ours, &theirs) {
                        Some(merged) => {
                            let blob = merged.into_bytes();
                            let id = object_id(ObjectKind::Blob, &blob);
                            objects.push((ObjectKind::Blob, blob));
                            changes.push(Change { path, entry: Some((kind, id)) });
                        }
                        None => conflicts.push(path),
                    }
                }
                (Step::Content { .. }, None) => {}
            }
        }
        if !conflicts.is_empty() {
            return Ok(Made::Conflict(conflicts));
        }
        let dirs: BTreeSet<String> = changes.iter().flat_map(|change| ancestors(&change.path).map(str::to_owned)).collect();
        let trees: HashMap<String, Vec<TreeEntry>> = read_dirs(git, &base_commit.tree_hash, &dirs).await?.into_values().collect();
        match merge_tree(&base_commit.tree_hash, &trees, &changes) {
            Ok(merged) => {
                objects.extend(merged.objects.into_iter().map(|bytes| (ObjectKind::Tree, bytes)));
                merged.tree
            }
            Err(why) => return Ok(Made::Unsupported(why)),
        }
    };
    let commit = commit_object(
        &tree,
        &[base, head],
        &Signature { name: g1t_contracts::system::USERNAME, email: g1t_contracts::system::EMAIL, seconds },
        &message(head, base),
    );
    let id = object_id(ObjectKind::Commit, &commit);
    objects.push((ObjectKind::Commit, commit));
    Ok(Made::Merged { commit: id, objects })
}

fn unavailable(reason: impl Into<String>) -> Result<PullMergeRef> {
    Ok(PullMergeRef::Unavailable { reason: reason.into() })
}

impl<S: GitStore> Repos<S> {
    /// `pull_merge_ref` (contracts `PullMergeRefArgs`).
    pub(crate) async fn pull_merge_ref(&self, a: PullMergeRefArgs) -> Result<PullMergeRef> {
        let Some(target) = self.registry.by_id(&a.repo_id).await? else {
            return unavailable("the repository is gone");
        };
        if let Some((_, message)) = crate::lifecycle::read_only_refusal(&target) {
            return unavailable(message);
        }
        let target = match self.unpaused(target).await? {
            Ok(target) => target,
            Err((_, message)) => return unavailable(message),
        };
        let git = self.store.open(&store_key(&target)).await?;
        let refs = refs::all(&git.access(Scope::Read).await?).await?;
        let find = |refs: &[(String, String)], name: &str| refs.iter().find(|(known, _)| known == name).map(|(_, hash)| hash.clone());
        let (head_ref, merge_ref) = (pull_head_ref(a.number), pull_merge_ref(a.number));
        let base_branch = a.target_branch.clone().filter(|branch| !branch.is_empty()).unwrap_or_else(|| target.default_branch.clone());
        let Some(base) = find(&refs, &format!("refs/heads/{base_branch}")) else {
            return unavailable(format!("{base_branch} has no commits"));
        };
        let head = a.head.clone();

        // The head, kept in the repository, its objects brought from the fork.
        let held_head = find(&refs, &head_ref);
        if held_head.as_deref() != Some(head.as_str()) {
            let write = git.access(Scope::Write).await?;
            let moved = if !git.log(&head, 1).await?.is_empty() {
                land::push_ref(&write, &head_ref, held_head.as_deref(), &head, Some(land::EMPTY_PACK.to_vec())).await?
            } else {
                let source = match self.registry.by_id(&a.source_id).await? {
                    Some(source) if source.id != target.id => source,
                    _ => return unavailable("the head commit is not in the repository"),
                };
                // A working copy removed after its pull request closed is made again.
                self.live(&source).await?;
                let source_read = self.store.open(&store_key(&source)).await?.access(Scope::Read).await?;
                let command = (head_ref.clone(), held_head.clone(), head.clone());
                land::copy_refs(&source_read, &write, &[command], std::slice::from_ref(&head), std::slice::from_ref(&base)).await?
            };
            self.refs_moved(&target.id).await;
            if let Err(reason) = moved {
                return unavailable(format!("{head_ref} could not be kept: {reason}"));
            }
        }

        let held_merge = find(&refs, &merge_ref);
        match make(&git, &base, &head).await? {
            Made::Unsupported(reason) => unavailable(reason),
            Made::Conflict(paths) => {
                // No merge commit, so no merge ref, as on GitHub.
                if let Some(old) = &held_merge {
                    let write = git.access(Scope::Write).await?;
                    if let Err(reason) = land::push_ref(&write, &merge_ref, Some(old), ZERO_ID, None).await? {
                        worker::console_warn!("{merge_ref} of {} not removed: {reason}", target.id);
                    }
                    self.refs_moved(&target.id).await;
                }
                Ok(PullMergeRef::Conflict { head, base, paths })
            }
            // Made the same for the same head and base: there already when
            // an earlier event made it.
            Made::Merged { commit, .. } if held_merge.as_deref() == Some(commit.as_str()) => {
                Ok(PullMergeRef::Merged { head, base, merge: commit })
            }
            Made::Merged { commit, objects } => {
                let write = git.access(Scope::Write).await?;
                let pushed = land::push_ref(&write, &merge_ref, held_merge.as_deref(), &commit, Some(write_pack(&objects))).await?;
                self.refs_moved(&target.id).await;
                if let Err(reason) = pushed {
                    // Another event for the same pair made it meanwhile.
                    let refs = refs::all(&git.access(Scope::Read).await?).await?;
                    if find(&refs, &merge_ref).as_deref() != Some(commit.as_str()) {
                        return unavailable(format!("{merge_ref} could not be moved: {reason}"));
                    }
                }
                Ok(PullMergeRef::Merged { head, base, merge: commit })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(hash: &str) -> Option<FileEntry> {
        Some((EntryKind::Blob, hash.to_owned()))
    }

    fn changed(path: &str, base: Option<FileEntry>, now: Option<FileEntry>) -> Changed {
        (path.to_owned(), base, now)
    }

    #[test]
    fn changes_to_different_lines_merge() {
        let base = "a\nb\nc\nd\ne\n";
        let ours = "A\nb\nc\nd\ne\n";
        let theirs = "a\nb\nc\nd\nE\n";
        assert_eq!(merge_text(base, ours, theirs).as_deref(), Some("A\nb\nc\nd\nE\n"));
        // Lines added at either end, and one taken out in the middle.
        assert_eq!(merge_text(base, "top\na\nb\nc\nd\ne\n", "a\nb\nd\ne\nend\n").as_deref(), Some("top\na\nb\nd\ne\nend\n"));
    }

    #[test]
    fn the_same_change_on_both_sides_merges() {
        let base = "a\nb\nc\n";
        assert_eq!(merge_text(base, "a\nB\nc\n", "a\nB\nc\n").as_deref(), Some("a\nB\nc\n"));
    }

    #[test]
    fn different_changes_to_the_same_or_touching_lines_conflict() {
        let base = "a\nb\nc\nd\n";
        assert_eq!(merge_text(base, "a\nX\nc\nd\n", "a\nY\nc\nd\n"), None);
        // Neighbouring lines, with no unchanged line between: git conflicts.
        assert_eq!(merge_text(base, "a\nX\nc\nd\n", "a\nb\nY\nd\n"), None);
        // Both added different files from nothing.
        assert_eq!(merge_text("", "one\n", "two\n"), None);
        // One unchanged line between them is enough.
        assert_eq!(merge_text(base, "X\nb\nc\nd\n", "a\nb\nY\nd\n").as_deref(), Some("X\nb\nY\nd\n"));
    }

    #[test]
    fn a_missing_final_newline_is_kept() {
        assert_eq!(merge_text("a\nb\nc", "A\nb\nc", "a\nb\nC").as_deref(), Some("A\nb\nC"));
    }

    #[test]
    fn files_only_one_side_changed_are_taken_from_it() {
        let ours = [changed("src/a.rs", blob("1"), blob("2")), changed("gone.md", blob("3"), None)];
        let theirs = [changed("src/b.rs", blob("4"), blob("5"))];
        assert_eq!(
            plan(&ours, &theirs),
            Plan::Steps(vec![("src/a.rs".into(), Step::Take(blob("2"))), ("gone.md".into(), Step::Take(None))])
        );
    }

    #[test]
    fn a_file_both_changed_is_merged_by_content() {
        let ours = [changed("a", blob("1"), blob("2")), changed("same", blob("1"), blob("9"))];
        let theirs = [changed("a", blob("1"), blob("3")), changed("same", blob("1"), blob("9"))];
        assert_eq!(
            plan(&ours, &theirs),
            Plan::Steps(vec![(
                "a".into(),
                Step::Content { kind: EntryKind::Blob, base: Some("1".into()), ours: "2".into(), theirs: "3".into() }
            )])
        );
        // One side made it executable, the other changed it.
        let ours = [changed("run", blob("1"), Some((EntryKind::Exec, "1".into())))];
        let theirs = [changed("run", blob("1"), blob("2"))];
        assert_eq!(
            plan(&ours, &theirs),
            Plan::Steps(vec![(
                "run".into(),
                Step::Content { kind: EntryKind::Exec, base: Some("1".into()), ours: "1".into(), theirs: "2".into() }
            )])
        );
    }

    #[test]
    fn what_cannot_merge_says_so() {
        // A submodule moved two ways.
        let ours = [changed("vendor", Some((EntryKind::Gitlink, "1".into())), Some((EntryKind::Gitlink, "2".into())))];
        let theirs = [changed("vendor", Some((EntryKind::Gitlink, "1".into())), Some((EntryKind::Gitlink, "3".into())))];
        assert_eq!(plan(&ours, &theirs), Plan::Conflict(vec!["vendor".into()]));
        // Deleted on one side, changed on the other: maybe a rename.
        let ours = [changed("a", blob("1"), None)];
        let theirs = [changed("a", blob("1"), blob("2"))];
        assert!(matches!(plan(&ours, &theirs), Plan::Unsupported(_)));
        // A file against a directory.
        let ours = [changed("a", None, blob("1"))];
        let theirs = [changed("a/b", None, blob("2"))];
        assert!(matches!(plan(&ours, &theirs), Plan::Unsupported(_)));
    }

    #[test]
    fn binary_files_are_told_apart_from_text() {
        assert_eq!(as_text(Some(b"text\n".to_vec())), Ok("text\n".to_owned()));
        assert_eq!(as_text(Some(vec![0, 1, 2])), Err(true));
        assert_eq!(as_text(None), Err(false));
        assert_eq!(as_text(Some(vec![b'a'; MAX_MERGE_BYTES + 1])), Err(false));
    }

    /// A store of whole objects, made in the test: commits by hash, trees
    /// and blobs by their real ids.
    #[derive(Default)]
    struct Store {
        commits: HashMap<String, g1t_contracts::repos::Commit>,
        trees: HashMap<String, Vec<TreeEntry>>,
        blobs: HashMap<String, Vec<u8>>,
    }

    impl Store {
        fn blob(&mut self, text: &str) -> String {
            let id = object_id(ObjectKind::Blob, text.as_bytes());
            self.blobs.insert(id.clone(), text.as_bytes().to_vec());
            id
        }

        /// A tree of `files` (`path`, text), its subtrees made as needed.
        fn tree(&mut self, files: &[(&str, &str)]) -> String {
            let mut here: Vec<TreeEntry> = Vec::new();
            let mut dirs: std::collections::BTreeMap<&str, Vec<(&str, &str)>> = Default::default();
            for (path, text) in files {
                match path.split_once('/') {
                    Some((dir, rest)) => dirs.entry(dir).or_default().push((rest, text)),
                    None => {
                        let hash = self.blob(text);
                        here.push(TreeEntry { name: (*path).to_owned(), hash, kind: EntryKind::Blob });
                    }
                }
            }
            for (dir, files) in dirs {
                let hash = self.tree(&files);
                here.push(TreeEntry { name: dir.to_owned(), hash, kind: EntryKind::Tree });
            }
            let id = object_id(ObjectKind::Tree, &crate::catch_up::encode_entries(&here));
            self.trees.insert(id.clone(), here);
            id
        }

        fn commit(&mut self, hash: &str, parents: &[&str], files: &[(&str, &str)]) {
            let tree_hash = self.tree(files);
            self.commits.insert(
                hash.to_owned(),
                g1t_contracts::repos::Commit {
                    hash: hash.to_owned(),
                    tree_hash,
                    message: hash.to_owned(),
                    author: g1t_contracts::repos::Signature { name: "a".into(), email: "a@example.com".into() },
                    parents: parents.iter().map(|&p| p.to_owned()).collect(),
                    authored_at: String::new(),
                },
            );
        }

        /// The files of a tree in `objects` or the store, by path.
        fn files(&self, tree: &str, written: &HashMap<String, Vec<TreeEntry>>, blobs: &HashMap<String, Vec<u8>>, prefix: &str) -> Vec<(String, String)> {
            let entries = written.get(tree).or_else(|| self.trees.get(tree)).expect("tree");
            let mut out = Vec::new();
            for entry in entries {
                let path = format!("{prefix}{}", entry.name);
                if entry.kind == EntryKind::Tree {
                    out.extend(self.files(&entry.hash, written, blobs, &format!("{path}/")));
                } else {
                    let bytes = blobs.get(&entry.hash).or_else(|| self.blobs.get(&entry.hash)).expect("blob");
                    out.push((path, String::from_utf8(bytes.clone()).unwrap()));
                }
            }
            out
        }
    }

    impl GitRepo for Store {
        async fn access(&self, _scope: Scope) -> Result<g1t_contracts::repos::GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<g1t_contracts::repos::Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<g1t_contracts::repos::Commit>> {
            let mut out = Vec::new();
            let mut at = self.commits.get(git_ref);
            while let Some(commit) = at.filter(|_| (out.len() as u32) < limit) {
                out.push(commit.clone());
                at = commit.parents.first().and_then(|parent| self.commits.get(parent));
            }
            Ok(out)
        }
        async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
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

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
        }
    }

    /// The merge's files, read from the objects it wrote and the store.
    fn merged_files(store: &Store, made: Made, base: &str, head: &str) -> Vec<(String, String)> {
        let Made::Merged { commit, objects } = made else { panic!("not merged") };
        let mut trees = HashMap::new();
        let mut blobs = HashMap::new();
        let mut tree = None;
        for (kind, bytes) in &objects {
            let id = object_id(*kind, bytes);
            match kind {
                ObjectKind::Tree => {
                    let entries = g1t_scan::pack::parse_tree(bytes)
                        .into_iter()
                        .map(|item| TreeEntry {
                            kind: if item.mode == "40000" { EntryKind::Tree } else { EntryKind::Blob },
                            name: item.name,
                            hash: item.id,
                        })
                        .collect();
                    trees.insert(id, entries);
                }
                ObjectKind::Blob => {
                    blobs.insert(id, bytes.clone());
                }
                ObjectKind::Commit => {
                    assert_eq!(id, commit);
                    let text = String::from_utf8(bytes.clone()).unwrap();
                    assert!(text.contains(&format!("parent {base}\nparent {head}\n")), "{text}");
                    assert!(text.contains(&format!("\n\nMerge {head} into {base}\n")), "{text}");
                    tree = text.lines().next().and_then(|line| line.strip_prefix("tree ")).map(str::to_owned);
                }
                ObjectKind::Tag => unreachable!(),
            }
        }
        let mut files = store.files(&tree.expect("a commit"), &trees, &blobs, "");
        files.sort();
        files
    }

    #[test]
    fn a_head_behind_its_base_merges_both_sides() {
        let mut store = Store::default();
        store.commit("m", &[], &[("README.md", "hi\n"), ("src/lib.rs", "a\nb\nc\nd\ne\n")]);
        store.commit("h", &["m"], &[("README.md", "hi\n"), ("src/lib.rs", "A\nb\nc\nd\ne\n"), ("src/new.rs", "new\n")]);
        store.commit("b", &["m"], &[("README.md", "hello\n"), ("src/lib.rs", "a\nb\nc\nd\nE\n")]);
        let made = block_on(make(&store, "b", "h")).unwrap();
        assert_eq!(
            merged_files(&store, made, "b", "h"),
            [
                ("README.md".to_owned(), "hello\n".to_owned()),
                ("src/lib.rs".to_owned(), "A\nb\nc\nd\nE\n".to_owned()),
                ("src/new.rs".to_owned(), "new\n".to_owned()),
            ]
        );
    }

    #[test]
    fn a_head_up_to_date_merges_to_its_own_files() {
        let mut store = Store::default();
        store.commit("b", &[], &[("a", "1\n")]);
        store.commit("h", &["b"], &[("a", "2\n")]);
        let made = block_on(make(&store, "b", "h")).unwrap();
        assert_eq!(merged_files(&store, made, "b", "h"), [("a".to_owned(), "2\n".to_owned())]);
    }

    #[test]
    fn the_same_head_and_base_always_make_the_same_commit() {
        let mut store = Store::default();
        store.commit("m", &[], &[("a", "1\n"), ("b", "x\n")]);
        store.commit("h", &["m"], &[("a", "2\n"), ("b", "x\n")]);
        store.commit("b", &["m"], &[("a", "1\n"), ("b", "y\n")]);
        store.commits.get_mut("h").unwrap().authored_at = "2026-10-12T03:00:00.000Z".into();
        store.commits.get_mut("b").unwrap().authored_at = "2026-10-12T04:00:00.000Z".into();
        let id = |made: Made| match made {
            Made::Merged { commit, objects } => (commit, String::from_utf8(objects.last().unwrap().1.clone()).unwrap()),
            _ => panic!("not merged"),
        };
        let (first, text) = id(block_on(make(&store, "b", "h")).unwrap());
        assert_eq!(id(block_on(make(&store, "b", "h")).unwrap()).0, first);
        // Dated as the later of the two.
        assert!(text.contains(" 1791777600 +0000\n"), "{text}");
    }

    #[test]
    fn a_conflict_makes_no_merge() {
        let mut store = Store::default();
        store.commit("m", &[], &[("a", "1\n"), ("b", "x\n")]);
        store.commit("h", &["m"], &[("a", "2\n"), ("b", "x\n")]);
        store.commit("b", &["m"], &[("a", "3\n"), ("b", "y\n")]);
        let Made::Conflict(paths) = block_on(make(&store, "b", "h")).unwrap() else { panic!("no conflict") };
        assert_eq!(paths, ["a"]);
    }

    #[test]
    fn the_merge_commit_says_what_github_s_does() {
        assert_eq!(message("abc", "def"), "Merge abc into def");
        assert_eq!(pull_merge_ref(7), "refs/pull/7/merge");
        assert_eq!(pull_head_ref(7), "refs/pull/7/head");
    }
}
