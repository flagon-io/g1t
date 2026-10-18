//! What a work item is blocked by: the work items of the same workspace
//! that have to land first (`work_items.blocked_by`, a JSON array of ids;
//! numbers in and out).
//!
//! `update_work_item` replaces the set, refusing a number that is not one
//! of the workspace's work items, the item itself, or a set that would
//! make a cycle. Each change is a `dependency.changed` event on the work
//! item; what follows a blocker closing is coordination's
//! (`coordination/dependencies.rs`).

use std::collections::{HashMap, HashSet};

use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use serde::Deserialize;
use worker::Result;

use super::reading::{held_rows, select};
use super::rows::Held;
use crate::Work;

#[derive(Deserialize)]
struct EdgeRow {
    number: u32,
    /// JSON array of the numbers it is blocked by.
    blocked_by: Option<String>,
}

/// A work item's number.
#[derive(Clone, Debug, Deserialize)]
struct Numbered {
    number: u32,
}

/// The numbers of those of `found` that `viewer` may see, and of those
/// already in `kept` (what a work item is blocked by now).
pub(crate) fn visible_numbers(found: &[Held], viewer: Option<&User>, kept: &[u32]) -> HashSet<u32> {
    found
        .iter()
        .filter(|item| kept.contains(&item.item.number) || item.may(viewer, g1t_contracts::access::Capability::Read))
        .map(|item| item.item.number)
        .collect()
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
    /// `asked` as `held`'s new `blocked_by`, set by `actor`, or why it
    /// cannot be. A work item `actor` may not see is refused as one that
    /// is not there, unless `held` is blocked by it already.
    pub(super) async fn checked_blocked_by(&self, held: &Held, actor: &User, asked: &[u32]) -> Result<Outcome<Vec<u32>>> {
        let workspace = held.item.workspace.as_str();
        let wanted = serde_json::to_string(asked)?;
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare(select("workspace = ?1 AND number IN (SELECT value FROM json_each(?2))"))
                    .bind(&[workspace.into(), wanted.into()])?,
                self.db.prepare(EDGES).bind(&[workspace.into()])?,
            ])
            .await?;
        let mut results = results.into_iter();
        let found: Vec<Held> = match results.next() {
            Some(result) => held_rows(&result)?,
            None => Vec::new(),
        };
        let edges: Vec<EdgeRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let items = visible_numbers(&found, Some(actor), &held.item.blocked_by);
        let number = held.item.number;
        let graph: HashMap<u32, Vec<u32>> = edges.into_iter().map(|row| (row.number, numbers(row.blocked_by.as_deref()))).collect();
        Ok(match check_blocked_by(number, asked, &items, &graph) {
            Ok(set) => Outcome::Ok(set),
            Err(message) => Outcome::fail(FailureCode::Invalid, message),
        })
    }

    /// The `dependency.changed` that setting `held`'s `blocked_by` to
    /// `after` makes, worked out before the change so that its updates are
    /// written with it; none when nothing changes.
    pub(super) async fn dependency_change(&self, held: &Held, after: &[u32], actor: &User) -> Result<Option<serde_json::Value>> {
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
    pub(super) async fn blocked_by_changed(&self, held: &Held, before: &[u32], actor: &User) -> Result<()> {
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
    pub(super) async fn still_open(&self, workspace: &str, numbers: &[u32], cleared: Option<u32>) -> Result<Vec<u32>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let open: Vec<Numbered> = self
            .db
            .prepare(
                "SELECT number FROM work_items
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

    /// The open work items `held` blocks.
    pub(super) async fn dependents(&self, held: &Held) -> Result<Vec<Held>> {
        held_rows(
            &self
                .db
                .prepare(select(
                    "workspace = ? AND state = 'open'
                       AND EXISTS (SELECT 1 FROM json_each(work_items.blocked_by) WHERE json_each.value = ?)",
                ))
                .bind(&[held.item.workspace.as_str().into(), held.item.id.as_str().into()])?
                .all()
                .await?,
        )
    }

    /// The work items of `workspace` that `numbers` names and `viewer` may
    /// see, in no particular order.
    pub(super) async fn visible_numbered(&self, workspace: &str, numbers: &[u32], viewer: Option<&User>) -> Result<Vec<Held>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let found = held_rows(
            &self
                .db
                .prepare(select("workspace = ?1 AND number IN (SELECT value FROM json_each(?2))"))
                .bind(&[workspace.into(), serde_json::to_string(numbers)?.into()])?
                .all()
                .await?,
        )?;
        Ok(found.into_iter().filter(|item| item.may(viewer, g1t_contracts::access::Capability::Read)).collect())
    }

    /// The work items that name `held` in their `blocked_by`, by number:
    /// those `viewer` may see.
    pub(super) async fn blocked_items(&self, held: &Held, viewer: Option<&User>) -> Result<Vec<ItemBrief>> {
        let found = held_rows(
            &self
                .db
                .prepare(select(
                    "workspace = ? AND number IS NOT NULL
                       AND EXISTS (SELECT 1 FROM json_each(work_items.blocked_by) WHERE json_each.value = ?)
                     ORDER BY number LIMIT 100",
                ))
                .bind(&[held.item.workspace.as_str().into(), held.item.id.as_str().into()])?
                .all()
                .await?,
        )?;
        Ok(found
            .into_iter()
            .filter(|item| item.may(viewer, g1t_contracts::access::Capability::Read))
            .map(|item| ItemBrief { number: item.item.number, title: item.item.title, state: item.item.state })
            .collect())
    }
}
