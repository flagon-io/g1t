//! A repository's lifecycle after it is made: renaming it, archiving it,
//! making it public or private, changing or renaming its default branch,
//! and deleting it with a window to restore it.
//!
//! Deleting is soft. The row gets `deleted_at` and `purge_after`
//! ([`RESTORE_DAYS`] on), every read in the registry leaves it out, git
//! refuses it, and `repo.deleted` tells every service to stop what runs for
//! it and hide it. Restoring clears the columns (`repo.restored`). Purging,
//! by an owner from the Recently deleted list or by the hourly sweep once
//! `purge_after` has passed, removes the git data from the store, then the
//! rows (its pull requests' working copies with it) and its redirects, and
//! announces `repo.purged`, on which services drop what they keep for it.
//! Until then its name stays taken, so a restore always has its path back.
//!
//! A rename is a path change like a transfer: the old path is kept in
//! `repo_redirects`, the git store key never changes, the tokens of agents
//! at work on it are moved with identity, and `repo.renamed` is handled by
//! services with the same helper as `repo.transferred`
//! (`g1t_kit::transfer`).

use g1t_contracts::audit::{
    AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface,
};
use g1t_contracts::events::{
    BranchRenamed, NewEvent, RepoArchived, RepoDefaultBranchChanged, RepoDeleted, RepoPurged,
    RepoRenamed, RepoRestored, RepoUpdated, RepoVisibilityChanged,
};
use g1t_contracts::identity::TransferRepoScopesArgs;
use g1t_contracts::repos::{
    ArchiveArgs, DeleteArgs, DeletedArgs, DeletedRepo, DeletedRepoArgs, PurgeDueArgs,
    RESTORE_DAYS, RenameArgs, RenameBranchArgs, Repo, RepoPath, RepoStatus, ResolveBranchArgs,
    SetDefaultBranchArgs, SetVisibilityArgs, StatusByIdArgs, archived_message,
    is_valid_branch_name,
};
use g1t_contracts::access::{self, Capability, RepoRole};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, is_valid_repo_name, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::registry::{Registry, remember_store, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::{Repos, SOURCE, UNVERIFIED, git_ops, land, not_found};

/// A pack with no objects: what a push that only creates a ref at a commit
/// the repository already has sends.
const EMPTY_PACK: &[u8] = &[
    b'P', b'A', b'C', b'K', 0, 0, 0, 2, 0, 0, 0, 0, 0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8,
    0xea, 0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
];

/// How many pull request working copies follow a change of the default
/// branch (newest first). Older ones keep the branch they were made with.
const FORKS_FOLLOWING: u32 = 100;

/// How many deleted repositories one sweep purges.
const PURGES_PER_SWEEP: u32 = 25;

type Refusal = (FailureCode, String);

/// Who is asking, as far as an owner's or an admin's action cares.
#[derive(Clone, Copy, Debug)]
pub struct Asker {
    /// A person, not a workspace's or an agent's token.
    pub person: bool,
    pub verified: bool,
    /// Their role in the repository's workspace.
    pub role: Option<Role>,
    /// Their role on the repository itself (see g1t_contracts::access).
    /// None where only the workspace is known, as for deleted ones.
    pub repo_role: Option<RepoRole>,
}

impl Asker {
    pub fn of(user: &User, namespace: &str) -> Self {
        Asker {
            person: user.kind == PrincipalKind::User,
            verified: user.verified,
            role: user.role_in(&namespace.to_lowercase()),
            repo_role: None,
        }
    }

    /// The asker, with their role on `repo`.
    pub fn on(user: &User, repo: &Repo) -> Self {
        Asker {
            repo_role: crate::registry::role(repo, &Some(user.clone())),
            ..Asker::of(user, &repo.namespace)
        }
    }
}

/// Whether `asker` may `what` ("rename", "archive"...) a repository of
/// `namespace` that takes `capability`: a verified person with the role
/// the permission table asks (Admin), and for transferring and deleting,
/// an owner of the workspace as well.
pub fn admin_only(asker: Asker, namespace: &str, what: &str, capability: Capability) -> std::result::Result<(), Refusal> {
    if access::OWNER_ONLY.contains(&capability) {
        // Someone who can see the repository is told why, not that it is missing.
        if asker.role.is_none() && asker.repo_role.is_some() && asker.person {
            return Err((
                FailureCode::Forbidden,
                format!("Only an owner of {namespace} can {what} its repositories."),
            ));
        }
        return owner_only(asker, namespace, what);
    }
    if asker.role.is_none() && asker.repo_role.is_none() {
        return Err((FailureCode::NotFound, "Repository not found.".into()));
    }
    if !asker.person {
        return Err((
            FailureCode::Forbidden,
            format!("Only a person can {what} a repository. Sign in, or use a personal access token."),
        ));
    }
    if !asker.repo_role.is_some_and(|role| access::allows(role, capability)) {
        return Err((
            FailureCode::Forbidden,
            format!(
                "You need the {} role on a repository of {namespace} to {what} it.",
                access::least_role(capability).label()
            ),
        ));
    }
    if !asker.verified {
        return Err((FailureCode::Forbidden, UNVERIFIED.into()));
    }
    Ok(())
}

/// Whether `asker` may `what` ("delete", "rename"...) a repository of
/// `namespace`: a verified person who owns the workspace.
pub fn owner_only(asker: Asker, namespace: &str, what: &str) -> std::result::Result<(), Refusal> {
    if asker.role.is_none() {
        return Err((FailureCode::NotFound, "Repository not found.".into()));
    }
    if !asker.person {
        return Err((
            FailureCode::Forbidden,
            format!("Only a person can {what} a repository. Sign in, or use a personal access token."),
        ));
    }
    if asker.role != Some(Role::Owner) {
        return Err((
            FailureCode::Forbidden,
            format!("Only an owner of {namespace} can {what} its repositories."),
        ));
    }
    if !asker.verified {
        return Err((FailureCode::Forbidden, UNVERIFIED.into()));
    }
    Ok(())
}

/// Whether what was typed to confirm names the repository: its full name,
/// `namespace/name`, in any case.
pub fn confirmed(path: &RepoPath, typed: &str) -> bool {
    typed.trim().to_lowercase() == format!("{}/{}", path.namespace, path.name).to_lowercase()
}

fn confirm_refusal(path: &RepoPath) -> Refusal {
    (
        FailureCode::Invalid,
        format!("Type {}/{} to confirm.", path.namespace, path.name),
    )
}

/// When a repository deleted at `now_ms` is purged.
pub fn purge_after(now_ms: u64) -> String {
    rfc3339(now_ms + RESTORE_DAYS * 86_400_000)
}

/// Whether a repository to be purged at `purge_after` can still be
/// restored at `now` (both RFC 3339, which compare as text).
pub fn restorable(purge_after: &str, now: &str) -> bool {
    now < purge_after
}

/// Where a repository is in its life, from its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Archived,
    /// Deleted, and restorable until purged.
    Deleted,
    /// Deleted, and due to be purged by the next sweep.
    Due,
}

