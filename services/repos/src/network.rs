//! Forks people make into their workspaces: a fork network.
//!
//! A fork is an ordinary repository of the workspace it goes in, with its
//! own access, settings, rules and pull requests, that remembers the
//! repository it came from (`parent_id`). That is all it shares: it can be
//! synced from its parent and can open pull requests into it. It is not a
//! pull request's working copy (`fork_of`, namespace `pulls`, forks.rs),
//! which is hidden, belongs to one pull request and goes with its source.
//!
//! What a fork gets is what a fork gets elsewhere: the code (the default
//! branch, or every branch and tag), and its project starts with the source
//! project's description. Settings, secrets and variables, rules, webhooks,
//! environments, domains and deployments
//! stay behind, and the actions service keeps a fork's workflows off until
//! someone turns them on.
//!
//! Where it is stored: an Artifacts fork stays in its source's namespace,
//! so it is made there unless the workspace keeps its data in the EU and
//! the source is not there; then the code is copied into the EU namespace
//! instead. Either way its size counts toward the workspace it goes in, in
//! full: whether Artifacts shares a fork's objects with its source is not
//! documented, so a fork is never assumed to be cheaper than a copy.
//!
//! Who can see it: a fork is exactly as visible as its parent when it is
//! made, and cannot change that while it is a fork. When the parent goes
//! public or private, its forks are detached and keep what they were. A
//! private repository is forked only when its admins allow it.

use std::collections::HashSet;

use futures_util::future::try_join;
use g1t_contracts::access::Capability;
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::events::{NewEvent, RepoCreated, RepoForked};
use g1t_contracts::repos::{
    DetachForkArgs, ForkRepoArgs, ForksArgs, PullBranchUpdate, Repo, RepoPath, SyncForkArgs, SyncStatus, SyncedFork,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, Viewer, is_valid_repo_name, new_id};
use g1t_kit::now_ms;
use worker::Result;

use crate::lifecycle::{VisibilityFacts, visibility_check};
use crate::public_storage::{self, Operation};
use crate::registry::{RepoRow, can, can_read, can_write, store_key};
use crate::store::{GitRepo, GitStore, Scope, locate};
use crate::{MAX_ANCESTRY, Repos, SOURCE, UNVERIFIED, copy, descends_from, land, lifecycle, not_found, shards};

/// The most forks `forks` lists.
const MAX_LISTED: u32 = 100;
/// The most conflicting files `sync_fork` names.
const MAX_CONFLICTS: usize = 20;
/// How many private forks one sweep checks, the least recently checked
/// first.
const CHECKS_PER_SWEEP: u32 = 50;

type Refusal = (FailureCode, String);

/// Why `source` may not be forked, if it may not. `None` when it may.
pub fn fork_refusal(source: &Repo) -> Option<Refusal> {
    if source.fork_of.is_some() {
        return Some((
            FailureCode::Invalid,
            "A pull request's working copy cannot be forked; fork the repository it belongs to.".to_owned(),
        ));
    }
    if source.is_private && !source.allow_forking {
        return Some((
            FailureCode::Forbidden,
            format!(
                "{}/{} is private, and its admins have not allowed forking it. They can in its settings.",
                source.namespace, source.name
            ),
        ));
    }
    None
}

/// Whether a fork made into `namespace` with store key `wanted` can be an
/// Artifacts fork of a source kept in `source_namespace`: the same store
/// namespace, and the workspace's residency allows it there.
pub fn forks_in_place(source_namespace: &str, residency: shards::Residency, eu: Option<&str>) -> bool {
    match residency {
        shards::Residency::Anywhere => true,
        shards::Residency::Eu => eu == Some(source_namespace),
    }
}

/// The branch of the parent a fork's `branch` follows: the parent's
/// default branch for the fork's default branch, the same name otherwise.
pub fn upstream_branch(branch: &str, fork: &Repo, parent: &Repo) -> String {
    if branch == fork.default_branch { parent.default_branch.clone() } else { branch.to_owned() }
}

