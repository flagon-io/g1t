//! What follows for coordination when a blocker resolves, and what an
//! agent picking up a work item sees of its blockers. What a work item is
//! blocked by, and changing it, is items/dependencies.rs.
//!
//! Each blocker that closes or has a pull request merged for it is a
//! `dependency.changed` event on the work item it blocks.

use std::collections::HashSet;

use g1t_contracts::work::*;
use g1t_contracts::User;
use serde::Deserialize;
use worker::Result;

use super::{CLAIM_COLUMNS, ClaimRow};
use crate::Work;
use crate::items::{self, Held};

#[derive(Deserialize)]
struct PullBriefRow {
    number: u32,
    title: String,
    status: PullStatus,
    item_id: String,
    repo_id: String,
}

impl Work {
    /// A work item closed (`closed`), or landed in one of its targets by
    /// `landing` (a pull request merged, or a commit pushed) and stays
    /// open: its claims end if it closed, and each open work item it
    /// blocks hears. A close clears it; a landing that leaves it open
    /// clears nothing, and it is still among what they wait on. Never
    /// fails what caused it: a problem is logged.
    pub(crate) async fn item_resolved(&self, held: &Held, actor: &User, closed: bool, landing: Option<&items::Landing>) {
        let number = held.item.number;
        let merged_pull = landing.and_then(|landing| landing.pull);
        let resolved = async {
            if closed {
                self.release_claims_on_close(held, Some(actor)).await?;
            }
            for dependent in items::dependents(self, held).await? {
                let blocked_by = dependent.item.blocked_by.clone();
                let remaining = items::still_open(self, &dependent.item.workspace, &blocked_by, closed.then_some(number)).await?;
                let change = DependencyChanged {
                    workspace: dependent.item.workspace.clone(),
                    number: dependent.item.number,
                    item: dependent.item.number,
                    repo_ids: dependent.repo_ids(),
                    blocked_by,
                    cleared: if closed { vec![number] } else { Vec::new() },
                    remaining,
                    merged_pull,
                    ..DependencyChanged::default()
                };
                // Follows from a close or landing already made: named by it,
                // so a repeat of the same one tells each session once.
                let key = resolution_key(&dependent.item.id, &held.item.id, closed, landing);
                let data = g1t_contracts::events::marked(change, Some(actor));
                self.publish_keyed_to("dependency.changed", &dependent.repo_ids(), Some(actor.id.clone()), data, &key).await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = resolved.await {
            worker::console_error!("#{number} resolved, but its dependents were not told: {error}");
        }
        // Its parent hears that one of its sub-items closed.
        if closed {
            items::sub_item_resolved(self, held, actor, true).await;
        }
    }

    /// The work items of `workspace` that `numbers` names and `viewer` may
    /// see, each with its active claims and its pull requests in
    /// repositories `viewer` may read, in the order given.
    pub(crate) async fn blockers(&self, viewer: Option<&User>, workspace: &str, numbers: &[u32]) -> Result<Vec<Blocker>> {
        let items = items::visible_numbered(self, workspace, numbers, viewer).await?;
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(&items.iter().map(|held| held.item.id.as_str()).collect::<Vec<_>>())?;
        let bind = |sql: String| -> Result<worker::D1PreparedStatement> { self.db.prepare(sql).bind(&[ids.as_str().into()]) };
        let results = self
            .db
            .batch(vec![
                bind(format!(
                    "SELECT {CLAIM_COLUMNS} FROM claims
                     WHERE state = 'active' AND item_id IN (SELECT value FROM json_each(?1))
                     ORDER BY created_at, id"
                ))?,
                bind(
                    "SELECT number, title, status, item_id, repo_id FROM pulls
                     WHERE item_id IN (SELECT value FROM json_each(?1))
                     ORDER BY created_at"
                        .to_owned(),
                )?,
            ])
            .await?;
        let mut results = results.into_iter();
        let mut next = || results.next();
        let claims: Vec<(String, Claim)> = match next() {
            Some(result) => result.results::<ClaimRow>()?.into_iter().map(|row| (row.item_id.clone(), Claim::from(row))).collect(),
            None => Vec::new(),
        };
        let pulls: Vec<PullBriefRow> = match next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let mut repo_ids: Vec<String> = pulls.iter().map(|pull| pull.repo_id.clone()).collect();
        repo_ids.extend(claims.iter().filter_map(|(_, claim)| claim.repo_id.clone()));
        repo_ids.sort();
        repo_ids.dedup();
        let readable = items::readable_repo_ids(self, viewer, &repo_ids).await?;
        Ok(assemble_blockers(numbers, &items, &claims, &pulls, &readable))
    }
}

/// What tells `dependent` once of `blocker` resolving: closing (`:closed`,
/// or `:merged:N` when a merge closed it), or landing somewhere while it
/// stays open (`:landed:` and what landed), which never stands in for the
/// close that comes later.
fn resolution_key(dependent: &str, blocker: &str, closed: bool, landing: Option<&items::Landing>) -> String {
    let pull = landing.and_then(|landing| landing.pull);
    let commit = landing.and_then(|landing| landing.commit.as_deref());
    let how = match (closed, pull, commit) {
        (true, Some(pull), _) => format!("merged:{pull}"),
        (true, None, _) => "closed".to_owned(),
        (false, Some(pull), _) => format!("landed:pull:{pull}"),
        (false, None, Some(commit)) => format!("landed:commit:{commit}"),
        (false, None, None) => "landed".to_owned(),
    };
    format!("{dependent}:cleared:{blocker}:{how}")
}

/// The blockers `numbers` names among `items` (those the viewer may see),
/// in the order given, each with the claims and pull requests that are not
/// in a repository outside `readable`.
fn assemble_blockers(
    numbers: &[u32],
    items: &[Held],
    claims: &[(String, Claim)],
    pulls: &[PullBriefRow],
    readable: &HashSet<String>,
) -> Vec<Blocker> {
    numbers
        .iter()
        .filter_map(|number| {
            let held = items.iter().find(|held| held.item.number == *number)?;
            Some(Blocker {
                number: held.item.number,
                title: held.item.title.clone(),
                state: held.item.state,
                claims: claims
                    .iter()
                    .filter(|(id, claim)| *id == held.item.id && claim.repo_id.as_ref().is_none_or(|repo| readable.contains(repo)))
                    .map(|(_, claim)| claim.clone())
                    .collect(),
                pulls: pulls
                    .iter()
                    .filter(|pull| pull.item_id == held.item.id && readable.contains(&pull.repo_id))
                    .map(|pull| PullBrief { number: pull.number, title: pull.title.clone(), status: pull.status })
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::rows_for_test::held_for_test;

    #[test]
    fn a_landing_that_leaves_a_blocker_open_never_stands_in_for_its_close() {
        let commit = items::Landing { pull: None, commit: Some("abc".into()), pushed_by: None, tie: None };
        let merged = items::Landing { pull: Some(5), commit: None, pushed_by: None, tie: None };
        let landed = resolution_key("wki_2", "wki_1", false, Some(&commit));
        let closed = resolution_key("wki_2", "wki_1", true, None);
        assert_ne!(landed, closed);
        assert_eq!(closed, "wki_2:cleared:wki_1:closed");
        assert_eq!(landed, "wki_2:cleared:wki_1:landed:commit:abc");
        assert_ne!(resolution_key("wki_2", "wki_1", false, Some(&merged)), resolution_key("wki_2", "wki_1", true, Some(&merged)));
    }

    #[test]
    fn blockers_show_only_what_the_viewer_may_read() {
        // #1 is visible (asked for by the caller, who filtered), #2 is not
        // among `items`: the viewer may not see it.
        let items = vec![held_for_test(1, &[("rep_web", "origin", "acme", false)], &[])];
        let pull = |number: u32, item: &str, repo: &str| PullBriefRow {
            number,
            title: format!("Pull {number}"),
            status: PullStatus::Open,
            item_id: item.to_owned(),
            repo_id: repo.to_owned(),
        };
        let pulls = vec![pull(10, "wki_1", "rep_web"), pull(11, "wki_1", "rep_secret"), pull(12, "wki_2", "rep_web")];
        let readable: HashSet<String> = ["rep_web".to_owned()].into();
        let blockers = assemble_blockers(&[2, 1], &items, &[], &pulls, &readable);
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].number, 1);
        assert_eq!(blockers[0].pulls.iter().map(|pull| pull.number).collect::<Vec<_>>(), vec![10]);
    }
}