pub fn state(archived_at: Option<&str>, deleted: Option<(&str, &str)>, now: &str) -> State {
    match deleted {
        Some((_, purge_after)) if !restorable(purge_after, now) => State::Due,
        Some(_) => State::Deleted,
        None if archived_at.is_some() => State::Archived,
        None => State::Active,
    }
}

/// What holds a name in a workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    Free,
    ByRepo,
    /// A repository deleted but not yet purged.
    ByDeleted,
}

/// The name a repository at `current` can be renamed to, tidied, or why
/// not.
pub fn new_name(namespace: &str, current: &str, wanted: &str, held: Held) -> std::result::Result<String, Refusal> {
    let name = wanted.trim().to_lowercase();
    if !is_valid_repo_name(&name) {
        return Err((
            FailureCode::Invalid,
            "Use letters, digits, dots, hyphens and underscores only.".into(),
        ));
    }
    if name == current {
        return Err((FailureCode::Invalid, format!("It is already called {name}.")));
    }
    match held {
        Held::Free => Ok(name),
        Held::ByRepo => Err((
            FailureCode::Conflict,
            format!("{namespace} already has a repository named {name}."),
        )),
        Held::ByDeleted => Err((
            FailureCode::Conflict,
            format!(
                "{namespace}/{name} was deleted recently and can still be restored. Restore it and rename it, or delete it permanently from the workspace's Recently deleted list first."
            ),
        )),
    }
}

/// Why a write to `repo` is refused because it is archived, if it is.
pub fn archived_refusal(repo: &Repo) -> Option<Refusal> {
    repo.archived()
        .then(|| (FailureCode::Forbidden, archived_message(&repo.namespace, &repo.name)))
}

/// Everything that decides whether a repository may go private or public.
#[derive(Debug, Default)]
pub struct VisibilityFacts {
    pub to_private: bool,
    /// The workspace is on no plan, so its private storage is capped.
    pub free: bool,
    /// What its private repositories hold now.
    pub private_bytes: i64,
    /// What this repository holds.
    pub bytes: i64,
    /// What a free workspace's private repositories may hold.
    pub free_private_bytes: i64,
}

/// Whether the visibility change `facts` describe may happen.
pub fn visibility_check(namespace: &str, facts: &VisibilityFacts) -> std::result::Result<(), Refusal> {
    if facts.to_private
        && facts.free
        && git_ops::storage_full(facts.private_bytes + facts.bytes, facts.free_private_bytes)
    {
        return Err((
            FailureCode::PaymentRequired,
            format!(
                "{namespace}'s private repositories would hold {:.2} GB, more than the {:.0} GB a free workspace has. Start the g1t plan in {namespace}, or keep the repository public.",
                (facts.private_bytes + facts.bytes) as f64 / 1e9,
                facts.free_private_bytes as f64 / 1e9,
            ),
        ));
    }
    Ok(())
}

/// Whether `from` can be renamed to `to` in a repository whose branches
/// are `branches`. `to` is tidied of surrounding space.
pub fn branch_rename(from: &str, to: &str, branches: &[String]) -> std::result::Result<String, Refusal> {
    let to = to.trim().to_owned();
    if !branches.iter().any(|branch| branch == from) {
        return Err((FailureCode::NotFound, format!("There is no branch named {from}.")));
    }
    if !is_valid_branch_name(&to) {
        return Err((
            FailureCode::Invalid,
            format!("{to:?} cannot be a branch name. Use letters, digits, '/', '-', '_' and '.', and no spaces."),
        ));
    }
    if to == from {
        return Err((FailureCode::Invalid, format!("It is already called {to}.")));
    }
    if branches.contains(&to) {
        return Err((FailureCode::Conflict, format!("There is already a branch named {to}.")));
    }
    Ok(to)
}

/// The row of a deleted repository.
#[derive(Deserialize)]
struct DeletedRow {
    id: String,
    namespace: String,
    name: String,
    description: Option<String>,
    is_private: u8,
    deleted_at: String,
    #[serde(default)]
    deleted_by: Option<String>,
    purge_after: String,
}

impl From<DeletedRow> for DeletedRepo {
    fn from(row: DeletedRow) -> Self {
        DeletedRepo {
            id: row.id,
            namespace: row.namespace,
            name: row.name,
            description: row.description,
            is_private: row.is_private != 0,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by.unwrap_or_default(),
            purge_after: row.purge_after,
        }
    }
}

const DELETED_COLUMNS: &str =
    "id, namespace, name, description, is_private, deleted_at, deleted_by, purge_after";

impl Registry {
    /// Deletes a repository and its pull requests' working copies, softly.
    pub async fn soft_delete(&self, id: &str, by: &str, at: &str, purge_after: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE repos SET deleted_at = ?1, deleted_by = ?2, purge_after = ?3
                 WHERE (id = ?4 OR fork_of = ?4) AND deleted_at IS NULL",
            )
            .bind(&[at.into(), by.into(), purge_after.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Brings a deleted repository and its working copies back.
    pub async fn undelete(&self, id: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE repos SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL
                 WHERE id = ?1 OR fork_of = ?1",
            )
            .bind(&[id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A workspace's deleted repositories, newest first.
    pub async fn deleted_in(&self, namespace: &str) -> Result<Vec<DeletedRepo>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {DELETED_COLUMNS} FROM repos
                 WHERE namespace = ? AND deleted_at IS NOT NULL AND fork_of IS NULL
                 ORDER BY deleted_at DESC LIMIT 200"
            ))
            .bind(&[namespace.to_lowercase().into()])?
            .all()
            .await?
            .results::<DeletedRow>()?
            .into_iter()
            .map(DeletedRepo::from)
            .collect())
    }

