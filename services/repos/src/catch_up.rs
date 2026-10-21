//! Bringing a pull request up to date with the branch it would merge into,
//! without a sandbox, when that is safe.
//!
//! By merge (the default): the files the pull request changed since the
//! two last agreed are applied to the base branch's tree, a file both
//! changed merged line by line (merge_methods.rs), and one merge commit on
//! top whose parents are the pull request's head and the base branch's
//! head. Only the trees on the way to changed files are rebuilt. They are
//! written as a pack of whole objects and pushed to the pull request's
//! branch, if it is still where it was.
//!
//! By rebase: the branch's commits are made again on the base branch's
//! head (merge_methods.rs `replay`), and the branch is moved there.
//!
//! When lines both sides changed clash, or the change is beyond what g1t
//! merges itself, the answer is that a sandbox is needed, and nothing is
//! pushed.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use futures_util::future::{try_join, try_join_all};
use g1t_contracts::audit::{AuditActor, NewAuditEntry, Surface};
use g1t_contracts::credentials::Decision;
use g1t_contracts::repos::{
    EntryKind, NeedsAgentReason, PullBranchUpdate, RepoPath, TreeEntry, UpdateMethod, UpdatePullBranchArgs,
};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_scan::pack::{ObjectKind, TreeItem, encode_tree, extend_pack, object_id, write_pack};
use worker::Result;

