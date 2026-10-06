//! Bringing a pull request up to date with the branch it would merge into,
//! without a sandbox, when that is safe.
//!
//! When the pull request and the default branch changed different files
//! since they last agreed, the merge cannot conflict, and its result is
//! known without merging any file: the default branch's tree, with the
//! files the pull request changed taken from the pull request. Only the
//! trees on the way to those files change. They are rebuilt here, with one
//! merge commit on top whose parents are the pull request's head and the
//! default branch's head, written as a pack of whole objects and pushed to
//! the pull request's branch, if it is still where it was.
//!
//! When both sides changed a file, the merge needs git itself (and maybe an
//! agent), so the answer is that a sandbox is needed, and nothing is pushed.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use futures_util::future::{try_join, try_join_all};
use g1t_contracts::audit::{AuditActor, NewAuditEntry, Surface};
use g1t_contracts::credentials::Decision;
use g1t_contracts::repos::{
    EntryKind, NeedsAgentReason, PullBranchUpdate, RepoPath, TreeEntry, UpdatePullBranchArgs,
};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_scan::pack::{ObjectKind, TreeItem, encode_tree, extend_pack, object_id, write_pack};
use worker::Result;

use crate::registry::{can_read, can_write, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::{MAX_ANCESTRY, Repos, UNVERIFIED, descends_from, diff, land, nearest_ancestor_in, not_found};

/// The mode git writes for an entry of each kind.
fn mode(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Tree => "40000",
        EntryKind::Blob => "100644",
        EntryKind::Exec => "100755",
        EntryKind::Symlink => "120000",
        EntryKind::Gitlink => "160000",
    }
}

/// Git orders a tree's entries by name, comparing a subtree's name as if
/// it ended in `/`.
fn sort_key(entry: &TreeEntry) -> Vec<u8> {
    let mut key = entry.name.as_bytes().to_vec();
    if entry.kind == EntryKind::Tree {
        key.push(b'/');
    }
    key
}

/// A tree object's bytes, its entries in git's order.
pub(crate) fn encode_entries(entries: &[TreeEntry]) -> Vec<u8> {
    let mut sorted: Vec<&TreeEntry> = entries.iter().collect();
    sorted.sort_by_key(|entry| sort_key(entry));
    let items: Vec<TreeItem> = sorted
        .into_iter()
        .map(|entry| TreeItem {
            mode: mode(entry.kind).to_owned(),
            name: entry.name.clone(),
            id: entry.hash.clone(),
        })
        .collect();
    encode_tree(&items)
}

/// The directories above a path, nearest the root first: `a/b/c` is in
/// `a` and `a/b`.
fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(at, _)| &path[..at])
}

/// The paths at which the two sides' changes meet, so that the merge is not
/// a matter of taking each side's files: a file both changed, or a file on
/// one side where the other has a directory (a file `a` against `a/b`).
pub(crate) fn overlapping(ours: &[String], theirs: &[String]) -> Vec<String> {
    let their_files: HashSet<&str> = theirs.iter().map(String::as_str).collect();
    let their_dirs: HashSet<&str> = theirs.iter().flat_map(|path| ancestors(path)).collect();
    let mut met: BTreeSet<String> = BTreeSet::new();
    for path in ours {
        if their_files.contains(path.as_str()) || their_dirs.contains(path.as_str()) {
            met.insert(path.clone());
        }
        for dir in ancestors(path) {
            if their_files.contains(dir) {
                met.insert(dir.to_owned());
            }
        }
    }
    met.into_iter().collect()
}

/// One file the pull request changed, as it is on the pull request: its
/// kind and blob, or `None` when it deleted it.
#[derive(Clone, Debug)]
pub(crate) struct Change {
    pub path: String,
    pub entry: Option<(EntryKind, String)>,
}

/// The merged tree's id, and the tree objects written for it.
#[derive(Debug)]
pub(crate) struct Merged {
    pub tree: String,
    pub objects: Vec<Vec<u8>>,
}

enum Node {
    Leaf(EntryKind, String),
    /// A subtree left as it is.
    Subtree(String),
    /// A subtree being changed.
    Dir(Dir),
}

#[derive(Default)]
struct Dir {
    entries: BTreeMap<String, Node>,
}

