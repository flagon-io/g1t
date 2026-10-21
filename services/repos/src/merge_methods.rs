//! Landing a pull request by making commits on the branch it merges into:
//! a merge commit, one squashed commit, or the branch's commits made again
//! on top (`land` with a `method`); and rebasing a pull request's branch
//! onto that branch (`update_pull_branch` with `rebase`).
//!
//! Each is worked out here, without a sandbox, from trees. The changes one
//! side made since the two last agreed are applied to the other side's
//! tree ([`apply`]): a file only that side changed is taken from it, and a
//! file both changed is merged line by line, as git merges text
//! (test_merge.rs `merge_text`). Lines both changed differently, a file
//! one side deleted and the other changed, or a binary file both changed
//! are a conflict, and nothing is made: the conflict names the files. Only
//! the trees on the way to changed files are read and written. What is
//! made is pushed as one pack, with whatever a fork's commits bring that
//! the repository lacks, and the branch moves only if it is still where it
//! was.
//!
//! The work is bounded for a Worker: at most [`MAX_LAND_FILES`] files
//! applied at a time, [`MAX_LINE_MERGES`] of them merged line by line
//! (each at most test_merge.rs `MAX_MERGE_BYTES`), and at most
//! [`MAX_REBASE_COMMITS`] commits made again by a rebase. Beyond those g1t
//! says it cannot do it itself, and nothing is changed.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};

use futures_util::future::{try_join, try_join_all};
use g1t_contracts::repos::{
    Branch, BuildQueueStepArgs, Commit, EntryKind, GitAccess, LandArgs, Landed, NeedsAgentReason, PullBranchUpdate, QueueStep,
    Repo, TreeEntry,
};
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::time::parse_rfc3339;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use g1t_scan::pack::{ObjectKind, extend_pack, object_id, parse_tree, write_pack};
use worker::Result;

use crate::public_storage::Operation;
use crate::catch_up::{BranchUpdate, Change, Signature, ancestors, commit_object_by, merge_tree, moved_since, read_dirs};
use crate::diff::{FileEntry, changed_entries_up_to};
use crate::registry::store_key;
use crate::store::{GitRepo, GitStore, Scope};
use crate::test_merge::{as_text, merge_text};
use crate::{MAX_ANCESTRY, Repos, descends_from, land, nearest_ancestor_in};

/// The most files one side's change may touch for g1t to apply it.
pub(crate) const MAX_LAND_FILES: usize = 1000;
/// The most files both sides changed that are merged line by line at once.
pub(crate) const MAX_LINE_MERGES: usize = 100;
/// The most commits a rebase makes again.
pub(crate) const MAX_REBASE_COMMITS: usize = 250;

/// Reads objects from a repository, then from a second one (a fork, or the
/// repository a fork came from) for what the first lacks, and first of all
/// from the objects made here and not yet pushed.
pub(crate) struct Reader<'a, R> {
    first: &'a R,
    second: Option<&'a R>,
    trees: RefCell<HashMap<String, Vec<TreeEntry>>>,
    blobs: RefCell<HashMap<String, Vec<u8>>>,
}

/// What git's tree mode says an entry is.
fn kind_of(mode: &str) -> EntryKind {
    match mode {
        "40000" | "040000" => EntryKind::Tree,
        "100755" => EntryKind::Exec,
        "120000" => EntryKind::Symlink,
        "160000" => EntryKind::Gitlink,
        _ => EntryKind::Blob,
    }
}

impl<'a, R: GitRepo> Reader<'a, R> {
    pub(crate) fn new(first: &'a R, second: Option<&'a R>) -> Self {
        Reader { first, second, trees: RefCell::default(), blobs: RefCell::default() }
    }

    /// Keeps `objects`, made here, to be read before they are pushed.
    fn keep(&self, objects: &[(ObjectKind, Vec<u8>)]) {
        for (kind, bytes) in objects {
            match kind {
                ObjectKind::Tree => {
                    let entries = parse_tree(bytes)
                        .into_iter()
                        .map(|item| TreeEntry { kind: kind_of(&item.mode), name: item.name, hash: item.id })
                        .collect();
                    self.trees.borrow_mut().insert(object_id(ObjectKind::Tree, bytes), entries);
                }
                ObjectKind::Blob => {
                    self.blobs.borrow_mut().insert(object_id(ObjectKind::Blob, bytes), bytes.clone());
                }
                _ => {}
            }
        }
    }
}

impl<R: GitRepo> GitRepo for Reader<'_, R> {
    async fn access(&self, scope: Scope) -> Result<GitAccess> {
        self.first.access(scope).await
    }
    async fn branches(&self) -> Result<Vec<Branch>> {
        self.first.branches().await
    }
    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
        let found = self.first.log(git_ref, limit).await?;
        match self.second {
            Some(second) if found.is_empty() => second.log(git_ref, limit).await,
            _ => Ok(found),
        }
    }
    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
        match (self.first.parents(commit_hash).await?, self.second) {
            (None, Some(second)) => second.parents(commit_hash).await,
            (found, _) => Ok(found),
        }
    }
    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        let made = self.trees.borrow().get(tree_hash).cloned();
        if made.is_some() {
            return Ok(made);
        }
        match (self.first.read_tree(tree_hash).await?, self.second) {
            (None, Some(second)) => second.read_tree(tree_hash).await,
            (found, _) => Ok(found),
        }
    }
    async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
        let made = self.blobs.borrow().get(blob_hash).cloned();
        if made.is_some() {
            return Ok(made);
        }
        match (self.first.read_blob(blob_hash).await?, self.second) {
            (None, Some(second)) => second.read_blob(blob_hash).await,
            (found, _) => Ok(found),
        }
    }
    async fn read_file(&self, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>> {
        self.first.read_file(git_ref, path).await
    }
    async fn fork(&self, target_key: &str, default_branch_only: bool) -> Result<()> {
        self.first.fork(target_key, default_branch_only).await
    }
}

/// What becomes of one file a change touched, applied to another tree.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Resolution {
    /// The other tree has it as the change started from: put the change's
    /// version there (`None`: remove it).
    Take(Option<FileEntry>),
    /// The other tree already has it as the change made it.
    Keep,
    /// Both changed the text: merge the three, as `kind`.
    Content { kind: EntryKind, base: Option<String>, ours: String, theirs: String },
    /// Both changed it in ways that cannot be merged.
    Conflict,
}

fn text_kind(kind: EntryKind) -> bool {
    matches!(kind, EntryKind::Blob | EntryKind::Exec)
}

/// How a file the change took from `base` to `ours` comes out where it is
/// `theirs` (a directory's entry included, which a file cannot replace).
pub(crate) fn resolve(base: Option<&FileEntry>, ours: Option<&FileEntry>, theirs: Option<&FileEntry>) -> Resolution {
    if theirs == base {
        return Resolution::Take(ours.cloned());
    }
    if theirs == ours {
        return Resolution::Keep;
    }
    // Deleted on one side and changed on the other.
    let (Some(ours), Some(theirs)) = (ours, theirs) else {
        return Resolution::Conflict;
    };
    if ours.0 == EntryKind::Tree || theirs.0 == EntryKind::Tree {
        return Resolution::Conflict;
    }
    let base_kind = base.map(|(kind, _)| *kind);
    // A change of mode on one side is kept with the other's content.
    let kind = if ours.0 == theirs.0 {
        ours.0
    } else if base_kind == Some(ours.0) {
        theirs.0
    } else if base_kind == Some(theirs.0) {
        ours.0
    } else {
        return Resolution::Conflict;
    };
    if ours.1 == theirs.1 {
        return Resolution::Take(Some((kind, ours.1.clone())));
    }
    if !text_kind(ours.0) || !text_kind(theirs.0) || base_kind.is_some_and(|kind| !text_kind(kind)) {
        return Resolution::Conflict;
    }
    Resolution::Content { kind, base: base.map(|(_, hash)| hash.clone()), ours: ours.1.clone(), theirs: theirs.1.clone() }
}

/// A change applied to a tree.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Applied {
    /// The tree it makes.
    Tree(String),
    /// The files whose changes clash, by path.
    Conflict(Vec<String>),
    /// What g1t cannot apply itself.
    Unsupported(String),
}