use crate::public_storage::Operation;
use crate::registry::{can_read, can_write, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::merge_methods::{Applied, Reader, apply};
use crate::{MAX_ANCESTRY, Repos, UNVERIFIED, descends_from, land, nearest_ancestor_in, not_found};

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
pub(crate) fn ancestors(path: &str) -> impl Iterator<Item = &str> {
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
    commit_object_by(tree, parents, by, by, message)
}

/// A commit object's bytes, by `author`, committed by `committer`.
pub(crate) fn commit_object_by(tree: &str, parents: &[&str], author: &Signature, committer: &Signature, message: &str) -> Vec<u8> {
    let mut out = format!("tree {tree}\n");
    for parent in parents {
        out.push_str(&format!("parent {parent}\n"));
    }
    // Git takes everything up to `<` as the name.
    let line = |by: &Signature| {
        let name: String = by.name.chars().filter(|c| !matches!(c, '<' | '>' | '\n')).collect();
        let email: String = by.email.chars().filter(|c| !matches!(c, '<' | '>' | '\n')).collect();
        format!("{name} <{email}> {} +0000", by.seconds)
    };
    out.push_str(&format!("author {}\ncommitter {}\n\n{message}\n", line(author), line(committer)));
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
pub(crate) async fn read_dirs<R: GitRepo>(
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

/// g1t's own name and address, for a commit g1t's agent or g1t itself
/// makes. None for anyone else.
pub(crate) fn g1t_commit_identity(actor: &g1t_contracts::User) -> Option<g1t_contracts::accounts::CommitIdentity> {
    use g1t_contracts::{PrincipalKind, system};
    matches!(actor.kind, PrincipalKind::Agent | PrincipalKind::System).then(|| g1t_contracts::accounts::CommitIdentity {
        name: system::USERNAME.to_owned(),
        email: system::EMAIL.to_owned(),
    })
}

fn needs_agent(reason: NeedsAgentReason, detail: impl Into<String>, paths: Vec<String>) -> Outcome<PullBranchUpdate> {
    Outcome::Ok(PullBranchUpdate::NeedsAgent {
        reason,
        detail: detail.into(),
        paths,
    })
}

impl<S: GitStore> Repos<S> {
    /// The name and address a commit made for `actor` carries: their
    /// noreply address unless they chose to show their own. What g1t's
    /// agent or g1t itself commits is g1t's, whoever it works for. Without
    /// identity, the noreply address all the same.
    pub(crate) async fn commit_identity(&self, actor: &g1t_contracts::User) -> g1t_contracts::accounts::CommitIdentity {
        if let Some(g1t) = g1t_commit_identity(actor) {
            return g1t;
        }
        let person = (actor.id.clone(), actor.username.clone());
        let found = match &self.identity {
            Some(identity) => g1t_kit::call::<_, Option<g1t_contracts::accounts::CommitIdentity>>(
                identity,
                "commit_identity",
                &g1t_contracts::accounts::CommitIdentityArgs { user_id: person.0.clone() },
            )
            .await
            .ok()
            .flatten(),
            None => None,
        };
        found.unwrap_or_else(|| g1t_contracts::accounts::CommitIdentity {
            name: person.1.clone(),
            email: g1t_contracts::accounts::noreply_address(&person.0, &person.1),
        })
    }

    pub(crate) async fn update_pull_branch(&self, a: UpdatePullBranchArgs) -> Result<Outcome<PullBranchUpdate>> {
        let actor = Some(a.actor.clone());
        let Some(source) = self.registry.by_id(&a.source_id).await? else {
            return Ok(not_found());
        };
        let target = self.pull_target(&source, a.target_id.as_deref()).await?;
        let Some(target) = target.filter(|repo| can_read(repo, &actor)) else {
            return Ok(not_found());
        };
        // The update is pushed as the person asking, so they must be able
        // to push: to the working copy as whoever opened the pull request,
        // or to the fork or repository holding the branch.
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
        if let Some((code, message)) = crate::lifecycle::read_only_refusal(&target) {
            return Ok(Outcome::fail(code, message));
        }
        // Moving between namespaces: wait for it (moves.rs). Both are read
        // again once it is done, for their new keys.
        let (source, target) = match (self.unpaused(source).await?, self.unpaused(target).await?) {
            (Ok(source), Ok(target)) => (source, target),
            (Err((code, message)), _) | (_, Err((code, message))) => return Ok(Outcome::fail(code, message)),
        };
        let from_fork = source.id != target.id;
        let base_branch = a.target_branch.clone().unwrap_or_else(|| target.default_branch.clone());
        // A working copy holds the change on the branch it merges into.
        let branch = match a.branch.clone() {
            Some(branch) => branch,
            None if source.fork_of.is_some() || !from_fork => target.default_branch.clone(),
            None => return Ok(Outcome::fail(FailureCode::Invalid, "Say which branch of the fork to update.")),
        };
        if !from_fork && branch == base_branch {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("{base_branch} cannot be merged into itself."),
            ));
        }
        match a.method {
            UpdateMethod::Merge => {
                let message = merge_message(&base_branch, &branch, a.number);
                self.merge_up(source, target, branch, base_branch, &a.actor, message, a.expected_head.as_deref()).await
            }
            UpdateMethod::Rebase => {
                self.rebase_up(source, target, branch, base_branch, &a.actor, a.expected_head.as_deref()).await
            }
        }
    }

    /// Merges `base_branch` of `target` into `branch` of `source` without a
    /// sandbox, pushed as `actor` with `message`; `source` may be `target`
    /// itself, a pull request's working copy, or a fork. Files only one
    /// side changed are taken from it, and a file both changed is merged
    /// line by line (merge_methods.rs); lines both changed differently
    /// leave it to a sandbox, naming the files. Refused when the branch is
    /// no longer at `expected_head`. The caller has checked who may do it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn merge_up(
        &self,
        source: g1t_contracts::repos::Repo,
        target: g1t_contracts::repos::Repo,
        branch: String,
        base_branch: String,
        actor: &g1t_contracts::User,
        message: String,
        expected_head: Option<&str>,
    ) -> Result<Outcome<PullBranchUpdate>> {
        let from_fork = source.id != target.id;
        // A working copy removed after its pull request closed is made again.
        self.live(&source).await?;
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
                format!("{branch} has no commits to bring up to date."),
            ));
        };
        if let Some(refused) = moved_since(&branch, &head.hash, expected_head) {
            return Ok(refused);
        }
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

        // The pull request's changes, applied to the base branch's tree.
        let reader = Reader::new(&source_git, from_fork.then_some(&target_git));
        let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
        let tree = match apply(&reader, Some(&merge_base_tree), &head.tree_hash, &base.tree_hash, &mut objects).await? {
            Applied::Tree(tree) => tree,
            Applied::Conflict(paths) => {
                return Ok(needs_agent(
                    NeedsAgentReason::Conflicting,
                    format!("This pull request and {base_branch} changed the same lines of some files."),
                    paths,
                ));
            }
            Applied::Unsupported(why) => {
                return Ok(needs_agent(
                    NeedsAgentReason::Unsupported,
                    format!("g1t could not merge this itself: {why}."),
                    Vec::new(),
                ));
            }
        };

        let author = self.commit_identity(actor).await;
        let commit = commit_object(
            &tree,
            &[&head.hash, &base.hash],
            &Signature {
                name: &author.name,
                email: &author.email,
                seconds: now_ms() / 1000,
            },
            &message,
        );
        let commit_id = object_id(ObjectKind::Commit, &commit);
        objects.push((ObjectKind::Commit, commit));
        let facts = vec![crate::rules::made_commit(&commit_id, &message, &author.email, 2, Vec::new())];
        let update = BranchUpdate { branch: &branch, head: &head.hash, commit: &commit_id, fast_forward: true, commits: 1 };
        // From another repository (a fork syncing, a pull request from a
        // fork catching up), the merge also brings that repository's commits,
        // which are not read here: a rule about what commits hold refuses it
        // rather than pass them unseen.
        if let Some(refused) = self.update_refused(&source, actor, &update, facts, !from_fork).await? {
            return Ok(refused);
        }
        // A fork lacks what the default branch gained since it was made:
        // those objects come from the repository, with the merge after them.
        let pack = if from_fork {
            let target_access = target_git.access(Scope::Read).await?;
            let fetched = land::fetch_pack(&target_access, &base.hash, Some(&merge_base)).await?;
            extend_pack(&fetched, &objects).map_err(worker::Error::RustError)?
        } else {
            write_pack(&objects)
        };
        self.push_update(&source, &source_git, actor, &update, pack).await
    }

    /// Whether the rules of `update.branch` refuse moving it as `update`
    /// says, for a branch of a repository (not a pull request's working
    /// copy, which has none), as for any push (rules.rs). A catch-up
    /// brings nothing the base branch does not have, so no files.
    pub(crate) async fn update_refused(
        &self,
        source: &g1t_contracts::repos::Repo,
        actor: &g1t_contracts::User,
        update: &BranchUpdate<'_>,
        commits: Vec<g1t_contracts::rules::CommitFacts>,
        complete: bool,
    ) -> Result<Option<Outcome<PullBranchUpdate>>> {
        if source.fork_of.is_some() {
            return Ok(None);
        }
        let change = g1t_rules::push::RefChange {
            git_ref: format!("refs/heads/{}", update.branch),
            old: Some(update.head.to_owned()),
            new: Some(update.commit.to_owned()),
            fast_forward: Some(update.fast_forward),
            commits,
            complete,
        };
        Ok(match self.check_changes(source, actor, g1t_contracts::rules::Action::Push, vec![change]).await? {
            crate::rules::Ruled::Refused { message, .. } => Some(Outcome::fail(FailureCode::Forbidden, message)),
            _ => None,
        })
    }

    /// Moves `update.branch` of `source` to `update.commit`, sending
    /// `pack`, only if it is still at `update.head`: a push that landed
    /// meanwhile is kept, and this is refused. Audited and announced as a
    /// push by `actor`.
    pub(crate) async fn push_update(
        &self,
        source: &g1t_contracts::repos::Repo,
        source_git: &S::Repo,
        actor: &g1t_contracts::User,
        update: &BranchUpdate<'_>,
        pack: Vec<u8>,
    ) -> Result<Outcome<PullBranchUpdate>> {
        let branch = update.branch;
        let source_access = source_git.access(Scope::Write).await?;
        let Some(pushed) = self
            .push_reserved(source, Operation::Update, Some(&actor.id), &source_access, branch, Some(update.head), update.commit, pack)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Public repository storage is full. Make room before adding more data."));
        };
        self.refs_moved(&source.id).await;
        let git_ref = format!("refs/heads/{branch}");
        let path = RepoPath {
            namespace: source.namespace.clone(),
            name: source.name.clone(),
        };
        let mut target_entry = self.audit_target(&path).await?;
        target_entry.git_ref = Some(git_ref.clone());
        let mut entry = NewAuditEntry::new(
            AuditActor::of(actor),
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
        self.publish_push(source, &git_ref, Some(update.head), update.commit, Some(actor), Some(update.commits))
            .await?;
        Ok(Outcome::Ok(PullBranchUpdate::Updated {
            commit: update.commit.to_owned(),
            previous: update.head.to_owned(),
        }))
    }
}

