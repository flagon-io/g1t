//! What a work item is blocked by: the work items of the same workspace
//! that have to land first (`work_items.blocked_by`, a JSON array of ids;
//! numbers in and out).
//!
//! `update_work_item` replaces the set, refusing a number that is not one
//! of the workspace's work items, the item itself, or a set that would
//! make a cycle. Each change, and each blocker that closes or has a pull
//! request merged for it, is a `dependency.changed` event on the work item
//! it blocks.

use std::collections::{HashMap, HashSet};

use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{CLAIM_COLUMNS, ClaimRow};
use crate::Work;
use crate::items::{Held, ITEM_COLUMNS, ItemRow};

#[derive(Deserialize)]
struct EdgeRow {
    number: u32,
    /// JSON array of the numbers it is blocked by.
    blocked_by: Option<String>,
}

#[derive(Deserialize)]
struct BriefRow {
    id: String,
    number: u32,
    title: String,
    state: State,
}

#[derive(Deserialize)]
struct PullBriefRow {
    number: u32,
    title: String,
    status: PullStatus,
    item_id: String,
}

fn numbers(json: Option<&str>) -> Vec<u32> {
    json.and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default()
}

/// A workspace's (`?1`) work items that are blocked by something, each
/// with what it is blocked by, by number.
const EDGES: &str = "SELECT number,
     (SELECT json_group_array(b.number) FROM json_each(work_items.blocked_by) j JOIN work_items b ON b.id = j.value
      WHERE b.number IS NOT NULL) AS blocked_by
   FROM work_items WHERE workspace = ?1 AND blocked_by <> '[]' AND number IS NOT NULL";