/// The change from tree `from` (`None`: nothing) to tree `to`, applied to
/// tree `onto`. The objects it makes are added to `objects`, and kept in
/// `git` for what is applied after it.
pub(crate) async fn apply<R: GitRepo>(
    git: &Reader<'_, R>,
    from: Option<&str>,
    to: &str,
    onto: &str,
    objects: &mut Vec<(ObjectKind, Vec<u8>)>,
) -> Result<Applied> {
    if from == Some(onto) || to == onto {
        return Ok(Applied::Tree(to.to_owned()));
    }
    if from == Some(to) {
        return Ok(Applied::Tree(onto.to_owned()));
    }
    let (ours, cut) = changed_entries_up_to(git, from, to, MAX_LAND_FILES).await?;
    if cut {
        return Ok(Applied::Unsupported(format!("it changes more than {MAX_LAND_FILES} files")));
    }
    // Each changed path as `onto` has it.
    let dirs: BTreeSet<String> = ours.iter().flat_map(|(path, _, _)| ancestors(path).map(str::to_owned)).collect();
    let found = read_dirs(git, onto, &dirs).await?;
    let theirs_of = |path: &str| -> Option<FileEntry> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        let (_, entries) = found.get(parent)?;
        entries.iter().find(|entry| entry.name == name).map(|entry| (entry.kind, entry.hash.clone()))
    };
    let mut changes = Vec::new();
    let mut conflicts = Vec::new();
    let mut merges = Vec::new();
    for (path, base, mine) in ours {
        let theirs = theirs_of(&path);
        match resolve(base.as_ref(), mine.as_ref(), theirs.as_ref()) {
            Resolution::Take(entry) => changes.push(Change { path, entry }),
            Resolution::Keep => {}
            Resolution::Conflict => conflicts.push(path),
            Resolution::Content { kind, base, ours, theirs } => merges.push((path, kind, base, ours, theirs)),
        }
    }
    if merges.len() > MAX_LINE_MERGES {
        return Ok(Applied::Unsupported(format!("both sides changed more than {MAX_LINE_MERGES} of the same files")));
    }
    let read = try_join_all(merges.iter().map(|(_, _, base, ours, theirs)| async move {
        let base = async {
            match base {
                Some(hash) => git.read_blob(hash).await,
                None => Ok(Some(Vec::new())),
            }
        };
        let (base, (ours, theirs)) = try_join(base, try_join(git.read_blob(ours), git.read_blob(theirs))).await?;
        Ok::<_, worker::Error>((base, ours, theirs))
    }))
    .await?;
    let mut made: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    for ((path, kind, ..), (base, ours, theirs)) in merges.into_iter().zip(read) {
        let texts = (as_text(base), as_text(ours), as_text(theirs));
        let (Ok(base), Ok(ours), Ok(theirs)) = texts else {
            if matches!(texts, (Err(true), _, _) | (_, Err(true), _) | (_, _, Err(true))) {
                conflicts.push(path);
                continue;
            }
            return Ok(Applied::Unsupported(format!("{path} is too large to merge line by line")));
        };
        match merge_text(&base, &ours, &theirs) {
            Some(merged) => {
                let blob = merged.into_bytes();
                let id = object_id(ObjectKind::Blob, &blob);
                made.push((ObjectKind::Blob, blob));
                changes.push(Change { path, entry: Some((kind, id)) });
            }
            None => conflicts.push(path),
        }
    }
    if !conflicts.is_empty() {
        conflicts.sort();
        return Ok(Applied::Conflict(conflicts));
    }
    if changes.is_empty() {
        return Ok(Applied::Tree(onto.to_owned()));
    }
    let trees: HashMap<String, Vec<TreeEntry>> = found.into_values().collect();
    let merged = match merge_tree(onto, &trees, &changes) {
        Ok(merged) => merged,
        Err(why) => return Ok(Applied::Unsupported(why)),
    };
    made.extend(merged.objects.into_iter().map(|bytes| (ObjectKind::Tree, bytes)));
    git.keep(&made);
    objects.extend(made);
    Ok(Applied::Tree(merged.tree))
}

/// The commits of a branch the branch it merges into does not have,
/// oldest first and each after its parents: those reachable from the
/// newest of `history` (the branch's first-parent chain) and not from
/// `shared` (the other branch's). `None` when there are more than `limit`.
pub(crate) async fn branch_commits<R: GitRepo>(
    git: &R,
    history: &[Commit],
    shared: &HashSet<String>,
    limit: usize,
) -> Result<Option<Vec<Commit>>> {
    let mut known: HashMap<String, Commit> = history.iter().map(|commit| (commit.hash.clone(), commit.clone())).collect();
    let Some(head) = history.first() else {
        return Ok(Some(Vec::new()));
    };
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    // Depth first, a commit written once its parents are: the first
    // parent's line before the others.
    let mut stack = vec![(head.hash.clone(), false)];
    while let Some((hash, parents_done)) = stack.pop() {
        if parents_done {
            if let Some(commit) = known.get(&hash) {
                order.push(commit.clone());
            }
            continue;
        }
        if shared.contains(&hash) || !seen.insert(hash.clone()) {
            continue;
        }
        if seen.len() > limit {
            return Ok(None);
        }
        let commit = match known.get(&hash) {
            Some(commit) => commit.clone(),
            None => match git.log(&hash, 1).await?.into_iter().next() {
                Some(commit) => {
                    known.insert(hash.clone(), commit.clone());
                    commit
                }
                // Not there to read: where the branch's history ends.
                None => continue,
            },
        };
        stack.push((hash, true));
        for parent in commit.parents.iter().rev() {
            stack.push((parent.clone(), false));
        }
    }
    Ok(Some(order))
}

/// A branch's commits, made again.
#[derive(Debug)]
pub(crate) struct Replayed {
    /// The last commit made, or where they were made onto if none was.
    pub head: String,
    /// The commits made, oldest first, each with the one it was made from.
    pub made: Vec<(String, String)>,
    /// The messages and authors of what was made, for the rules.
    pub facts: Vec<g1t_contracts::rules::CommitFacts>,
}

/// How replaying went.
#[derive(Debug)]
pub(crate) enum Replay {
    Done(Replayed),
    /// A commit's changes clash with what is there: the commit, and the files.
    Conflict { commit: Commit, paths: Vec<String> },
    Unsupported { commit: Commit, why: String },
}

/// When a commit says it was authored, in seconds.
fn authored_seconds(commit: &Commit) -> u64 {
    parse_rfc3339(&commit.authored_at).unwrap_or(0) / 1000
}

/// Makes each of `commits` (oldest first) again on top of `onto` (a commit
/// and its tree): its changes applied to the commit before, its author,
/// date and message kept, committed by `committer` with `sign_off` added.
/// Merge commits are left out, their changes already in what they merged,
/// and so is a commit whose changes are all there already.
pub(crate) async fn replay<R: GitRepo>(
    git: &Reader<'_, R>,
    commits: &[Commit],
    onto: (&str, &str),
    committer: &Signature<'_>,
    sign_off: Option<&str>,
    objects: &mut Vec<(ObjectKind, Vec<u8>)>,
) -> Result<Replay> {
    let trees: HashMap<&str, &str> = commits.iter().map(|commit| (commit.hash.as_str(), commit.tree_hash.as_str())).collect();
    let (mut head, mut tree) = (onto.0.to_owned(), onto.1.to_owned());
    let mut made = Vec::new();
    let mut facts = Vec::new();
    for commit in commits.iter().filter(|commit| commit.parents.len() <= 1) {
        let from = match commit.parents.first() {
            None => None,
            Some(parent) => match trees.get(parent.as_str()) {
                Some(tree) => Some((*tree).to_owned()),
                None => match git.log(parent, 1).await?.into_iter().next() {
                    Some(parent) => Some(parent.tree_hash),
                    None => {
                        return Ok(Replay::Unsupported { commit: commit.clone(), why: format!("its parent {parent} could not be read") });
                    }
                },
            },
        };
        let applied = apply(git, from.as_deref(), &commit.tree_hash, &tree, objects).await?;
        let new_tree = match applied {
            Applied::Tree(new_tree) => new_tree,
            Applied::Conflict(paths) => return Ok(Replay::Conflict { commit: commit.clone(), paths }),
            Applied::Unsupported(why) => return Ok(Replay::Unsupported { commit: commit.clone(), why }),
        };
        if new_tree == tree {
            continue;
        }
        let author = Signature { name: &commit.author.name, email: &commit.author.email, seconds: authored_seconds(commit) };
        let message = with_trailers(&commit.message, sign_off.into_iter().map(str::to_owned).collect::<Vec<_>>().as_slice());
        let bytes = commit_object_by(&new_tree, &[&head], &author, committer, &message);
        let id = object_id(ObjectKind::Commit, &bytes);
        objects.push((ObjectKind::Commit, bytes));
        let mut fact = crate::rules::made_commit(&id, &message, committer.email, 1, Vec::new());
        fact.author_email = Some(commit.author.email.clone());
        facts.push(fact);
        made.push((id.clone(), commit.hash.clone()));
        head = id;
        tree = new_tree;
    }
    Ok(Replay::Done(Replayed { head, made, facts }))
}

