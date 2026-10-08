//! Seeing a pull request through. Once a g1t agent has made a change, g1t
//! takes each remaining step itself: waiting for the checks the
//! repository's workflows report on it, a review by another agent, sending
//! the author back to address a failed check (with what its jobs printed)
//! or the review, and catching up when the branch it would land on has
//! moved. It stops when the pull request meets everything the default
//! branch's protection requires, or when it has tried and a person has to
//! decide.
//!
//! This service decides what the next step is and claims it. The runner
//! service asks, on every event that could change the answer, and carries
//! the step out in a sandbox.

use g1t_contracts::repos::{GetByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Membership, Outcome, User, Viewer};
use g1t_kit::now_ms;
use std::collections::HashMap;

use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::prefetch::Slot;
use crate::reviews::{AGENT_ID, AGENT_NAME};
use crate::statuses::{self, WorkflowFacts};
use crate::rows::ValueRow;

/// How long a claimed step is waited for before it may be taken again.
const REVIEW_MINUTES: u64 = 20;
const REVISION_MINUTES: u64 = 60;
const CATCH_UP_MINUTES: u64 = 30;
const MERGE_MINUTES: u64 = 2;
/// Who a merge made by a repository's settings is attributed to. Not an
/// account: `g1t` cannot be registered.
pub(crate) const POLICY_ACTOR_ID: &str = "g1t_policy";
pub(crate) const POLICY_ACTOR_NAME: &str = "g1t";
/// How much of a failed check's output the author is shown.
const MAX_CHECK_OUTPUT_CHARS: usize = 4_000;
/// How many failed jobs' logs the author is shown, and how much of each.
const MAX_FAILED_JOBS: usize = 3;
const MAX_JOB_LOG_CHARS: usize = 3_000;
/// The most pages of a job's log read to find its end.
const MAX_LOG_PAGES: usize = 6;
const MANAGED_PAGE: u32 = 200;

/// The part of a pull request's row that tracks its lifecycle.
#[derive(Deserialize)]
struct Progress {
    managed: u8,
    revisions: u32,
    revised_at: Option<String>,
    working_on: Option<String>,
    working_until: Option<String>,
    stalled: Option<String>,
}

/// A merge asked for while the pull request was behind, as stored.
#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LandRequest {
    actor: User,
    keep_issue_open: bool,
}

#[derive(Deserialize)]
struct LandRow {
    land_requested: Option<String>,
    land_requested_at: Option<String>,
    stalled: Option<String>,
}

#[derive(Deserialize)]
struct FinishedReview {
    finished_at: String,
    verdict: Option<Verdict>,
}

#[derive(Deserialize)]
struct ReviewNote {
    body: String,
    path: Option<String>,
    line: Option<u32>,
}

/// What the author is being sent back to address.
pub(crate) enum Feedback {
    /// The merge queue took it out: its combined state failed.
    FailedChecks,
    /// Checks that failed on its head.
    FailedWorkflows,
    /// The review that finished at this time.
    Review(String),
    /// What a person who asked for changes wrote since the last revision.
    Person(PersonRequest),
}

/// A person's request for changes that still stands: their latest verdict,
/// made after the agent last revised.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PersonRequest {
    author_id: String,
    author_name: String,
    created_at: String,
}

/// What should happen next, if it is g1t's turn.
pub(crate) enum Next {
    /// A step is under way, or it is a person's turn.
    Wait,
    Review,
    Revise(Feedback),
    CatchUp,
    /// Land it, because the repository says ready pull requests land.
    Merge,
}

/// Whether g1t made this pull request, and so sees it through.
pub(crate) fn made_by_g1t(pull: &Pull) -> bool {
    pull.runtime == Runtime::Hosted && pull.agent == AGENT_NAME && pull.fork.is_some()
}

/// Whether a verdict by `reviewer` is a person's other than the pull
/// request's owner (whoever asked g1t for it, or its author): neither
/// theirs nor g1t's agent's.
pub(crate) fn from_someone_else(pull: &Pull, reviewer: &str) -> bool {
    !pull.is_owned_by(reviewer) && reviewer != AGENT_ID
}

fn at(stage: Stage, detail: impl Into<String>, revisions: u32) -> Lifecycle {
    Lifecycle {
        stage,
        detail: detail.into(),
        revisions,
    }
}

fn times(count: u32) -> String {
    match count {
        1 => "once".to_owned(),
        2 => "twice".to_owned(),
        count => format!("{count} times"),
    }
}

/// Everything the next step depends on.
struct Facts {
    /// Still being made: not yet marked ready for review.
    draft: bool,
    /// Why g1t stopped, if it has.
    stalled: Option<String>,
    /// The step under way, if one was claimed and is still being waited for.
    working_on: Option<String>,
    /// `failed` when the merge queue took it out.
    check_status: Option<CheckStatus>,
    /// A review someone asked for is being written.
    review_pending: bool,
    revisions: u32,
    /// The latest finished review of the change as it is now.
    review: Option<FinishedReview>,
    /// Whether the branch it would land on has moved without it.
    behind: bool,
    /// Whether it is known to conflict with the branch it would land on.
    conflicting: bool,
    /// Whether the repository lands a ready pull request by itself.
    auto_merge: bool,
    /// Whether the repository refuses to merge one that is behind.
    require_up_to_date: bool,
    /// Whether a second agent reviews it without being asked.
    agent_review: bool,
    /// How many times the author may be sent back.
    max_revisions: u32,
    /// What the repository's approval rule still wants, if anything.
    approvals_missing: Option<String>,
    /// A person asked for changes since the agent last revised.
    person_request: Option<PersonRequest>,
    /// Its place in the merge queue, and what is ahead of it there.
    queued: Option<(QueueState, Vec<u32>)>,
    /// What the checks on its head say, against the required ones.
    workflows: WorkflowFacts,
    /// Why the agent's change has low confidence, when the repository asks
    /// a person before merging one and no person has approved it since.
    low_confidence: Option<String>,
}

