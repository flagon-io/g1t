//! Planning: an outcome someone wrote, turned by an agent into issues and
//! the order they have to land in.
//!
//! This service keeps the plan. The runner starts the sandbox in which an
//! agent reads the repository and writes it, and the sandbox reports back
//! with the plan's one-time token. A person then reads the proposal and
//! applies it, which opens the issues. Issues that depend on others are
//! held back and handed to a g1t agent when what they depend on has
//! merged, so that each starts from the result of the last.

use std::collections::HashMap;

use g1t_contracts::access::Capability;
use g1t_contracts::events::IssueEvent;
use g1t_contracts::repos::{PathByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::rows::user;
use crate::{MAX_TITLE_CHARS, Work, valid_title};

const MAX_BRIEF_CHARS: usize = 8_000;
const MAX_PLANNED_ISSUES: usize = 12;
const MAX_BODY_CHARS: usize = 20_000;
const PLAN_PAGE: u32 = 20;
/// Planning that has not reported back in this long has failed.
const PLANNING_MINUTES: u64 = 20;
/// How many g1t agents make changes in one repository at once. The rest of
/// a plan waits its turn, which also keeps a large plan from flooding the
/// sandboxes that checks and reviews need.
const MAX_AGENTS_AT_WORK: usize = 6;

#[derive(Deserialize)]
struct PlanRow {
    id: String,
    repo_id: String,
    brief: String,
    status: PlanStatus,
    summary: Option<String>,
    issues: String,
    error: Option<String>,
    token_hash: String,
    author_id: String,
    author_name: String,
    created_at: String,
    finished_at: Option<String>,
}

impl From<PlanRow> for Plan {
    fn from(row: PlanRow) -> Self {
        // A sandbox that never reported is not still planning.
        let oldest = rfc3339(now_ms().saturating_sub(PLANNING_MINUTES * 60 * 1000));
        let abandoned = row.status == PlanStatus::Planning && row.created_at < oldest;
        Plan {
            id: row.id,
            repo_id: row.repo_id,
            brief: row.brief,
            status: if abandoned {
                PlanStatus::Failed
            } else {
                row.status
            },
            summary: row.summary.unwrap_or_default(),
            issues: serde_json::from_str(&row.issues).unwrap_or_default(),
            error: row
                .error
                .or_else(|| abandoned.then(|| "The planner did not report back.".to_owned())),
            author: user(row.author_id, row.author_name),
            created_at: row.created_at,
            finished_at: row.finished_at,
            progress: Vec::new(),
            exchanges: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct LatestPull {
    number: u32,
    agent: String,
    status: String,
    stage: Option<String>,
    stage_detail: Option<String>,
}

/// An issue waiting for a g1t agent, as selected.
#[derive(Deserialize)]
struct QueuedRow {
    repo_id: String,
    number: u32,
    queued_by: String,
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Tidies what an agent proposed into something that can be opened as it
/// is: bounded, with titles that are valid and dependencies that point only
/// at earlier issues.
pub(crate) fn tidy(proposed: Vec<PlannedIssue>) -> Vec<PlannedIssue> {
    let mut issues: Vec<PlannedIssue> = Vec::new();
    for issue in proposed.into_iter().take(MAX_PLANNED_ISSUES) {
        // Nothing is dropped, so that the positions later issues depend on
        // stay what the agent meant.
        let title = match valid_title(&issue.title) {
            Ok(title) => title.to_owned(),
            Err(_) => match issue.title.trim() {
                "" => "Untitled change".to_owned(),
                long => long.chars().take(MAX_TITLE_CHARS).collect(),
            },
        };
        let position = issues.len() as u32 + 1;
        let mut depends_on: Vec<u32> = issue
            .depends_on
            .into_iter()
            .filter(|earlier| (1..position).contains(earlier))
            .collect();
        depends_on.sort_unstable();
        depends_on.dedup();
        issues.push(PlannedIssue {
            title,
            body: issue.body.trim().chars().take(MAX_BODY_CHARS).collect(),
            labels: normalize_labels(&issue.labels).unwrap_or_default(),
            done: issue
                .done
                .into_iter()
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .take(10)
                .collect(),
            files: issue.files.into_iter().take(40).collect(),
            depends_on,
            number: None,
        });
    }
    issues
}

impl Work {
    async fn plan_row(&self, id: &str) -> Result<Option<PlanRow>> {
        self.db
            .prepare("SELECT * FROM plans WHERE id = ?")
            .bind(&[id.into()])?
            .first::<PlanRow>(None)
            .await
    }

    /// Records an outcome to plan for, and returns what a sandbox needs to
    /// plan it. Needs the Write role: a plan becomes issues and agents at
    /// work, which the workspace pays for.
    pub(crate) async fn start_plan(&self, a: StartPlanArgs) -> Result<Outcome<PlanJob>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if let Some(refused) = may_plan(&a.actor, &repo) {
            return Ok(refused);
        }
        let brief: String = a.brief.trim().chars().take(MAX_BRIEF_CHARS).collect();
        if brief.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Say what you want to be true when the work is done.",
            ));
        }
        let now = now_ms();
        let id = new_id("pln", now);
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("no source of randomness");
        let token = hex::encode(bytes);
        self.db
            .prepare(
                "INSERT INTO plans
                   (id, repo_id, brief, token_hash, author_id, author_name, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                brief.as_str().into(),
                hash(&token).into(),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(PlanJob {
            plan_id: id,
            token,
            brief,
            repo: RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
        }))
    }

    /// Records the plan a sandbox's agent wrote, or why it could not write
    /// one. The plan's token is the only credential.
    pub(crate) async fn report_plan(&self, a: ReportPlanArgs) -> Result<Outcome<bool>> {
        let row = self
            .plan_row(&a.plan_id)
            .await?
            .filter(|row| row.token_hash == hash(&a.token));
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Plan not found."));
        };
        if row.status != PlanStatus::Planning {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This plan has already been reported.",
            ));
        }
        let issues = tidy(a.issues);
        let error = a.error.or_else(|| {
            issues
                .is_empty()
                .then(|| "The planner proposed no issues.".to_owned())
        });
        self.db
            .prepare(
                "UPDATE plans SET status = ?, summary = ?, issues = ?, error = ?, finished_at = ?
                 WHERE id = ? AND status = 'planning'",
            )
            .bind(&[
                if error.is_some() { "failed" } else { "ready" }.into(),
                a.summary.trim().into(),
                serde_json::to_string(&issues)?.into(),
                error.as_deref().map_or(JsValue::NULL, JsValue::from),
                rfc3339(now_ms()).into(),
                row.id.into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn get_plan(&self, a: PlanArgs) -> Result<Outcome<Plan>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // The repos service found it for the viewer, so they can read it,
        // and whoever can read a repository can read its plans.
        Ok(
            match self
                .plan_row(&a.id)
                .await?
                .filter(|row| row.repo_id == repo.id)
            {
                Some(row) => {
                    let mut plan: Plan = row.into();
                    if plan.status == PlanStatus::Applied {
                        plan.progress = self.progress(&repo.id, &plan).await?;
                        let numbers: Vec<u32> = plan
                            .progress
                            .iter()
                            .flat_map(|item| std::iter::once(item.number).chain(item.pull))
                            .collect();
                        plan.exchanges = self.exchanges(&repo.id, &numbers).await?;
                    }
                    Outcome::Ok(plan)
                }
                None => Outcome::fail(FailureCode::NotFound, "Plan not found."),
            },
        )
    }

    /// Where each issue an applied plan opened stands now, all at once.
    async fn progress(&self, repo_id: &str, plan: &Plan) -> Result<Vec<IssueProgress>> {
        let numbers: Vec<u32> = plan.issues.iter().filter_map(|issue| issue.number).collect();
        let issues = futures_util::future::try_join_all(
            numbers.iter().map(|number| self.issue(repo_id, *number)),
        )
        .await?;
        let pulls = futures_util::future::try_join_all(numbers.iter().map(|number| async move {
            self.db
                .prepare(
                    "SELECT number, agent, status, stage, stage_detail FROM pulls
                     WHERE repo_id = ? AND issue_number = ? AND status != 'closed'
                     ORDER BY number DESC LIMIT 1",
                )
                .bind(&[repo_id.into(), (*number).into()])?
                .first::<LatestPull>(None)
                .await
        }))
        .await?;
        let open: std::collections::HashSet<u32> = issues
            .iter()
            .flatten()
            .filter(|issue| issue.state == State::Open)
            .map(|issue| issue.number)
            .collect();
        Ok(issues
            .into_iter()
            .zip(pulls)
            .filter_map(|(issue, pull)| {
                let issue = issue?;
                let blocked_by: Vec<u32> = issue
                    .blocked_by
                    .iter()
                    .copied()
                    .filter(|number| open.contains(number))
                    .collect();
                let (state, detail) = if issue.state == State::Closed {
                    match (issue.reason, issue.resolved_by) {
                        (Some(IssueReason::Completed), Some(by)) => {
                            ("landed".to_owned(), format!("Landed with #{by}."))
                        }
                        _ => ("closed".to_owned(), "Closed without landing.".to_owned()),
                    }
                } else if let Some(pull) = pull.as_ref().filter(|pull| pull.status != "merged") {
                    (
                        pull.stage.clone().unwrap_or_else(|| {
                            if pull.status == "draft" { "working" } else { "ready" }.to_owned()
                        }),
                        pull.stage_detail.clone().unwrap_or_default(),
                    )
                } else if !blocked_by.is_empty() {
                    let named: Vec<String> = blocked_by.iter().map(|n| format!("#{n}")).collect();
                    ("blocked".to_owned(), format!("Waiting for {} to land.", named.join(", ")))
                } else if issue.queued {
                    ("waiting".to_owned(), "Waiting for an agent to be free.".to_owned())
                } else {
                    ("open".to_owned(), "Nobody is working on it.".to_owned())
                };
                Some(IssueProgress {
                    number: issue.number,
                    title: issue.title,
                    state,
                    detail,
                    blocked_by,
                    pull: pull.as_ref().map(|pull| pull.number),
                    agent: pull.map(|pull| pull.agent).or(issue.agent),
                })
            })
            .collect())
    }

    pub(crate) async fn list_plans(&self, a: ViewArgs) -> Result<Outcome<Vec<Plan>>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // Found for the viewer: they can read it, and so its plans.
        let rows = self
            .db
            .prepare("SELECT * FROM plans WHERE repo_id = ? ORDER BY id DESC LIMIT ?")
            .bind(&[repo.id.into(), PLAN_PAGE.into()])?
            .all()
            .await?
            .results::<PlanRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Plan::from).collect()))
    }

    /// Opens a plan's issues. Each depends on the issues the plan said it
    /// does, by their new numbers. With `assign`, every one is queued for a
    /// g1t agent: those that depend on nothing are ready at once, and the
    /// rest as what they depend on merges.
    pub(crate) async fn apply_plan(&self, a: ApplyPlanArgs) -> Result<Outcome<Plan>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if let Some(refused) = may_plan(&a.actor, &repo) {
            return Ok(refused);
        }
        if a.assign
            && let Some(refused) = crate::mentions::refuse_job_token(&a.actor)
        {
            return Ok(refused);
        }
        let Some(row) = self
            .plan_row(&a.id)
            .await?
            .filter(|row| row.repo_id == repo.id)
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Plan not found."));
        };
        // Only whoever flips it from ready to applied opens the issues.
        let claimed = self
            .db
            .prepare(
                "UPDATE plans SET status = 'applied' WHERE id = ? AND status = 'ready'
                 RETURNING id AS value",
            )
            .bind(&[row.id.as_str().into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This plan is not waiting to be applied.",
            ));
        }

        let mut plan: Plan = row.into();
        // What the person kept, in the plan's order. A dependency on an
        // issue they dropped is dropped with it.
        let kept: Vec<usize> = match &a.keep {
            Some(positions) => (0..plan.issues.len())
                .filter(|index| positions.contains(&(*index as u32 + 1)))
                .collect(),
            None => (0..plan.issues.len()).collect(),
        };
        let queued_by = a
            .assign
            .then(|| serde_json::to_string(&a.actor))
            .transpose()?;
        let mut numbers: Vec<Option<u32>> = vec![None; plan.issues.len()];
        // Whoever applies the plan opens its issues; g1t's agent applying
        // one opens them as g1t, for the person it works for.
        let (author, requested_by) = authorship(&a.actor, false);
        for index in kept {
            let planned = &plan.issues[index];
            let blocked_by: Vec<u32> = planned
                .depends_on
                .iter()
                .filter_map(|position| numbers.get(*position as usize - 1).copied().flatten())
                .collect();
            let number = self.next_number(&repo.id).await?;
            let now = now_ms();
            let timestamp = rfc3339(now);
            let issue_id = new_id("iss", now);
            self.db
                .prepare(
                    "INSERT INTO issues
                       (id, repo_id, number, title, body, labels, checks, blocked_by, queued_by,
                        author_id, author_name, requested_by_id, requested_by_name, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    issue_id.as_str().into(),
                    repo.id.as_str().into(),
                    number.into(),
                    planned.title.as_str().into(),
                    // What done looks like, in words, for the agent and
                    // reviewers; the branch's required checks gate the merge.
                    with_definition_of_done(&planned.body, &planned.done).into(),
                    serde_json::to_string(&planned.labels)?.into(),
                    "[]".into(),
                    serde_json::to_string(&blocked_by)?.into(),
                    queued_by.as_deref().map_or(JsValue::NULL, JsValue::from),
                    author.id.as_str().into(),
                    author.username.as_str().into(),
                    requested_by.as_ref().map_or(JsValue::NULL, |user| user.id.as_str().into()),
                    requested_by.as_ref().map_or(JsValue::NULL, |user| user.username.as_str().into()),
                    timestamp.as_str().into(),
                    timestamp.as_str().into(),
                ])?
                .run()
                .await?;
            if a.assign {
                self.note(
                    &repo.id,
                    number,
                    (&a.actor.id, &a.actor.username),
                    &if blocked_by.is_empty() {
                        "queued this for g1t".to_owned()
                    } else {
                        format!(
                            "queued this for g1t, to start once {} {} merged",
                            blocked_by
                                .iter()
                                .map(|number| format!("#{number}"))
                                .collect::<Vec<_>>()
                                .join(", "),
                            if blocked_by.len() == 1 { "has" } else { "have" }
                        )
                    },
                )
                .await?;
            }
            self.publish(
                "issue.opened",
                &repo.id,
                &a.actor,
                IssueEvent {
                    issue_id,
                    repo_id: repo.id.clone(),
                    number,
                    author: Some((&author).into()),
                    requested_by: requested_by.as_ref().map(Into::into),
                    title: Some(planned.title.clone()),
                    ..IssueEvent::default()
                },
            )
            .await?;
            numbers[index] = Some(number);
        }
        for (issue, number) in plan.issues.iter_mut().zip(&numbers) {
            issue.number = *number;
        }
        self.db
            .prepare("UPDATE plans SET issues = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&plan.issues)?.into(),
                plan.id.as_str().into(),
            ])?
            .run()
            .await?;
        plan.status = PlanStatus::Applied;
        Ok(Outcome::Ok(plan))
    }

    /// Queues an issue for a g1t agent, which needs the Write role, or
    /// takes it out of the queue, as whoever may change the issue.
    pub(crate) async fn queue_issue(&self, a: QueueIssueArgs) -> Result<Outcome<bool>> {
        let issue = match self.manageable_issue(&a.actor, &a.repo, a.number).await? {
            Outcome::Ok(issue) => issue,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if a.queued {
            if let Some(refused) = crate::mentions::refuse_job_token(&a.actor) {
                return Ok(refused);
            }
            let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
                Outcome::Ok(repo) => repo,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, Capability::Run) {
                return Ok(Outcome::Fail(failure));
            }
        }
        let queued_by = a
            .queued
            .then(|| serde_json::to_string(&a.actor))
            .transpose()?;
        self.db
            .prepare("UPDATE issues SET queued_by = ? WHERE id = ?")
            .bind(&[
                queued_by.as_deref().map_or(JsValue::NULL, JsValue::from),
                issue.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// Takes the issues that are waiting for a g1t agent and can be given
    /// one now: open, queued, with nobody working on them, and with
    /// everything they depend on closed. Oldest first, in one repository or
    /// in all, and no more than leaves each repository with
    /// `MAX_AGENTS_AT_WORK` agents making changes at once.
    ///
    /// Taking an issue takes it out of the queue, in one statement, so two
    /// callers cannot both start an agent on it. A caller that then cannot
    /// start one puts it back with `queue_issue`.
    pub(crate) async fn ready_issues(&self, a: ReadyIssuesArgs) -> Result<Vec<ReadyIssue>> {
        let rows = self
            .db
            .prepare(
                "SELECT repo_id, number, queued_by FROM issues
                 WHERE state = 'open' AND queued_by IS NOT NULL
                   AND (?1 IS NULL OR repo_id = ?1)
                   AND NOT EXISTS (
                     SELECT 1 FROM pulls
                     WHERE pulls.issue_id = issues.id AND pulls.status IN ('draft', 'open'))
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(issues.blocked_by) AS blocker
                     JOIN issues AS earlier
                       ON earlier.repo_id = issues.repo_id AND earlier.number = blocker.value
                     WHERE earlier.state = 'open')
                 ORDER BY number LIMIT 50",
            )
            .bind(&[a.repo_id.map_or(JsValue::NULL, JsValue::from)])?
            .all()
            .await?
            .results::<QueuedRow>()?;
        let mut ready = Vec::new();
        let mut room: HashMap<String, usize> = HashMap::new();
        for row in rows {
            let Ok(actor) = serde_json::from_str::<User>(&row.queued_by) else {
                continue;
            };
            // How many more agents this repository has room for.
            if !room.contains_key(&row.repo_id) {
                // An archived or deleted repository's issues stay queued,
                // untaken, for when it is writable again.
                if !self.repo_active(&row.repo_id).await? {
                    room.insert(row.repo_id.clone(), 0);
                    continue;
                }
                let working = self
                    .db
                    .prepare(
                        "SELECT count(*) AS n FROM pulls
                         WHERE repo_id = ? AND managed = 1 AND status = 'draft'",
                    )
                    .bind(&[row.repo_id.as_str().into()])?
                    .first::<crate::rows::NumberRow>(None)
                    .await?
                    .map_or(0, |row| row.n as usize);
                room.insert(
                    row.repo_id.clone(),
                    MAX_AGENTS_AT_WORK.saturating_sub(working),
                );
            }
            let left = room.get_mut(&row.repo_id).expect("just inserted");
            if *left == 0 {
                continue;
            }
            let taken = self
                .db
                .prepare(
                    "UPDATE issues SET queued_by = NULL
                     WHERE repo_id = ? AND number = ? AND queued_by IS NOT NULL
                     RETURNING id AS value",
                )
                .bind(&[row.repo_id.as_str().into(), row.number.into()])?
                .first::<crate::rows::ValueRow>(None)
                .await?;
            if taken.is_none() {
                continue;
            }
            *left -= 1;
            // Where the repository is now. Who may run agents there is the
            // runner's question when it starts the issue, asked as whoever
            // queued it; this only needs the address.
            let path: Option<RepoPath> =
                g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: row.repo_id.clone() }).await?;
            match path {
                Some(repo) => ready.push(ReadyIssue { repo, number: row.number, actor }),
                None => {
                    // Taken but not handed over: put it back, so it is not
                    // lost with nothing said.
                    worker::console_error!("ready_issues: no path for {}; issue #{} stays queued", row.repo_id, row.number);
                    self.db
                        .prepare("UPDATE issues SET queued_by = ? WHERE repo_id = ? AND number = ?")
                        .bind(&[row.queued_by.as_str().into(), row.repo_id.as_str().into(), row.number.into()])?
                        .run()
                        .await?;
                }
            }
        }
        Ok(ready)
    }
}