/// A trailer's key and who or what it names, compared without case: the
/// address in `<...>` when there is one.
fn trailer_parts(line: &str) -> Option<(String, String)> {
    let (key, value) = line.trim().split_once(':')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || !value.starts_with(' ') {
        return None;
    }
    let value = value.trim();
    let named = match (value.rfind('<'), value.rfind('>')) {
        (Some(open), Some(close)) if open < close => &value[open + 1..close],
        _ => value,
    };
    Some((key.to_ascii_lowercase(), named.to_lowercase()))
}

/// `message` with `trailers` added at its end, each unless one with the
/// same key naming the same address is there already. They join the
/// message's own trailers when its last paragraph is made of them, and
/// otherwise start a paragraph of their own.
pub(crate) fn with_trailers(message: &str, trailers: &[String]) -> String {
    let message = message.trim_end();
    let mut present: Vec<(String, String)> = message.lines().filter_map(trailer_parts).collect();
    let mut adding: Vec<&str> = Vec::new();
    for trailer in trailers {
        match trailer_parts(trailer) {
            Some(parts) if present.contains(&parts) => {}
            Some(parts) => {
                present.push(parts);
                adding.push(trailer);
            }
            None => adding.push(trailer),
        }
    }
    if adding.is_empty() {
        return message.to_owned();
    }
    if message.is_empty() {
        return adding.join("\n");
    }
    let ends_in_trailers = message
        .rsplit_once("\n\n")
        .is_some_and(|(_, last)| !last.trim().is_empty() && last.lines().all(|line| trailer_parts(line).is_some()));
    let gap = if ends_in_trailers { "\n" } else { "\n\n" };
    format!("{message}{gap}{}", adding.join("\n"))
}

/// The `Signed-off-by:` trailer for someone.
pub(crate) fn sign_off_trailer(name: &str, email: &str) -> String {
    format!("Signed-off-by: {name} <{email}>")
}

/// A `Co-authored-by:` trailer for everyone who wrote one of `commits`
/// other than `author` (by address) and g1t itself, once each, in the
/// order they first appear. Merge commits change nothing of their own and
/// credit no one.
pub(crate) fn co_authors(commits: &[Commit], author: &str) -> Vec<String> {
    let mut seen: HashSet<String> = [author.to_lowercase(), g1t_contracts::system::EMAIL.to_owned()].into_iter().collect();
    commits
        .iter()
        .filter(|commit| commit.parents.len() <= 1 && !commit.author.email.trim().is_empty())
        .filter(|commit| seen.insert(commit.author.email.trim().to_lowercase()))
        .map(|commit| format!("Co-authored-by: {} <{}>", commit.author.name, commit.author.email.trim()))
        .collect()
}

