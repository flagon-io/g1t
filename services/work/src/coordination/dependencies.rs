//! What follows for coordination when a blocker resolves, and what an
//! agent picking up a work item sees of its blockers. What a work item is
//! blocked by, and changing it, is items/dependencies.rs.
//!
//! Each blocker that closes or has a pull request merged for it is a
//! `dependency.changed` event on the work item it blocks.

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
}

impl Work {
    /// A work item closed (`closed`) or had a pull request merged for it
    /// (`merged_pull`): its claims end if it closed, and each open work
    /// item it blocks hears that it cleared. Never fails what caused it: a
    /// problem is logged.
    pub(crate) async fn item_resolved(&self, held: &Held, actor: &User, closed: bool, merged_pull: Option<u32>) {
        let number = held.item.number;
        let resolved = async {
            if closed {
                self.release_claims_on_close(held, Some(actor)).await?;
            }
            for dependent in items::dependents(self, held).await? {
                let blocked_by = dependent.item.blocked_by.clone();
                let remaining = items::still_open(self, &dependent.item.workspace, &blocked_by, Some(number)).await?;
                let change = DependencyChanged {
                    workspace: dependent.item.workspace.clone(),
                    number: dependent.item.number,
                    item: dependent.item.number,
                    repo_ids: dependent.repo_ids(),
                    blocked_by,
                    cleared: vec![number],
                    remaining,
                    merged_pull,
                    ..DependencyChanged::default()
                };
                // Follows from a close or merge already made: named by it, so
                // a repeat of the same close or merge tells each session once.
                let how = merged_pull.map_or_else(|| "closed".to_owned(), |pull| format!("merged:{pull}"));
                let key = format!("{}:cleared:{}:{how}", dependent.item.id, held.item.id);
                let data = g1t_contracts::events::marked(change, Some(actor));
                self.publish_keyed_to("dependency.changed", &dependent.repo_ids(), Some(actor.id.clone()), data, &key).await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = resolved.await {
            worker::console_error!("#{number} resolved, but its dependents were not told: {error}");
        }
    }

    /// The work items of `workspace` that `numbers` names, each with its
    /// active claims and its pull requests, in the order given.
    pub(crate) async fn blockers(&self, workspace: &str, numbers: &[u32]) -> Result<Vec<Blocker>> {
        let items = items::briefs(self, workspace, numbers).await?;
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(&items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>())?;
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
                    "SELECT number, title, status, item_id FROM pulls
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
        Ok(numbers
            .iter()
            .filter_map(|number| {
                let item = items.iter().find(|item| item.number == *number)?;
                Some(Blocker {
                    number: item.number,
                    title: item.title.clone(),
                    state: item.state,
                    claims: claims.iter().filter(|(id, _)| *id == item.id).map(|(_, claim)| claim.clone()).collect(),
                    pulls: pulls
                        .iter()
                        .filter(|pull| pull.item_id == item.id)
                        .map(|pull| PullBrief { number: pull.number, title: pull.title.clone(), status: pull.status })
                        .collect(),
                })
            })
            .collect())
    }
}