/// How a pull request's branch is being moved.
pub(crate) struct BranchUpdate<'a> {
    pub branch: &'a str,
    /// Where it is, which it must still be when it moves.
    pub head: &'a str,
    /// Where it goes.
    pub commit: &'a str,
    /// Whether `commit` keeps `head` in its history (a merge does, a
    /// rebase does not).
    pub fast_forward: bool,
    /// How many commits it makes.
    pub commits: u32,
}

/// The refusal for a branch that is no longer at `expected`.
pub(crate) fn moved_since(branch: &str, head: &str, expected: Option<&str>) -> Option<Outcome<PullBranchUpdate>> {
    expected.filter(|expected| *expected != head).map(|_| {
        Outcome::fail(
            FailureCode::Conflict,
            format!("{branch} has changed since it was last looked at. Look again, then update it."),
        )
    })
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
    fn g1ts_commits_are_g1ts_whoever_asked() {
        use g1t_contracts::{PrincipalKind, User};
        let agent = User { id: "usr_g1t_agent".into(), username: "g1t".into(), kind: PrincipalKind::Agent, ..User::default() };
        let made = g1t_commit_identity(&agent).unwrap();
        assert_eq!((made.name.as_str(), made.email.as_str()), ("g1t", "g1t@users.noreply.g1t.sh"));
        let made = g1t_commit_identity(&User::system("acme")).unwrap();
        assert_eq!((made.name.as_str(), made.email.as_str()), ("g1t", "g1t@users.noreply.g1t.sh"));
        let person = User { id: "usr_1".into(), username: "ana".into(), ..User::default() };
        assert!(g1t_commit_identity(&person).is_none());
    }

    #[test]
    fn a_branch_that_moved_since_it_was_looked_at_is_left_alone() {
        assert!(moved_since("feature", "abc", None).is_none());
        assert!(moved_since("feature", "abc", Some("abc")).is_none());
        let Some(Outcome::Fail(failure)) = moved_since("feature", "abc", Some("def")) else { panic!("not refused") };
        assert_eq!(failure.code, FailureCode::Conflict);
        assert!(failure.message.starts_with("feature has changed"));
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