/// `message` with its `Co-authored-by:` trailers made right, as a
/// template may have written them from addresses alone: none for the
/// commit's own author (`author_email`) or g1t, and one naming someone in
/// `known` (trailers g1t made from the commits) as that one names them.
pub(crate) fn tidy_co_authors(message: &str, author_email: &str, known: &[String]) -> String {
    let email_of = |line: &str| {
        line.rsplit_once('<')
            .and_then(|(_, rest)| rest.split_once('>'))
            .map(|(email, _)| email.trim().to_lowercase())
    };
    let author = author_email.trim().to_lowercase();
    message
        .lines()
        .filter_map(|line| {
            if !line.trim_start().to_lowercase().starts_with("co-authored-by:") {
                return Some(line.to_owned());
            }
            let Some(email) = email_of(line) else { return Some(line.to_owned()) };
            if email == author || email == g1t_contracts::system::EMAIL {
                return None;
            }
            Some(known.iter().find(|trailer| email_of(trailer).as_deref() == Some(email.as_str())).cloned().unwrap_or_else(|| line.to_owned()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Files named in a sentence: a few, then how many more.
pub(crate) fn name_files(paths: &[String]) -> String {
    const SHOWN: usize = 5;
    match paths {
        [] => "some files".to_owned(),
        [one] => one.clone(),
        _ if paths.len() <= SHOWN => {
            let (last, rest) = paths.split_last().expect("two or more");
            format!("{} and {last}", rest.join(", "))
        }
        _ => format!("{} and {} more files", paths[..SHOWN].join(", "), paths.len() - SHOWN),
    }
}

/// A commit's short hash.
fn short(hash: &str) -> &str {
    &hash[..hash.len().min(7)]
}

/// A commit as people know it: its short hash and title.
fn named_commit(commit: &Commit) -> String {
    let title = commit.message.lines().next().unwrap_or_default().trim();
    format!("{} ({title})", &commit.hash[..commit.hash.len().min(7)])
}

/// What was made to land, ready to push.
struct Made {
    commit: String,
    rebased: Vec<(String, String)>,
    /// How many commits it brings, when that is known.
    commits: Option<u32>,
}

/// Why a landing was refused, or that it was there already.
enum NotMade {
    Refused(Outcome<Landed>),
    /// Lines clash in these files.
    Clash { message: String, paths: Vec<String> },
    /// Nothing to make: the branch already has every change.
    AlreadyThere,
}

fn refused(code: FailureCode, message: String) -> NotMade {
    NotMade::Refused(Outcome::fail(code, message))
}

/// The pack that sends what was made: with what the pull request's commits
/// bring that the repository lacks, from the fork, when it does not hold
/// them (`held`).
async fn pack_for<R: GitRepo>(
    held: bool,
    source_git: &R,
    new: &str,
    merge_base: &str,
    objects: &[(ObjectKind, Vec<u8>)],
) -> Result<Vec<u8>> {
    if held {
        return Ok(write_pack(objects));
    }
    let source_access = source_git.access(Scope::Read).await?;
    let fetched = land::fetch_pack(&source_access, new, Some(merge_base)).await?;
    extend_pack(&fetched, objects).map_err(worker::Error::RustError)
}

/// What `method` (any but `fast_forward`) makes of a pull request's
/// commits (`history`, its first-parent chain, headed by `new`) on the
/// head of `target_history`, with the objects made added to `objects`;
/// and the merge base, which a pack from a fork starts at. `branch`
/// names where it lands in what is said about a refusal.
#[allow(clippy::too_many_arguments)]
async fn make_on<R: GitRepo>(
    method: MergeMethod,
    reader: &Reader<'_, R>,
    target_history: &[Commit],
    history: &[Commit],
    new: &str,
    message: &str,
    (author, by): (&Signature<'_>, &Signature<'_>),
    sign_off: Option<&str>,
    branch: &str,
    objects: &mut Vec<(ObjectKind, Vec<u8>)>,
) -> Result<std::result::Result<(Made, String), NotMade>> {
    let Some(base) = target_history.first() else {
        return Ok(Err(refused(FailureCode::Conflict, format!("{branch} has no commits yet."))));
    };
    let shared: HashSet<String> = target_history.iter().map(|commit| commit.hash.clone()).collect();
    let merge_base = nearest_ancestor_in(reader, history, &shared).await?;
    let Some((merge_base, merge_base_tree)) = merge_base.and_then(|hash| {
        target_history.iter().find(|commit| commit.hash == hash).map(|commit| (hash, commit.tree_hash.clone()))
    }) else {
        return Ok(Err(refused(
            FailureCode::Conflict,
            format!("g1t could not find where this pull request left {branch}, so it cannot make its commits there."),
        )));
    };
    let made = match method {
        MergeMethod::Merge | MergeMethod::Squash => {
            let squash = method == MergeMethod::Squash;
            let co_authored = if squash {
                let commits = match branch_commits(reader, history, &shared, MAX_ANCESTRY as usize).await? {
                    Some(commits) => commits,
                    // Too many to walk: those on the branch's own line.
                    None => {
                        let mut own: Vec<Commit> = history.iter().take_while(|commit| !shared.contains(&commit.hash)).cloned().collect();
                        own.reverse();
                        own
                    }
                };
                co_authors(&commits, author.email)
            } else {
                Vec::new()
            };
            let head = &history[0];
            made_merge(
                reader,
                (&merge_base_tree, &head.tree_hash, base),
                new,
                squash,
                message,
                &co_authored,
                sign_off,
                (author, by),
                branch,
                objects,
            )
            .await?
        }
        _ => {
            let commits = match branch_commits(reader, history, &shared, MAX_REBASE_COMMITS).await? {
                Some(commits) => commits,
                None => {
                    return Ok(Err(refused(
                        FailureCode::Conflict,
                        format!(
                            "This pull request has more than {MAX_REBASE_COMMITS} commits, too many for g1t to rebase itself. Squash or merge it instead."
                        ),
                    )));
                }
            };
            match replay(reader, &commits, (&base.hash, &base.tree_hash), by, sign_off, objects).await? {
                Replay::Done(replayed) if replayed.made.is_empty() => Err(NotMade::AlreadyThere),
                Replay::Done(replayed) => Ok(Made {
                    commit: replayed.head,
                    commits: Some(replayed.made.len() as u32),
                    rebased: replayed.made,
                }),
                Replay::Conflict { commit, paths } => Err(NotMade::Clash {
                    message: format!(
                        "Rebasing stopped at {}: it and {branch} changed the same lines of {}. Rebase the branch onto {branch} and resolve them, or merge it another way.",
                        named_commit(&commit),
                        name_files(&paths)
                    ),
                    paths,
                }),
                Replay::Unsupported { commit, why } => Err(refused(
                    FailureCode::Conflict,
                    format!("g1t cannot rebase {} itself: {why}. Rebase the branch onto {branch}, or merge it another way.", named_commit(&commit)),
                )),
            }
        }
    };
    Ok(made.map(|made| (made, merge_base)))
}

/// A merge commit (parents `base` and `new`) or a squashed commit
/// (parent `base`) whose tree is the pull request's changes since
/// `trees.0` (the merge base's tree; `trees.1` is its head's) applied
/// to `base`'s.
#[allow(clippy::too_many_arguments)]
async fn made_merge<R: GitRepo>(
    reader: &Reader<'_, R>,
    trees: (&str, &str, &Commit),
    new: &str,
    squash: bool,
    message: &str,
    co_authored: &[String],
    sign_off: Option<&str>,
    (author, committer): (&Signature<'_>, &Signature<'_>),
    branch: &str,
    objects: &mut Vec<(ObjectKind, Vec<u8>)>,
) -> Result<std::result::Result<Made, NotMade>> {
    let (merge_base_tree, head_tree, base) = trees;
    let verb = if squash { "squash" } else { "merge" };
    let tree = match apply(reader, Some(merge_base_tree), head_tree, &base.tree_hash, objects).await? {
        Applied::Tree(tree) => tree,
        Applied::Conflict(paths) => {
            return Ok(Err(NotMade::Clash {
                message: format!(
                    "This pull request and {branch} changed the same lines of {}. Bring the pull request up to date with {branch} and resolve them, then merge again.",
                    name_files(&paths)
                ),
                paths,
            }));
        }
        Applied::Unsupported(why) => {
            return Ok(Err(refused(
                FailureCode::Conflict,
                format!("g1t cannot {verb} this pull request itself: {why}. Bring it up to date with {branch}, or merge it another way."),
            )));
        }
    };
    // Squashing what is there already would make an empty commit.
    if squash && tree == base.tree_hash {
        return Ok(Err(NotMade::AlreadyThere));
    }
    let mut trailers: Vec<String> = co_authored.to_vec();
    trailers.extend(sign_off.map(str::to_owned));
    let by = if squash { &author.email } else { &committer.email };
    let message = with_trailers(&tidy_co_authors(message, by, co_authored), &trailers);
    let bytes = if squash {
        commit_object_by(&tree, &[&base.hash], author, committer, &message)
    } else {
        commit_object_by(&tree, &[&base.hash, new], committer, committer, &message)
    };
    let commit = object_id(ObjectKind::Commit, &bytes);
    objects.push((ObjectKind::Commit, bytes));
    Ok(Ok(Made { commit, rebased: Vec::new(), commits: squash.then_some(1) }))
}

/// What one merge queue entry made: the state with it in, and the merge
/// base a pack from its fork starts at; or why it cannot be built.
#[derive(Debug)]
pub(crate) enum StepMade {
    Made { commit: String, rebased: Vec<(String, String)>, merge_base: String },
    Conflict { message: String, paths: Vec<String> },
    Refused(String),
}

/// One merge queue entry (`history`, its first-parent chain from the
/// commit queued) landed by `method` on the head of `onto_history`, a
/// state of the queue: its commits made as landing would make them there,
/// with the objects made added to `objects`. A fast-forward makes none and
/// needs its head to contain that state; an entry whose changes are all
/// there already leaves the state as it is. `held`: the repository holds
/// the entry's commits (`git` reads a fork's otherwise).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn queue_step_on<R: GitRepo>(
    git: &Reader<'_, R>,
    held: bool,
    method: MergeMethod,
    (onto_history, history): (&[Commit], &[Commit]),
    message: Option<&str>,
    signatures: (&Signature<'_>, &Signature<'_>),
    sign_off: Option<&str>,
    place: &str,
    objects: &mut Vec<(ObjectKind, Vec<u8>)>,
) -> Result<StepMade> {
    let (Some(head), Some(base)) = (history.first(), onto_history.first()) else {
        return Ok(StepMade::Refused("Its commit or the state it is built on is no longer there.".to_owned()));
    };
    let there = |commit: &str| StepMade::Made { commit: commit.to_owned(), rebased: Vec::new(), merge_base: base.hash.clone() };
    if base.hash == head.hash || (held && descends_from(git, onto_history, &head.hash).await?) {
        return Ok(there(&base.hash));
    }
    if method == MergeMethod::FastForward {
        return Ok(if descends_from(git, history, &base.hash).await? {
            there(&head.hash)
        } else {
            StepMade::Refused(format!(
                "It lands by fast-forward, so its branch must contain {place} with everything queued ahead of it. Bring it up to date, or merge it another way."
            ))
        });
    }
    let message = match message.map(str::trim_end).filter(|text| !text.trim().is_empty()) {
        Some(text) => text.to_owned(),
        None if method == MergeMethod::Rebase => String::new(),
        None => return Ok(StepMade::Refused("Say what the commit's message is: its first line is its title.".to_owned())),
    };
    Ok(match make_on(method, git, onto_history, history, &head.hash, &message, signatures, sign_off, place, objects).await? {
        Ok((made, merge_base)) => StepMade::Made { commit: made.commit, rebased: made.rebased, merge_base },
        Err(NotMade::AlreadyThere) => there(&base.hash),
        Err(NotMade::Clash { message, paths }) => StepMade::Conflict { message, paths },
        Err(NotMade::Refused(Outcome::Fail(failure))) => StepMade::Refused(failure.message),
        Err(NotMade::Refused(Outcome::Ok(_))) => StepMade::Refused("It could not be built.".to_owned()),
    })
}

impl<S: GitStore> Repos<S> {
    /// `land` by `method`, any but `fast_forward`: makes the commits on
    /// `branch` of `target` from `new`, the checked head of the pull
    /// request's branch (`history`, its first-parent chain, in
    /// `source_git`), and moves `branch` to the last of them if it is still
    /// where it was. If another change lands first, it is worked out again
    /// once on the new head. The caller has checked who may do it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn land_by(
        &self,
        method: MergeMethod,
        a: &LandArgs,
        target: &Repo,
        source_git: &S::Repo,
        target_git: &S::Repo,
        branch: &str,
        history: &[Commit],
        new: String,
        from_fork: bool,
    ) -> Result<Outcome<Landed>> {
        let message = match method {
            MergeMethod::Merge | MergeMethod::Squash => match a.message.as_deref().map(str::trim_end).filter(|text| !text.trim().is_empty()) {
                Some(text) => text.to_owned(),
                None => {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Say what the commit's message is: its first line is its title."));
                }
            },
            _ => String::new(),
        };
        let committer = self.commit_identity(&a.actor).await;
        let author = match (&a.author, method) {
            (Some(author), MergeMethod::Squash) => self.commit_identity(author).await,
            _ => committer.clone(),
        };
        let sign_off = a.sign_off.then(|| sign_off_trailer(&committer.name, &committer.email));
        // Whether the repository holds the pull request's commits: always
        // for its own branch, and for a fork's once its head was kept there
        // (test_merge.rs). Otherwise they are read from the fork, and sent
        // with what is made.
        let held = !from_fork || !target_git.log(&new, 1).await?.is_empty();
        let reader = Reader::new(target_git, (!held).then_some(source_git));
        let mut attempt = 0;
        loop {
            attempt += 1;
            let target_history = target_git.log(branch, MAX_ANCESTRY).await?;
            let Some(base) = target_history.first().cloned() else {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("{branch} has no commits yet, so there is nothing to make this pull request's commits on. Land it by fast-forward instead."),
                ));
            };
            // There already: an attempt that published and stopped before
            // the merge was recorded, or a branch with nothing new.
            if base.hash == new || (held && descends_from(target_git, &target_history, &new).await?) {
                let commit = match method {
                    MergeMethod::Merge => target_history
                        .iter()
                        .find(|commit| commit.parents.get(1) == Some(&new))
                        .map_or_else(|| base.hash.clone(), |commit| commit.hash.clone()),
                    _ => base.hash.clone(),
                };
                return Ok(Outcome::Ok(Landed { commit, previous: None, method, rebased: Vec::new() }));
            }
            let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
            let seconds = now_ms() / 1000;
            let by = Signature { name: &committer.name, email: &committer.email, seconds };
            let author = Signature { name: &author.name, email: &author.email, seconds };
            let made =
                make_on(method, &reader, &target_history, history, &new, &message, (&author, &by), sign_off.as_deref(), branch, &mut objects)
                    .await?;
            let (made, merge_base) = match made {
                Ok(made) => made,
                Err(NotMade::Refused(outcome)) => return Ok(outcome),
                Err(NotMade::Clash { message, .. }) => return Ok(Outcome::fail(FailureCode::Conflict, message)),
                Err(NotMade::AlreadyThere) => {
                    return Ok(Outcome::Ok(Landed { commit: base.hash.clone(), previous: None, method, rebased: Vec::new() }));
                }
            };
            let pack = pack_for(held, source_git, &new, &merge_base, &objects).await?;
            let target_access = target_git.access(Scope::Write).await?;
            let pushed = match self
                .push_reserved(target, Operation::Merge, Some(&a.actor.id), &target_access, branch, Some(&base.hash), &made.commit, pack)
                .await?
            {
                Ok(pushed) => pushed,
                Err(refusal) => return Ok(refusal.outcome()),
            };
            self.refs_moved(&target.id).await;
            match pushed {
                Ok(()) => {
                    self.publish_landing(target, branch, Some(&base.hash), &made.commit, a, made.commits)
                        .await?;
                    return Ok(Outcome::Ok(Landed {
                        commit: made.commit,
                        previous: Some(base.hash.clone()),
                        method,
                        rebased: made.rebased,
                    }));
                }
                // Most often another pull request landed meanwhile: once
                // more, on top of it.
                Err(_) if attempt < 2 => continue,
                Err(reason) => {
                    return Ok(Outcome::fail(FailureCode::Conflict, format!("{branch} could not be updated: {reason}")));
                }
            }
        }
    }

    /// `build_queue_step`: one merge queue entry landed by its method on
    /// `onto`, a commit of the target, as `land_by` would land it on a
    /// branch whose head that is, and `push_branch` pointed at what was
    /// made. Nothing else moves. The work service decides who may merge;
    /// the committer must still be able to.
    pub(crate) async fn build_queue_step(&self, a: BuildQueueStepArgs) -> Result<Outcome<QueueStep>> {
        let actor = Some(a.actor.clone());
        let (Some(target), Some(source)) = (self.registry.by_id(&a.target_id).await?, self.registry.by_id(&a.source_id).await?) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such repository."));
        };
        if !crate::registry::can(&target, &actor, g1t_contracts::access::Capability::Merge) || !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Whoever queued it can no longer merge here."));
        }
        // A fork's change lands only on a repository in its network.
        if source.id != target.id && self.pull_target(&source, Some(&target.id)).await?.is_none_or(|found| found.id != target.id) {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such repository."));
        }
        let from_fork = source.id != target.id;
        self.live(&source).await?;
        let source_git = self.store.open(&store_key(&source)).await?;
        let target_git = self.store.open(&store_key(&target)).await?;
        let refused = |message: String| Ok(Outcome::Ok(QueueStep::Refused { message }));
        // What was queued is the commit: its branch may have moved since.
        let (history, onto_history) = try_join(source_git.log(&a.commit, MAX_ANCESTRY), target_git.log(&a.onto, MAX_ANCESTRY)).await?;
        let (Some(head), Some(base)) = (history.first(), onto_history.first()) else {
            return refused(format!("{} or the state it is built on is no longer there.", short(&a.commit)));
        };
        let new = head.hash.clone();
        let base = base.hash.clone();
        let held = !from_fork || !target_git.log(&new, 1).await?.is_empty();
        let reader = Reader::new(&target_git, (!held).then_some(&source_git));
        let place = target.default_branch.clone();
        let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
        let committer = self.commit_identity(&a.actor).await;
        let author = match (&a.author, a.method) {
            (Some(author), MergeMethod::Squash) => self.commit_identity(author).await,
            _ => committer.clone(),
        };
        let sign_off = a.sign_off.then(|| sign_off_trailer(&committer.name, &committer.email));
        let seconds = now_ms() / 1000;
        let by = Signature { name: &committer.name, email: &committer.email, seconds };
        let author = Signature { name: &author.name, email: &author.email, seconds };
        let step = queue_step_on(
            &reader,
            held,
            a.method,
            (&onto_history, &history),
            a.message.as_deref(),
            (&author, &by),
            sign_off.as_deref(),
            &place,
            &mut objects,
        )
        .await?;
        let (commit, rebased, merge_base) = match step {
            StepMade::Made { commit, rebased, merge_base } => (commit, rebased, merge_base),
            StepMade::Conflict { message, paths } => return Ok(Outcome::Ok(QueueStep::Conflict { message, paths })),
            StepMade::Refused(message) => return refused(message),
        };
        // Nothing new when it was there already.
        let pack = if commit == base {
            write_pack(&objects)
        } else {
            pack_for(held, &source_git, &new, &merge_base, &objects).await?
        };
        let old = target_git.log(&a.push_branch, 1).await?.into_iter().next().map(|commit| commit.hash);
        let target_access = target_git.access(Scope::Write).await?;
        let pushed = match self
            .push_reserved(&target, Operation::Queue, Some(&a.actor.id), &target_access, &a.push_branch, old.as_deref(), &commit, pack)
            .await?
        {
            Ok(pushed) => pushed,
            Err(refusal) => return Ok(refusal.outcome()),
        };
        self.refs_moved(&target.id).await;
        Ok(match pushed {
            Ok(()) => Outcome::Ok(QueueStep::Built { commit, rebased }),
            Err(reason) => Outcome::fail(FailureCode::Conflict, format!("{} could not be updated: {reason}", a.push_branch)),
        })
    }

    /// `update_pull_branch` by `rebase`: makes the commits of `branch` of
    /// `source` again on the head of `base_branch` of `target` and moves
    /// the branch there (a force push), if it is still at `expected_head`
    /// (else its head when read). The caller has checked who may do it.
    pub(crate) async fn rebase_up(
        &self,
        source: Repo,
        target: Repo,
        branch: String,
        base_branch: String,
        actor: &User,
        expected_head: Option<&str>,
    ) -> Result<Outcome<PullBranchUpdate>> {
        let from_fork = source.id != target.id;
        // A working copy removed after its pull request closed is made again.
        self.live(&source).await?;
        let source_git = self.store.open(&store_key(&source)).await?;
        let target_git = self.store.open(&store_key(&target)).await?;
        let (history, target_history) =
            try_join(source_git.log(&branch, MAX_ANCESTRY), target_git.log(&base_branch, MAX_ANCESTRY)).await?;
        let (Some(head), Some(base)) = (history.first(), target_history.first()) else {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{branch} has no commits to bring up to date.")));
        };
        if let Some(refused) = moved_since(&branch, &head.hash, expected_head) {
            return Ok(refused);
        }
        let needs_agent = |reason, detail: String, paths| Outcome::Ok(PullBranchUpdate::NeedsAgent { reason, detail, paths });
        let shared: HashSet<String> = target_history.iter().map(|commit| commit.hash.clone()).collect();
        let reader = Reader::new(&source_git, from_fork.then_some(&target_git));
        let Some(merge_base) = nearest_ancestor_in(&reader, &history, &shared).await? else {
            return Ok(needs_agent(
                NeedsAgentReason::Unsupported,
                format!("g1t could not find where this pull request left {base_branch}."),
                Vec::new(),
            ));
        };
        // On the base's head already, with no merge commits to straighten.
        let commits = match branch_commits(&reader, &history, &shared, MAX_REBASE_COMMITS).await? {
            Some(commits) => commits,
            None => {
                return Ok(needs_agent(
                    NeedsAgentReason::Unsupported,
                    format!("{branch} has more than {MAX_REBASE_COMMITS} commits, too many for g1t to rebase itself."),
                    Vec::new(),
                ));
            }
        };
        if merge_base == base.hash && commits.iter().all(|commit| commit.parents.len() <= 1) {
            return Ok(Outcome::Ok(PullBranchUpdate::UpToDate { commit: head.hash.clone() }));
        }
        let committer = self.commit_identity(actor).await;
        let by = Signature { name: &committer.name, email: &committer.email, seconds: now_ms() / 1000 };
        let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
        let replayed = match replay(&reader, &commits, (&base.hash, &base.tree_hash), &by, None, &mut objects).await? {
            Replay::Done(replayed) => replayed,
            Replay::Conflict { commit, paths } => {
                return Ok(needs_agent(
                    NeedsAgentReason::Conflicting,
                    format!("{} and {base_branch} changed the same lines of some files.", named_commit(&commit)),
                    paths,
                ));
            }
            Replay::Unsupported { commit, why } => {
                return Ok(needs_agent(
                    NeedsAgentReason::Unsupported,
                    format!("g1t could not rebase {} itself: {why}.", named_commit(&commit)),
                    Vec::new(),
                ));
            }
        };
        let update = BranchUpdate {
            branch: &branch,
            head: &head.hash,
            commit: &replayed.head,
            fast_forward: false,
            commits: replayed.made.len() as u32,
        };
        if let Some(refused) = self.update_refused(&source, actor, &update, replayed.facts.clone(), true).await? {
            return Ok(refused);
        }
        // A fork lacks what the base branch gained since it was made.
        let pack = if from_fork {
            let target_access = target_git.access(Scope::Read).await?;
            let fetched = land::fetch_pack(&target_access, &base.hash, Some(&merge_base)).await?;
            extend_pack(&fetched, &objects).map_err(worker::Error::RustError)?
        } else {
            write_pack(&objects)
        };
        self.push_update(&source, &source_git, actor, &update, pack).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::Signature as Person;

    fn blob(hash: &str) -> Option<FileEntry> {
        Some((EntryKind::Blob, hash.to_owned()))
    }

    #[test]
    fn a_file_the_other_side_left_alone_takes_the_change() {
        assert_eq!(resolve(blob("1").as_ref(), blob("2").as_ref(), blob("1").as_ref()), Resolution::Take(blob("2")));
        // Added, where nothing was.
        assert_eq!(resolve(None, blob("2").as_ref(), None), Resolution::Take(blob("2")));
        // Deleted.
        assert_eq!(resolve(blob("1").as_ref(), None, blob("1").as_ref()), Resolution::Take(None));
        // Made the same on both sides.
        assert_eq!(resolve(blob("1").as_ref(), blob("2").as_ref(), blob("2").as_ref()), Resolution::Keep);
    }

    #[test]
    fn a_file_both_changed_is_merged_or_conflicts() {
        assert_eq!(
            resolve(blob("1").as_ref(), blob("2").as_ref(), blob("3").as_ref()),
            Resolution::Content { kind: EntryKind::Blob, base: Some("1".into()), ours: "2".into(), theirs: "3".into() }
        );
        // Deleted on one side, changed on the other.
        assert_eq!(resolve(blob("1").as_ref(), None, blob("3").as_ref()), Resolution::Conflict);
        assert_eq!(resolve(blob("1").as_ref(), blob("2").as_ref(), None), Resolution::Conflict);
        // A file where the other side has a directory.
        assert_eq!(resolve(None, blob("2").as_ref(), Some(&(EntryKind::Tree, "t".into()))), Resolution::Conflict);
        // Submodules moved two ways.
        let link = |hash: &str| Some((EntryKind::Gitlink, hash.to_owned()));
        assert_eq!(resolve(link("1").as_ref(), link("2").as_ref(), link("3").as_ref()), Resolution::Conflict);
        // Made executable on one side, changed on the other.
        assert_eq!(
            resolve(blob("1").as_ref(), Some(&(EntryKind::Exec, "1".into())), blob("2").as_ref()),
            Resolution::Content { kind: EntryKind::Exec, base: Some("1".into()), ours: "1".into(), theirs: "2".into() }
        );
    }

    #[test]
    fn trailers_are_added_once_after_the_message() {
        let sign = sign_off_trailer("Ana", "ana@example.com");
        assert_eq!(with_trailers("Fix it\n", std::slice::from_ref(&sign)), "Fix it\n\nSigned-off-by: Ana <ana@example.com>");
        // Already signed off (case aside): not again.
        let signed = "Fix it\n\nsigned-off-by: Ana <ANA@example.com>\n";
        assert_eq!(with_trailers(signed, std::slice::from_ref(&sign)), signed.trim_end());
        // Joins trailers already ending the message.
        // A template's trailers, from addresses alone: the author's own and
        // g1t's go, and a known one takes its real name.
        let known = ["Co-authored-by: Bo Lin <bo@example.com>".to_owned()];
        let g1t = format!("Co-authored-by: g1t <{}>", g1t_contracts::system::EMAIL);
        let message = format!(
            "Fix\n\nCo-authored-by: ana <ANA@example.com>\nCo-authored-by: bo <bo@example.com>\n{g1t}\nCo-authored-by: cy <cy@example.com>"
        );
        assert_eq!(
            tidy_co_authors(&message, "ana@example.com", &known),
            "Fix\n\nCo-authored-by: Bo Lin <bo@example.com>\nCo-authored-by: cy <cy@example.com>"
        );
        let co = "Co-authored-by: Bo <bo@example.com>".to_owned();
        assert_eq!(
            with_trailers("Fix it\n\nBody.\n\nCo-authored-by: Cy <cy@example.com>", &[co.clone(), sign.clone()]),
            "Fix it\n\nBody.\n\nCo-authored-by: Cy <cy@example.com>\nCo-authored-by: Bo <bo@example.com>\nSigned-off-by: Ana <ana@example.com>"
        );
        // A body that only looks like it has a colon is not a trailer.
        assert_eq!(with_trailers("Fix it\n\nNote: see below\nmore text", std::slice::from_ref(&co)), "Fix it\n\nNote: see below\nmore text\n\nCo-authored-by: Bo <bo@example.com>");
        // Twice in one list: once.
        assert_eq!(with_trailers("Fix", &[co.clone(), co.clone()]), "Fix\n\nCo-authored-by: Bo <bo@example.com>");
        // Adding it to a message already holding it changes nothing.
        let once = with_trailers("Fix", std::slice::from_ref(&sign));
        assert_eq!(with_trailers(&once, std::slice::from_ref(&sign)), once);
    }

    fn commit(hash: &str, parents: &[&str], name: &str, email: &str) -> Commit {
        Commit {
            hash: hash.to_owned(),
            tree_hash: String::new(),
            message: format!("{hash}\n"),
            author: Person { name: name.to_owned(), email: email.to_owned() },
            parents: parents.iter().map(|&parent| parent.to_owned()).collect(),
            authored_at: String::new(),
        }
    }

    #[test]
    fn everyone_else_whose_commits_are_squashed_is_credited_once() {
        let commits = [
            commit("a", &["m"], "Ana", "ana@example.com"),
            commit("b", &["a"], "Bo", "bo@example.com"),
            commit("c", &["b"], "Bo again", "BO@example.com"),
            commit("d", &["c"], "g1t", g1t_contracts::system::EMAIL),
            // A merge commit brings nothing of its own.
            commit("e", &["d", "x"], "Cy", "cy@example.com"),
            commit("f", &["e"], "Di", "di@example.com"),
        ];
        assert_eq!(
            co_authors(&commits, "ANA@example.com"),
            ["Co-authored-by: Bo <bo@example.com>", "Co-authored-by: Di <di@example.com>"]
        );
    }

    #[test]
    fn files_are_named_a_few_at_a_time() {
        let paths = |n: usize| (1..=n).map(|i| format!("f{i}")).collect::<Vec<_>>();
        assert_eq!(name_files(&paths(1)), "f1");
        assert_eq!(name_files(&paths(3)), "f1, f2 and f3");
        assert_eq!(name_files(&paths(8)), "f1, f2, f3, f4, f5 and 3 more files");
    }

    /// A store of whole objects made in the test: commits by name, trees
    /// and blobs by their real ids.
    #[derive(Default)]
    struct Store {
        commits: HashMap<String, Commit>,
        trees: HashMap<String, Vec<TreeEntry>>,
        blobs: HashMap<String, Vec<u8>>,
    }

    impl Store {
        fn tree(&mut self, files: &[(&str, &str)]) -> String {
            let mut here: Vec<TreeEntry> = Vec::new();
            let mut dirs: std::collections::BTreeMap<&str, Vec<(&str, &str)>> = Default::default();
            for (path, text) in files {
                match path.split_once('/') {
                    Some((dir, rest)) => dirs.entry(dir).or_default().push((rest, text)),
                    None => {
                        let hash = object_id(ObjectKind::Blob, text.as_bytes());
                        self.blobs.insert(hash.clone(), text.as_bytes().to_vec());
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

        fn commit(&mut self, hash: &str, parents: &[&str], author: &str, files: &[(&str, &str)]) -> Commit {
            let tree_hash = self.tree(files);
            let made = Commit {
                hash: hash.to_owned(),
                tree_hash,
                message: format!("Change {hash}\n"),
                author: Person { name: author.to_owned(), email: format!("{author}@example.com") },
                parents: parents.iter().map(|&parent| parent.to_owned()).collect(),
                authored_at: "2026-10-01T00:00:00.000Z".to_owned(),
            };
            self.commits.insert(hash.to_owned(), made.clone());
            made
        }

        /// The files of a tree, read through `git`, by path.
        fn files(git: &Reader<'_, Store>, tree: &str) -> Vec<(String, String)> {
            let mut out = Vec::new();
            let mut todo = vec![(String::new(), tree.to_owned())];
            while let Some((prefix, tree)) = todo.pop() {
                for entry in block_on(git.read_tree(&tree)).unwrap().expect("tree") {
                    let path = format!("{prefix}{}", entry.name);
                    if entry.kind == EntryKind::Tree {
                        todo.push((format!("{path}/"), entry.hash));
                    } else {
                        let bytes = block_on(git.read_blob(&entry.hash)).unwrap().expect("blob");
                        out.push((path, String::from_utf8(bytes).unwrap()));
                    }
                }
            }
            out.sort();
            out
        }
    }

    impl GitRepo for Store {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
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

    fn files(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(path, text)| ((*path).to_owned(), (*text).to_owned())).collect()
    }

    /// `main` at m then b; the branch at m then h1, h2.
    fn diverged() -> (Store, [Commit; 4]) {
        let mut store = Store::default();
        let m = store.commit("m", &[], "ana", &[("README.md", "hi\n"), ("src/lib.rs", "a\nb\nc\nd\ne\n")]);
        let b = store.commit("b", &["m"], "ana", &[("README.md", "hello\n"), ("src/lib.rs", "a\nb\nc\nd\nE\n")]);
        let h1 = store.commit("h1", &["m"], "bo", &[("README.md", "hi\n"), ("src/lib.rs", "A\nb\nc\nd\ne\n")]);
        let h2 = store.commit(
            "h2",
            &["h1"],
            "cy",
            &[("README.md", "hi\n"), ("src/lib.rs", "A\nb\nc\nd\ne\n"), ("src/new.rs", "new\n")],
        );
        (store, [m, b, h1, h2])
    }

    #[test]
    fn a_change_applies_line_by_line_where_both_sides_touched_a_file() {
        let (store, [m, b, _, h2]) = diverged();
        let git = Reader::new(&store, None);
        let mut objects = Vec::new();
        let Applied::Tree(tree) = block_on(apply(&git, Some(&m.tree_hash), &h2.tree_hash, &b.tree_hash, &mut objects)).unwrap() else {
            panic!("not applied")
        };
        assert_eq!(
            Store::files(&git, &tree),
            files(&[("README.md", "hello\n"), ("src/lib.rs", "A\nb\nc\nd\nE\n"), ("src/new.rs", "new\n")])
        );
        // The merged blob, the root and src: only what changed.
        assert_eq!(objects.iter().filter(|(kind, _)| *kind == ObjectKind::Blob).count(), 1);
        assert_eq!(objects.iter().filter(|(kind, _)| *kind == ObjectKind::Tree).count(), 2);
    }

    #[test]
    fn clashing_lines_name_the_file_and_make_nothing() {
        let mut store = Store::default();
        let m = store.commit("m", &[], "ana", &[("a", "1\n"), ("b", "x\n")]);
        let h = store.commit("h", &["m"], "bo", &[("a", "2\n"), ("b", "y\n")]);
        let b = store.commit("b", &["m"], "ana", &[("a", "3\n"), ("b", "x\n")]);
        let git = Reader::new(&store, None);
        let mut objects = Vec::new();
        let applied = block_on(apply(&git, Some(&m.tree_hash), &h.tree_hash, &b.tree_hash, &mut objects)).unwrap();
        assert_eq!(applied, Applied::Conflict(vec!["a".into()]));
        assert!(objects.is_empty());
    }

    #[test]
    fn a_branch_s_commits_come_oldest_first_and_stop_at_the_base() {
        let (mut store, [m, b, h1, h2]) = diverged();
        // The branch merged main in, then went on.
        let j = store.commit("j", &["h2", "b"], "bo", &[("README.md", "hello\n")]);
        let k = store.commit("k", &["j"], "bo", &[("README.md", "hello\n")]);
        let history = block_on(store.log("k", 100)).unwrap();
        let shared: HashSet<String> = [m.hash.clone(), b.hash.clone()].into_iter().collect();
        let commits = block_on(branch_commits(&store, &history, &shared, 10)).unwrap().unwrap();
        let order: Vec<&str> = commits.iter().map(|commit| commit.hash.as_str()).collect();
        assert_eq!(order, [h1.hash.as_str(), h2.hash.as_str(), j.hash.as_str(), k.hash.as_str()]);
        // Too many: none.
        assert!(block_on(branch_commits(&store, &history, &shared, 3)).unwrap().is_none());
    }

    #[test]
    fn a_rebase_makes_each_commit_again_on_the_base_keeping_its_author() {
        let (store, [_, b, h1, h2]) = diverged();
        let git = Reader::new(&store, None);
        let committer = Signature { name: "Di", email: "di@example.com", seconds: 1_800_000_000 };
        let sign = sign_off_trailer("Di", "di@example.com");
        let mut objects = Vec::new();
        let commits = [h1.clone(), h2.clone()];
        let Replay::Done(replayed) = block_on(replay(&git, &commits, (&b.hash, &b.tree_hash), &committer, Some(&sign), &mut objects)).unwrap() else {
            panic!("not replayed")
        };
        assert_eq!(replayed.made.iter().map(|(_, original)| original.as_str()).collect::<Vec<_>>(), ["h1", "h2"]);
        let made: Vec<String> = objects
            .iter()
            .filter(|(kind, _)| *kind == ObjectKind::Commit)
            .map(|(_, bytes)| String::from_utf8(bytes.clone()).unwrap())
            .collect();
        assert_eq!(made.len(), 2);
        // The first on the base, the second on the first.
        assert!(made[0].contains(&format!("parent {}\n", b.hash)), "{}", made[0]);
        assert!(made[1].contains(&format!("parent {}\n", replayed.made[0].0)), "{}", made[1]);
        assert_eq!(replayed.head, replayed.made[1].0);
        // Their authors and dates kept, committed by whoever rebased.
        assert!(made[0].contains("author bo <bo@example.com> 1790812800 +0000\ncommitter Di <di@example.com> 1800000000 +0000\n"));
        assert!(made[1].ends_with("\n\nChange h2\n\nSigned-off-by: Di <di@example.com>\n"), "{}", made[1]);
        // The last holds both sides.
        let tree = made[1].lines().next().unwrap().strip_prefix("tree ").unwrap().to_owned();
        assert_eq!(
            Store::files(&git, &tree),
            files(&[("README.md", "hello\n"), ("src/lib.rs", "A\nb\nc\nd\nE\n"), ("src/new.rs", "new\n")])
        );
    }

    #[test]
    fn a_rebase_stops_at_the_commit_that_clashes() {
        let mut store = Store::default();
        store.commit("m", &[], "ana", &[("a", "1\n"), ("b", "x\n")]);
        let h1 = store.commit("h1", &["m"], "bo", &[("a", "1\n"), ("b", "y\n")]);
        let h2 = store.commit("h2", &["h1"], "bo", &[("a", "2\n"), ("b", "y\n")]);
        let b = store.commit("b", &["m"], "ana", &[("a", "3\n"), ("b", "x\n")]);
        let git = Reader::new(&store, None);
        let committer = Signature { name: "Di", email: "di@example.com", seconds: 1 };
        let mut objects = Vec::new();
        let replayed = block_on(replay(&git, &[h1, h2], (&b.hash, &b.tree_hash), &committer, None, &mut objects)).unwrap();
        let Replay::Conflict { commit, paths } = replayed else { panic!("no conflict") };
        assert_eq!(commit.hash, "h2");
        assert_eq!(paths, ["a"]);
        assert_eq!(named_commit(&commit), "h2 (Change h2)");
    }

    #[test]
    fn a_commit_whose_changes_are_there_already_is_left_out() {
        let mut store = Store::default();
        store.commit("m", &[], "ana", &[("a", "1\n")]);
        let h1 = store.commit("h1", &["m"], "bo", &[("a", "2\n")]);
        // The base made the same change.
        let b = store.commit("b", &["m"], "ana", &[("a", "2\n")]);
        let git = Reader::new(&store, None);
        let committer = Signature { name: "Di", email: "di@example.com", seconds: 1 };
        let mut objects = Vec::new();
        let Replay::Done(replayed) = block_on(replay(&git, &[h1], (&b.hash, &b.tree_hash), &committer, None, &mut objects)).unwrap() else {
            panic!("not replayed")
        };
        assert!(replayed.made.is_empty());
        assert_eq!(replayed.head, b.hash);
    }

    #[test]
    fn a_merge_commit_has_both_parents_and_a_squash_one() {
        let (store, [m, b, _, h2]) = diverged();
        let git = Reader::new(&store, None);
        let committer = Signature { name: "Di", email: "di@example.com", seconds: 5 };
        let author = Signature { name: "Bo", email: "bo@example.com", seconds: 5 };
        let mut objects = Vec::new();
        let Applied::Tree(tree) = block_on(apply(&git, Some(&m.tree_hash), &h2.tree_hash, &b.tree_hash, &mut objects)).unwrap() else {
            panic!("not applied")
        };
        let merge = String::from_utf8(commit_object_by(&tree, &[&b.hash, &h2.hash], &committer, &committer, "Merge it")).unwrap();
        assert!(merge.contains(&format!("parent {}\nparent {}\n", b.hash, h2.hash)));
        let squash = String::from_utf8(commit_object_by(&tree, &[&b.hash], &author, &committer, "Squash it")).unwrap();
        assert_eq!(squash.matches("parent ").count(), 1);
        assert!(squash.contains("author Bo <bo@example.com> 5 +0000\ncommitter Di <di@example.com> 5 +0000\n"));
    }

    #[test]
    fn reads_fall_back_to_the_second_repository_and_the_objects_made() {
        let mut fork = Store::default();
        let h = fork.commit("h", &[], "bo", &[("a", "fork\n")]);
        let repo = Store::default();
        let git = Reader::new(&repo, Some(&fork));
        assert!(block_on(git.read_tree(&h.tree_hash)).unwrap().is_some());
        assert_eq!(block_on(git.log("h", 1)).unwrap().len(), 1);
        let made = vec![(ObjectKind::Blob, b"made\n".to_vec())];
        git.keep(&made);
        assert_eq!(block_on(git.read_blob(&object_id(ObjectKind::Blob, b"made\n"))).unwrap().as_deref(), Some(&b"made\n"[..]));
    }

    /// A commit made in a test, as the store would list it.
    fn made_commit(objects: &[(ObjectKind, Vec<u8>)], id: &str) -> Commit {
        let bytes = objects
            .iter()
            .find(|(kind, bytes)| *kind == ObjectKind::Commit && object_id(ObjectKind::Commit, bytes) == id)
            .map(|(_, bytes)| String::from_utf8(bytes.clone()).unwrap())
            .expect("made");
        let field = |name: &str| bytes.lines().filter_map(|line| line.strip_prefix(name)).map(str::to_owned).collect::<Vec<_>>();
        Commit {
            hash: id.to_owned(),
            tree_hash: field("tree ").remove(0),
            message: bytes.split_once("\n\n").map(|(_, message)| message.to_owned()).unwrap_or_default(),
            author: Person { name: "Di".to_owned(), email: "di@example.com".to_owned() },
            parents: field("parent "),
            authored_at: "2026-10-01T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn each_queue_entry_lands_by_its_own_method_on_the_state_ahead_of_it() {
        let (mut store, [m, b, h1, h2]) = diverged();
        // A second change, from the same start, to another file.
        let g = store.commit("g", &["m"], "eve", &[("README.md", "hi\n"), ("src/lib.rs", "a\nb\nc\nd\ne\n"), ("docs.md", "docs\n")]);
        let k = store.commit("k", &["m"], "eve", &[("README.md", "hi\n"), ("src/lib.rs", "a\nb\nc\nd\ne\n"), ("k.md", "k\n")]);
        let git = Reader::new(&store, None);
        let by = Signature { name: "Di", email: "di@example.com", seconds: 7 };
        let author = Signature { name: "bo", email: "bo@example.com", seconds: 7 };
        let mut objects = Vec::new();
        let step = |method, onto: &[Commit], history: &[Commit], objects: &mut Vec<_>| {
            block_on(queue_step_on(&git, true, method, (onto, history), Some("Land it"), (&author, &by), None, "main", objects)).unwrap()
        };
        let onto = vec![b.clone(), m.clone()];

        // The first squashes onto the default branch: one commit, one parent.
        let StepMade::Made { commit: first, .. } = step(MergeMethod::Squash, &onto, &[h2.clone(), h1.clone(), m.clone()], &mut objects) else {
            panic!("not squashed")
        };
        let first = made_commit(&objects, &first);
        assert_eq!(first.parents, ["b"]);

        // The second is a merge commit on the first's state, so landing it
        // is a fast-forward from there.
        let onto = vec![first.clone(), b.clone(), m.clone()];
        let StepMade::Made { commit: second, .. } = step(MergeMethod::Merge, &onto, &[g.clone(), m.clone()], &mut objects) else {
            panic!("not merged")
        };
        let second = made_commit(&objects, &second);
        assert_eq!(second.parents, [first.hash.clone(), "g".to_owned()]);
        assert_eq!(
            Store::files(&git, &second.tree_hash),
            files(&[("README.md", "hello\n"), ("docs.md", "docs\n"), ("src/lib.rs", "A\nb\nc\nd\nE\n"), ("src/new.rs", "new\n")])
        );

        // Queued again, its changes are there already: the state is kept.
        let onto = vec![second.clone(), first.clone(), b.clone(), m.clone()];
        let StepMade::Made { commit, .. } = step(MergeMethod::Rebase, &onto, &[h2.clone(), h1.clone(), m.clone()], &mut objects) else {
            panic!("not kept")
        };
        assert_eq!(commit, second.hash);

        // A fast-forward needs its head to hold the state ahead of it.
        let StepMade::Refused(why) = step(MergeMethod::FastForward, &onto, &[k, m.clone()], &mut objects) else {
            panic!("fast-forwarded")
        };
        assert!(why.contains("fast-forward"), "{why}");
    }

    #[test]
    fn a_fast_forward_entry_is_its_own_head_and_a_clash_names_the_files() {
        let (mut store, [m, b, h1, h2]) = diverged();
        let ahead = store.commit("f", &["b"], "eve", &[("README.md", "hello\n"), ("src/lib.rs", "a\nb\nc\nd\nE\n"), ("f.md", "f\n")]);
        let clash = store.commit("x", &["m"], "eve", &[("README.md", "hey\n"), ("src/lib.rs", "a\nb\nc\nd\ne\n")]);
        let git = Reader::new(&store, None);
        let by = Signature { name: "Di", email: "di@example.com", seconds: 7 };
        let mut objects = Vec::new();
        let onto = vec![b.clone(), m.clone()];
        let made = block_on(queue_step_on(&git, true, MergeMethod::FastForward, (&onto, &[ahead.clone(), b.clone(), m.clone()]), None, (&by, &by), None, "main", &mut objects)).unwrap();
        assert!(matches!(made, StepMade::Made { ref commit, .. } if commit == "f"), "{made:?}");
        assert!(objects.is_empty());
        let clashed = block_on(queue_step_on(&git, true, MergeMethod::Rebase, (&onto, &[clash, m.clone()]), None, (&by, &by), None, "main", &mut objects)).unwrap();
        assert!(matches!(clashed, StepMade::Conflict { ref paths, .. } if paths == &["README.md".to_owned()]), "{clashed:?}");
        let _ = (h1, h2);
    }
}
