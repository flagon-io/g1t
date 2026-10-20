//! Work items (`g1t_contracts::work::items`): any tracked work of a
//! workspace, linked to the repositories it concerns
//! (migrations/0049_work_items.sql).
//!
//! A work item is numbered in its workspace's sequence (`work_counters`,
//! numbering.rs), which new pull requests share, and links repositories in
//! `work_item_repos` (links.rs): its origin, its targets and those it
//! touched. Who may see one is `access::item_role`: the workspace's
//! members, and anyone who can read its origin. What `#N` names is
//! refs.rs; what landing one does, landing.rs. Labels and milestones are
//! the workspace's, and pull requests carry them too (labels.rs,
//! milestones.rs). Moving repositories' issues in is migration.rs.
//!
//! This module is the boundary. Its RPC methods (`open_work_item` and the
//! other `*_work_item` methods, labels, milestones, `resolve_ref`,
//! `closed_by_commit`, `legacy_item_map`, `migrate_work_items`) are the
//! service's; the rest of the crate (pull requests, merging, pushes,
//! coordination) reaches work items only through the functions below, and
//! reads them in its own queries only through the fragments in [`sql`]. A
//! later split of work items into a service of their own turns each
//! function into an RPC method and each fragment into a copy the caller
//! keeps from `work_item.*` events.
//!
//! Work items call out the other way at a few points, which a split would
//! turn into events: what a close means for claims and blocked work
//! (`Work::item_resolved`), the session a close was made in
//! (`Work::caller_session`, `Work::trailer_session`), and repositories and
//! their settings. `repo_workspaces`, where each repository is, is kept
//! here and read by anyone.

use g1t_contracts::access::Capability;
use g1t_contracts::repos::Repo;
use g1t_contracts::work::refs::Ref;
use g1t_contracts::{Outcome, User, Viewer};
use worker::Result;

use crate::Work;

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

mod changes;
mod dependencies;
mod labels;
mod landing;
mod links;
mod migration;
mod milestones;
mod numbering;
mod plan;
mod reading;
mod refs;
mod rows;
pub(crate) mod sql;
#[cfg(test)]
mod tests;

pub(crate) use labels::Labeled;
pub(crate) use links::MARK_DELETED;
pub(crate) use landing::{Landing, PastLanding};
pub(crate) use migration::{DELETED, RENAMED, TRANSFERRED};
pub(crate) use reading::{held_rows, select};
pub(crate) use refs::{MAX_CLOSES, Named, NamedItems};
pub(crate) use rows::{Held, path_of, repo_readable, workspace_of};

/// Work items and people made up for other modules' tests.
#[cfg(test)]
pub(crate) mod rows_for_test {
    pub(crate) use super::rows::{held_for_test, person_for_test};
}

// --- Reading ---------------------------------------------------------------

/// The work item numbered `number` in `workspace`, whoever is asking.
pub(crate) async fn by_number(work: &Work, workspace: &str, number: u32) -> Result<Option<Held>> {
    work.item(workspace, number).await
}

/// A work item by id, whoever is asking.
pub(crate) async fn by_id(work: &Work, id: &str) -> Result<Option<Held>> {
    work.item_by_id(id).await
}

/// The work items of these ids, in no particular order.
pub(crate) async fn by_ids(work: &Work, ids: &[String]) -> Result<Vec<Held>> {
    work.items_by_ids(ids).await
}

/// A work item, if `viewer` may do `capability` on it; not found when they
/// may not see it.
pub(crate) async fn for_viewer(work: &Work, viewer: &Viewer, workspace: &str, number: u32, capability: Capability) -> Result<Outcome<Held>> {
    work.item_for(viewer, workspace, number, capability).await
}

/// A pull request's own work item, if it has one.
pub(crate) async fn for_pull(work: &Work, pull_id: &str) -> Result<Option<Held>> {
    match work.pull_item_id(pull_id).await? {
        Some(id) => work.item_by_id(&id).await,
        None => Ok(None),
    }
}

// --- Numbers and repositories ----------------------------------------------

/// The next number of `workspace`'s sequence, for a pull request of
/// `repo_id` or (without one) a work item.
pub(crate) async fn next_number(work: &Work, workspace: &str, repo_id: Option<&str>) -> Result<u32> {
    work.next_number(workspace, repo_id).await
}

/// Records which workspace `repo` is in, its path and whether it is
/// private, as repos just said.
pub(crate) async fn remember_repo(work: &Work, repo: &Repo) -> Result<()> {
    work.remember_repo(repo).await
}

/// The workspace repository `repo_id` is in.
pub(crate) async fn repo_workspace(work: &Work, repo_id: &str) -> Result<Option<String>> {
    work.repo_workspace(repo_id).await
}

/// `repo.created`: where the repository is, and for a workspace's first,
/// the default labels.
pub(crate) async fn repo_created(work: &Work, data: &serde_json::Value) -> Result<()> {
    work.repo_created(data).await
}

/// `repo.restored`: where the repository is again, and what it kept for
/// itself, placed.
pub(crate) async fn repo_restored(work: &Work, data: &serde_json::Value) -> Result<()> {
    work.repo_restored(data).await
}