/// A tree, ready to change. Its entries are checked to write back to
/// exactly its id: a tree holding something this cannot write, such as an
/// unusual file mode, is refused rather than changed.
fn load(id: &str, trees: &HashMap<String, Vec<TreeEntry>>) -> std::result::Result<Dir, String> {
    let entries = trees
        .get(id)
        .ok_or_else(|| format!("tree {id} was not read"))?;
    if object_id(ObjectKind::Tree, &encode_entries(entries)) != id {
        return Err(format!("tree {id} holds entries g1t cannot write back exactly"));
    }
    Ok(Dir {
        entries: entries
            .iter()
            .map(|entry| {
                let node = match entry.kind {
                    EntryKind::Tree => Node::Subtree(entry.hash.clone()),
                    kind => Node::Leaf(kind, entry.hash.clone()),
                };
                (entry.name.clone(), node)
            })
            .collect(),
    })
}

/// The directory at `node`, read if it was not yet.
fn open<'a>(
    node: &'a mut Node,
    trees: &HashMap<String, Vec<TreeEntry>>,
) -> std::result::Result<&'a mut Dir, String> {
    if let Node::Subtree(id) = node {
        *node = Node::Dir(load(id, trees)?);
    }
    match node {
        Node::Dir(dir) => Ok(dir),
        _ => Err("a file is where a directory was expected".to_owned()),
    }
}

/// Removes the file at `parts`, and any directory that leaves empty.
fn remove(
    dir: &mut Dir,
    parts: &[&str],
    trees: &HashMap<String, Vec<TreeEntry>>,
) -> std::result::Result<(), String> {
    let (name, rest) = parts.split_first().ok_or("an empty path")?;
    if rest.is_empty() {
        return match dir.entries.get(*name) {
            Some(Node::Leaf(..)) => {
                dir.entries.remove(*name);
                Ok(())
            }
            Some(_) => Err(format!("{name} is a directory, not a file")),
            None => Err(format!("{name} is not there to remove")),
        };
    }
    let child = dir
        .entries
        .get_mut(*name)
        .ok_or_else(|| format!("{name} is not there"))?;
    let inner = open(child, trees)?;
    remove(inner, rest, trees)?;
    if inner.entries.is_empty() {
        dir.entries.remove(*name);
    }
    Ok(())
}

/// Puts a file at `parts`, making the directories it needs.
fn insert(
    dir: &mut Dir,
    parts: &[&str],
    kind: EntryKind,
    hash: &str,
    trees: &HashMap<String, Vec<TreeEntry>>,
) -> std::result::Result<(), String> {
    let (name, rest) = parts.split_first().ok_or("an empty path")?;
    if rest.is_empty() {
        if matches!(dir.entries.get(*name), Some(Node::Subtree(_) | Node::Dir(_))) {
            return Err(format!("{name} is a directory, not a file"));
        }
        dir.entries.insert((*name).to_owned(), Node::Leaf(kind, hash.to_owned()));
        return Ok(());
    }
    let child = dir
        .entries
        .entry((*name).to_owned())
        .or_insert_with(|| Node::Dir(Dir::default()));
    insert(open(child, trees)?, rest, kind, hash, trees)
}

/// Writes a changed directory and those in it; returns its id.
fn write(dir: Dir, objects: &mut Vec<Vec<u8>>) -> String {
    let mut entries = Vec::with_capacity(dir.entries.len());
    for (name, node) in dir.entries {
        let (kind, hash) = match node {
            Node::Leaf(kind, hash) => (kind, hash),
            Node::Subtree(hash) => (EntryKind::Tree, hash),
            // Git keeps no empty directories.
            Node::Dir(inner) if inner.entries.is_empty() => continue,
            Node::Dir(inner) => (EntryKind::Tree, write(inner, objects)),
        };
        entries.push(TreeEntry { name, hash, kind });
    }
    let bytes = encode_entries(&entries);
    let id = object_id(ObjectKind::Tree, &bytes);
    objects.push(bytes);
    id
}

