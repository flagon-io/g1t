//! What an issue is blocked by: the issues of the same repository that have
//! to land first (`issues.blocked_by`, a JSON array of numbers).
//!
//! `update_issue` replaces the set, refusing an issue that is not one of
//! the repository's, the issue itself, or a set that would make a cycle.
//! Each change, and each blocker that closes or has its pull request
//! merged, is a `dependency.changed` event on the issue it blocks.

use std::collections::{HashMap, HashSet};

use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{CLAIM_COLUMNS, ClaimRow};
use crate::Work;

#[derive(Deserialize)]
struct EdgeRow {
    number: u32,
    blocked_by: String,
}

#[derive(Deserialize)]
struct BriefRow {
    number: u32,
    title: String,
    state: State,
}

#[derive(Deserialize)]
struct PullBriefRow {
    number: u32,
    title: String,
    status: PullStatus,
    issue_number: u32,
}

fn numbers(json: &str) -> Vec<u32> {
    serde_json::from_str(json).unwrap_or_default()
}

impl Work {
    /// `asked` as `number`'s new `blocked_by`, or why it cannot be.
    pub(crate) async fn checked_blocked_by(&self, repo_id: &str, number: u32, asked: &[u32]) -> Result<Outcome<Vec<u32>>> {
        let wanted = serde_json::to_string(asked)?;
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare(
                        "SELECT number, title, state FROM issues
                         WHERE repo_id = ? AND number IN (SELECT value FROM json_each(?))",
                    )
                    .bind(&[repo_id.into(), wanted.into()])?,
                self.db
                    .prepare("SELECT number, blocked_by FROM issues WHERE repo_id = ? AND blocked_by <> '[]'")
                    .bind(&[repo_id.into()])?,
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
        let issues: HashSet<u32> = found.iter().map(|row| row.number).collect();
        let graph: HashMap<u32, Vec<u32>> = edges.into_iter().map(|row| (row.number, numbers(&row.blocked_by))).collect();
        Ok(match check_blocked_by(number, asked, &issues, &graph) {
            Ok(set) => Outcome::Ok(set),
            Err(message) => Outcome::fail(FailureCode::Invalid, message),
        })
    }

    /// The `dependency.changed` that setting `issue`'s `blocked_by` to
    /// `after` makes, worked out before the change so that its updates are
    /// written with it; none when nothing changes.
    pub(crate) async fn dependency_change(&self, issue: &Issue, after: &[u32], actor: &User) -> Result<Option<serde_json::Value>> {
        let before = &issue.blocked_by;
        let added: Vec<u32> = after.iter().filter(|n| !before.contains(n)).copied().collect();
        let removed: Vec<u32> = before.iter().filter(|n| !after.contains(n)).copied().collect();
        if added.is_empty() && removed.is_empty() {
            return Ok(None);
        }
        let remaining = self.still_open(&issue.repo_id, after, None).await?;
        let change = DependencyChanged {
            repo_id: issue.repo_id.clone(),
            number: issue.number,
            issue: issue.number,
            blocked_by: after.to_vec(),
            added,
            removed,
            cleared: Vec::new(),
            remaining,
            merged_pull: None,
        };
        Ok(Some(g1t_contracts::events::marked(change, Some(actor))))
    }

    /// Notes a change to `issue`'s `blocked_by` (from `before`) in the
    /// issue's conversation.
    pub(crate) async fn blocked_by_changed(&self, issue: &Issue, before: &[u32], actor: &User) -> Result<()> {
        let added: Vec<u32> = issue.blocked_by.iter().filter(|n| !before.contains(n)).copied().collect();
        let removed: Vec<u32> = before.iter().filter(|n| !issue.blocked_by.contains(n)).copied().collect();
        if added.is_empty() && removed.is_empty() {
            return Ok(());
        }
        let list = |numbers: &[u32]| numbers.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ");
        let who = (actor.id.as_str(), actor.username.as_str());
        if !added.is_empty() {
            self.note(&issue.repo_id, issue.number, who, &format!("marked this as blocked by {}", list(&added))).await?;
        }
        if !removed.is_empty() {
            self.note(&issue.repo_id, issue.number, who, &format!("marked this as no longer blocked by {}", list(&removed)))
                .await?;
        }
        Ok(())
    }

