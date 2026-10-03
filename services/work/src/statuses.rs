//! Statuses on commits: what workflow runs say about a pull request's head.
//! A pending status holds the pull request, a failed one sends its agent
//! back (or, for anyone else's, refuses the merge), as acceptance checks do.

use g1t_contracts::events::ChecksEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{CommitStatus, SetCommitStatusArgs};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

#[derive(Deserialize)]
struct StatusRow {
    context: String,
    state: String,
    description: Option<String>,
    target_url: Option<String>,
    updated_at: String,
}

impl From<StatusRow> for CommitStatus {
    fn from(row: StatusRow) -> Self {
        CommitStatus {
            context: row.context,
            state: row.state,
            description: row.description,
            target_url: row.target_url,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct HeadRow {
    id: String,
    number: u32,
}

/// The workflows still running and the ones that failed, by name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorkflowFacts {
    pub(crate) pending: Vec<String>,
    pub(crate) failed: Vec<String>,
}

impl WorkflowFacts {
    pub(crate) fn of(statuses: &[CommitStatus]) -> WorkflowFacts {
        WorkflowFacts {
            pending: statuses.iter().filter(|s| s.state == "pending").map(|s| s.context.clone()).collect(),
            failed: statuses.iter().filter(|s| s.state == "failure" || s.state == "error").map(|s| s.context.clone()).collect(),
        }
    }

    /// Why a merge has to wait, if it does.
    pub(crate) fn refusal(&self) -> Option<String> {
        if !self.failed.is_empty() {
            return Some(format!("{} failed.", list(&self.failed)));
        }
        if !self.pending.is_empty() {
            return Some(format!("{} {} still running.", list(&self.pending), if self.pending.len() == 1 { "is" } else { "are" }));
        }
        None
    }
}

pub(crate) fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

impl Work {
    pub(crate) async fn statuses(&self, repo_id: &str, sha: Option<&str>) -> Result<Vec<CommitStatus>> {
        let Some(sha) = sha else { return Ok(Vec::new()) };
        Ok(self
            .db
            .prepare("SELECT context, state, description, target_url, updated_at FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY context")
            .bind(&[repo_id.into(), sha.into()])?
            .all()
            .await?
            .results::<StatusRow>()?
            .into_iter()
            .map(CommitStatus::from)
            .collect())
    }

    pub(crate) async fn set_commit_status(&self, a: SetCommitStatusArgs) -> Result<Outcome<bool>> {
        if !matches!(a.state.as_str(), "pending" | "success" | "failure" | "error") {
            return Ok(Outcome::fail(FailureCode::Invalid, "`state` is pending, success, failure or error."));
        }
        self.db
            .prepare(
                "INSERT INTO commit_statuses (repo_id, sha, context, state, description, target_url, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id, sha, context) DO UPDATE SET
                   state = excluded.state, description = excluded.description,
                   target_url = excluded.target_url, updated_at = excluded.updated_at",
            )
            .bind(&[
                a.repo_id.as_str().into(),
                a.sha.as_str().into(),
                a.context.as_str().into(),
                a.state.as_str().into(),
                a.description.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                a.target_url.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        if a.state == "pending" {
            return Ok(Outcome::Ok(true));
        }
        // Once every workflow on a pull request's head has finished, its
        // lifecycle moves on, as it does when its checks finish.
        let facts = WorkflowFacts::of(&self.statuses(&a.repo_id, Some(&a.sha)).await?);
        if !facts.pending.is_empty() {
            return Ok(Outcome::Ok(true));
        }
        let heads = self
            .db
            .prepare("SELECT id, number FROM pulls WHERE repo_id = ? AND head_commit = ? AND status IN ('draft', 'open')")
            .bind(&[a.repo_id.as_str().into(), a.sha.as_str().into()])?
            .all()
            .await?
            .results::<HeadRow>()?;
        for head in heads {
            // A pull request g1t stopped on picks back up once what stopped
            // it passes: its workflows, and its checks if it has any. The
            // lifecycle then decides again, within its usual limits.
            if facts.failed.is_empty() {
                let resumed = self
                    .db
                    .prepare(
                        "UPDATE pulls SET stalled = NULL WHERE id = ? AND managed = 1 AND stalled IS NOT NULL
                           AND (check_status IS NULL OR check_status = 'passed') RETURNING id AS value",
                    )
                    .bind(&[head.id.as_str().into()])?
                    .first::<crate::rows::ValueRow>(None)
                    .await?;
                if resumed.is_some() {
                    self.note(
                        &a.repo_id,
                        head.number,
                        (crate::lifecycle::POLICY_ACTOR_ID, crate::lifecycle::POLICY_ACTOR_NAME),
                        "picked this back up: its workflows pass now",
                    )
                    .await?;
                }
            }
            self.publish_as(
                "checks.completed",
                &a.repo_id,
                None,
                ChecksEvent {
                    pull_id: head.id,
                    repo_id: a.repo_id.clone(),
                    number: head.number,
                    status: if facts.failed.is_empty() { "passed" } else { "failed" },
                    commit: a.sha.clone(),
                },
            )
            .await?;
        }
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(context: &str, state: &str) -> CommitStatus {
        CommitStatus {
            context: context.into(),
            state: state.into(),
            description: None,
            target_url: None,
            updated_at: String::new(),
        }
    }

    #[test]
    fn failures_come_before_waiting() {
        let facts = WorkflowFacts::of(&[status("CI / push", "pending"), status("Lint / pull_request", "failure"), status("Docs", "success")]);
        assert_eq!(facts.pending, ["CI / push"]);
        assert_eq!(facts.failed, ["Lint / pull_request"]);
        assert_eq!(facts.refusal().unwrap(), "Lint / pull_request failed.");
        let waiting = WorkflowFacts::of(&[status("A", "pending"), status("B", "pending")]);
        assert_eq!(waiting.refusal().unwrap(), "A and B are still running.");
        assert!(WorkflowFacts::of(&[status("A", "success")]).refusal().is_none());
    }
}