/// `repo.visibility_changed`: whether its work items are public.
pub(crate) async fn repo_visibility(work: &Work, data: &serde_json::Value) -> Result<()> {
    work.repo_visibility(data).await
}

// --- References and landing ------------------------------------------------

/// What `reference` names, read in repository `repo_id` of `workspace`,
/// with the repository it is read in (another of the workspace's, for
/// `owner/name#N`): none for another workspace's, or a repository not
/// known.
pub(crate) async fn resolve_in(work: &Work, repo_id: &str, workspace: &str, reference: &Ref) -> Result<Option<(String, Named)>> {
    work.resolve_in(repo_id, workspace, reference).await
}

/// The work item `reference` names, read in `repo`, by id: one of its
/// workspace's, or none.
pub(crate) async fn referenced(work: &Work, repo: &Repo, reference: &Ref) -> Result<Option<String>> {
    work.ref_item(repo, reference).await
}

/// The work items `text`, written in `repo`, closes and is part of, with
/// `own` (a pull request's own work item) closed first: those each of
/// `who` may close, or see (refs.rs `admits`).
pub(crate) async fn named(work: &Work, repo: &Repo, own: Option<&str>, text: &str, who: &[&User]) -> Result<NamedItems> {
    work.named_items(repo, own, text, who).await
}

/// Whether each of `who` may have `held` closed by naming it (`closing`),
/// or linked as something a change is part of.
pub(crate) fn admits(held: &Held, who: &[&User], closing: bool) -> bool {
    refs::admits(held, who, closing)
}

/// Lands `closes` (work items, by id) in `repo` by `landing` and links
/// `parts` (landing.rs). Returns the work items it closed.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn land(
    work: &Work,
    repo: &Repo,
    landing: &Landing,
    actor: &User,
    closes: &[String],
    parts: &[String],
    session: Option<&str>,
    agent: bool,
) -> Result<Vec<Held>> {
    work.land(repo, landing, actor, closes, parts, session, agent).await
}

/// Links `repo` to `held` as touched (it has a pull request for it),
/// unless it is linked already.
pub(crate) async fn touch(work: &Work, held: &Held, repo: &Repo, actor: &User) -> Result<()> {
    work.touch_item(held, repo, actor).await
}

/// Where the other work items of `held`'s workspace landed, newest first.
pub(crate) async fn landed_before(work: &Work, held: &Held, limit: u32) -> Result<Vec<PastLanding>> {
    work.landed_before(held, limit).await
}

// --- Its conversation ------------------------------------------------------

/// Notes something that happened to a work item, in its conversation.
pub(crate) async fn note<'a>(work: &Work, item_id: &str, author: impl Into<crate::rows::By<'a>>, text: &str) -> Result<()> {
    work.note_item(item_id, author, text).await
}

/// A statement that marks a work item updated at `at`, for a caller's
/// batch (a comment on it).
pub(crate) fn stamp(work: &Work, item_id: &str, at: &str) -> Result<worker::D1PreparedStatement> {
    work.db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").bind(&[at.into(), item_id.into()])
}

// --- Labels and milestones -------------------------------------------------

/// Sets the labels of a work item or pull request to `wanted`.
pub(crate) async fn relabel(work: &Work, actor: &User, labeled: &Labeled, wanted: &[String]) -> Result<Outcome<Vec<String>>> {
    work.relabel(actor, labeled, wanted).await
}

/// Puts a work item or pull request in milestone `number` (0: none).
pub(crate) async fn set_milestone(work: &Work, actor: &User, labeled: &Labeled, number: u32) -> Result<Outcome<()>> {
    work.set_milestone(actor, labeled, number).await
}

// --- What blocks what ------------------------------------------------------

/// The open work items `held` blocks.
pub(crate) async fn dependents(work: &Work, held: &Held) -> Result<Vec<Held>> {
    work.dependents(held).await
}

/// Those of `numbers` whose work item in `workspace` is still open,
/// leaving out `cleared`.
pub(crate) async fn still_open(work: &Work, workspace: &str, numbers: &[u32], cleared: Option<u32>) -> Result<Vec<u32>> {
    work.still_open(workspace, numbers, cleared).await
}

/// Those of `ids` (repositories) that `viewer` may read, as recorded in
/// `repo_workspaces`.
pub(crate) async fn readable_repo_ids(work: &Work, viewer: Option<&User>, ids: &[String]) -> Result<std::collections::HashSet<String>> {
    work.readable_repo_ids(viewer, ids).await
}

/// The work items of `workspace` that `numbers` names and `viewer` may
/// see, in no particular order.
pub(crate) async fn visible_numbered(work: &Work, workspace: &str, numbers: &[u32], viewer: Option<&User>) -> Result<Vec<Held>> {
    work.visible_numbered(workspace, numbers, viewer).await
}

/// The work items that name `held` in their `blocked_by`, those `viewer`
/// may see.
pub(crate) async fn blocked_items(work: &Work, held: &Held, viewer: Option<&User>) -> Result<Vec<g1t_contracts::work::ItemBrief>> {
    work.blocked_items(held, viewer).await
}