/// Where a pull request stands, and the step to take if it is g1t's turn.
///
/// The order is: nothing while a step is under way; a person asking for
/// changes is answered first; its checks must finish, and the required
/// ones pass; then a review must approve; then it must be up to date. A
/// person's or an agent's request for changes, or a failed check, sends the
/// author back, a limited number of times, after which a person is asked.
/// A check the branch does not require stops holding it once the
/// revisions run out.
fn decide(facts: Facts) -> (Lifecycle, Next) {
    let revisions = facts.revisions;
    let wait = |stage, detail: &str| (at(stage, detail, revisions), Next::Wait);
    let exhausted = revisions >= facts.max_revisions;

    if facts.draft {
        return wait(Stage::Working, "g1t is making the change.");
    }
    if let Some(reason) = &facts.stalled {
        return wait(Stage::NeedsYou, reason);
    }
    if let Some((state, ahead)) = &facts.queued {
        let named = ahead.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ");
        let detail = match (state, ahead.is_empty()) {
            (QueueState::Testing, true) => "In the merge queue: being tested on the default branch as it is.".to_owned(),
            (QueueState::Testing, false) => {
                format!("In the merge queue: being tested together with {named}, ahead of it.")
            }
            (QueueState::Passed, true) => "Passed in the merge queue. Landing.".to_owned(),
            (QueueState::Passed, false) => {
                format!("Passed in the merge queue together with {named}. It lands once they have.")
            }
            _ => "In the merge queue, waiting for its turn to be tested.".to_owned(),
        };
        return wait(Stage::Queued, &detail);
    }
    match facts.working_on.as_deref() {
        Some("revision") => {
            return wait(
                Stage::Revising,
                "The agent is addressing what the checks or the review found.",
            );
        }
        Some("catch_up") => {
            return wait(
                Stage::CatchingUp,
                "The agent is merging in the branch this will land on, which has moved.",
            );
        }
        Some("answer") => {
            return wait(
                Stage::Answering,
                "The agent is answering what another agent asked it.",
            );
        }
        Some("merge") => return wait(Stage::Ready, "Merging."),
        Some(_) => return wait(Stage::Reviewing, "g1t is reviewing the change."),
        None => {}
    }
    if facts.review_pending {
        return wait(Stage::Reviewing, "g1t is reviewing the change.");
    }
    // A person asked for changes: the agent makes them, as it would for a
    // review it asked for, before anything else.
    if let Some(request) = &facts.person_request {
        if exhausted {
            return wait(
                Stage::NeedsYou,
                &format!(
                    "{} asked for changes, and the agent has already revised {}.",
                    request.author_name,
                    times(revisions)
                ),
            );
        }
        return (
            at(
                Stage::Revising,
                format!(
                    "{} asked for changes. The agent is being sent back to make them.",
                    request.author_name
                ),
                revisions,
            ),
            Next::Revise(Feedback::Person(request.clone())),
        );
    }

    // The merge queue took it out: its change failed together with what
    // was ahead of it.
    match facts.check_status {
        Some(CheckStatus::Failed) if exhausted => {
            return wait(
                Stage::NeedsYou,
                &format!("It failed in the merge queue after the agent revised {}.", times(revisions)),
            );
        }
        Some(CheckStatus::Failed) => {
            return (
                at(
                    Stage::Revising,
                    "It failed in the merge queue. The agent is being sent back to fix it.",
                    revisions,
                ),
                Next::Revise(Feedback::FailedChecks),
            );
        }
        Some(CheckStatus::Errored) => {
            return wait(Stage::NeedsYou, "Its checks could not be run.");
        }
        _ => {}
    }

    // Its checks: the agent fixes any that failed. Once it is out of
    // revisions, only the checks the branch requires still hold it.
    if !facts.workflows.failed.is_empty() {
        let failed = statuses::list(&facts.workflows.failed);
        let required = facts.workflows.required_failed();
        if !exhausted {
            return (
                at(
                    Stage::Revising,
                    format!("{failed} failed. The agent is being sent back to fix it."),
                    revisions,
                ),
                Next::Revise(Feedback::FailedWorkflows),
            );
        }
        if !required.is_empty() {
            return wait(
                Stage::NeedsYou,
                &format!(
                    "The required {} {} still {} after the agent revised {}.",
                    if required.len() == 1 { "check" } else { "checks" },
                    statuses::list(&required),
                    if required.len() == 1 { "fails" } else { "fail" },
                    times(revisions)
                ),
            );
        }
    }
    if !facts.workflows.pending.is_empty() {
        return wait(
            Stage::Checking,
            &format!("Waiting for {} to finish.", statuses::list(&facts.workflows.pending)),
        );
    }
    let expected = facts.workflows.expected();
    if !expected.is_empty() {
        return wait(
            Stage::Checking,
            &format!(
                "Waiting for the required {} {} to report on its latest commit.",
                if expected.len() == 1 { "check" } else { "checks" },
                statuses::list(&expected)
            ),
        );
    }

    // A second agent reviews it, unless the repository leaves review to people.
    if facts.agent_review {
        match facts.review {
            None => {
                return (
                    at(
                        Stage::Reviewing,
                        "g1t is about to review the change.",
                        revisions,
                    ),
                    Next::Review,
                );
            }
            Some(FinishedReview { verdict: None, .. }) => {
                return wait(Stage::NeedsYou, "The review could not be completed.");
            }
            Some(FinishedReview {
                verdict: Some(Verdict::RequestChanges),
                ..
            }) if exhausted => {
                return wait(
                    Stage::NeedsYou,
                    &format!(
                        "The review still asks for changes after the agent revised {}.",
                        times(revisions)
                    ),
                );
            }
            Some(FinishedReview {
                verdict: Some(Verdict::RequestChanges),
                finished_at,
            }) => {
                return (
                    at(
                        Stage::Revising,
                        "The review asked for changes. The agent is being sent back to make them.",
                        revisions,
                    ),
                    Next::Revise(Feedback::Review(finished_at)),
                );
            }
            Some(FinishedReview {
                verdict: Some(Verdict::Approve),
                ..
            }) => {}
        }
    }

    // A conflict found ahead of time is resolved before anything else that
    // is left: it could not merge, by a person or by the queue, until then.
    if facts.conflicting {
        return (
            at(
                Stage::CatchingUp,
                "It conflicts with the branch it will land on. The agent is merging that branch in and resolving the conflicts.",
                revisions,
            ),
            Next::CatchUp,
        );
    }
    // Only where the repository insists is catching up a step of its own,
    // followed by its checks again. Elsewhere it happens as part of merging.
    if facts.behind && facts.require_up_to_date {
        return (
            at(
                Stage::CatchingUp,
                "The branch it will land on has moved. The agent is catching up.",
                revisions,
            ),
            Next::CatchUp,
        );
    }
    // The repository wants approvals this does not have yet: people's turn,
    // so it is shown as needing someone, not as g1t still working.
    if let Some(missing) = &facts.approvals_missing {
        return wait(Stage::NeedsYou, missing);
    }
    // Everything else is met, but g1t is not sure of the change: a person
    // decides, rather than auto-merge or the queue.
    if let Some(reasons) = &facts.low_confidence {
        return wait(
            Stage::NeedsYou,
            &format!(
                "The agent's confidence in this change is low ({reasons}). This repository asks a person before merging it: approve it to let it land, or ask for changes."
            ),
        );
    }
    if facts.auto_merge {
        return (
            at(
                Stage::Ready,
                "Everything this repository asks for is met. Merging, as its settings say.",
                revisions,
            ),
            Next::Merge,
        );
    }
    wait(
        Stage::Ready,
        if facts.behind {
            "Ready to merge. Merging brings it up to date with the default branch first."
        } else {
            "Everything this repository asks for is met. Ready to merge."
        },
    )
}

impl Work {
    /// Where a pull request stands and what g1t does next, remembered so
    /// lists can show it without working it out again. `None` for one g1t
    /// is not seeing through.
    pub(crate) async fn assess(
        &self,
        pull: &Pull,
        issue: &Option<Issue>,
        behind: bool,
    ) -> Result<Option<(Lifecycle, Next)>> {
        Ok(self
            .assess_with_confidence(pull, issue, behind)
            .await?
            .map(|(lifecycle, next, _)| (lifecycle, next)))
    }

    /// [`Self::assess`], with how sure g1t is of the change once the agent
    /// has finished it.
    pub(crate) async fn assess_with_confidence(
        &self,
        pull: &Pull,
        issue: &Option<Issue>,
        behind: bool,
    ) -> Result<Option<(Lifecycle, Next, Option<Confidence>)>> {
        let assessed = self.assess_now(pull, issue, behind).await?;
        if let Some((lifecycle, _, _)) = &assessed
            && !self.remembered_as(&pull.id, lifecycle)?
        {
            self.remember(&pull.id, lifecycle).await?;
        }
        Ok(assessed)
    }

    /// Whether the row read for this request already says `lifecycle`, so
    /// that showing a pull request does not write it again unchanged.
    fn remembered_as(&self, pull_id: &str, lifecycle: &Lifecycle) -> Result<bool> {
        let Some(found) = self.prefetched_pull(pull_id) else {
            return Ok(false);
        };
        Ok(found
            .first::<crate::rows::Snapshot>(Slot::Pull)?
            .is_some_and(|stored| {
                stored.stage == Some(lifecycle.stage) && stored.stage_detail.as_deref() == Some(lifecycle.detail.as_str())
            }))
    }