    /// Those of `numbers` whose issue is still open, leaving out `cleared`
    /// (a blocker whose pull request just merged).
    async fn still_open(&self, repo_id: &str, numbers: &[u32], cleared: Option<u32>) -> Result<Vec<u32>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let open: Vec<BriefRow> = self
            .db
            .prepare(
                "SELECT number, title, state FROM issues
                 WHERE repo_id = ? AND state = 'open' AND number IN (SELECT value FROM json_each(?))",
            )
            .bind(&[repo_id.into(), serde_json::to_string(numbers)?.into()])?
            .all()
            .await?
            .results()?;
        Ok(numbers
            .iter()
            .filter(|number| Some(**number) != cleared && open.iter().any(|row| row.number == **number))
            .copied()
            .collect())
    }

    /// An issue closed (`closed`) or had a pull request merged for it
    /// (`merged_pull`): its claims end if it closed, and each open issue it
    /// blocks hears that it cleared. Never fails what caused it: a problem
    /// is logged.
    pub(crate) async fn issue_resolved(&self, repo_id: &str, number: u32, actor: &User, closed: bool, merged_pull: Option<u32>) {
        let resolved = async {
            if closed {
                self.release_claims_on_close(repo_id, number, Some(actor)).await?;
            }
            let dependents: Vec<EdgeRow> = self
                .db
                .prepare(
                    "SELECT number, blocked_by FROM issues
                     WHERE repo_id = ? AND state = 'open'
                       AND EXISTS (SELECT 1 FROM json_each(issues.blocked_by) WHERE json_each.value = ?)",
                )
                .bind(&[repo_id.into(), number.into()])?
                .all()
                .await?
                .results()?;
            for dependent in dependents {
                let blocked_by = numbers(&dependent.blocked_by);
                let remaining = self.still_open(repo_id, &blocked_by, Some(number)).await?;
                let change = DependencyChanged {
                    repo_id: repo_id.to_owned(),
                    number: dependent.number,
                    issue: dependent.number,
                    blocked_by,
                    cleared: vec![number],
                    remaining,
                    merged_pull,
                    ..DependencyChanged::default()
                };
                // Follows from a close or merge already made: named by it, so
                // a repeat of the same close or merge tells each session once.
                let how = merged_pull.map_or_else(|| "closed".to_owned(), |pull| format!("merged:{pull}"));
                let key = format!("{}:cleared:{number}:{how}", dependent.number);
                let data = g1t_contracts::events::marked(change, Some(actor));
                self.publish_keyed("dependency.changed", repo_id, Some(actor.id.clone()), data, &key).await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = resolved.await {
            worker::console_error!("#{number} resolved, but its dependents were not told: {error}");
        }
    }

    /// The issues `numbers` names, each with its active claims and its pull
    /// requests, in the order given.
    pub(crate) async fn blockers(&self, repo_id: &str, numbers: &[u32]) -> Result<Vec<Blocker>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let list = serde_json::to_string(numbers)?;
        let bind = |sql: String| -> Result<worker::D1PreparedStatement> {
            self.db.prepare(sql).bind(&[repo_id.into(), JsValue::from(list.as_str())])
        };
        let results = self
            .db
            .batch(vec![
                bind("SELECT number, title, state FROM issues
                      WHERE repo_id = ? AND number IN (SELECT value FROM json_each(?))"
                    .to_owned())?,
                bind(format!(
                    "SELECT {CLAIM_COLUMNS} FROM claims
                     WHERE repo_id = ? AND state = 'active' AND issue IN (SELECT value FROM json_each(?))
                     ORDER BY created_at, id"
                ))?,
                bind("SELECT number, title, status, issue_number FROM pulls
                      WHERE repo_id = ? AND issue_number IN (SELECT value FROM json_each(?))
                      ORDER BY number"
                    .to_owned())?,
            ])
            .await?;
        let mut results = results.into_iter();
        let mut next = || results.next();
        let issues: Vec<BriefRow> = match next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let claims: Vec<Claim> = match next() {
            Some(result) => result.results::<ClaimRow>()?.into_iter().map(Claim::from).collect(),
            None => Vec::new(),
        };
        let pulls: Vec<PullBriefRow> = match next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        Ok(numbers
            .iter()
            .filter_map(|number| {
                let issue = issues.iter().find(|issue| issue.number == *number)?;
                Some(Blocker {
                    number: issue.number,
                    title: issue.title.clone(),
                    state: issue.state,
                    claims: claims.iter().filter(|claim| claim.issue == *number).cloned().collect(),
                    pulls: pulls
                        .iter()
                        .filter(|pull| pull.issue_number == *number)
                        .map(|pull| PullBrief { number: pull.number, title: pull.title.clone(), status: pull.status })
                        .collect(),
                })
            })
            .collect())
    }

    /// The issues that name `number` in their `blocked_by`, by number.
    pub(crate) async fn blocked_issues(&self, repo_id: &str, number: u32) -> Result<Vec<IssueBrief>> {
        Ok(self
            .db
            .prepare(
                "SELECT number, title, state FROM issues
                 WHERE repo_id = ? AND EXISTS (SELECT 1 FROM json_each(issues.blocked_by) WHERE json_each.value = ?)
                 ORDER BY number LIMIT 100",
            )
            .bind(&[repo_id.into(), number.into()])?
            .all()
            .await?
            .results::<BriefRow>()?
            .into_iter()
            .map(|row| IssueBrief { number: row.number, title: row.title, state: row.state })
            .collect())
    }
}
