//! What the runner needs to apply a workspace's plan caps (see
//! `@g1t/contracts` `compute.ts`): how many agents it has at work, what an
//! issue's agents have spent, a comment from g1t when it cannot
//! start, and somewhere for runs to wait for a free slot.
//!
//! The decisions are the runner's; this keeps the counts and the queue.

use g1t_contracts::agents::*;
use g1t_contracts::events::CommentCreated;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::checks::hash;
use crate::reviews::{AGENT_ID, AGENT_NAME};
use crate::rows::{NumberRow, ValueRow};
use crate::runs::member_of;

/// The longest comment g1t leaves for a run it could not start.
const MAX_COMMENT_CHARS: usize = 2000;
/// The most runs one workspace may have waiting at once.
const MAX_WAITING: u32 = 50;

#[derive(Deserialize)]
struct SpendRow {
    spent: Option<f64>,
}

#[derive(Deserialize)]
struct PullKey {
    id: String,
    issue_id: Option<String>,
}

#[derive(Deserialize)]
struct WaitRow {
    id: String,
    workspace: String,
    kind: String,
    payload: String,
    created_at: String,
}

#[derive(Deserialize)]
struct CostRow {
    cost_usd: Option<f64>,
    token_hash: String,
}

/// The kinds that count against the agents-at-once cap, as SQL.
fn agent_kinds_sql() -> String {
    AGENT_KINDS
        .iter()
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Dollars as millionths, rounded up.
pub(crate) fn to_micros(usd: f64) -> i64 {
    if usd.is_finite() && usd > 0.0 {
        (usd * 1_000_000.0).ceil() as i64
    } else {
        0
    }
}

impl Work {
    async fn repo_id_of(&self, path: &RepoPath) -> Result<Outcome<String>> {
        let service = User {
            id: "svc_runner".to_owned(),
            username: "g1t".to_owned(),
            ..User::default()
        };
        Ok(match self.repo(path, &member_of(&service, &path.namespace)).await? {
            Outcome::Ok(repo) => Outcome::Ok(repo.id),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    pub(crate) async fn active_agents(&self, a: ActiveAgentsArgs) -> Result<u32> {
        // A run whose sandbox died unnoticed does not hold a slot forever.
        self.sweep_silent().await?;
        let count = self
            .db
            .prepare(format!(
                "SELECT count(*) AS n FROM agent_runs
                 WHERE workspace = ? AND status IN ('queued', 'running') AND kind IN ({})",
                agent_kinds_sql()
            ))
            .bind(&[a.workspace.to_lowercase().into()])?
            .first::<NumberRow>(None)
            .await?;
        Ok(count.map_or(0, |row| row.n))
    }

    pub(crate) async fn issue_spend(&self, a: IssueSpendArgs) -> Result<Outcome<IssueSpend>> {
        let repo_id = match self.repo_id_of(&a.repo).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let pull = self
            .db
            .prepare("SELECT id, issue_id FROM pulls WHERE repo_id = ? AND number = ?")
            .bind(&[repo_id.as_str().into(), a.number.into()])?
            .first::<PullKey>(None)
            .await?;
        // The issue a pull request is for, or the pull request itself.
        let issue_id = match &pull {
            Some(pull) => pull.issue_id.clone(),
            None => self
                .db
                .prepare("SELECT id AS value FROM issues WHERE repo_id = ? AND number = ?")
                .bind(&[repo_id.as_str().into(), a.number.into()])?
                .first::<ValueRow>(None)
                .await?
                .map(|row| row.value),
        };
        let (issue_number, spent) = match (&issue_id, &pull) {
            (Some(issue_id), _) => {
                let number = self
                    .db
                    .prepare("SELECT number AS n FROM issues WHERE id = ?")
                    .bind(&[issue_id.as_str().into()])?
                    .first::<NumberRow>(None)
                    .await?
                    .map_or(a.number, |row| row.n);
                let spent = self
                    .db
                    .prepare(
                        "SELECT sum(cost_usd) AS spent FROM agent_runs
                         WHERE pull_id IN (SELECT id FROM pulls WHERE issue_id = ?1)
                            OR (repo_id = ?2 AND number = ?3 AND pull_id IS NULL)",
                    )
                    .bind(&[issue_id.as_str().into(), repo_id.as_str().into(), number.into()])?
                    .first::<SpendRow>(None)
                    .await?;
                (number, spent)
            }
            (None, Some(pull)) => {
                let spent = self
                    .db
                    .prepare(
                        "SELECT sum(cost_usd) AS spent FROM agent_runs
                         WHERE pull_id = ?1 OR (repo_id = ?2 AND number = ?3 AND pull_id IS NULL)",
                    )
                    .bind(&[pull.id.as_str().into(), repo_id.as_str().into(), a.number.into()])?
                    .first::<SpendRow>(None)
                    .await?;
                (a.number, spent)
            }
            (None, None) => {
                return Ok(Outcome::fail(FailureCode::NotFound, "No issue or pull request by that number."));
            }
        };
        Ok(Outcome::Ok(IssueSpend {
            issue: issue_number,
            spent_micros: to_micros(spent.and_then(|row| row.spent).unwrap_or(0.0)),
        }))
    }

    pub(crate) async fn wait_for_slot(&self, a: WaitForSlotArgs) -> Result<bool> {
        // The claim is given back as if it had never been taken, so the
        // revision it counted does not count.
        let released = self
            .db
            .prepare(
                "UPDATE pulls SET
                   revisions = CASE WHEN working_on = 'revision' AND revisions > 0 THEN revisions - 1 ELSE revisions END,
                   working_on = NULL, working_until = NULL, stage_detail = ?
                 WHERE id = ? AND status = 'open'
                 RETURNING id AS value",
            )
            .bind(&[a.reason.trim().into(), a.pull_id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        Ok(released.is_some())
    }

    pub(crate) async fn agent_comment(&self, a: AgentCommentArgs) -> Result<bool> {
        let body: String = a.body.trim().chars().take(MAX_COMMENT_CHARS).collect();
        if body.is_empty() {
            return Ok(false);
        }
        let repo_id = match self.repo_id_of(&a.repo).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(_) => return Ok(false),
        };
        let pull_id = self
            .db
            .prepare("SELECT id AS value FROM pulls WHERE repo_id = ? AND number = ?")
            .bind(&[repo_id.as_str().into(), a.number.into()])?
            .first::<ValueRow>(None)
            .await?
            .map(|row| row.value);
        let table = if pull_id.is_some() { "pulls" } else { "issues" };
        let now = now_ms();
        let id = new_id("cmt", now);
        let at = rfc3339(now);
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments (id, repo_id, number, author_id, author_name, body, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        repo_id.as_str().into(),
                        a.number.into(),
                        AGENT_ID.into(),
                        AGENT_NAME.into(),
                        body.as_str().into(),
                        at.as_str().into(),
                    ])?,
                self.db
                    .prepare(format!("UPDATE {table} SET updated_at = ? WHERE repo_id = ? AND number = ?"))
                    .bind(&[at.as_str().into(), repo_id.as_str().into(), a.number.into()])?,
            ])
            .await?;
        self.publish_as(
            "comment.created",
            &repo_id,
            Some(AGENT_ID.to_owned()),
            CommentCreated {
                comment_id: id,
                repo_id: repo_id.clone(),
                number: a.number,
                pull_id,
                verdict: None,
                ..CommentCreated::default()
            },
        )
        .await?;
        Ok(true)
    }

    pub(crate) async fn add_wait(&self, a: AddWaitArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        let waiting = self
            .db
            .prepare("SELECT count(*) AS n FROM agent_waits WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n);
        if waiting >= MAX_WAITING {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{MAX_WAITING} runs are already waiting for this workspace's agents. Try again when some have started."),
            ));
        }
        let now = now_ms();
        self.db
            .prepare("INSERT INTO agent_waits (id, workspace, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&[
                new_id("wait", now).into(),
                workspace.into(),
                a.kind.into(),
                serde_json::to_string(&a.payload)?.into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn waiting_workspaces(&self, _a: WaitingWorkspacesArgs) -> Result<Vec<String>> {
        let rows = self
            .db
            .prepare(
                "SELECT workspace AS value FROM agent_waits
                 GROUP BY workspace ORDER BY min(created_at) LIMIT 100",
            )
            .all()
            .await?
            .results::<ValueRow>()?;
        Ok(rows.into_iter().map(|row| row.value).collect())
    }

    pub(crate) async fn take_wait(&self, a: TakeWaitArgs) -> Result<Option<AgentWait>> {
        let row = self
            .db
            .prepare(
                "DELETE FROM agent_waits WHERE id = (
                   SELECT id FROM agent_waits WHERE workspace = ? ORDER BY created_at, id LIMIT 1)
                 RETURNING id, workspace, kind, payload, created_at",
            )
            .bind(&[a.workspace.to_lowercase().into()])?
            .first::<WaitRow>(None)
            .await?;
        Ok(row.map(|row| AgentWait {
            id: row.id,
            workspace: row.workspace,
            kind: row.kind,
            payload: serde_json::from_str(&row.payload).unwrap_or(serde_json::Value::Null),
            created_at: row.created_at,
        }))
    }

    pub(crate) async fn run_cost(&self, a: RunCostArgs) -> Result<Option<f64>> {
        let row = self
            .db
            .prepare("SELECT cost_usd, token_hash FROM agent_runs WHERE id = ?")
            .bind(&[JsValue::from(a.run_id.as_str())])?
            .first::<CostRow>(None)
            .await?;
        Ok(row
            .filter(|row| row.token_hash == hash(&a.token))
            .and_then(|row| row.cost_usd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dollars_become_micros_rounded_up() {
        assert_eq!(to_micros(0.094), 94_000);
        assert_eq!(to_micros(0.0000001), 1);
        assert_eq!(to_micros(-1.0), 0);
        assert_eq!(to_micros(f64::NAN), 0);
    }

    #[test]
    fn only_agent_kinds_hold_a_slot() {
        let sql = agent_kinds_sql();
        assert!(sql.contains("'implement'") && sql.contains("'plan'"));
        assert!(!sql.contains("'checks'") && !sql.contains("'queue'") && !sql.contains("'mergecheck'"));
    }
}