    /// Saves where a pull request stands, for [`Self::remembered`].
    pub(crate) async fn remember(&self, pull_id: &str, lifecycle: &Lifecycle) -> Result<()> {
        let stage = serde_json::to_value(lifecycle.stage)?;
        self.db
            .prepare("UPDATE pulls SET stage = ?, stage_detail = ? WHERE id = ?")
            .bind(&[
                stage.as_str().unwrap_or_default().into(),
                lifecycle.detail.as_str().into(),
                pull_id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    async fn assess_now(
        &self,
        pull: &Pull,
        // What done means is in its body, for the agent; the merge waits on
        // the branch's required checks, not on the issue.
        _issue: &Option<Issue>,
        behind: bool,
    ) -> Result<Option<(Lifecycle, Next, Option<Confidence>)>> {
        if !pull.status.is_active() {
            return Ok(None);
        }
        // As read for this request (prefetch.rs), or now.
        let prefetched = self.prefetched_pull(&pull.id);
        let progress = match &prefetched {
            Some(found) => found.first::<Progress>(Slot::Pull)?,
            None => {
                self.db
                    .prepare(
                        "SELECT managed, revisions, revised_at, working_on, working_until, stalled
                         FROM pulls WHERE id = ?",
                    )
                    .bind(&[pull.id.as_str().into()])?
                    .first::<Progress>(None)
                    .await?
            }
        };
        let Some(progress) = progress.filter(|progress| progress.managed != 0) else {
            return Ok(None);
        };
        let now = rfc3339(now_ms());
        let working_on = progress
            .working_until
            .as_deref()
            .is_some_and(|until| until > now.as_str())
            .then(|| progress.working_on.clone().unwrap_or_default());
        let review = match &prefetched {
            Some(found) => found.first::<FinishedReview>(Slot::Review)?,
            None => {
                self.db
                    .prepare(
                        "SELECT finished_at, verdict FROM review_runs
                         WHERE pull_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
                    )
                    .bind(&[pull.id.as_str().into()])?
                    .first::<FinishedReview>(None)
                    .await?
            }
        }
            // A review of what the change was before its last revision says
            // nothing about what it is now.
            .filter(|review| {
                progress
                    .revised_at
                    .as_deref()
                    .is_none_or(|revised| review.finished_at.as_str() >= revised)
            });
        let settings = self.settings_for(pull).await?;
        let workflows = WorkflowFacts::of(
            &self.statuses(&pull.repo_id, pull.head_commit.as_deref()).await?,
            &settings.required_checks,
        );
        // Once the agent has finished the change: how sure g1t is of it, and
        // whether that holds it for a person.
        let (confidence, low_confidence) = if pull.status == PullStatus::Draft {
            (None, None)
        } else {
            let review_comments = match &review {
                Some(review) => self.review_comments(pull, &review.finished_at).await?,
                None => 0,
            };
            let confidence = self
                .assess_confidence(
                    pull,
                    crate::confidence::Signals {
                        required: crate::confidence::RequiredSignal::of(&workflows.required),
                        queue_failed: pull.check_status == Some(CheckStatus::Failed),
                        revisions: progress.revisions,
                        agent_review: settings.agent_review,
                        review: review.as_ref().and_then(|review| review.verdict),
                        review_comments,
                        ..Default::default()
                    },
                )
                .await?;
            let held = settings.hold_low_confidence
                && confidence.level == ConfidenceLevel::Low
                && !self.person_approved(pull, progress.revised_at.as_deref()).await?;
            let reasons = held.then(|| confidence.reasons.join(", "));
            (Some(confidence), reasons)
        };
        let (lifecycle, next) = decide(Facts {
            draft: pull.status == PullStatus::Draft,
            stalled: progress.stalled,
            working_on,
            check_status: pull.check_status,
            review_pending: self.review_pending(&pull.id).await?,
            revisions: progress.revisions,
            review,
            behind,
            conflicting: self.conflicting_files(pull).await?.is_some(),
            auto_merge: settings.auto_merge,
            require_up_to_date: settings.require_up_to_date,
            agent_review: settings.agent_review,
            max_revisions: settings.max_revisions,
            approvals_missing: self.approvals_gap(&settings, pull).await?,
            person_request: self
                .person_request(pull, progress.revised_at.as_deref())
                .await?,
            queued: self.queued_entry(&pull.id).await?,
            workflows,
            low_confidence,
        });
        Ok(Some((lifecycle, next, confidence)))
    }

    /// The latest request for changes by a person other than its owner
    /// (whoever asked g1t for it, or its author), if it is that person's
    /// latest verdict and came after the last revision.
    async fn person_request(
        &self,
        pull: &Pull,
        revised_at: Option<&str>,
    ) -> Result<Option<PersonRequest>> {
        #[derive(Deserialize)]
        struct Verdicts {
            author_id: String,
            author_name: String,
            verdict: Verdict,
            created_at: String,
        }
        let rows = match self.prefetched_pull(&pull.id) {
            Some(found) => found
                .rows::<Verdicts>(Slot::Verdicts)?
                .into_iter()
                .filter(|row| from_someone_else(pull, &row.author_id))
                .collect(),
            None => self
                .db
                .prepare(
                    "SELECT author_id, author_name, verdict, created_at FROM comments
                     WHERE repo_id = ? AND number = ? AND verdict IS NOT NULL
                       AND author_id != ? AND author_id != ?
                     ORDER BY id",
                )
                .bind(&[
                    pull.repo_id.as_str().into(),
                    pull.number.into(),
                    pull.owner().id.as_str().into(),
                    AGENT_ID.into(),
                ])?
                .all()
                .await?
                .results::<Verdicts>()?,
        };
        // Each person's latest verdict is the one that stands.
        let mut latest: HashMap<String, Verdicts> = HashMap::new();
        for row in rows {
            latest.insert(row.author_id.clone(), row);
        }
        Ok(latest
            .into_values()
            .filter(|row| row.verdict == Verdict::RequestChanges)
            .filter(|row| revised_at.is_none_or(|revised| row.created_at.as_str() > revised))
            .max_by(|a, b| a.created_at.cmp(&b.created_at))
            .map(|row| PersonRequest {
                author_id: row.author_id,
                author_name: row.author_name,
                created_at: row.created_at,
            }))
    }

    /// Marks a pull request a g1t agent has just opened as one g1t sees
    /// through.
    pub(crate) async fn manage(&self, pull: &Pull) -> Result<()> {
        if !made_by_g1t(pull) {
            return Ok(());
        }
        self.db
            .prepare("UPDATE pulls SET managed = 1 WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Takes a step for a pull request, if nobody else has. One statement,
    /// so that two callers cannot both take it.
    pub(crate) async fn claim(&self, pull_id: &str, step: &str, minutes: u64, revising: bool) -> Result<bool> {
        let now = now_ms();
        let revision = if revising {
            ", revisions = revisions + 1, revised_at = ?1"
        } else {
            ""
        };
        Ok(self
            .db
            .prepare(format!(
                "UPDATE pulls SET working_on = ?2, working_until = ?3{revision}
                 WHERE id = ?4 AND status = 'open' AND stalled IS NULL
                   AND (working_until IS NULL OR working_until < ?1)
                 RETURNING id AS value"
            ))
            .bind(&[
                rfc3339(now).into(),
                step.into(),
                rfc3339(now + minutes * 60 * 1000).into(),
                pull_id.into(),
            ])?
            .first::<ValueRow>(None)
            .await?
            .is_some())
    }

    /// What the author is told when sent back: the checks that failed and
    /// what their failing jobs printed, why the merge queue took it out, or
    /// the review and its comments on lines.
    async fn feedback(&self, pull: &Pull, feedback: &Feedback) -> Result<String> {
        match feedback {
            Feedback::FailedChecks => {
                let run = self.latest_checks(&pull.id).await?;
                // Why it failed, when that is more than a list of commands:
                // the merge queue saying what broke in the combined state.
                let why = run.as_ref().and_then(|run| run.error.clone()).map(|error| format!("{error}\n\n")).unwrap_or_default();
                let failed: Vec<String> = run
                    .map(|run| run.results)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|result| !result.passed)
                    .map(|result| {
                        let length = result.output.chars().count();
                        let output: String = result
                            .output
                            .chars()
                            .skip(length.saturating_sub(MAX_CHECK_OUTPUT_CHARS))
                            .collect();
                        let exit = result
                            .exit_code
                            .map_or("it was stopped for taking too long".to_owned(), |code| {
                                format!("exit code {code}")
                            });
                        format!("`{}` failed ({exit}):\n\n{}", result.command, output.trim())
                    })
                    .collect();
                if failed.is_empty() {
                    return Ok(format!(
                        "{why}Find the cause, fix it in your change, and push. Use get_workflow_run and get_job_logs for any workflow named above."
                    ));
                }
                Ok(format!(
                    "{why}These commands failed against your change.\n\n{}",
                    failed.join("\n\n")
                ))
            }
            Feedback::FailedWorkflows => {
                let (statuses, settings) = futures_util::future::try_join(
                    self.statuses(&pull.repo_id, pull.head_commit.as_deref()),
                    self.settings_for(pull),
                )
                .await?;
                let required = |context: &str| {
                    let name = g1t_contracts::work::check_name(context).0;
                    settings.required_checks.iter().any(|wanted| wanted.eq_ignore_ascii_case(name))
                };
                let failing: Vec<&CommitStatus> =
                    statuses.iter().filter(|s| s.state == "failure" || s.state == "error").collect();
                let failed: Vec<String> = failing
                    .iter()
                    .map(|s| {
                        let run = s.target_url.as_deref().and_then(|url| url.rsplit('/').next()).unwrap_or_default();
                        format!(
                            "- {}{} ({}): run `{run}`, {}",
                            s.context,
                            if required(&s.context) { ", required to merge" } else { "" },
                            s.description.as_deref().unwrap_or("failed"),
                            s.target_url.as_deref().unwrap_or_default()
                        )
                    })
                    .collect();
                let logs = self.failing_logs(pull, &failing).await.unwrap_or_default();
                // Named outright: the agent cannot guess it from its fork.
                let repo = g1t_kit::call::<_, Option<RepoPath>>(
                    &self.repos,
                    "path_by_id",
                    &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() },
                )
                .await?
                .map(|path| format!("{}/{}", path.namespace, path.name))
                .unwrap_or_default();
                let logs = if logs.is_empty() {
                    String::new()
                } else {
                    format!("\n\nThe end of what the failing jobs printed:\n\n{}", logs.join("\n\n"))
                };
                Ok(format!(
                    "These checks failed on your latest commit to {repo}. They are the repository's workflows, run on your pull request:\n\n{}{logs}\n\n\
                     For more, use the `get_workflow_run` tool (repo `{repo}` and the run's id), \
                     then `get_job_logs` for the job that failed. Fix the cause in the code, not the workflow, \
                     unless the workflow itself is wrong. Push, and the checks run again.",
                    failed.join("\n")
                ))
            }
            Feedback::Review(finished_at) => {
                // Everything a review says is recorded at the moment it finished.
                let notes = self
                    .db
                    .prepare(
                        "SELECT body, path, line FROM comments
                         WHERE repo_id = ? AND number = ? AND author_id = ? AND created_at = ?
                         ORDER BY id",
                    )
                    .bind(&[
                        pull.repo_id.as_str().into(),
                        pull.number.into(),
                        AGENT_ID.into(),
                        finished_at.as_str().into(),
                    ])?
                    .all()
                    .await?
                    .results::<ReviewNote>()?;
                let mut on_lines = Vec::new();
                let mut summary = String::new();
                for note in notes {
                    match (note.path, note.line) {
                        (Some(path), Some(line)) => {
                            on_lines.push(format!("- `{path}` line {line}: {}", note.body));
                        }
                        (Some(path), None) => on_lines.push(format!("- `{path}`: {}", note.body)),
                        (None, _) => summary = note.body,
                    }
                }
                let mut text = format!(
                    "Another agent reviewed your change and asked for changes.\n\n{summary}"
                );
                if !on_lines.is_empty() {
                    text.push_str("\n\nIts comments on lines:\n");
                    text.push_str(&on_lines.join("\n"));
                }
                Ok(text)
            }
            Feedback::Person(request) => {
                // What they wrote since the agent last revised, which their
                // request for changes closes.
                let revised: Option<String> = self
                    .db
                    .prepare("SELECT revised_at AS value FROM pulls WHERE id = ?")
                    .bind(&[pull.id.as_str().into()])?
                    .first::<Option<String>>(Some("value"))
                    .await?
                    .flatten();
                let notes = self
                    .db
                    .prepare(
                        "SELECT body, path, line FROM comments
                         WHERE repo_id = ? AND number = ? AND author_id = ?
                           AND created_at > ? AND created_at <= ?
                         ORDER BY id",
                    )
                    .bind(&[
                        pull.repo_id.as_str().into(),
                        pull.number.into(),
                        request.author_id.as_str().into(),
                        revised.unwrap_or_default().into(),
                        request.created_at.as_str().into(),
                    ])?
                    .all()
                    .await?
                    .results::<ReviewNote>()?;
                let mut on_lines = Vec::new();
                let mut said = Vec::new();
                for note in notes {
                    match (note.path, note.line) {
                        (Some(path), Some(line)) => {
                            on_lines.push(format!("- `{path}` line {line}: {}", note.body));
                        }
                        (Some(path), None) => on_lines.push(format!("- `{path}`: {}", note.body)),
                        (None, _) => said.push(note.body),
                    }
                }
                let mut text = format!(
                    "{} reviewed your change and asked for changes.\n\n{}",
                    request.author_name,
                    said.join("\n\n")
                );
                if !on_lines.is_empty() {
                    text.push_str("\n\nTheir comments on lines:\n");
                    text.push_str(&on_lines.join("\n"));
                }
                Ok(text)
            }
        }
    }

    /// The end of what the failed jobs of failing workflow runs printed, a
    /// few jobs at most, for an agent sent back to fix them. Empty where the
    /// runs or their logs cannot be read.
    async fn failing_logs(&self, pull: &Pull, failing: &[&CommitStatus]) -> Result<Vec<String>> {
        use g1t_contracts::actions::{JobLog, LogsArgs, RunArgs, RunDetail};
        let Some(repo) = g1t_kit::call::<_, Option<RepoPath>>(
            &self.repos,
            "path_by_id",
            &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() },
        )
        .await?
        else {
            return Ok(Vec::new());
        };
        let viewer = self.owner_viewer(pull).await?;
        let mut out = Vec::new();
        for status in failing {
            let Some(run_id) = status
                .target_url
                .as_deref()
                .and_then(|url| url.split("/actions/runs/").nth(1))
                .map(|rest| rest.split(['/', '?', '#']).next().unwrap_or_default().to_owned())
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let detail: Outcome<RunDetail> = g1t_kit::call(
                &self.actions,
                "run",
                &RunArgs { repo: repo.clone(), viewer: viewer.clone(), id: run_id },
            )
            .await?;
            let Outcome::Ok(detail) = detail else { continue };
            let failed_jobs = detail.jobs.into_iter().filter(|job| {
                job.status == "completed" && matches!(job.conclusion.as_deref(), Some("failure" | "timed_out"))
            });
            for job in failed_jobs {
                if out.len() >= MAX_FAILED_JOBS {
                    return Ok(out);
                }
                let mut text = String::new();
                let mut after = 0;
                for _ in 0..MAX_LOG_PAGES {
                    let page: Outcome<JobLog> = g1t_kit::call(
                        &self.actions,
                        "logs",
                        &LogsArgs { repo: repo.clone(), viewer: viewer.clone(), job: job.id.clone(), after },
                    )
                    .await?;
                    let Outcome::Ok(page) = page else { break };
                    let Some(last) = page.chunks.last().map(|chunk| chunk.seq) else { break };
                    for chunk in &page.chunks {
                        text.push_str(&chunk.text);
                        if !chunk.text.ends_with('\n') {
                            text.push('\n');
                        }
                    }
                    // Only the end is kept, so the start can go as it is read.
                    let length = text.chars().count();
                    if length > MAX_JOB_LOG_CHARS * 2 {
                        text = text.chars().skip(length - MAX_JOB_LOG_CHARS).collect();
                    }
                    after = last;
                    if page.chunks.len() < 500 {
                        break;
                    }
                }
                let length = text.chars().count();
                let tail: String = text.chars().skip(length.saturating_sub(MAX_JOB_LOG_CHARS)).collect();
                if !tail.trim().is_empty() {
                    out.push(format!("{} / {}:\n```\n{}\n```", status.context, job.name, tail.trim_end()));
                }
            }
        }
        Ok(out)
    }

    pub(crate) async fn advance(&self, a: AdvanceArgs) -> Result<Advance> {
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(Advance::None);
        };
        if pull.status != PullStatus::Open {
            return Ok(Advance::None);
        }
        // As a member: a private repository would look missing otherwise,
        // and the pull request would never move.
        let viewer: Viewer = self.owner_viewer(&pull).await?;
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer,
            },
        )
        .await?;
        let (Outcome::Ok(repo), Some(source)) = (crate::retired::unless_archived(repo), pull.fork.clone()) else {
            return Ok(Advance::None);
        };
        // The branch it merges into: what it catches up with.
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };
        let behind = self.is_behind(&repo.id, &pull).await?;
        let Some((lifecycle, next)) = self.assess(&pull, &issue, behind).await? else {
            return Ok(Advance::None);
        };

        if matches!(next, Next::Merge) {
            self.merge_by_policy(&repo, &pull).await?;
            return Ok(Advance::None);
        }
        let (step, minutes) = match &next {
            Next::Wait | Next::Merge => return Ok(Advance::None),
            Next::Review => ("review", REVIEW_MINUTES),
            Next::Revise(_) => ("revision", REVISION_MINUTES),
            Next::CatchUp => ("catch_up", CATCH_UP_MINUTES),
        };
        let feedback = match &next {
            Next::Revise(feedback) => self.feedback(&pull, feedback).await?,
            Next::CatchUp => self.conflict_note(&pull, &base).await?,
            _ => String::new(),
        };
        if !self
            .claim(&pull.id, step, minutes, matches!(next, Next::Revise(_)))
            .await?
        {
            return Ok(Advance::None);
        }
        // Said in the conversation, so nobody has to wonder why a review or
        // a new commit appeared.
        let told = match &next {
            Next::Review => {
                self.db
                    .prepare(
                        "UPDATE pulls SET reviewers = json_insert(reviewers, '$[#]', ?1)
                         WHERE id = ?2 AND NOT EXISTS (
                           SELECT 1 FROM json_each(pulls.reviewers) WHERE json_each.value = ?1)",
                    )
                    .bind(&[AGENT_NAME.into(), pull.id.as_str().into()])?
                    .run()
                    .await?;
                "requested a review from g1t".to_owned()
            }
            Next::Revise(Feedback::FailedChecks) => {
                "sent g1t back to fix what failed in the merge queue".to_owned()
            }
            Next::Revise(Feedback::FailedWorkflows) => {
                "sent g1t back to fix the failed checks".to_owned()
            }
            Next::Revise(Feedback::Review(_)) => {
                "sent g1t back to address the review".to_owned()
            }
            _ => format!("asked g1t to bring this up to date with {base}"),
        };
        self.note(
            &pull.repo_id,
            pull.number,
            (POLICY_ACTOR_ID, POLICY_ACTOR_NAME),
            &told,
        )
        .await?;
        let job = LifecycleJob {
            pull_id: pull.id,
            repo: RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
            number: pull.number,
            author: pull.requested_by.unwrap_or(pull.author),
            source,
            branch: None,
            default_branch: base,
            title: pull.title,
            description: pull.body.unwrap_or_default(),
            issue,
            feedback,
            round: lifecycle.revisions + 1,
        };
        Ok(match next {
            Next::Review => Advance::Review { job },
            Next::Revise(_) => Advance::Revise { job },
            Next::CatchUp => Advance::CatchUp { job },
            Next::Wait | Next::Merge => Advance::None,
        })
    }

    /// Lands a pull request that is ready, on the authority of the
    /// repository's settings instead of a person's click.
    async fn merge_by_policy(&self, repo: &Repo, pull: &Pull) -> Result<()> {
        if !self.claim(&pull.id, "merge", MERGE_MINUTES, false).await? {
            return Ok(());
        }
        // g1t acts for the workspace whose members turned this on, with the
        // default base permission (Write), which merging needs.
        let actor = User {
            id: POLICY_ACTOR_ID.to_owned(),
            username: POLICY_ACTOR_NAME.to_owned(),
            verified: true,
            workspaces: vec![Membership::member(repo.namespace.to_lowercase())],
            ..User::default()
        };
        let merged = self
            .merge_pull(PullActionArgs {
                actor,
                repo: RepoPath {
                    namespace: repo.namespace.clone(),
                    name: repo.name.clone(),
                },
                number: pull.number,
                summary: String::new(),
                keep_issue_open: false,
                ignore_checks: false,
            })
            .await?;
        match merged {
            Outcome::Ok(_) => Ok(()),
            // Most likely the branch moved in the moment between: let go, and
            // the next look at it will catch up and try again.
            Outcome::Fail(failure) if failure.code == FailureCode::Conflict => {
                self.db
                    .prepare(
                        "UPDATE pulls SET working_on = NULL, working_until = NULL
                         WHERE id = ? AND working_on = 'merge'",
                    )
                    .bind(&[pull.id.as_str().into()])?
                    .run()
                    .await?;
                Ok(())
            }
            Outcome::Fail(failure) => {
                self.stall(StallArgs {
                    pull_id: pull.id.clone(),
                    reason: format!("g1t could not merge this: {}", failure.message),
                    by: None,
                })
                .await?;
                Ok(())
            }
        }
    }

    /// Records that a merge was asked for while the pull request was
    /// behind, and announces it so that the runner brings it up to date.
    pub(crate) async fn request_landing(
        &self,
        pull: &Pull,
        actor: &User,
        keep_issue_open: bool,
    ) -> Result<()> {
        let now = now_ms();
        let request = serde_json::to_string(&LandRequest {
            actor: actor.clone(),
            keep_issue_open,
        })?;
        self.db
            .prepare(
                "UPDATE pulls
                 SET land_requested = ?, land_requested_at = ?, stalled = NULL,
                     working_on = 'catch_up', working_until = ?
                 WHERE id = ?",
            )
            .bind(&[
                request.into(),
                rfc3339(now).into(),
                rfc3339(now + CATCH_UP_MINUTES * 60 * 1000).into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.publish(
            "pull.merge_requested",
            &pull.repo_id,
            actor,
            Self::pull_event(pull),
        )
        .await
    }

    /// The merge waiting on a pull request, if one was asked for recently
    /// enough to still stand.
    async fn land_request(&self, pull_id: &str) -> Result<Option<LandRequest>> {
        let row = self.land_row(pull_id).await?;
        let oldest = rfc3339(now_ms().saturating_sub(CATCH_UP_MINUTES * 60 * 1000));
        Ok(row
            .filter(|row| {
                row.land_requested_at
                    .as_deref()
                    .is_some_and(|at| at >= oldest.as_str())
            })
            .and_then(|row| row.land_requested)
            .and_then(|request| serde_json::from_str(&request).ok()))
    }

    /// Whether a merge is waiting on a pull request, and why g1t stopped
    /// working on it if it did.
    pub(crate) async fn landing_state(&self, pull_id: &str) -> Result<(bool, Option<String>)> {
        let stalled = self.land_row(pull_id).await?.and_then(|row| row.stalled);
        Ok((self.land_request(pull_id).await?.is_some(), stalled))
    }

    /// The merge waiting on a pull request and why g1t stopped, as read
    /// for this request (prefetch.rs) or now.
    async fn land_row(&self, pull_id: &str) -> Result<Option<LandRow>> {
        if let Some(found) = self.prefetched_pull(pull_id) {
            return found.first::<LandRow>(Slot::Pull);
        }
        self.db
            .prepare("SELECT land_requested, land_requested_at, stalled FROM pulls WHERE id = ?")
            .bind(&[pull_id.into()])?
            .first::<LandRow>(None)
            .await
    }

    async fn forget_landing(&self, pull_id: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE pulls SET land_requested = NULL, land_requested_at = NULL WHERE id = ?",
            )
            .bind(&[pull_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Lands a pull request whose head has just moved, if a merge of it was
    /// waiting for exactly that. What it was caught up to was already
    /// checked and reviewed apart from the merge, so the checks are not
    /// waited for again; a repository that wants them rerun turns on
    /// "require up to date", and then nothing is landed this way.
    pub(crate) async fn land_if_requested(&self, pull_id: &str) -> Result<()> {
        let Some(request) = self.land_request(pull_id).await? else {
            return Ok(());
        };
        self.forget_landing(pull_id).await?;
        let Some(pull) = self.pull_by_id(pull_id).await? else {
            return Ok(());
        };
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: Some(request.actor.clone()),
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(());
        };
        let merged = self
            .merge_pull(PullActionArgs {
                actor: request.actor,
                repo: RepoPath {
                    namespace: repo.namespace,
                    name: repo.name,
                },
                number: pull.number,
                summary: String::new(),
                keep_issue_open: request.keep_issue_open,
                ignore_checks: true,
            })
            .await?;
        if let Outcome::Fail(failure) = merged {
            self.stall(StallArgs {
                pull_id: pull.id,
                reason: format!(
                    "It was brought up to date but could not be merged: {}",
                    failure.message
                ),
                by: None,
            })
            .await?;
        }
        Ok(())
    }

    /// What the runner needs to bring a pull request up to date for a merge
    /// that is waiting on it.
    pub(crate) async fn catch_up_job(&self, a: CatchUpJobArgs) -> Result<Option<LifecycleJob>> {
        if self.land_request(&a.pull_id).await?.is_none() {
            return Ok(None);
        }
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(None);
        };
        // Its owner (whoever asked g1t for it, or its author) can read both
        // the repository and the pull request's source.
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: self.owner_viewer(&pull).await?,
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(None);
        };
        let path = RepoPath {
            namespace: repo.namespace,
            name: repo.name,
        };
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let feedback = self.conflict_note(&pull, &base).await?;
        Ok(Some(LifecycleJob {
            pull_id: pull.id,
            source: pull.fork.unwrap_or_else(|| path.clone()),
            repo: path,
            number: pull.number,
            author: pull.requested_by.unwrap_or(pull.author),
            branch: pull.branch,
            default_branch: base,
            title: pull.title,
            description: pull.body.unwrap_or_default(),
            issue,
            feedback,
            round: 0,
        }))
    }

    /// For an agent catching up: the files g1t already knows conflict, so
    /// it reads them first. Empty when none are known.
    pub(crate) async fn conflict_note(&self, pull: &Pull, default_branch: &str) -> Result<String> {
        Ok(match self.conflicting_files(pull).await? {
            Some(files) if !files.is_empty() => format!(
                "g1t found ahead of time that merging {default_branch} into this pull request conflicts in these files: {}.",
                files.join(", ")
            ),
            _ => String::new(),
        })
    }

    /// Stops seeing a pull request through until a person steps in. The
    /// first stop is published (`pull.stalled`), which tells its people
    /// that it needs them; a stop on one already stopped only says why.
    pub(crate) async fn stall(&self, a: StallArgs) -> Result<bool> {
        let before = self.pull_by_id(&a.pull_id).await?;
        let was_stalled = self.is_stalled(&a.pull_id).await?;
        self.db
            .prepare(
                "UPDATE pulls
                 SET stalled = ?, working_on = NULL, working_until = NULL,
                     land_requested = NULL, land_requested_at = NULL
                 WHERE id = ? AND status = 'open'",
            )
            .bind(&[a.reason.trim().into(), a.pull_id.as_str().into()])?
            .run()
            .await?;
        self.db
            .prepare("UPDATE pulls SET stage = 'needs_you', stage_detail = ? WHERE id = ?")
            .bind(&[a.reason.trim().into(), a.pull_id.as_str().into()])?
            .run()
            .await?;
        if let Some(pull) = before.filter(|pull| !was_stalled && pull.status == PullStatus::Open) {
            self.publish_as(
                "pull.stalled",
                &pull.repo_id,
                a.by.clone(),
                g1t_contracts::events::PullEvent {
                    detail: Some(a.reason.trim().to_owned()),
                    ..Self::pull_event(&pull)
                },
            )
            .await?;
        }
        Ok(true)
    }

    /// Whether g1t has stopped seeing the pull request through.
    pub(crate) async fn is_stalled(&self, pull_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS value FROM pulls WHERE id = ? AND stalled IS NOT NULL")
            .bind(&[pull_id.into()])?
            .first::<u32>(Some("value"))
            .await?
            .is_some())
    }

    /// Says that a pull request g1t had stopped on is going again, which
    /// closes what it was waiting on a person for.
    pub(crate) async fn announce_resumed(&self, pull_id: &str, actor: Option<String>) -> Result<()> {
        if let Some(pull) = self.pull_by_id(pull_id).await? {
            self.publish_as("pull.resumed", &pull.repo_id, actor, Self::pull_event(&pull)).await?;
        }
        Ok(())
    }

    pub(crate) async fn managed_pulls(&self, a: ManagedPullsArgs) -> Result<Vec<String>> {
        let rows = self
            .db
            .prepare(
                "SELECT id AS value FROM pulls
                 WHERE status = 'open' AND managed = 1 AND stalled IS NULL
                   AND (?1 IS NULL OR repo_id = ?1)
                 ORDER BY updated_at DESC LIMIT ?2",
            )
            .bind(&[
                a.repo_id.map_or(JsValue::NULL, JsValue::from),
                MANAGED_PAGE.into(),
            ])?
            .all()
            .await?
            .results::<ValueRow>()?;
        Ok(rows.into_iter().map(|row| row.value).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_REVISIONS: u32 = 2;

    #[test]
    fn a_verdict_from_whoever_asked_for_g1t_s_change_is_not_someone_else_s() {
        use crate::rows::stored::{ASKER, G1T, pull};
        let made = pull(G1T, Some(ASKER));
        assert!(made_by_g1t(&made));
        // The person it was made for is held to what an author was: their
        // request for changes does not send g1t back as a reviewer's
        // would, and their approval does not lift a hold.
        assert!(!from_someone_else(&made, ASKER.0));
        assert!(!from_someone_else(&made, AGENT_ID));
        assert!(from_someone_else(&made, "usr_reviewer"));
        // Anyone's own pull request, the same.
        let own = pull(ASKER, None);
        assert!(!from_someone_else(&own, ASKER.0));
        assert!(from_someone_else(&own, "usr_reviewer"));
    }

    #[test]
    fn approvals_the_repository_wants_are_waited_for() {
        let short = || Facts {
            review: reviewed(Some(Verdict::Approve)),
            approvals_missing: Some("This repository requires 1 approving review.".to_owned()),
            ..facts()
        };
        let (lifecycle, next) = decide(short());
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(
            lifecycle.detail,
            "This repository requires 1 approving review."
        );
        assert!(matches!(next, Next::Wait));
        // Not even a repository that merges by itself merges without them.
        let automatic = Facts {
            auto_merge: true,
            ..short()
        };
        assert_eq!(outcome(automatic), (Stage::NeedsYou, "wait"));
    }

    #[test]
    fn a_repository_can_leave_review_to_people() {
        let unreviewed = Facts {
            agent_review: false,
            ..facts()
        };
        assert_eq!(outcome(unreviewed), (Stage::Ready, "wait"));
        let failing = Facts {
            agent_review: false,
            check_status: Some(CheckStatus::Failed),
            ..facts()
        };
        assert_eq!(outcome(failing), (Stage::Revising, "revise for checks"));
    }

    #[test]
    fn a_repository_sets_how_often_the_author_is_sent_back() {
        let never = Facts {
            max_revisions: 0,
            check_status: Some(CheckStatus::Failed),
            ..facts()
        };
        assert_eq!(outcome(never), (Stage::NeedsYou, "wait"));
    }

    /// Checks on a head commit: `(context, state)` statuses, against the
    /// required check names.
    fn checks(statuses: &[(&str, &str)], required: &[&str]) -> WorkflowFacts {
        let statuses: Vec<CommitStatus> = statuses
            .iter()
            .map(|(context, state)| CommitStatus {
                context: (*context).to_owned(),
                state: (*state).to_owned(),
                description: None,
                target_url: None,
                updated_at: String::new(),
                source: None,
            })
            .collect();
        let required: Vec<String> = required.iter().map(|name| (*name).to_owned()).collect();
        WorkflowFacts::of(&statuses, &required)
    }

    /// A pull request that is ready for review, whose required check
    /// passed, and nothing else yet.
    fn facts() -> Facts {
        Facts {
            draft: false,
            stalled: None,
            working_on: None,
            check_status: None,
            review_pending: false,
            revisions: 0,
            review: None,
            behind: false,
            conflicting: false,
            auto_merge: false,
            require_up_to_date: false,
            agent_review: true,
            max_revisions: MAX_REVISIONS,
            approvals_missing: None,
            person_request: None,
            queued: None,
            workflows: checks(&[("CI / pull_request", "success")], &["CI"]),
            low_confidence: None,
        }
    }

    #[test]
    fn failed_checks_send_the_agent_back_and_running_ones_wait() {
        let failed = Facts {
            workflows: checks(&[("CI / pull_request", "failure")], &["CI"]),
            ..facts()
        };
        let (lifecycle, next) = decide(failed);
        assert!(matches!(next, Next::Revise(Feedback::FailedWorkflows)));
        assert!(lifecycle.detail.contains("CI / pull_request failed"));
        let running = Facts {
            workflows: checks(&[("CI / pull_request", "pending")], &["CI"]),
            ..facts()
        };
        let (lifecycle, next) = decide(running);
        assert!(matches!(next, Next::Wait));
        assert!(lifecycle.detail.contains("Waiting for CI / pull_request"));
    }

    #[test]
    fn a_check_the_branch_does_not_require_is_fixed_but_does_not_hold_it_for_ever() {
        // Lint is not required: the agent is still sent back to fix it...
        let lint = checks(&[("CI / pull_request", "success"), ("Lint / pull_request", "failure")], &["CI"]);
        let failing = Facts { workflows: lint.clone(), ..facts() };
        assert_eq!(outcome(failing), (Stage::Revising, "revise for workflows"));
        // ...but once it is out of revisions, Lint no longer holds it.
        let exhausted = Facts {
            workflows: lint,
            revisions: MAX_REVISIONS,
            review: reviewed(Some(Verdict::Approve)),
            ..facts()
        };
        assert_eq!(outcome(exhausted), (Stage::Ready, "wait"));
        // A required check that still fails asks a person.
        let required = Facts {
            workflows: checks(&[("CI / pull_request", "failure")], &["CI"]),
            revisions: MAX_REVISIONS,
            ..facts()
        };
        let (lifecycle, next) = decide(required);
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(lifecycle.detail, "The required check CI still fails after the agent revised twice.");
        assert!(matches!(next, Next::Wait));
    }

    #[test]
    fn a_required_check_that_has_not_reported_is_waited_for() {
        let missing = Facts {
            workflows: checks(&[("CI / pull_request", "success")], &["CI", "Deploy"]),
            review: reviewed(Some(Verdict::Approve)),
            auto_merge: true,
            ..facts()
        };
        let (lifecycle, next) = decide(missing);
        assert_eq!(lifecycle.stage, Stage::Checking);
        assert_eq!(lifecycle.detail, "Waiting for the required check Deploy to report on its latest commit.");
        assert!(matches!(next, Next::Wait), "auto-merge must not land it");
    }

    #[test]
    fn a_queued_pull_request_waits_in_the_queue() {
        let queued = Facts {
            review: reviewed(Some(Verdict::Approve)),
            queued: Some((QueueState::Testing, vec![12, 14])),
            auto_merge: true,
            ..facts()
        };
        let (lifecycle, next) = decide(queued);
        assert_eq!(lifecycle.stage, Stage::Queued);
        assert!(lifecycle.detail.contains("#12, #14"));
        assert!(matches!(next, Next::Wait));
    }

    fn asked_by_a_person() -> Option<PersonRequest> {
        Some(PersonRequest {
            author_id: "usr_reviewer".to_owned(),
            author_name: "g1t-reviewer".to_owned(),
            created_at: "2026-10-02T11:00:00.000Z".to_owned(),
        })
    }

    #[test]
    fn a_person_asking_for_changes_sends_the_agent_back() {
        let asked = Facts {
            review: reviewed(Some(Verdict::Approve)),
            approvals_missing: Some("A reviewer has asked for changes.".to_owned()),
            person_request: asked_by_a_person(),
            ..facts()
        };
        let (lifecycle, _) = decide(Facts {
            person_request: asked_by_a_person(),
            ..facts()
        });
        assert!(lifecycle.detail.starts_with("g1t-reviewer asked for changes"));
        assert_eq!(outcome(asked), (Stage::Revising, "revise for a person"));
    }

    #[test]
    fn a_person_is_asked_once_the_revisions_run_out() {
        let exhausted = Facts {
            person_request: asked_by_a_person(),
            revisions: MAX_REVISIONS,
            ..facts()
        };
        assert_eq!(outcome(exhausted), (Stage::NeedsYou, "wait"));
    }

    fn reviewed(verdict: Option<Verdict>) -> Option<FinishedReview> {
        Some(FinishedReview {
            finished_at: "2026-10-02T10:00:00.000Z".to_owned(),
            verdict,
        })
    }

    /// The stage, and a word for the step to take.
    fn outcome(facts: Facts) -> (Stage, &'static str) {
        let (lifecycle, next) = decide(facts);
        let step = match next {
            Next::Wait => "wait",
            Next::Review => "review",
            Next::Revise(Feedback::FailedChecks) => "revise for checks",
            Next::Revise(Feedback::FailedWorkflows) => "revise for workflows",
            Next::Revise(Feedback::Review(_)) => "revise for review",
            Next::Revise(Feedback::Person(_)) => "revise for a person",
            Next::CatchUp => "catch up",
            Next::Merge => "merge",
        };
        (lifecycle.stage, step)
    }

    #[test]
    fn nothing_is_started_while_the_agent_is_still_working() {
        let draft = Facts {
            draft: true,
            check_status: None,
            ..facts()
        };
        assert_eq!(outcome(draft), (Stage::Working, "wait"));
    }

    #[test]
    fn checks_come_before_review() {
        let unchecked = Facts {
            workflows: checks(&[], &["CI"]),
            ..facts()
        };
        assert_eq!(outcome(unchecked), (Stage::Checking, "wait"));
        let running = Facts {
            workflows: checks(&[("CI / pull_request", "pending")], &["CI"]),
            ..facts()
        };
        assert_eq!(outcome(running), (Stage::Checking, "wait"));
        assert_eq!(outcome(facts()), (Stage::Reviewing, "review"));
    }

    #[test]
    fn a_branch_that_requires_no_checks_goes_straight_to_review() {
        let unchecked = Facts {
            workflows: WorkflowFacts::default(),
            ..facts()
        };
        assert_eq!(outcome(unchecked), (Stage::Reviewing, "review"));
    }

    #[test]
    fn failing_in_the_merge_queue_sends_the_author_back() {
        let failed = Facts {
            check_status: Some(CheckStatus::Failed),
            ..facts()
        };
        let (lifecycle, next) = decide(failed);
        assert_eq!(lifecycle.detail, "It failed in the merge queue. The agent is being sent back to fix it.");
        assert!(matches!(next, Next::Revise(Feedback::FailedChecks)));
    }

    #[test]
    fn checks_that_could_not_run_are_a_persons_problem() {
        let errored = Facts {
            check_status: Some(CheckStatus::Errored),
            ..facts()
        };
        assert_eq!(outcome(errored), (Stage::NeedsYou, "wait"));
    }

    #[test]
    fn a_review_asking_for_changes_sends_the_author_back() {
        let changes = Facts {
            review: reviewed(Some(Verdict::RequestChanges)),
            ..facts()
        };
        assert_eq!(outcome(changes), (Stage::Revising, "revise for review"));
    }

    #[test]
    fn the_author_is_sent_back_only_so_many_times() {
        let failing = Facts {
            check_status: Some(CheckStatus::Failed),
            revisions: MAX_REVISIONS,
            ..facts()
        };
        assert_eq!(outcome(failing), (Stage::NeedsYou, "wait"));
        let unconvinced = Facts {
            review: reviewed(Some(Verdict::RequestChanges)),
            revisions: MAX_REVISIONS,
            ..facts()
        };
        assert_eq!(outcome(unconvinced), (Stage::NeedsYou, "wait"));
        // One short of the limit still gets another go.
        let once = Facts {
            check_status: Some(CheckStatus::Failed),
            revisions: MAX_REVISIONS - 1,
            ..facts()
        };
        assert_eq!(outcome(once), (Stage::Revising, "revise for checks"));
    }

    #[test]
    fn a_review_that_could_not_be_written_is_not_retried() {
        let broken = Facts {
            review: reviewed(None),
            ..facts()
        };
        assert_eq!(outcome(broken), (Stage::NeedsYou, "wait"));
    }

    #[test]
    fn being_behind_only_holds_a_change_up_where_the_repository_says_so() {
        let behind = || Facts {
            review: reviewed(Some(Verdict::Approve)),
            behind: true,
            ..facts()
        };
        // By default it is ready as it is; merging brings it up to date.
        assert_eq!(outcome(behind()), (Stage::Ready, "wait"));
        let strict = Facts {
            require_up_to_date: true,
            ..behind()
        };
        assert_eq!(outcome(strict), (Stage::CatchingUp, "catch up"));
        let current = Facts {
            review: reviewed(Some(Verdict::Approve)),
            ..facts()
        };
        assert_eq!(outcome(current), (Stage::Ready, "wait"));
    }

    #[test]
    fn a_ready_change_lands_by_itself_only_where_the_repository_says_so() {
        let ready = || Facts {
            review: reviewed(Some(Verdict::Approve)),
            ..facts()
        };
        assert_eq!(outcome(ready()), (Stage::Ready, "wait"));
        let automatic = Facts {
            auto_merge: true,
            ..ready()
        };
        assert_eq!(outcome(automatic), (Stage::Ready, "merge"));
        // One that is behind is merged too: merging brings it up to date.
        let behind = Facts {
            auto_merge: true,
            behind: true,
            ..ready()
        };
        assert_eq!(outcome(behind), (Stage::Ready, "merge"));
        // Unless the repository wants it caught up and checked again first.
        let strict = Facts {
            auto_merge: true,
            behind: true,
            require_up_to_date: true,
            ..ready()
        };
        assert_eq!(outcome(strict), (Stage::CatchingUp, "catch up"));
        // Nothing short of approved is merged, whatever the setting.
        let failing = Facts {
            auto_merge: true,
            check_status: Some(CheckStatus::Failed),
            ..ready()
        };
        assert_eq!(outcome(failing), (Stage::Revising, "revise for checks"));
        let unreviewed = Facts {
            auto_merge: true,
            ..facts()
        };
        assert_eq!(outcome(unreviewed), (Stage::Reviewing, "review"));
    }

    #[test]
    fn a_conflict_found_ahead_of_time_is_resolved_before_merging() {
        let conflicting = || Facts {
            review: reviewed(Some(Verdict::Approve)),
            behind: true,
            conflicting: true,
            ..facts()
        };
        // Even where the repository would merge one that is merely behind.
        assert_eq!(outcome(conflicting()), (Stage::CatchingUp, "catch up"));
        let automatic = Facts {
            auto_merge: true,
            ..conflicting()
        };
        assert_eq!(outcome(automatic), (Stage::CatchingUp, "catch up"));
        // Failed checks come first: a revision merges the branch in too.
        let failing = Facts {
            check_status: Some(CheckStatus::Failed),
            ..conflicting()
        };
        assert_eq!(outcome(failing), (Stage::Revising, "revise for checks"));
    }

    #[test]
    fn catching_up_reruns_the_checks_but_not_the_review() {
        // The merge moved the head, so the checks are waited for again.
        let merged_in = Facts {
            review: reviewed(Some(Verdict::Approve)),
            workflows: checks(&[], &["CI"]),
            ..facts()
        };
        assert_eq!(outcome(merged_in), (Stage::Checking, "wait"));
    }

    #[test]
    fn a_step_under_way_is_not_started_again() {
        for (step, stage) in [
            ("review", Stage::Reviewing),
            ("revision", Stage::Revising),
            ("catch_up", Stage::CatchingUp),
        ] {
            let busy = Facts {
                working_on: Some(step.to_owned()),
                // Whatever else is true, the step in hand comes first.
                check_status: Some(CheckStatus::Failed),
                ..facts()
            };
            assert_eq!(outcome(busy), (stage, "wait"));
        }
        let asked = Facts {
            review_pending: true,
            ..facts()
        };
        assert_eq!(outcome(asked), (Stage::Reviewing, "wait"));
    }

    #[test]
    fn a_low_confidence_change_waits_for_a_person_instead_of_merging() {
        let held = || Facts {
            review: reviewed(Some(Verdict::Approve)),
            auto_merge: true,
            low_confidence: Some("tests not added, 3 revisions".to_owned()),
            ..facts()
        };
        let (lifecycle, next) = decide(held());
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert!(matches!(next, Next::Wait), "auto-merge must not land it");
        assert_eq!(
            lifecycle.detail,
            "The agent's confidence in this change is low (tests not added, 3 revisions). This repository asks a person before merging it: approve it to let it land, or ask for changes."
        );
        // Without auto-merge it needs someone too, and says why.
        assert_eq!(outcome(Facts { auto_merge: false, ..held() }), (Stage::NeedsYou, "wait"));
        // Not held (the setting is off, or a person approved): it lands.
        assert_eq!(outcome(Facts { low_confidence: None, ..held() }), (Stage::Ready, "merge"));
        // It holds only a change that is otherwise ready: what comes first,
        // such as failed checks, is still dealt with first.
        let failing = Facts {
            check_status: Some(CheckStatus::Failed),
            ..held()
        };
        assert_eq!(outcome(failing), (Stage::Revising, "revise for checks"));
        let unapproved = Facts {
            approvals_missing: Some("This repository requires 1 approving review.".to_owned()),
            ..held()
        };
        assert_eq!(decide(unapproved).0.detail, "This repository requires 1 approving review.");
    }

    #[test]
    fn once_stopped_it_stays_stopped() {
        let (lifecycle, next) = decide(Facts {
            stalled: Some("The agent could not catch up.".to_owned()),
            review: reviewed(Some(Verdict::Approve)),
            behind: true,
            ..facts()
        });
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(lifecycle.detail, "The agent could not catch up.");
        assert!(matches!(next, Next::Wait));
    }
}