/// How many commits of `history` (newest first) come before any of
/// `known`: what one side has that the other lacks, as far as either was
/// read.
pub fn not_in(history: &[g1t_contracts::repos::Commit], known: &HashSet<&str>) -> u32 {
    history.iter().take_while(|commit| !known.contains(commit.hash.as_str())).count() as u32
}

/// The most merge commits whose other parents `reachable` follows.
const MERGES_FOLLOWED: usize = 10;

/// The commits `history` (a first-parent log, newest first) reaches: those
/// it lists, and the first-parent history of the other parents of its
/// first [`MERGES_FOLLOWED`] merge commits, so commits a sync merged in
/// count as had.
async fn reachable<R: GitRepo>(git: &R, history: &[g1t_contracts::repos::Commit]) -> Result<HashSet<String>> {
    let mut known: HashSet<String> = history.iter().map(|commit| commit.hash.clone()).collect();
    let merged: Vec<&String> = history
        .iter()
        .filter(|commit| commit.parents.len() > 1)
        .take(MERGES_FOLLOWED)
        .flat_map(|commit| commit.parents.iter().skip(1))
        .collect();
    for parent in merged {
        if known.contains(parent) {
            continue;
        }
        known.extend(git.log(parent, MAX_ANCESTRY).await?.into_iter().map(|commit| commit.hash));
    }
    Ok(known)
}