/// The tree of `base_root` with `changes` applied: deletions first, so a
/// file can take the place of a directory the pull request emptied.
/// `trees` holds every tree of the base on the way to a changed path.
pub(crate) fn merge_tree(
    base_root: &str,
    trees: &HashMap<String, Vec<TreeEntry>>,
    changes: &[Change],
) -> std::result::Result<Merged, String> {
    let mut root = load(base_root, trees)?;
    for change in changes.iter().filter(|change| change.entry.is_none()) {
        let parts: Vec<&str> = change.path.split('/').collect();
        remove(&mut root, &parts, trees).map_err(|why| format!("{}: {why}", change.path))?;
    }
    for change in changes {
        if let Some((kind, hash)) = &change.entry {
            let parts: Vec<&str> = change.path.split('/').collect();
            insert(&mut root, &parts, *kind, hash, trees)
                .map_err(|why| format!("{}: {why}", change.path))?;
        }
    }
    let mut objects = Vec::new();
    let tree = write(root, &mut objects);
    // A subtree that came out as it was is already stored.
    let mut seen = HashSet::new();
    objects.retain(|bytes| seen.insert(object_id(ObjectKind::Tree, bytes)));
    Ok(Merged { tree, objects })
}

/// Who a commit is by, and when.
pub(crate) struct Signature<'a> {
    pub name: &'a str,
    pub email: &'a str,
    /// Seconds since the epoch, in UTC.
    pub seconds: u64,
}

/// A commit object's bytes, authored and committed by `by`.
pub(crate) fn commit_object(tree: &str, parents: &[&str], by: &Signature, message: &str) -> Vec<u8> {
    let mut out = format!("tree {tree}\n");
    for parent in parents {
        out.push_str(&format!("parent {parent}\n"));
    }
    // Git takes everything up to `<` as the name.
    let name: String = by.name.chars().filter(|c| !matches!(c, '<' | '>' | '\n')).collect();
    let email: String = by.email.chars().filter(|c| !matches!(c, '<' | '>' | '\n')).collect();
    let line = format!("{name} <{email}> {} +0000", by.seconds);
    out.push_str(&format!("author {line}\ncommitter {line}\n\n{message}\n"));
    out.into_bytes()
}

/// What the merge commit says.
pub(crate) fn merge_message(base: &str, branch: &str, number: u32) -> String {
    if branch == base {
        // A fork carries its change on a branch named like the default.
        format!("Merge {base} into pull request #{number}")
    } else {
        format!("Merge {base} into {branch}")
    }
}

/// The trees at `dirs` (and the root, `""`) under `root`, by path: each
/// one's id and entries. A directory that is not there is left out. Each
/// level is read at once.
async fn read_dirs<R: GitRepo>(
    repo: &R,
    root: &str,
    dirs: &BTreeSet<String>,
) -> Result<HashMap<String, (String, Vec<TreeEntry>)>> {
    let mut found: HashMap<String, (String, Vec<TreeEntry>)> = HashMap::new();
    if let Some(entries) = repo.read_tree(root).await? {
        found.insert(String::new(), (root.to_owned(), entries));
    }
    let depth = |path: &str| path.matches('/').count();
    let deepest = dirs.iter().map(|dir| depth(dir)).max().unwrap_or(0);
    for level in 0..=deepest {
        let wanted: Vec<(String, String)> = dirs
            .iter()
            .filter(|dir| !dir.is_empty() && depth(dir) == level)
            .filter_map(|dir| {
                let (parent, name) = dir.rsplit_once('/').unwrap_or(("", dir.as_str()));
                let (_, entries) = found.get(parent)?;
                entries
                    .iter()
                    .find(|entry| entry.name == name && entry.kind == EntryKind::Tree)
                    .map(|entry| (dir.clone(), entry.hash.clone()))
            })
            .collect();
        let read = try_join_all(wanted.iter().map(|(_, id)| repo.read_tree(id))).await?;
        for ((dir, id), entries) in wanted.into_iter().zip(read) {
            if let Some(entries) = entries {
                found.insert(dir, (id, entries));
            }
        }
    }
    Ok(found)
}

fn needs_agent(reason: NeedsAgentReason, detail: impl Into<String>, paths: Vec<String>) -> Outcome<PullBranchUpdate> {
    Outcome::Ok(PullBranchUpdate::NeedsAgent {
        reason,
        detail: detail.into(),
        paths,
    })
}