/// Refuses whoever may not plan work in `repo`: the Write role, verified.
fn may_plan<T>(actor: &User, repo: &Repo) -> Option<Outcome<T>> {
    if !actor.verified {
        return Some(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
    }
    match crate::allowed(Some(actor), repo, Capability::Run) {
        Outcome::Ok(()) => None,
        Outcome::Fail(failure) => Some(Outcome::Fail(failure)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposed(title: &str, depends_on: &[u32]) -> PlannedIssue {
        PlannedIssue {
            title: title.to_owned(),
            body: "  What to do.  ".to_owned(),
            labels: vec!["Feature".to_owned()],
            done: vec![" The flag is documented in --help. ".to_owned(), String::new()],
            files: vec!["src/lib.rs".to_owned()],
            depends_on: depends_on.to_vec(),
            number: None,
        }
    }

    #[test]
    fn a_proposal_is_trimmed_and_normalised() {
        let issues = tidy(vec![proposed("  Add a flag  ", &[])]);
        assert_eq!(issues[0].title, "Add a flag");
        assert_eq!(issues[0].body, "What to do.");
        assert_eq!(issues[0].labels, ["feature"]);
        assert_eq!(issues[0].done, ["The flag is documented in --help."]);
    }

    #[test]
    fn an_issue_can_only_depend_on_earlier_ones() {
        let issues = tidy(vec![
            proposed("First", &[2]),
            proposed("Second", &[1, 1, 2, 9]),
            proposed("Third", &[2, 1]),
        ]);
        assert!(issues[0].depends_on.is_empty());
        assert_eq!(issues[1].depends_on, [1]);
        assert_eq!(issues[2].depends_on, [1, 2]);
    }

    #[test]
    fn a_plan_is_bounded() {
        let many = (0..30)
            .map(|i| proposed(&format!("Issue {i}"), &[]))
            .collect();
        assert_eq!(tidy(many).len(), MAX_PLANNED_ISSUES);
    }
}