impl Work {
    /// `asked` as `number`'s new `blocked_by` in `workspace`, or why it
    /// cannot be.
    pub(crate) async fn checked_blocked_by(&self, workspace: &str, number: u32, asked: &[u32]) -> Result<Outcome<Vec<u32>>> {
        let wanted = serde_json::to_string(asked)?;
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare(
                        "SELECT id, number, title, state FROM work_items
                         WHERE workspace = ? AND number IN (SELECT value FROM json_each(?))",
                    )
                    .bind(&[workspace.into(), wanted.into()])?,
                self.db.prepare(EDGES).bind(&[workspace.into()])?,
            ])
            .await?;
        let mut results = results.into_iter();
        let found: Vec<BriefRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let edges: Vec<EdgeRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let items: HashSet<u32> = found.iter().map(|row| row.number).collect();
        let graph: HashMap<u32, Vec<u32>> = edges.into_iter().map(|row| (row.number, numbers(row.blocked_by.as_deref()))).collect();
        Ok(match check_blocked_by(number, asked, &items, &graph) {
            Ok(set) => Outcome::Ok(set),
            Err(message) => Outcome::fail(FailureCode::Invalid, message),
        })
    }

    /// The `dependency.changed` that setting `held`'s `blocked_by` to
    /// `after` makes, worked out before the change so that its updates are
    /// written with it; none when nothing changes.
    pub(crate) async fn dependency_change(&self, held: &Held, after: &[u32], actor: &User) -> Result<Option<serde_json::Value>> {
        let before = &held.item.blocked_by;
        let added: Vec<u32> = after.iter().filter(|n| !before.contains(n)).copied().collect();
        let removed: Vec<u32> = before.iter().filter(|n| !after.contains(n)).copied().collect();
        if added.is_empty() && removed.is_empty() {
            return Ok(None);
        }
        let remaining = self.still_open(&held.item.workspace, after, None).await?;
        let change = DependencyChanged {
            workspace: held.item.workspace.clone(),
            number: held.item.number,
            item: held.item.number,
            repo_ids: held.repo_ids(),
            blocked_by: after.to_vec(),
            added,
            removed,
            cleared: Vec::new(),
            remaining,
            merged_pull: None,
        };
        Ok(Some(g1t_contracts::events::marked(change, Some(actor))))
    }

    /// Notes a change to `held`'s `blocked_by` (from `before`) in its
    /// conversation.
    pub(crate) async fn blocked_by_changed(&self, held: &Held, before: &[u32], actor: &User) -> Result<()> {
        let added: Vec<u32> = held.item.blocked_by.iter().filter(|n| !before.contains(n)).copied().collect();
        let removed: Vec<u32> = before.iter().filter(|n| !held.item.blocked_by.contains(n)).copied().collect();
        if added.is_empty() && removed.is_empty() {
            return Ok(());
        }
        let list = |numbers: &[u32]| numbers.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ");
        if !added.is_empty() {
            self.note_item(&held.item.id, actor, &format!("marked this as blocked by {}", list(&added))).await?;
        }
        if !removed.is_empty() {
            self.note_item(&held.item.id, actor, &format!("marked this as no longer blocked by {}", list(&removed))).await?;
        }
        Ok(())
    }

    /// Those of `numbers` whose work item is still open, leaving out
    /// `cleared` (a blocker that just landed).
    async fn still_open(&self, workspace: &str, numbers: &[u32], cleared: Option<u32>) -> Result<Vec<u32>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let open: Vec<BriefRow> = self
            .db
            .prepare(
                "SELECT id, number, title, state FROM work_items
                 WHERE workspace = ? AND state = 'open' AND number IN (SELECT value FROM json_each(?))",
            )
            .bind(&[workspace.into(), serde_json::to_string(numbers)?.into()])?
            .all()
            .await?
            .results()?;
        Ok(numbers
            .iter()
            .filter(|number| Some(**number) != cleared && open.iter().any(|row| row.number == **number))
            .copied()
            .collect())
    }

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
            let dependents: Vec<Held> = self
                .db
                .prepare(format!(
                    "SELECT {ITEM_COLUMNS} FROM work_items
                     WHERE workspace = ? AND state = 'open'
                       AND EXISTS (SELECT 1 FROM json_each(work_items.blocked_by) WHERE json_each.value = ?)"
                ))
                .bind(&[held.item.workspace.as_str().into(), held.item.id.as_str().into()])?
                .all()
                .await?
                .results::<ItemRow>()?
                .into_iter()
                .filter_map(ItemRow::held)
                .collect();
            for dependent in dependents {
                let blocked_by = dependent.item.blocked_by.clone();
                let remaining = self.still_open(&dependent.item.workspace, &blocked_by, Some(number)).await?;
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
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let list = serde_json::to_string(numbers)?;
        let bind = |sql: String| -> Result<worker::D1PreparedStatement> {
            self.db.prepare(sql).bind(&[workspace.into(), JsValue::from(list.as_str())])
        };
        let named = "SELECT id FROM work_items WHERE workspace = ?1 AND number IN (SELECT value FROM json_each(?2))";
        let results = self
            .db
            .batch(vec![
                bind("SELECT id, number, title, state FROM work_items
                      WHERE workspace = ?1 AND number IN (SELECT value FROM json_each(?2))"
                    .to_owned())?,
                bind(format!(
                    "SELECT {CLAIM_COLUMNS} FROM claims
                     WHERE state = 'active' AND item_id IN ({named})
                     ORDER BY created_at, id"
                ))?,
                bind(format!(
                    "SELECT number, title, status, item_id FROM pulls
                     WHERE item_id IN ({named})
                     ORDER BY created_at"
                ))?,
            ])
            .await?;
        let mut results = results.into_iter();
        let mut next = || results.next();
        let items: Vec<BriefRow> = match next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
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

    /// The work items that name `held` in their `blocked_by`, by number.
    pub(crate) async fn blocked_items(&self, held: &Held) -> Result<Vec<ItemBrief>> {
        Ok(self
            .db
            .prepare(
                "SELECT id, number, title, state FROM work_items
                 WHERE workspace = ? AND number IS NOT NULL
                   AND EXISTS (SELECT 1 FROM json_each(work_items.blocked_by) WHERE json_each.value = ?)
                 ORDER BY number LIMIT 100",
            )
            .bind(&[held.item.workspace.as_str().into(), held.item.id.as_str().into()])?
            .all()
            .await?
            .results::<BriefRow>()?
            .into_iter()
            .map(|row| ItemBrief { number: row.number, title: row.title, state: row.state })
            .collect())
    }
}