impl<S: GitStore> Repos<S> {
    pub(crate) async fn update_pull_branch(&self, a: UpdatePullBranchArgs) -> Result<Outcome<PullBranchUpdate>> {
        let actor = Some(a.actor.clone());
        let Some(source) = self.registry.by_id(&a.source_id).await? else {
            return Ok(not_found());
        };
        let target = match &source.fork_of {
            Some(id) => self.registry.by_id(id).await?,
            None => Some(source.clone()),
        };
        let Some(target) = target.filter(|repo| can_read(repo, &actor)) else {
            return Ok(not_found());
        };
        // The merge is pushed as the person asking, so they must be able to push.
        if !can_write(&source, &actor) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                if source.fork_of.is_some() {
                    "Only whoever opened this pull request can update it.".to_owned()
                } else {
                    g1t_contracts::access::needs(
                        g1t_contracts::access::Capability::Push,
                        &format!("{}/{}", source.namespace, source.name),
                    )
                },
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        if let Some((code, message)) = crate::lifecycle::archived_refusal(&target) {
            return Ok(Outcome::fail(code, message));
        }
        let from_fork = source.id != target.id;
        let base_branch = target.default_branch.clone();
        let branch = a.branch.clone().unwrap_or_else(|| base_branch.clone());
        if !from_fork && branch == base_branch {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("{base_branch} cannot be merged into itself."),
            ));
        }

        let source_git = self.store.open(&store_key(&source)).await?;
        let target_git = self.store.open(&store_key(&target)).await?;
        let (history, target_history) = try_join(
            source_git.log(&branch, MAX_ANCESTRY),
            target_git.log(&base_branch, MAX_ANCESTRY),
        )
        .await?;
        let (Some(head), Some(base)) = (history.first(), target_history.first()) else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request has no commits to bring up to date.",
            ));
        };
        if descends_from(&source_git, &history, &base.hash).await? {
            return Ok(Outcome::Ok(PullBranchUpdate::UpToDate {
                commit: head.hash.clone(),
            }));
        }
        let shared: HashSet<String> = target_history.iter().map(|commit| commit.hash.clone()).collect();
        let merge_base = nearest_ancestor_in(&source_git, &history, &shared).await?;
        let Some((merge_base, merge_base_tree)) = merge_base.and_then(|hash| {
            target_history
                .iter()
                .find(|commit| commit.hash == hash)
                .map(|commit| (hash, commit.tree_hash.clone()))
        }) else {
            return Ok(needs_agent(
                NeedsAgentReason::Unsupported,
                format!("g1t could not find where this pull request left {base_branch}."),
                Vec::new(),
            ));
        };

        let ((ours, ours_cut), (theirs, theirs_cut)) = try_join(
            diff::changed_paths(&source_git, Some(&merge_base_tree), &head.tree_hash),
            diff::changed_paths(&target_git, Some(&merge_base_tree), &base.tree_hash),
        )
        .await?;
        if ours_cut || theirs_cut {
            return Ok(needs_agent(
                NeedsAgentReason::Unsupported,
                "The change is too large to merge without a sandbox.",
                Vec::new(),
            ));
        }
        let met = overlapping(&ours, &theirs);
        if !met.is_empty() {
            return Ok(needs_agent(
                NeedsAgentReason::Overlap,
                format!("This pull request and {base_branch} both changed some of the same files."),
                met,
            ));
        }

        // The trees on the way to each changed file, on both sides.
        let dirs: BTreeSet<String> = ours
            .iter()
            .flat_map(|path| ancestors(path).map(str::to_owned))
            .collect();
        let (on_pull, on_base) = try_join(
            read_dirs(&source_git, &head.tree_hash, &dirs),
            read_dirs(&target_git, &base.tree_hash, &dirs),
        )
        .await?;
        let changes: Vec<Change> = ours
            .iter()
            .map(|path| {
                let (parent, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
                let entry = on_pull.get(parent).and_then(|(_, entries)| {
                    entries
                        .iter()
                        .find(|entry| entry.name == name && entry.kind != EntryKind::Tree)
                        .map(|entry| (entry.kind, entry.hash.clone()))
                });
                Change {
                    path: path.clone(),
                    entry,
                }
            })
            .collect();
        let trees: HashMap<String, Vec<TreeEntry>> = on_base.into_values().collect();
        let merged = match merge_tree(&base.tree_hash, &trees, &changes) {
            Ok(merged) => merged,
            Err(why) => {
                return Ok(needs_agent(
                    NeedsAgentReason::Unsupported,
                    format!("g1t could not merge this itself: {why}."),
                    Vec::new(),
                ));
            }
        };

        // The person's commit name and address: their noreply address
        // unless they chose to show their own. An agent's commit is its
        // person's. Without identity, the noreply address all the same.
        let person = a
            .actor
            .acting
            .as_ref()
            .map_or((a.actor.id.clone(), a.actor.username.clone()), |acting| {
                (acting.on_behalf_of.id.clone(), acting.on_behalf_of.username.clone())
            });
        let author = match &self.identity {
            Some(identity) => g1t_kit::call::<_, Option<g1t_contracts::accounts::CommitIdentity>>(
                identity,
                "commit_identity",
                &g1t_contracts::accounts::CommitIdentityArgs { user_id: person.0.clone() },
            )
            .await
            .ok()
            .flatten(),
            None => None,
        }
        .unwrap_or_else(|| g1t_contracts::accounts::CommitIdentity {
            name: person.1.clone(),
            email: g1t_contracts::accounts::noreply_address(&person.0, &person.1),
        });
        let commit = commit_object(
            &merged.tree,
            &[&head.hash, &base.hash],
            &Signature {
                name: &author.name,
                email: &author.email,
                seconds: now_ms() / 1000,
            },
            &merge_message(&base_branch, &branch, a.number),
        );
        let commit_id = object_id(ObjectKind::Commit, &commit);
        let mut objects: Vec<(ObjectKind, Vec<u8>)> = merged
            .objects
            .into_iter()
            .map(|bytes| (ObjectKind::Tree, bytes))
            .collect();
        objects.push((ObjectKind::Commit, commit));

        // A fork lacks what the default branch gained since it was made:
        // those objects come from the repository, with the merge after them.
        let pack = if from_fork {
            let target_access = target_git.access(Scope::Read).await?;
            let fetched = land::fetch_pack(&target_access, &base.hash, Some(&merge_base)).await?;
            extend_pack(&fetched, &objects).map_err(worker::Error::RustError)?
        } else {
            write_pack(&objects)
        };
        let source_access = source_git.access(Scope::Write).await?;
        // Only if the branch is still where it was: a push that landed
        // meanwhile is kept, and this is refused.
        let pushed = land::push_pack(&source_access, &branch, Some(&head.hash), &commit_id, pack).await?;
        self.refs_moved(&source.id).await;
        let git_ref = format!("refs/heads/{branch}");
        let path = RepoPath {
            namespace: source.namespace.clone(),
            name: source.name.clone(),
        };
        let mut target_entry = self.audit_target(&path).await?;
        target_entry.git_ref = Some(git_ref.clone());
        let mut entry = NewAuditEntry::new(
            AuditActor::of(&a.actor),
            "git.push",
            Surface::Git,
            target_entry,
            &Decision::allow("person"),
            g1t_contracts::new_id("req", now_ms()),
        );
        if let Err(reason) = pushed {
            entry.result = Some("conflict".to_owned());
            entry.message = Some(reason);
            self.record_git(entry).await;
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{branch} moved while it was being brought up to date. Nothing was lost; try again."),
            ));
        }
        entry.result = Some("ok".to_owned());
        self.record_git(entry).await;
        // As any push does: the pull request's head moves, its checks run
        // again, and whether it merges cleanly is worked out anew.
        self.publish_push(&source, &git_ref, Some(&head.hash), &commit_id, Some(a.actor.id.clone()))
            .await?;
        Ok(Outcome::Ok(PullBranchUpdate::Updated {
            commit: commit_id,
            previous: head.hash.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: EntryKind, hash: &str) -> TreeEntry {
        TreeEntry {
            name: name.to_owned(),
            hash: hash.to_owned(),
            kind,
        }
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| (*path).to_owned()).collect()
    }

    #[test]
    fn different_files_do_not_meet() {
        assert!(overlapping(&paths(&["src/a.rs", "README.md"]), &paths(&["src/b.rs", "docs/x.md"])).is_empty());
    }

    #[test]
    fn the_same_file_meets() {
        assert_eq!(overlapping(&paths(&["src/a.rs", "b"]), &paths(&["src/a.rs"])), ["src/a.rs"]);
    }

    #[test]
    fn a_file_against_a_directory_meets() {
        // Ours made `a` a file where theirs put files under `a/`.
        assert_eq!(overlapping(&paths(&["a"]), &paths(&["a/b"])), ["a"]);
        // And the other way round.
        assert_eq!(overlapping(&paths(&["a/b/c"]), &paths(&["a/b"])), ["a/b"]);
        // A shared prefix of a name is not a directory.
        assert!(overlapping(&paths(&["ab"]), &paths(&["a/b"])).is_empty());
    }

    #[test]
    fn modes_are_written_as_git_writes_them() {
        assert_eq!(mode(EntryKind::Tree), "40000");
        assert_eq!(mode(EntryKind::Blob), "100644");
        assert_eq!(mode(EntryKind::Exec), "100755");
        assert_eq!(mode(EntryKind::Symlink), "120000");
        assert_eq!(mode(EntryKind::Gitlink), "160000");
    }

    // Ids below come from git itself (`git mktree --missing`,
    // `git hash-object`, `git commit-tree`) in a scratch repository.
    const EMPTY: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const HELLO: &str = "ce013625030ba8dba906f756967f9e9ca394464a";
    const SUBMODULE: &str = "1111111111111111111111111111111111111111";

    #[test]
    fn entries_sort_as_git_sorts_them() {
        // `a` as a directory sorts after `a.b` and `a-c` but before `a0`:
        // it compares as `a/`.
        let entries = vec![
            entry("a0", EntryKind::Exec, HELLO),
            entry("a", EntryKind::Tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
            entry("a.b", EntryKind::Blob, EMPTY),
            entry("a-c", EntryKind::Symlink, HELLO),
            entry("vendor", EntryKind::Gitlink, SUBMODULE),
        ];
        let id = object_id(ObjectKind::Tree, &encode_entries(&entries));
        assert_eq!(id, "59710ac869a643ad7e179b924af6fb3009b84859");
    }

    #[test]
    fn the_empty_tree_is_gits() {
        assert_eq!(
            object_id(ObjectKind::Tree, &encode_entries(&[])),
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        );
    }

    /// A base with `README.md`, `bin/run` (executable), `docs/old.md`,
    /// `src/lib.rs` and a submodule `vendor/dep`.
    fn base() -> (String, HashMap<String, Vec<TreeEntry>>) {
        let mut trees = HashMap::new();
        let bin = vec![entry("run", EntryKind::Exec, HELLO)];
        let docs = vec![entry("old.md", EntryKind::Blob, HELLO)];
        let src = vec![entry("lib.rs", EntryKind::Blob, EMPTY)];
        let vendor = vec![entry("dep", EntryKind::Gitlink, SUBMODULE)];
        let mut id = |entries: Vec<TreeEntry>| {
            let id = object_id(ObjectKind::Tree, &encode_entries(&entries));
            trees.insert(id.clone(), entries);
            id
        };
        let root = vec![
            entry("README.md", EntryKind::Blob, HELLO),
            entry("bin", EntryKind::Tree, &id(bin)),
            entry("docs", EntryKind::Tree, &id(docs)),
            entry("src", EntryKind::Tree, &id(src)),
            entry("vendor", EntryKind::Tree, &id(vendor)),
        ];
        let root = id(root);
        (root, trees)
    }

    #[test]
    fn the_base_tree_matches_git() {
        assert_eq!(base().0, "cdbaeedd6c31387975e65e67f9d453589d3c73d1");
    }

    #[test]
    fn changes_are_applied_to_the_base() {
        let (root, trees) = base();
        let changes = vec![
            // Added in a new directory.
            Change { path: "src/net/http.rs".into(), entry: Some((EntryKind::Blob, HELLO.into())) },
            // Made executable: the same blob.
            Change { path: "src/lib.rs".into(), entry: Some((EntryKind::Exec, EMPTY.into())) },
            // Deleted, leaving its directory empty.
            Change { path: "docs/old.md".into(), entry: None },
            // A symlink added at the top.
            Change { path: "latest".into(), entry: Some((EntryKind::Symlink, HELLO.into())) },
        ];
        let merged = merge_tree(&root, &trees, &changes).unwrap();
        assert_eq!(merged.tree, "3097aeb8d4a86f097eca63da84e432ebeb456158");
        // The root, src and src/net; docs is gone, bin and vendor untouched.
        assert_eq!(merged.objects.len(), 3);
    }

    #[test]
    fn a_file_can_replace_a_directory_the_pull_request_emptied() {
        let (root, trees) = base();
        let changes = vec![
            Change { path: "docs".into(), entry: Some((EntryKind::Blob, HELLO.into())) },
            Change { path: "docs/old.md".into(), entry: None },
        ];
        let merged = merge_tree(&root, &trees, &changes).unwrap();
        assert_eq!(merged.tree, "088fc1bb6d44a71fcd0c33d4022e7bb1628b7202");
    }

    #[test]
    fn a_tree_that_cannot_be_written_back_is_refused() {
        let (root, mut trees) = base();
        // Entries that do not hash to the id they are filed under, as a
        // tree with a mode g1t does not know would not.
        let entries = trees.remove(&root).unwrap();
        trees.insert(root.clone(), entries[1..].to_vec());
        let changes = vec![Change { path: "x".into(), entry: Some((EntryKind::Blob, HELLO.into())) }];
        assert!(merge_tree(&root, &trees, &changes).is_err());
    }

    #[test]
    fn a_file_is_not_put_where_a_directory_still_is() {
        let (root, trees) = base();
        let changes = vec![Change { path: "src".into(), entry: Some((EntryKind::Blob, HELLO.into())) }];
        assert!(merge_tree(&root, &trees, &changes).is_err());
    }

    #[test]
    fn the_merge_commit_matches_git() {
        let commit = commit_object(
            "cdbaeedd6c31387975e65e67f9d453589d3c73d1",
            &["74257edb70e8dc5d2f31af4b76fe898608f829da", "110bda84f45f58e44d3699be9efe91276381b43d"],
            &Signature { name: "octo", email: "octo@users.g1t.sh", seconds: 1_700_000_000 },
            &merge_message("main", "feature", 7),
        );
        assert_eq!(object_id(ObjectKind::Commit, &commit), "f8d35e9d454b11a179215ee1283ac71b7216f024");
    }

    #[test]
    fn a_fork_on_the_default_branch_is_named_by_number() {
        assert_eq!(merge_message("main", "main", 12), "Merge main into pull request #12");
        assert_eq!(merge_message("main", "fix-login", 12), "Merge main into fix-login");
    }

    #[test]
    fn a_pack_of_the_merge_reads_back() {
        let (root, trees) = base();
        let changes = vec![Change { path: "src/new.rs".into(), entry: Some((EntryKind::Blob, HELLO.into())) }];
        let merged = merge_tree(&root, &trees, &changes).unwrap();
        let mut objects: Vec<(ObjectKind, Vec<u8>)> =
            merged.objects.iter().map(|bytes| (ObjectKind::Tree, bytes.clone())).collect();
        let pack = write_pack(&objects);
        let read = g1t_scan::pack::Pack::parse(&pack).unwrap();
        assert!(read.tree(&merged.tree).is_some());

        // Extended with a commit, it still reads, and its checksum holds.
        let commit = commit_object(
            &merged.tree,
            &[&root],
            &Signature { name: "octo", email: "octo@users.g1t.sh", seconds: 1 },
            "m",
        );
        let commit_id = object_id(ObjectKind::Commit, &commit);
        objects.clear();
        objects.push((ObjectKind::Commit, commit));
        let extended = extend_pack(&pack, &objects).unwrap();
        let read = g1t_scan::pack::Pack::parse(&extended).unwrap();
        assert!(read.tree(&merged.tree).is_some());
        assert_eq!(read.commits(), [commit_id]);
    }
}