    /// The deleted repository at `path`, if that is what holds it.
    pub async fn deleted_at(&self, path: &RepoPath) -> Result<Option<DeletedRepo>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {DELETED_COLUMNS} FROM repos
                 WHERE namespace = ? AND name = ? AND deleted_at IS NOT NULL AND fork_of IS NULL"
            ))
            .bind(&[
                path.namespace.to_lowercase().into(),
                path.name.to_lowercase().into(),
            ])?
            .first::<DeletedRow>(None)
            .await?
            .map(DeletedRepo::from))
    }

    /// Deleted repositories whose time to be restored has passed.
    pub async fn due(&self, now: &str, limit: u32) -> Result<Vec<DeletedRepo>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {DELETED_COLUMNS} FROM repos
                 WHERE deleted_at IS NOT NULL AND purge_after <= ? AND fork_of IS NULL
                 ORDER BY purge_after LIMIT ?"
            ))
            .bind(&[now.into(), limit.into()])?
            .all()
            .await?
            .results::<DeletedRow>()?
            .into_iter()
            .map(DeletedRepo::from)
            .collect())
    }

    /// Every deleted repository left in a workspace, for when the
    /// workspace itself is deleted.
    pub async fn deleted_ids_in(&self, namespace: &str) -> Result<Vec<DeletedRepo>> {
        self.deleted_in(namespace).await
    }

    /// The git store keys of a repository and of its working copies.
    pub async fn store_keys(&self, id: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            namespace: String,
            name: String,
            #[serde(default)]
            store: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT namespace, name, store FROM repos WHERE id = ?1 OR fork_of = ?1")
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.store.unwrap_or_else(|| format!("{}--{}", row.namespace, row.name)))
            .collect())
    }

    /// Forgets a purged repository: its rows, its working copies' rows and
    /// every redirect to it.
    pub async fn erase(&self, id: &str) -> Result<()> {
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM repos WHERE fork_of = ?1").bind(&[id.into()])?,
                self.db.prepare("DELETE FROM repos WHERE id = ?1").bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM repo_redirects WHERE repo_id = ?1")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM branch_redirects WHERE repo_id = ?1")
                    .bind(&[id.into()])?,
            ])
            .await?;
        Ok(())
    }

    /// Renames a repository, keeping its old path as a redirect. Any
    /// redirect held by the new path gives way.
    pub async fn rename(&self, repo: &Repo, name: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE repos SET name = ? WHERE id = ? AND name = ?")
                    .bind(&[name.into(), repo.id.as_str().into(), repo.name.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM repo_redirects WHERE namespace = ? AND name = ?")
                    .bind(&[repo.namespace.as_str().into(), name.into()])?,
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO repo_redirects (namespace, name, repo_id, created_at)
                         VALUES (?, ?, ?, ?)",
                    )
                    .bind(&[
                        repo.namespace.as_str().into(),
                        repo.name.as_str().into(),
                        repo.id.as_str().into(),
                        now.as_str().into(),
                    ])?,
            ])
            .await?;
        Ok(())
    }

    pub async fn set_archived(&self, id: &str, at: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET archived_at = ? WHERE id = ?")
            .bind(&[at.map_or(JsValue::NULL, JsValue::from), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Makes a repository and its working copies public or private.
    pub async fn set_private(&self, id: &str, private: bool) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET is_private = ?1 WHERE id = ?2 OR fork_of = ?2")
            .bind(&[u32::from(private).into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_default_branch(&self, id: &str, branch: &str) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET default_branch = ? WHERE id = ?")
            .bind(&[branch.into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Working copies of a repository, newest first, at most `limit`.
    pub async fn forks_of(&self, id: &str, limit: u32) -> Result<Vec<Repo>> {
        let rows = self
            .db
            .prepare(
                "SELECT * FROM repos WHERE fork_of = ? AND deleted_at IS NULL
                 ORDER BY created_at DESC LIMIT ?",
            )
            .bind(&[id.into(), limit.into()])?
            .all()
            .await?
            .results::<crate::registry::RepoRow>()?;
        Ok(rows.into_iter().map(Repo::from).collect())
    }

    /// Records that `from` is now called `to`. Redirects that pointed at
    /// `from` point at `to`, and one held by `to` itself ends.
    pub async fn add_branch_redirect(&self, repo_id: &str, from: &str, to: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM branch_redirects WHERE repo_id = ? AND branch = ?")
                    .bind(&[repo_id.into(), to.into()])?,
                self.db
                    .prepare("UPDATE branch_redirects SET now = ? WHERE repo_id = ? AND now = ?")
                    .bind(&[to.into(), repo_id.into(), from.into()])?,
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO branch_redirects (repo_id, branch, now, created_at)
                         VALUES (?, ?, ?, ?)",
                    )
                    .bind(&[repo_id.into(), from.into(), to.into(), now.as_str().into()])?,
            ])
            .await?;
        Ok(())
    }

    pub async fn branch_redirect(&self, repo_id: &str, branch: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            now: String,
        }
        Ok(self
            .db
            .prepare("SELECT now FROM branch_redirects WHERE repo_id = ? AND branch = ?")
            .bind(&[repo_id.into(), branch.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.now))
    }

    /// Whether a repository is archived or deleted; unknown is deleted.
    pub async fn status(&self, id: &str) -> Result<RepoStatus> {
        #[derive(Deserialize)]
        struct Row {
            #[serde(default)]
            archived_at: Option<String>,
            #[serde(default)]
            deleted_at: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT archived_at, deleted_at FROM repos WHERE id = ?")
            .bind(&[id.into()])?
            .first::<Row>(None)
            .await?
            .map_or(
                RepoStatus {
                    archived: false,
                    deleted: true,
                },
                |row| RepoStatus {
                    archived: row.archived_at.is_some(),
                    deleted: row.deleted_at.is_some(),
                },
            ))
    }
}

/// An audit entry for something done to a repository.
fn entry(actor: AuditActor, action: &str, surface: Option<Surface>, path: &RepoPath, rule: &str, message: String) -> NewAuditEntry {
    NewAuditEntry {
        actor,
        action: action.to_owned(),
        surface: surface.unwrap_or(Surface::Web),
        target: AuditTarget {
            workspace: path.namespace.clone(),
            repo: Some(format!("{}/{}", path.namespace, path.name)),
            ..AuditTarget::default()
        },
        outcome: AuditOutcome::Allowed,
        rule: rule.to_owned(),
        result: Some("ok".to_owned()),
        message: Some(message),
        request_id: new_id("req", now_ms()),
    }
}

/// g1t itself, as the actor of what its schedule does.
fn g1t_actor() -> AuditActor {
    AuditActor {
        actor: "g1t".to_owned(),
        actor_id: "g1t".to_owned(),
        ..AuditActor::default()
    }
}

fn fail<T>((code, message): Refusal) -> Outcome<T> {
    Outcome::fail(code, message)
}

fn path_of(repo: &Repo) -> RepoPath {
    RepoPath {
        namespace: repo.namespace.clone(),
        name: repo.name.clone(),
    }
}

impl<S: GitStore> Repos<S> {
    pub(crate) async fn record(&self, entries: Vec<NewAuditEntry>) {
        let recorded: Result<u32> =
            g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries }).await;
        if let Err(error) = recorded {
            worker::console_error!("audit entries not recorded: {error}");
        }
    }

    /// The repository at `path` an admin is acting on: found, not a
    /// working copy, and the actor allowed `capability` on it (Admin, and
    /// for deleting, an owner of its workspace).
    async fn owned(
        &self,
        actor: &User,
        path: &RepoPath,
        what: &str,
        capability: Capability,
    ) -> Result<std::result::Result<Repo, Refusal>> {
        let viewer = Some(actor.clone());
        let Some(repo) = self.readable(path, &viewer).await? else {
            return Ok(Err((FailureCode::NotFound, "Repository not found.".into())));
        };
        if repo.fork_of.is_some() {
            return Ok(Err((FailureCode::NotFound, "Repository not found.".into())));
        }
        if let Err(refusal) = admin_only(Asker::on(actor, &repo), &repo.namespace, what, capability) {
            return Ok(Err(refusal));
        }
        Ok(Ok(repo))
    }

    /// `delete`: see `g1t_contracts::repos::DeleteArgs`.
    pub(crate) async fn delete(&self, a: DeleteArgs) -> Result<Outcome<DeletedRepo>> {
        let repo = match self.owned(&a.actor, &a.path, "delete", Capability::Delete).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let path = path_of(&repo);
        if !confirmed(&path, &a.confirm) {
            return Ok(fail(confirm_refusal(&path)));
        }
        let now = now_ms();
        let at = rfc3339(now);
        let purge = purge_after(now);
        self.registry
            .soft_delete(&repo.id, &a.actor.username, &at, &purge)
            .await?;
        self.publish(NewEvent {
            kind: "repo.deleted",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoDeleted {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
                is_private: repo.is_private,
                purge_after: purge.clone(),
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "repo.deleted",
            a.surface,
            &path,
            "owner",
            format!("Deleted; restorable until {purge}"),
        )])
        .await;
        Ok(Outcome::Ok(DeletedRepo {
            id: repo.id,
            namespace: repo.namespace,
            name: repo.name,
            description: repo.description,
            is_private: repo.is_private,
            deleted_at: at,
            deleted_by: a.actor.username,
            purge_after: purge,
        }))
    }

    /// `deleted`: see `g1t_contracts::repos::DeletedArgs`.
    pub(crate) async fn deleted(&self, a: DeletedArgs) -> Result<Vec<DeletedRepo>> {
        let namespace = a.namespace.to_lowercase();
        let owner = a
            .viewer
            .as_ref()
            .is_some_and(|user| user.role_in(&namespace) == Some(Role::Owner));
        if !owner {
            return Ok(Vec::new());
        }
        self.registry.deleted_in(&namespace).await
    }

    /// The deleted repository an owner is acting on.
    async fn owned_deleted(
        &self,
        actor: &User,
        path: &RepoPath,
        what: &str,
    ) -> Result<std::result::Result<DeletedRepo, Refusal>> {
        if let Err(refusal) = owner_only(Asker::of(actor, &path.namespace), &path.namespace.to_lowercase(), what) {
            return Ok(Err(refusal));
        }
        Ok(match self.registry.deleted_at(path).await? {
            Some(deleted) => Ok(deleted),
            None => Err((
                FailureCode::NotFound,
                format!(
                    "{}/{} is not among the workspace's recently deleted repositories.",
                    path.namespace, path.name
                ),
            )),
        })
    }

    /// `restore`: see `g1t_contracts::repos::DeletedRepoArgs`.
    pub(crate) async fn restore(&self, a: DeletedRepoArgs) -> Result<Outcome<Repo>> {
        let deleted = match self.owned_deleted(&a.actor, &a.path, "restore").await? {
            Ok(deleted) => deleted,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let deleted_state = state(
            None,
            Some((&deleted.deleted_at, &deleted.purge_after)),
            &rfc3339(now_ms()),
        );
        if deleted_state == State::Due {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{}/{} is being purged and can no longer be restored.", deleted.namespace, deleted.name),
            ));
        }
        self.registry.undelete(&deleted.id).await?;
        let Some(repo) = self.registry.by_id(&deleted.id).await? else {
            return Ok(not_found());
        };
        self.publish(NewEvent {
            kind: "repo.restored",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoRestored {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
                is_private: repo.is_private,
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "repo.restored",
            a.surface,
            &path_of(&repo),
            "owner",
            format!("Restored; deleted by {} at {}", deleted.deleted_by, deleted.deleted_at),
        )])
        .await;
        Ok(Outcome::Ok(repo))
    }

    /// `purge`: see `g1t_contracts::repos::DeletedRepoArgs`.
    pub(crate) async fn purge(&self, a: DeletedRepoArgs) -> Result<Outcome<bool>> {
        let deleted = match self.owned_deleted(&a.actor, &a.path, "permanently delete").await? {
            Ok(deleted) => deleted,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let path = RepoPath {
            namespace: deleted.namespace.clone(),
            name: deleted.name.clone(),
        };
        if !confirmed(&path, a.confirm.as_deref().unwrap_or_default()) {
            return Ok(fail(confirm_refusal(&path)));
        }
        self.purge_now(&deleted, Some(&a.actor.id)).await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "repo.purged",
            a.surface,
            &path,
            "owner",
            "Permanently deleted, with its git data".to_owned(),
        )])
        .await;
        Ok(Outcome::Ok(true))
    }

    /// Removes a deleted repository for good: git data first, so a failure
    /// leaves it to the next sweep, then its rows; then says so.
    async fn purge_now(&self, deleted: &DeletedRepo, actor: Option<&str>) -> Result<()> {
        for key in self.registry.store_keys(&deleted.id).await? {
            self.store.delete(&key).await?;
        }
        self.registry.erase(&deleted.id).await?;
        // Who had access to it goes with it.
        if let Some(identity) = &self.identity {
            let forgotten: Result<bool> = g1t_kit::call(
                identity,
                "forget_repo_access",
                &g1t_contracts::access::ForgetRepoAccessArgs {
                    repo_id: deleted.id.clone(),
                },
            )
            .await;
            if let Err(error) = forgotten {
                worker::console_error!("access to {} not forgotten: {error}", deleted.id);
            }
        }
        self.publish(NewEvent {
            kind: "repo.purged",
            source: SOURCE,
            repo_id: Some(deleted.id.clone()),
            actor: actor.map(str::to_owned),
            data: RepoPurged {
                repo_id: deleted.id.clone(),
                namespace: deleted.namespace.clone(),
                name: deleted.name.clone(),
            },
        })
        .await
    }

    /// `purge_due`: see `g1t_contracts::repos::PurgeDueArgs`.
    pub(crate) async fn purge_due(&self, a: PurgeDueArgs) -> Result<u32> {
        let limit = a.limit.unwrap_or(PURGES_PER_SWEEP).clamp(1, 100);
        let due = self.registry.due(&rfc3339(now_ms()), limit).await?;
        let mut purged = 0;
        for deleted in due {
            match self.purge_now(&deleted, None).await {
                Ok(()) => {
                    purged += 1;
                    let path = RepoPath {
                        namespace: deleted.namespace.clone(),
                        name: deleted.name.clone(),
                    };
                    self.record(vec![entry(
                        g1t_actor(),
                        "repo.purged",
                        None,
                        &path,
                        "schedule",
                        format!("Purged {RESTORE_DAYS} days after {} deleted it", deleted.deleted_by),
                    )])
                    .await;
                }
                Err(error) => worker::console_error!("{} not purged: {error}", deleted.id),
            }
        }
        Ok(purged)
    }

    /// Purges whatever deleted repositories a deleted workspace left.
    pub(crate) async fn purge_workspace(&self, namespace: &str) -> Result<()> {
        for deleted in self.registry.deleted_ids_in(namespace).await? {
            if let Err(error) = self.purge_now(&deleted, None).await {
                worker::console_error!("{} not purged with its workspace: {error}", deleted.id);
            }
        }
        Ok(())
    }

    /// `rename`: see `g1t_contracts::repos::RenameArgs`.
    pub(crate) async fn rename(&self, a: RenameArgs) -> Result<Outcome<Repo>> {
        let repo = match self.owned(&a.actor, &a.path, "rename", Capability::Administer).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let wanted = RepoPath {
            namespace: repo.namespace.clone(),
            name: a.name.trim().to_lowercase(),
        };
        let held = match self.registry.by_path_any(&wanted).await? {
            None => Held::Free,
            Some((_, None)) => Held::ByRepo,
            Some((_, Some(_))) => Held::ByDeleted,
        };
        let name = match new_name(&repo.namespace, &repo.name, &a.name, held) {
            Ok(name) => name,
            Err(refusal) => return Ok(fail(refusal)),
        };
        // The git store key stays what it was; the new path must not
        // change where it is read from.
        let key = store_key(&repo);
        self.registry.rename(&repo, &name).await?;
        let renamed = Repo {
            name: name.clone(),
            ..repo.clone()
        };
        remember_store(&renamed, &key);
        let from = path_of(&repo);
        let to = path_of(&renamed);
        if let Some(identity) = &self.identity {
            let moved: Result<bool> = g1t_kit::call(
                identity,
                "transfer_repo_scopes",
                &TransferRepoScopesArgs {
                    from: from.clone(),
                    to: to.clone(),
                },
            )
            .await;
            if let Err(error) = moved {
                worker::console_error!("agent scopes for {} not moved: {error}", repo.id);
            }
        }
        self.publish(NewEvent {
            kind: "repo.renamed",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoRenamed {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                from: repo.name.clone(),
                to: name.clone(),
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "repo.renamed",
            a.surface,
            &to,
            "owner",
            format!("Renamed from {}/{}", from.namespace, from.name),
        )])
        .await;
        Ok(Outcome::Ok(renamed))
    }

    /// `archive`: see `g1t_contracts::repos::ArchiveArgs`.
    pub(crate) async fn archive(&self, a: ArchiveArgs) -> Result<Outcome<Repo>> {
        let what = if a.archived { "archive" } else { "unarchive" };
        let repo = match self.owned(&a.actor, &a.path, what, Capability::Administer).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        if repo.archived() == a.archived {
            return Ok(Outcome::Ok(repo));
        }
        let at = a.archived.then(|| rfc3339(now_ms()));
        self.registry.set_archived(&repo.id, at.as_deref()).await?;
        let changed = Repo {
            archived_at: at,
            ..repo
        };
        let kind = if a.archived { "repo.archived" } else { "repo.unarchived" };
        self.publish(NewEvent {
            kind,
            source: SOURCE,
            repo_id: Some(changed.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoArchived {
                repo_id: changed.id.clone(),
                namespace: changed.namespace.clone(),
                name: changed.name.clone(),
                archived: a.archived,
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            kind,
            a.surface,
            &path_of(&changed),
            "owner",
            if a.archived {
                "Archived: read-only".to_owned()
            } else {
                "Unarchived".to_owned()
            },
        )])
        .await;
        Ok(Outcome::Ok(changed))
    }

    /// `set_visibility`: see `g1t_contracts::repos::SetVisibilityArgs`.
    pub(crate) async fn set_visibility(&self, a: SetVisibilityArgs) -> Result<Outcome<Repo>> {
        let repo = match self.owned(&a.actor, &a.path, "change the visibility of", Capability::Administer).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        if !confirmed(&path_of(&repo), &a.confirm) {
            return Ok(fail(confirm_refusal(&path_of(&repo))));
        }
        self.change_visibility(repo, a.is_private, &a.actor, a.surface).await
    }

    /// Makes `repo` public or private, if the workspace's storage allows,
    /// and says so: `repo.updated` and `repo.visibility_changed`. The
    /// caller has checked the actor may.
    pub(crate) async fn change_visibility(
        &self,
        repo: Repo,
        private: bool,
        actor: &User,
        surface: Option<Surface>,
    ) -> Result<Outcome<Repo>> {
        if repo.is_private == private {
            return Ok(Outcome::Ok(repo));
        }
        let facts = if private {
            VisibilityFacts {
                to_private: true,
                free: git_ops::is_free(self.billing.as_ref(), &repo.namespace).await,
                private_bytes: self.registry.private_bytes(&repo.namespace).await.unwrap_or(0),
                bytes: self.registry.stored_bytes(&repo.id).await?,
                free_private_bytes: self.free_private_bytes,
            }
        } else {
            VisibilityFacts::default()
        };
        if let Err(refusal) = visibility_check(&repo.namespace, &facts) {
            return Ok(fail(refusal));
        }
        self.registry.set_private(&repo.id, private).await?;
        let changed = Repo {
            is_private: private,
            ..repo
        };
        self.publish(NewEvent {
            kind: "repo.updated",
            source: SOURCE,
            repo_id: Some(changed.id.clone()),
            actor: Some(actor.id.clone()),
            data: RepoUpdated {
                repo_id: changed.id.clone(),
                namespace: changed.namespace.clone(),
                name: changed.name.clone(),
                is_private: private,
                visibility_changed: true,
            },
        })
        .await?;
        self.publish(NewEvent {
            kind: "repo.visibility_changed",
            source: SOURCE,
            repo_id: Some(changed.id.clone()),
            actor: Some(actor.id.clone()),
            data: RepoVisibilityChanged {
                repo_id: changed.id.clone(),
                is_private: private,
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(actor),
            "repo.visibility_changed",
            surface,
            &path_of(&changed),
            "owner",
            if private { "Made private".to_owned() } else { "Made public".to_owned() },
        )])
        .await;
        Ok(Outcome::Ok(changed))
    }

    /// The repository at `path` someone is changing the branches of:
    /// found, not a working copy, the actor allowed `capability` on it
    /// (Push to rename a branch, Administer to change the default),
    /// verified, and not archived.
    async fn writable_by(
        &self,
        actor: &User,
        path: &RepoPath,
        capability: Capability,
    ) -> Result<std::result::Result<Repo, Refusal>> {
        let viewer = Some(actor.clone());
        let Some(repo) = self.readable(path, &viewer).await? else {
            return Ok(Err((FailureCode::NotFound, "Repository not found.".into())));
        };
        if repo.fork_of.is_some() || !crate::registry::can(&repo, &viewer, capability) {
            return Ok(Err((
                FailureCode::Forbidden,
                access::needs(capability, &format!("{}/{}", repo.namespace, repo.name)),
            )));
        }
        if !actor.verified {
            return Ok(Err((FailureCode::Forbidden, UNVERIFIED.into())));
        }
        if let Some(refusal) = archived_refusal(&repo) {
            return Ok(Err(refusal));
        }
        Ok(Ok(repo))
    }

    /// `set_default_branch`: see `g1t_contracts::repos::SetDefaultBranchArgs`.
    pub(crate) async fn set_default_branch(&self, a: SetDefaultBranchArgs) -> Result<Outcome<Repo>> {
        let repo = match self.writable_by(&a.actor, &a.path, Capability::Administer).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let branch = a.branch.trim().to_owned();
        if branch == repo.default_branch {
            return Ok(Outcome::Ok(repo));
        }
        let git = self.store.open(&store_key(&repo)).await?;
        if !git.branches().await?.iter().any(|b| b.name == branch) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("There is no branch named {branch}. Push it first."),
            ));
        }
        self.registry.set_default_branch(&repo.id, &branch).await?;
        // HEAD in what git is told follows it.
        self.refs_moved(&repo.id).await;
        let from = repo.default_branch.clone();
        let changed = Repo {
            default_branch: branch.clone(),
            ..repo
        };
        self.forks_follow(&changed, &from, &branch, false).await;
        self.publish(NewEvent {
            kind: "repo.default_branch_changed",
            source: SOURCE,
            repo_id: Some(changed.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoDefaultBranchChanged {
                repo_id: changed.id.clone(),
                from: from.clone(),
                to: branch.clone(),
                renamed: false,
            },
        })
        .await?;
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "repo.default_branch_changed",
            a.surface,
            &path_of(&changed),
            "member",
            format!("Default branch changed from {from} to {branch}"),
        )])
        .await;
        Ok(Outcome::Ok(changed))
    }

    /// `rename_branch`: see `g1t_contracts::repos::RenameBranchArgs`.
    pub(crate) async fn rename_branch(&self, a: RenameBranchArgs) -> Result<Outcome<Repo>> {
        let repo = match self.writable_by(&a.actor, &a.path, Capability::Push).await? {
            Ok(repo) => repo,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let from = a.from.trim().to_owned();
        let is_default = from == repo.default_branch;
        if is_default
            && let Err(refusal) = admin_only(
                Asker::on(&a.actor, &repo),
                &repo.namespace,
                "rename the default branch of",
                Capability::Administer,
            )
        {
            return Ok(fail(refusal));
        }
        let git = self.store.open(&store_key(&repo)).await?;
        let branches = git.branches().await?;
        let names: Vec<String> = branches.iter().map(|b| b.name.clone()).collect();
        let to = match branch_rename(&from, &a.to, &names) {
            Ok(to) => to,
            Err(refusal) => return Ok(fail(refusal)),
        };
        let Some(head) = branches.iter().find(|b| b.name == from).map(|b| b.hash.clone()) else {
            return Ok(not_found());
        };
        let access = git.access(Scope::Write).await?;
        let made = land::push_pack(&access, &to, None, &head, EMPTY_PACK.to_vec()).await?;
        self.refs_moved(&repo.id).await;
        if let Err(reason) = made {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{to} could not be made: {reason}")));
        }
        // The default moves before the old name goes, so it never names a
        // branch that is not there.
        if is_default {
            self.registry.set_default_branch(&repo.id, &to).await?;
        }
        let removed = land::delete_ref(&access, &from, &head).await;
        self.refs_moved(&repo.id).await;
        if let Err(reason) = removed? {
            worker::console_error!("{from} not removed after renaming it to {to}: {reason}");
        }
        self.registry.add_branch_redirect(&repo.id, &from, &to).await?;
        let changed = if is_default {
            Repo {
                default_branch: to.clone(),
                ..repo
            }
        } else {
            repo
        };
        if is_default {
            self.forks_follow(&changed, &from, &to, true).await;
        }
        self.publish(NewEvent {
            kind: "branch.renamed",
            source: SOURCE,
            repo_id: Some(changed.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: BranchRenamed {
                repo_id: changed.id.clone(),
                from: from.clone(),
                to: to.clone(),
                default_branch: is_default,
            },
        })
        .await?;
        if is_default {
            self.publish(NewEvent {
                kind: "repo.default_branch_changed",
                source: SOURCE,
                repo_id: Some(changed.id.clone()),
                actor: Some(a.actor.id.clone()),
                data: RepoDefaultBranchChanged {
                    repo_id: changed.id.clone(),
                    from: from.clone(),
                    to: to.clone(),
                    renamed: true,
                },
            })
            .await?;
        }
        self.record(vec![entry(
            AuditActor::of(&a.actor),
            "branch.renamed",
            a.surface,
            &path_of(&changed),
            if is_default { "owner" } else { "member" },
            format!("Branch {from} renamed to {to}"),
        )])
        .await;
        Ok(Outcome::Ok(changed))
    }

    /// Pull requests' working copies name their branch after the default
    /// branch of the repository they came from. When it changes, the
    /// newest of them get a branch of the new name at the same commit (and,
    /// for a rename, lose the old one), so agents and merges find it.
    /// Best effort: a copy that cannot follow is logged and left.
    async fn forks_follow(&self, repo: &Repo, from: &str, to: &str, renamed: bool) {
        let forks = match self.registry.forks_of(&repo.id, FORKS_FOLLOWING).await {
            Ok(forks) => forks,
            Err(error) => {
                worker::console_error!("working copies of {} not listed: {error}", repo.id);
                return;
            }
        };
        for fork in forks {
            let followed: Result<()> = async {
                let git = self.store.open(&store_key(&fork)).await?;
                let branches = git.branches().await?;
                let Some(head) = branches.iter().find(|b| b.name == from).map(|b| b.hash.clone()) else {
                    return Ok(());
                };
                let access = git.access(Scope::Write).await?;
                if !branches.iter().any(|b| b.name == to) {
                    let made = land::push_pack(&access, to, None, &head, EMPTY_PACK.to_vec()).await;
                    self.refs_moved(&fork.id).await;
                    if let Err(reason) = made? {
                        worker::console_error!("working copy {} did not get {to}: {reason}", fork.id);
                        return Ok(());
                    }
                }
                self.registry.set_default_branch(&fork.id, to).await?;
                if renamed {
                    let removed = land::delete_ref(&access, from, &head).await;
                    self.refs_moved(&fork.id).await;
                    if let Err(reason) = removed? {
                        worker::console_error!("working copy {} kept {from}: {reason}", fork.id);
                    }
                }
                Ok(())
            }
            .await;
            if let Err(error) = followed {
                worker::console_error!("working copy {} did not follow {from} → {to}: {error}", fork.id);
            }
        }
    }

    /// `resolve_branch`: see `g1t_contracts::repos::ResolveBranchArgs`.
    pub(crate) async fn resolve_branch(&self, a: ResolveBranchArgs) -> Result<Option<String>> {
        let Some(now) = self.registry.branch_redirect(&a.repo_id, &a.branch).await? else {
            return Ok(None);
        };
        // A branch made again under the old name ends the redirect.
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(None);
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let branches = git.branches().await?;
        if branches.iter().any(|b| b.name == a.branch) || !branches.iter().any(|b| b.name == now) {
            return Ok(None);
        }
        Ok(Some(now))
    }

    /// `status_by_id`: see `g1t_contracts::repos::StatusByIdArgs`.
    pub(crate) async fn status_by_id(&self, a: StatusByIdArgs) -> Result<RepoStatus> {
        self.registry.status(&a.id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Asker {
        Asker {
            person: true,
            verified: true,
            role: Some(Role::Owner),
            repo_role: Some(RepoRole::Admin),
        }
    }

    fn path() -> RepoPath {
        RepoPath {
            namespace: "acme".into(),
            name: "rocket".into(),
        }
    }

    #[test]
    fn only_a_verified_person_who_owns_the_workspace_may() {
        assert!(owner_only(owner(), "acme", "delete").is_ok());
        let member = Asker { role: Some(Role::Member), ..owner() };
        let (code, message) = owner_only(member, "acme", "delete").unwrap_err();
        assert_eq!(code, FailureCode::Forbidden);
        assert_eq!(message, "Only an owner of acme can delete its repositories.");
        assert_eq!(owner_only(Asker { person: false, ..owner() }, "acme", "delete").unwrap_err().0, FailureCode::Forbidden);
        assert_eq!(owner_only(Asker { verified: false, ..owner() }, "acme", "delete").unwrap_err().0, FailureCode::Forbidden);
        // Outside the workspace, a private repository is not there at all.
        assert_eq!(owner_only(Asker { role: None, ..owner() }, "acme", "delete").unwrap_err().0, FailureCode::NotFound);
    }

    /// Renaming, archiving and changing visibility take Admin on the
    /// repository, which a direct grant can give; deleting and
    /// transferring still take an owner of the workspace.
    #[test]
    fn admin_on_the_repository_may_administer_but_not_delete() {
        let admin = Asker { role: None, repo_role: Some(RepoRole::Admin), ..owner() };
        assert!(admin_only(admin, "acme", "rename", Capability::Administer).is_ok());
        let (code, message) = admin_only(admin, "acme", "delete", Capability::Delete).unwrap_err();
        assert_eq!(code, FailureCode::Forbidden);
        assert_eq!(message, "Only an owner of acme can delete its repositories.");
        let member_admin = Asker { role: Some(Role::Member), ..admin };
        assert_eq!(admin_only(member_admin, "acme", "delete", Capability::Delete).unwrap_err().0, FailureCode::Forbidden);
        // Write (the default base permission) cannot rename.
        let writer = Asker { role: Some(Role::Member), repo_role: Some(RepoRole::Write), ..owner() };
        let (code, message) = admin_only(writer, "acme", "rename", Capability::Administer).unwrap_err();
        assert_eq!(code, FailureCode::Forbidden);
        assert_eq!(message, "You need the Admin role on a repository of acme to rename it.");
        // Someone who can read a public repository is refused, not told it is missing.
        let reader = Asker { role: None, repo_role: Some(RepoRole::Read), ..owner() };
        assert_eq!(admin_only(reader, "acme", "archive", Capability::Administer).unwrap_err().0, FailureCode::Forbidden);
        let stranger = Asker { role: None, repo_role: None, ..owner() };
        assert_eq!(admin_only(stranger, "acme", "archive", Capability::Administer).unwrap_err().0, FailureCode::NotFound);
        assert_eq!(admin_only(Asker { person: false, ..owner() }, "acme", "rename", Capability::Administer).unwrap_err().0, FailureCode::Forbidden);
    }

    #[test]
    fn the_full_name_confirms_in_any_case() {
        assert!(confirmed(&path(), "acme/rocket"));
        assert!(confirmed(&path(), " ACME/Rocket "));
        assert!(!confirmed(&path(), "rocket"));
        assert!(!confirmed(&path(), ""));
    }

    #[test]
    fn a_deleted_repository_is_restorable_for_thirty_days_then_due() {
        let deleted_at = 1_790_000_000_000u64;
        let purge = purge_after(deleted_at);
        assert_eq!(purge, rfc3339(deleted_at + 30 * 86_400_000));
        let day = 86_400_000u64;
        let at = |ms: u64| rfc3339(ms);
        assert_eq!(state(None, None, &at(deleted_at)), State::Active);
        assert_eq!(state(Some("2026-10-01T00:00:00.000Z"), None, &at(deleted_at)), State::Archived);
        let deleted = Some((at(deleted_at), purge.clone()));
        let deleted = deleted.as_ref().map(|(a, b)| (a.as_str(), b.as_str()));
        assert_eq!(state(None, deleted, &at(deleted_at + day)), State::Deleted);
        assert_eq!(state(None, deleted, &at(deleted_at + 30 * day - 1)), State::Deleted);
        assert_eq!(state(None, deleted, &at(deleted_at + 30 * day)), State::Due);
        // Archived and then deleted: deleted is what counts.
        assert_eq!(state(Some("x"), deleted, &at(deleted_at + day)), State::Deleted);
        assert!(restorable(&purge, &at(deleted_at + 29 * day)));
        assert!(!restorable(&purge, &at(deleted_at + 31 * day)));
    }

    #[test]
    fn a_rename_needs_a_valid_free_name() {
        assert_eq!(new_name("acme", "rocket", " Booster ", Held::Free).unwrap(), "booster");
        assert_eq!(new_name("acme", "rocket", "rocket", Held::Free).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(new_name("acme", "rocket", "no spaces", Held::Free).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(new_name("acme", "rocket", "x.git", Held::Free).unwrap_err().0, FailureCode::Invalid);
        let (code, message) = new_name("acme", "rocket", "booster", Held::ByRepo).unwrap_err();
        assert_eq!(code, FailureCode::Conflict);
        assert_eq!(message, "acme already has a repository named booster.");
        let (code, message) = new_name("acme", "rocket", "booster", Held::ByDeleted).unwrap_err();
        assert_eq!(code, FailureCode::Conflict);
        assert!(message.contains("deleted recently"));
    }

    fn repo(archived: bool) -> Repo {
        Repo {
            id: "rep_1".into(),
            namespace: "acme".into(),
            name: "rocket".into(),
            description: None,
            is_private: false,
            owner_id: "usr_1".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: false,
            created_at: String::new(),
            topics: Vec::new(),
            website: None,
            archived_at: archived.then(|| "2026-10-05T00:00:00.000Z".to_owned()),
        }
    }

    #[test]
    fn an_archived_repository_refuses_writes_with_the_reason() {
        assert!(archived_refusal(&repo(false)).is_none());
        let (code, message) = archived_refusal(&repo(true)).unwrap();
        assert_eq!(code, FailureCode::Forbidden);
        assert_eq!(message, "acme/rocket is archived, so it is read-only. An owner can unarchive it in its settings.");
    }

    #[test]
    fn going_private_on_a_free_workspace_needs_room() {
        let full = VisibilityFacts {
            to_private: true,
            free: true,
            private_bytes: 900_000_000,
            bytes: 200_000_000,
            free_private_bytes: 1_000_000_000,
        };
        assert_eq!(visibility_check("acme", &full).unwrap_err().0, FailureCode::PaymentRequired);
        assert!(visibility_check("acme", &VisibilityFacts { free: false, ..full }).is_ok());
        let full = VisibilityFacts {
            to_private: true,
            free: true,
            private_bytes: 900_000_000,
            bytes: 200_000_000,
            free_private_bytes: 1_000_000_000,
        };
        // Going public is never refused.
        assert!(visibility_check("acme", &VisibilityFacts { to_private: false, ..full }).is_ok());
        let light = VisibilityFacts {
            to_private: true,
            free: true,
            private_bytes: 1_000,
            bytes: 1_000,
            free_private_bytes: 1_000_000_000,
        };
        assert!(visibility_check("acme", &light).is_ok());
    }

    #[test]
    fn a_branch_is_renamed_to_a_free_valid_name() {
        let branches = vec!["main".to_owned(), "dev".to_owned()];
        assert_eq!(branch_rename("main", " trunk ", &branches).unwrap(), "trunk");
        assert_eq!(branch_rename("nope", "trunk", &branches).unwrap_err().0, FailureCode::NotFound);
        assert_eq!(branch_rename("main", "dev", &branches).unwrap_err().0, FailureCode::Conflict);
        assert_eq!(branch_rename("main", "main", &branches).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(branch_rename("main", "a b", &branches).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(branch_rename("main", "g1t-queue", &branches).unwrap_err().0, FailureCode::Invalid);
    }

    #[test]
    fn the_empty_pack_is_well_formed() {
        assert_eq!(EMPTY_PACK.len(), 32);
        assert!(EMPTY_PACK.starts_with(b"PACK\0\0\0\x02\0\0\0\0"));
    }
}