impl<S: GitStore> Repos<S> {
    /// `fork`: see `ForkRepoArgs`.
    pub(crate) async fn fork(&self, a: ForkRepoArgs) -> Result<Outcome<Repo>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let viewer = Some(a.actor.clone());
        let Some(source) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        if let Some((code, message)) = fork_refusal(&source) {
            return Ok(Outcome::fail(code, message));
        }
        let name = a.name.as_deref().map(str::trim).filter(|name| !name.is_empty()).unwrap_or(&source.name).to_lowercase();
        if !is_valid_repo_name(&name) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Use letters, digits, dots, hyphens and underscores only."));
        }
        let namespace = a.namespace.trim().to_lowercase();
        if namespace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which workspace to fork the repository into."));
        }
        let Some(role) = a.actor.role_in(&namespace) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "You are not a member of that workspace."));
        };
        let role = if a.actor.kind == PrincipalKind::Workspace { Role::Owner } else { role };
        if let Some(why) = a.actor.privileges_in(&namespace).creation_refusal(role, source.is_private, &namespace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        let path = RepoPath { namespace: namespace.clone(), name };
        if path.namespace == source.namespace && path.name == source.name {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "A repository cannot be forked onto itself. Choose another name or workspace.",
            ));
        }
        match self.registry.by_path_any(&path).await? {
            Some((_, None)) => {
                return Ok(Outcome::fail(FailureCode::Conflict, "That workspace already has a repository with that name."));
            }
            Some((_, Some(_))) => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!(
                        "{}/{} was deleted recently and can still be restored, so its name is taken. Restore it, or delete it permanently from the workspace's Recently deleted list.",
                        path.namespace, path.name
                    ),
                ));
            }
            None => {}
        }
        // Its copy is made in the source's store namespace: not while that
        // moves (moves.rs).
        let source = match self.unpaused(source).await? {
            Ok(source) => source,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        // A fork counts toward its workspace in full, so a free workspace's
        // private storage has to have room for all of it.
        let bytes = self.registry.stored_bytes(&source.id).await?;
        if source.is_private {
            let facts = VisibilityFacts {
                to_private: true,
                free: crate::git_ops::is_free(self.billing.as_ref(), &namespace).await,
                private_bytes: self.registry.private_bytes(&namespace).await.unwrap_or(0),
                bytes,
                free_private_bytes: self.free_private_bytes,
            };
            if let Err((code, message)) = visibility_check(&namespace, &facts) {
                return Ok(Outcome::fail(code, message));
            }
        }

        let now = now_ms();
        let fork = Repo {
            id: new_id("rep", now),
            namespace: path.namespace,
            name: path.name,
            is_private: source.is_private,
            owner_id: a.actor.id.clone(),
            default_branch: source.default_branch.clone(),
            fork_of: None,
            parent_id: Some(source.id.clone()),
            forked_from: Some(source.id.clone()),
            parent: Some(RepoPath { namespace: source.namespace.clone(), name: source.name.clone() }),
            allow_forking: false,
            max_ref_updates: None,
            protected: false,
            created_at: rfc3339(now),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        };
        let default = self.store.default_namespace();
        let (source_namespace, _) = locate(&store_key(&source));
        let residency = self.residency_of(&fork.namespace).await?;
        if forks_in_place(&source_namespace, residency, self.placement.eu.as_deref()) {
            if !self.registry.lock_copy(&source, &fork).await? {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "This repository is already being copied. Try again after the copy finishes.",
                ));
            }
            let (measured, pending) = self.registry.copy_size(&source).await?;
            let bytes = measured.saturating_add(pending);
            self.registry.claim_store_key(&fork, Some(&source_namespace), &default).await?;
            self.registry.insert(&fork).await?;
            let Ok(reservation) =
                self.registry.reserve_public(&fork, bytes, self.free_public_bytes, Operation::Fork, Some(&a.actor.id)).await?
            else {
                self.registry.remove(&fork.id).await?;
                self.registry.unlock_copy(&source, &fork).await?;
                return Ok(Outcome::fail(FailureCode::Forbidden, "This fork would exceed the workspace's public storage limit."));
            };
            let forked = match self.store.open(&store_key(&source)).await {
                Ok(source_git) => source_git.fork(&store_key(&fork), a.default_branch_only).await,
                Err(error) => {
                    // The store was never asked to copy anything.
                    self.registry.release_public(&reservation).await?;
                    self.registry.unlock_copy(&source, &fork).await?;
                    return Err(error);
                }
            };
            if let Err(error) = forked {
                let message = error.to_string();
                if public_storage::may_still_run(&message) {
                    // A timeout or a server error: the store may still be
                    // copying. The lock stays until staff release it, at
                    // the soonest once its lease and grace have passed
                    // (storage_holds.rs), and the reservation stays, ended.
                    // Its source takes no writes until then, and its
                    // writers are told the copy did not
                    // finish cleanly (public_storage.rs `Refusal::Stalled`);
                    // sudo's Overview and Storage holds show it.
                    self.registry.end_public(&reservation, &message, &[]).await;
                    worker::console_error!("{}", serde_json::json!({ "copy_lock_kept": source.id, "fork": fork.id, "error": message }));
                } else {
                    // The store refused, or was never asked: nothing is
                    // copying and nothing was copied.
                    self.registry.release_public(&reservation).await?;
                    self.registry.unlock_copy(&source, &fork).await?;
                }
                return Err(error);
            }
            // The settle first, so nothing after it can leave the fork
            // unbilled: the whole reservation goes, the source's in-flight
            // share with it, and the fork is counted at what was measured,
            // what it is billed from (stored_bytes). A fork counts in full
            // by policy, even of its default branch only. Then the lock;
            // an unlock that fails is said, never returned, so the settle
            // is neither skipped nor made twice, and the lock is left for
            // staff (it reads as stalled, public_storage.rs COPY_LOCKED).
            self.registry.finish_public(&reservation, measured).await?;
            let gone = match self.registry.unlock_copy(&source, &fork).await {
                Ok(unlocked) => !unlocked,
                Err(error) => {
                    worker::console_error!(
                        "{}",
                        serde_json::json!({ "copy_unlock_failed": source.id, "fork": fork.id, "error": error.to_string() })
                    );
                    false
                }
            };
            if gone {
                // Staff released the lock while the store copied, so the
                // source may have taken writes the fork holds and the count
                // misses.
                // `measured` is the source's stored_bytes taken right after
                // the lock, and stored_bytes only grows, so the count is a
                // lower bound and never more than the fork holds. Said for
                // staff, whose drift report measures what it holds.
                worker::console_warn!(
                    "{}",
                    serde_json::json!({
                        "fork_outlived_copy_lock": fork.id, "source": source.id, "measured_bytes": measured,
                        "note": "The fork was made after staff released its copy lock: it is counted at its source's measured size, and may hold more.",
                    })
                );
            }
        } else {
            // Kept in the EU: copied there, never forked across.
            let placed = match self.place(&fork).await? {
                Ok(placed) => placed,
                Err(unplaced) => return Ok(Outcome::fail(FailureCode::Conflict, unplaced.message())),
            };
            self.registry.claim_store_key(&fork, placed.as_deref(), &default).await?;
            self.registry.insert(&fork).await?;
            self.store.create(&store_key(&fork), None, &fork.default_branch).await?;
            let from = self.store.open(&store_key(&source)).await?.access(Scope::Read).await?;
            let to = self.store.open(&store_key(&fork)).await?.access(Scope::Write).await?;
            let copied = if a.default_branch_only {
                let head = self.store.open(&store_key(&source)).await?.log(&source.default_branch, 1).await?;
                match head.first() {
                    Some(head) => {
                        match land::fast_forward(
                            &from,
                            &to,
                            &fork.default_branch,
                            None,
                            &head.hash,
                            self.public_quota(&fork, Operation::Fork, Some(&a.actor.id)),
                        )
                        .await?
                        {
                            Ok(moved) => moved,
                            // Refused a reservation: said as a full copy's
                            // refusal is (copy.rs `Problem::Refused`).
                            Err(refusal) => Err(refusal.message()),
                        }
                    }
                    None => Ok(()),
                }
            } else {
                let held = std::cell::RefCell::new(None);
                let copied = copy::copy(
                    &copy::Endpoint::bearer(&from.remote, &from.token),
                    &copy::Endpoint::bearer(&to.remote, &to.token),
                    |bytes| self.hold_into(&held, &fork, bytes, Operation::Fork, Some(&a.actor.id)),
                )
                .await;
                let held = held.into_inner();
                match (copied, held) {
                    (Ok(Ok(copied)), Some(reservation)) => {
                        self.registry.finish_public(&reservation, copied.pack_bytes).await?;
                        Ok(())
                    }
                    (Ok(Ok(_)), None) => Ok(()),
                    // Sent, and the store said no or stopped answering.
                    (Ok(Err(problem)), Some(reservation)) => {
                        self.registry.end_public(&reservation, &problem.to_string(), &[]).await;
                        Err(problem.to_string())
                    }
                    (Ok(Err(problem)), None) => Err(problem.to_string()),
                    (Err(error), held) => {
                        if let Some(reservation) = held {
                            self.registry.end_public(&reservation, &error.to_string(), &[]).await;
                        }
                        return Err(error);
                    }
                }
            };
            if let Err(reason) = copied {
                return Ok(Outcome::fail(FailureCode::Unavailable, format!("The fork could not be copied: {reason}")));
            }
        }
        self.registry.drop_redirect(&RepoPath { namespace: fork.namespace.clone(), name: fork.name.clone() }).await?;
        self.refs_moved(&fork.id).await;
        // Whoever forks a repository is an Admin of the fork.
        if a.actor.kind == PrincipalKind::User {
            self.grant_creator(&fork, &a.actor.id).await;
        }
        let surface = a.surface.unwrap_or(Surface::Web);
        self.record_fork(&a.actor, "repo.forked", surface, &fork, format!("Forked from {}/{}", source.namespace, source.name)).await;
        if source.namespace != fork.namespace {
            self.record_fork(&a.actor, "repo.forked", surface, &source, format!("Forked to {}/{}", fork.namespace, fork.name)).await;
        }
        self.publish(NewEvent {
            kind: "repo.created",
            source: SOURCE,
            repo_id: Some(fork.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoCreated {
                repo_id: fork.id.clone(),
                namespace: fork.namespace.clone(),
                name: fork.name.clone(),
                is_private: fork.is_private,
                parent_id: Some(source.id.clone()),
            },
        })
        .await?;
        self.publish(NewEvent {
            kind: "repo.forked",
            source: SOURCE,
            repo_id: Some(source.id.clone()),
            actor: Some(a.actor.id),
            data: RepoForked { repo_id: fork.id.clone(), source_repo_id: source.id, pull_id: None },
        })
        .await?;
        Ok(Outcome::Ok(fork))
    }

    /// `forks`: see `ForksArgs`.
    pub(crate) async fn forks(&self, a: ForksArgs) -> Result<Outcome<Vec<Repo>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let limit = a.limit.unwrap_or(30).clamp(1, MAX_LISTED);
        let rows = self
            .registry
            .db
            .prepare("SELECT * FROM repos WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?")
            .bind(&[repo.id.as_str().into(), (limit * 2).into()])?
            .all()
            .await?
            .results::<RepoRow>()?;
        let parent = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(Repo::from)
                .filter(|fork| can_read(fork, &a.viewer))
                .take(limit as usize)
                .map(|mut fork| {
                    fork.parent = Some(parent.clone());
                    fork
                })
                .collect(),
        ))
    }

    /// Fills in where a fork's parent is, when the viewer may read it.
    pub(crate) async fn with_parent(&self, mut repo: Repo, viewer: &Viewer) -> Result<Repo> {
        if let Some(parent_id) = &repo.parent_id {
            repo.parent = self
                .registry
                .by_id(parent_id)
                .await?
                .filter(|parent| can_read(parent, viewer))
                .map(|parent| RepoPath { namespace: parent.namespace, name: parent.name });
        }
        Ok(repo)
    }

    /// `sync_fork`: see `SyncForkArgs`.
    pub(crate) async fn sync_fork(&self, a: SyncForkArgs) -> Result<Outcome<SyncedFork>> {
        let viewer = Some(a.actor.clone());
        let Some(fork) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        let full_name = format!("{}/{}", fork.namespace, fork.name);
        let Some(parent_id) = fork.parent_id.clone() else {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{full_name} is not a fork.")));
        };
        if !can_write(&fork, &viewer) {
            return Ok(Outcome::fail(FailureCode::Forbidden, g1t_contracts::access::needs(Capability::Push, &full_name)));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        if let Some((code, message)) = lifecycle::read_only_refusal(&fork) {
            return Ok(Outcome::fail(code, message));
        }
        let Some(parent) = self.registry.by_id(&parent_id).await?.filter(|parent| can_read(parent, &viewer)) else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("The repository {full_name} was forked from is gone, or you can no longer read it."),
            ));
        };
        let (fork, parent) = match (self.unpaused(fork).await?, self.unpaused(parent).await?) {
            (Ok(fork), Ok(parent)) => (fork, parent),
            (Err((code, message)), _) | (_, Err((code, message))) => return Ok(Outcome::fail(code, message)),
        };
        let branch = a.branch.as_deref().map(str::trim).filter(|branch| !branch.is_empty()).unwrap_or(&fork.default_branch).to_owned();
        let upstream = upstream_branch(&branch, &fork, &parent);
        let fork_git = self.store.open(&store_key(&fork)).await?;
        let parent_git = self.store.open(&store_key(&parent)).await?;
        let (ours, theirs) = try_join(fork_git.log(&branch, MAX_ANCESTRY), parent_git.log(&upstream, MAX_ANCESTRY)).await?;
        let Some(head) = ours.first().cloned() else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{full_name} has no branch named {branch}.")));
        };
        let Some(their_head) = theirs.first().cloned() else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("{}/{} has no branch named {upstream} to sync from.", parent.namespace, parent.name),
            ));
        };
        let (our_reach, their_reach) = try_join(reachable(&fork_git, &ours), reachable(&parent_git, &theirs)).await?;
        let our_hashes: HashSet<&str> = our_reach.iter().map(String::as_str).collect();
        let their_hashes: HashSet<&str> = their_reach.iter().map(String::as_str).collect();
        let behind = not_in(&theirs, &our_hashes);
        let ahead = not_in(&ours, &their_hashes);
        let synced = |status, head: String, conflicts| SyncedFork { status, branch: branch.clone(), head, behind, ahead, conflicts };
        if descends_from(&fork_git, &ours, &their_head.hash).await? {
            return Ok(Outcome::Ok(synced(SyncStatus::UpToDate, head.hash, Vec::new())));
        }
        if descends_from(&parent_git, &theirs, &head.hash).await? {
            // Only behind: the branch moves to where the parent's is, if it
            // is still where it was, and if the fork's rules for the branch
            // allow the push (rules.rs). Its commits are not read here, so a
            // rule about what commits hold refuses it rather than pass.
            let change = g1t_rules::push::RefChange {
                git_ref: format!("refs/heads/{branch}"),
                old: Some(head.hash.clone()),
                new: Some(their_head.hash.clone()),
                fast_forward: Some(true),
                commits: Vec::new(),
                complete: false,
            };
            if let crate::rules::Ruled::Refused { message, .. } =
                self.check_changes(&fork, &a.actor, g1t_contracts::rules::Action::Push, vec![change]).await?
            {
                return Ok(Outcome::fail(FailureCode::Forbidden, message));
            }
            let from = parent_git.access(Scope::Read).await?;
            let to = fork_git.access(Scope::Write).await?;
            let moved = land::fast_forward(
                &from,
                &to,
                &branch,
                Some(&head.hash),
                &their_head.hash,
                self.public_quota(&fork, Operation::Sync, Some(&a.actor.id)),
            )
            .await?;
            self.refs_moved(&fork.id).await;
            let moved = match moved {
                Ok(moved) => moved,
                // Refused a reservation on the way: said as every write
                // from the site says it (public_storage.rs `Refusal`).
                Err(refusal) => return Ok(refusal.outcome()),
            };
            if moved.is_err() {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("{branch} moved while it was being synced. Nothing was lost; try again."),
                ));
            }
            let git_ref = format!("refs/heads/{branch}");
            self.publish_push(&fork, &git_ref, Some(&head.hash), &their_head.hash, Some(&a.actor), Some(behind)).await?;
            return Ok(Outcome::Ok(synced(SyncStatus::FastForwarded, their_head.hash, Vec::new())));
        }
        let message = format!("Merge {}/{}:{upstream} into {branch}", parent.namespace, parent.name);
        let merged = self.merge_up(fork, parent, branch.clone(), upstream, &a.actor, message, None).await?;
        Ok(match merged {
            Outcome::Ok(PullBranchUpdate::Updated { commit, .. }) => Outcome::Ok(synced(SyncStatus::Merged, commit, Vec::new())),
            Outcome::Ok(PullBranchUpdate::UpToDate { commit }) => Outcome::Ok(synced(SyncStatus::UpToDate, commit, Vec::new())),
            Outcome::Ok(PullBranchUpdate::NeedsAgent { paths, .. }) => {
                Outcome::Ok(synced(SyncStatus::Conflicted, head.hash, paths.into_iter().take(MAX_CONFLICTS).collect()))
            }
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    /// `detach_fork`: see `DetachForkArgs`.
    pub(crate) async fn detach_fork(&self, a: DetachForkArgs) -> Result<Outcome<Repo>> {
        let viewer = Some(a.actor.clone());
        let Some(fork) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        let full_name = format!("{}/{}", fork.namespace, fork.name);
        if fork.parent_id.is_none() {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{full_name} is not a fork.")));
        }
        if !can(&fork, &viewer, Capability::Administer) {
            return Ok(Outcome::fail(FailureCode::Forbidden, g1t_contracts::access::needs(Capability::Administer, &full_name)));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        self.registry.detach(&fork.id).await?;
        if let Some(parent_id) = &fork.parent_id {
            self.publish_detached(&fork.id, parent_id).await?;
        }
        self.record_fork(&a.actor, "repo.detached", a.surface.unwrap_or(Surface::Web), &fork, "Detached from its fork network".to_owned())
            .await;
        let mut detached = fork;
        detached.parent_id = None;
        detached.parent = None;
        Ok(Outcome::Ok(detached))
    }

    /// The hourly check of private forks: one whose maker can no longer
    /// read the repository it came from is deleted, restorable for
    /// `RESTORE_DAYS` days, as its workspace's owners would delete it. A
    /// fork made with a workspace's own token, or whose parent is gone or
    /// public, is kept. Returns how many were deleted.
    pub(crate) async fn check_private_forks(&self) -> Result<usize> {
        let Some(identity) = &self.identity else { return Ok(0) };
        let forks = self
            .registry
            .db
            .prepare(
                "SELECT * FROM repos WHERE parent_id IS NOT NULL AND is_private = 1 AND deleted_at IS NULL
                 ORDER BY COALESCE(fork_checked_ms, 0) LIMIT ?",
            )
            .bind(&[CHECKS_PER_SWEEP.into()])?
            .all()
            .await?
            .results::<RepoRow>()?;
        let now = now_ms();
        let mut deleted = 0;
        for fork in forks.into_iter().map(Repo::from) {
            self.registry
                .db
                .prepare("UPDATE repos SET fork_checked_ms = ? WHERE id = ?")
                .bind(&[(now as f64).into(), fork.id.as_str().into()])?
                .run()
                .await?;
            let Some(parent_id) = &fork.parent_id else { continue };
            let Some(parent) = self.registry.by_id(parent_id).await? else { continue };
            if !fork.owner_id.starts_with("usr_") {
                continue;
            }
            let readable: bool = g1t_kit::call(
                identity,
                "can_read_repo",
                &g1t_contracts::access::CanReadRepoArgs { repo: parent.clone(), user_id: fork.owner_id.clone() },
            )
            .await?;
            if readable {
                continue;
            }
            let at = rfc3339(now);
            let purge = lifecycle::purge_after(now);
            self.registry.soft_delete(&fork.id, "g1t", &at, &purge).await?;
            self.publish(NewEvent {
                kind: "repo.deleted",
                source: SOURCE,
                repo_id: Some(fork.id.clone()),
                actor: None,
                data: g1t_contracts::events::RepoDeleted {
                    repo_id: fork.id.clone(),
                    namespace: fork.namespace.clone(),
                    name: fork.name.clone(),
                    is_private: true,
                    purge_after: purge.clone(),
                    with_workspace: false,
                },
            })
            .await?;
            self.record_fork_as(
                AuditActor::system(),
                "repo.deleted",
                Surface::Web,
                &fork,
                format!("Deleted: whoever forked it can no longer read {}/{}; restorable until {purge}", parent.namespace, parent.name),
            )
            .await;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// `repo.detached`, for a fork that left its parent's network.
    pub(crate) async fn publish_detached(&self, repo_id: &str, parent_id: &str) -> Result<()> {
        self.publish(NewEvent {
            kind: "repo.detached",
            source: SOURCE,
            repo_id: Some(repo_id.to_owned()),
            actor: None,
            data: g1t_contracts::events::RepoDetached { repo_id: repo_id.to_owned(), parent_id: parent_id.to_owned() },
        })
        .await
    }

    /// One entry in `repo`'s workspace's audit log.
    async fn record_fork(&self, actor: &g1t_contracts::User, action: &str, surface: Surface, repo: &Repo, message: String) {
        self.record_fork_as(AuditActor::of(actor), action, surface, repo, message).await;
    }

    async fn record_fork_as(&self, actor: AuditActor, action: &str, surface: Surface, repo: &Repo, message: String) {
        let entry = NewAuditEntry {
            actor,
            action: action.to_owned(),
            surface,
            target: AuditTarget {
                workspace: repo.namespace.clone(),
                repo: Some(format!("{}/{}", repo.namespace, repo.name)),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: "person".to_owned(),
            result: Some("ok".to_owned()),
            message: Some(message),
            request_id: new_id("req", now_ms()),
        };
        let recorded: Result<u32> = g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries: vec![entry] }).await;
        if let Err(error) = recorded {
            worker::console_error!("{action} audit entry not recorded: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(private: bool) -> Repo {
        Repo {
            id: "rep_1".into(),
            namespace: "acme".into(),
            name: "rocket".into(),
            is_private: private,
            owner_id: "usr_1".into(),
            default_branch: "main".into(),
            fork_of: None,
            parent_id: None,
            forked_from: None,
            parent: None,
            allow_forking: false,
            max_ref_updates: None,
            protected: false,
            created_at: String::new(),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        }
    }

    #[test]
    fn public_repositories_can_always_be_forked() {
        assert_eq!(fork_refusal(&repo(false)), None);
    }

    #[test]
    fn private_repositories_only_when_allowed() {
        let (code, message) = fork_refusal(&repo(true)).unwrap();
        assert_eq!(code, FailureCode::Forbidden);
        assert!(message.contains("acme/rocket is private"), "{message}");
        let mut allowed = repo(true);
        allowed.allow_forking = true;
        assert_eq!(fork_refusal(&allowed), None);
    }

    #[test]
    fn working_copies_are_never_forked() {
        let mut copy = repo(false);
        copy.fork_of = Some("rep_0".into());
        assert_eq!(fork_refusal(&copy).unwrap().0, FailureCode::Invalid);
    }

    #[test]
    fn an_eu_workspace_forks_in_place_only_from_the_eu_namespace() {
        assert!(forks_in_place("g1t-us-1", shards::Residency::Anywhere, Some("g1t-eu-1")));
        assert!(forks_in_place("g1t-eu-1", shards::Residency::Eu, Some("g1t-eu-1")));
        assert!(!forks_in_place("g1t-us-1", shards::Residency::Eu, Some("g1t-eu-1")));
        assert!(!forks_in_place("g1t-us-1", shards::Residency::Eu, None));
    }

    #[test]
    fn the_default_branch_follows_the_parents_default() {
        let mut fork = repo(false);
        fork.default_branch = "main".into();
        let mut parent = repo(false);
        parent.default_branch = "trunk".into();
        assert_eq!(upstream_branch("main", &fork, &parent), "trunk");
        assert_eq!(upstream_branch("feature", &fork, &parent), "feature");
    }

    #[test]
    fn counts_what_one_side_lacks() {
        let commit = |hash: &str| g1t_contracts::repos::Commit {
            hash: hash.into(),
            tree_hash: String::new(),
            message: String::new(),
            author: g1t_contracts::repos::Signature { name: String::new(), email: String::new() },
            parents: Vec::new(),
            authored_at: String::new(),
        };
        let ours = vec![commit("c"), commit("b"), commit("a")];
        let theirs = vec![commit("e"), commit("d"), commit("b"), commit("a")];
        let our_hashes: HashSet<&str> = ours.iter().map(|c| c.hash.as_str()).collect();
        let their_hashes: HashSet<&str> = theirs.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(not_in(&theirs, &our_hashes), 2);
        assert_eq!(not_in(&ours, &their_hashes), 1);
    }
}
