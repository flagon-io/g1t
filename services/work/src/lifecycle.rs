//! Seeing a pull request through. Once a g1t agent has made a change, g1t
//! takes each remaining step itself: the acceptance checks, a review by
//! another agent, sending the author back to address what either found,
//! and catching up when the branch it would land on has moved. It stops
//! when the pull request is ready for a person to merge, or when it has
//! tried and a person has to decide.
//!
//! This service decides what the next step is and claims it. The runner
//! service asks, on every event that could change the answer, and carries
//! the step out in a sandbox.

use g1t_contracts::events::PullEvent;
use g1t_contracts::repos::{GetByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Membership, Outcome, Role, User, Viewer};
use g1t_kit::now_ms;
use std::collections::HashMap;

use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::reviews::{AGENT_ID, AGENT_NAME};
use crate::rows::ValueRow;

/// How long a claimed step is waited for before it may be taken again.
const REVIEW_MINUTES: u64 = 20;
const REVISION_MINUTES: u64 = 60;
const CATCH_UP_MINUTES: u64 = 30;
const MERGE_MINUTES: u64 = 2;
/// Who a merge made by a repository's settings is attributed to. Not an
/// account: `g1t` cannot be registered.
const POLICY_ACTOR_ID: &str = "g1t_policy";
const POLICY_ACTOR_NAME: &str = "g1t";
/// How much of a failed check's output the author is shown.
const MAX_CHECK_OUTPUT_CHARS: usize = 4_000;
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
    FailedChecks,
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
    check_status: Option<CheckStatus>,
    /// A review someone asked for is being written.
    review_pending: bool,
    /// Whether the issue has acceptance checks at all.
    has_checks: bool,
    revisions: u32,
    /// The latest finished review of the change as it is now.
    review: Option<FinishedReview>,
    /// Whether the branch it would land on has moved without it.
    behind: bool,
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
}

/// Where a pull request stands, and the step to take if it is g1t's turn.
///
/// The order is: nothing while a step is under way; a person asking for
/// changes is answered first; the checks must pass; then a review must
/// approve; then it must be up to date. A person's or an agent's request
/// for changes, or a failed check, sends the author back, a limited number
/// of times, after which a person is asked.
fn decide(facts: Facts) -> (Lifecycle, Next) {
    let revisions = facts.revisions;
    let wait = |stage, detail: &str| (at(stage, detail, revisions), Next::Wait);
    let exhausted = revisions >= facts.max_revisions;

    if facts.draft {
        return wait(Stage::Working, "A g1t agent is making the change.");
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
        Some("merge") => return wait(Stage::Ready, "Merging."),
        Some(_) => return wait(Stage::Reviewing, "A g1t agent is reviewing the change."),
        None => {}
    }
    if matches!(
        facts.check_status,
        Some(CheckStatus::Queued | CheckStatus::Running)
    ) {
        return wait(Stage::Checking, "The acceptance checks are running.");
    }
    if facts.review_pending {
        return wait(Stage::Reviewing, "A g1t agent is reviewing the change.");
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

    if facts.has_checks {
        match facts.check_status {
            Some(CheckStatus::Passed) => {}
            Some(CheckStatus::Failed) if exhausted => {
                return wait(
                    Stage::NeedsYou,
                    &format!(
                        "The acceptance checks still fail after the agent revised {}.",
                        times(revisions)
                    ),
                );
            }
            Some(CheckStatus::Failed) => {
                return (
                    at(
                        Stage::Revising,
                        "The acceptance checks failed. The agent is being sent back to fix them.",
                        revisions,
                    ),
                    Next::Revise(Feedback::FailedChecks),
                );
            }
            Some(CheckStatus::Errored) => {
                return wait(Stage::NeedsYou, "The acceptance checks could not be run.");
            }
            _ => {
                return wait(
                    Stage::Checking,
                    "Waiting for the acceptance checks to start.",
                );
            }
        }
    }

    // A second agent reviews it, unless the repository leaves review to people.
    if facts.agent_review {
        match facts.review {
            None => {
                return (
                    at(
                        Stage::Reviewing,
                        "A g1t agent is about to review the change.",
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

    // Only where the repository insists is catching up a step of its own,
    // followed by the checks again. Elsewhere it happens as part of merging.
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
        let assessed = self.assess_now(pull, issue, behind).await?;
        if let Some((lifecycle, _)) = &assessed {
            self.remember(&pull.id, lifecycle).await?;
        }
        Ok(assessed)
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
        issue: &Option<Issue>,
        behind: bool,
    ) -> Result<Option<(Lifecycle, Next)>> {
        if !pull.status.is_active() {
            return Ok(None);
        }
        let Some(progress) = self
            .db
            .prepare(
                "SELECT managed, revisions, revised_at, working_on, working_until, stalled
                 FROM pulls WHERE id = ?",
            )
            .bind(&[pull.id.as_str().into()])?
            .first::<Progress>(None)
            .await?
            .filter(|progress| progress.managed != 0)
        else {
            return Ok(None);
        };
        let now = rfc3339(now_ms());
        let working_on = progress
            .working_until
            .as_deref()
            .is_some_and(|until| until > now.as_str())
            .then(|| progress.working_on.clone().unwrap_or_default());
        let review = self
            .db
            .prepare(
                "SELECT finished_at, verdict FROM review_runs
                 WHERE pull_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
            )
            .bind(&[pull.id.as_str().into()])?
            .first::<FinishedReview>(None)
            .await?
            // A review of what the change was before its last revision says
            // nothing about what it is now.
            .filter(|review| {
                progress
                    .revised_at
                    .as_deref()
                    .is_none_or(|revised| review.finished_at.as_str() >= revised)
            });
        let settings = self.settings(&pull.repo_id).await?;
        Ok(Some(decide(Facts {
            draft: pull.status == PullStatus::Draft,
            stalled: progress.stalled,
            working_on,
            check_status: pull.check_status,
            review_pending: self.review_pending(&pull.id).await?,
            has_checks: issue.as_ref().is_some_and(|issue| !issue.checks.is_empty()),
            revisions: progress.revisions,
            review,
            behind,
            auto_merge: settings.auto_merge,
            require_up_to_date: settings.require_up_to_date,
            agent_review: settings.agent_review,
            max_revisions: settings.max_revisions,
            approvals_missing: self.approvals_gap(&settings, pull).await?,
            person_request: self
                .person_request(pull, progress.revised_at.as_deref())
                .await?,
            queued: self.queued_entry(&pull.id).await?,
        })))
    }

    /// The latest request for changes by a person other than the author,
    /// if it is that person's latest verdict and came after the last
    /// revision.
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
        let rows = self
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
                pull.author.id.as_str().into(),
                AGENT_ID.into(),
            ])?
            .all()
            .await?
            .results::<Verdicts>()?;
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
    async fn claim(&self, pull_id: &str, step: &str, minutes: u64, revising: bool) -> Result<bool> {
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
    /// what they printed, or the review and its comments on lines.
    async fn feedback(&self, pull: &Pull, feedback: &Feedback) -> Result<String> {
        match feedback {
            Feedback::FailedChecks => {
                let failed: Vec<String> = self
                    .latest_checks(&pull.id)
                    .await?
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
                Ok(format!(
                    "These acceptance checks were run against your change in a clean sandbox and failed.\n\n{}",
                    failed.join("\n\n")
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

    pub(crate) async fn advance(&self, a: AdvanceArgs) -> Result<Advance> {
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(Advance::None);
        };
        if pull.status != PullStatus::Open {
            return Ok(Advance::None);
        }
        // Its author can read both the repository and the fork.
        let viewer: Viewer = Some(pull.author.clone());
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer,
            },
        )
        .await?;
        let (Outcome::Ok(repo), Some(source)) = (repo, pull.fork.clone()) else {
            return Ok(Advance::None);
        };
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
                "requested a review from g1t-agent".to_owned()
            }
            Next::Revise(Feedback::FailedChecks) => {
                "sent g1t-agent back to fix the failed checks".to_owned()
            }
            Next::Revise(Feedback::Review(_)) => {
                "sent g1t-agent back to address the review".to_owned()
            }
            _ => format!(
                "asked g1t-agent to bring this up to date with {}",
                repo.default_branch
            ),
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
            author: pull.author,
            source,
            branch: None,
            default_branch: repo.default_branch,
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
        // g1t acts for the workspace whose members turned this on.
        let actor = User {
            id: POLICY_ACTOR_ID.to_owned(),
            username: POLICY_ACTOR_NAME.to_owned(),
            verified: true,
            workspaces: vec![Membership {
                slug: repo.namespace.clone(),
                role: Role::Member,
            }],
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
            PullEvent {
                pull_id: pull.id.clone(),
                repo_id: pull.repo_id.clone(),
                number: pull.number,
                issue: pull.issue,
                ..PullEvent::default()
            },
        )
        .await
    }

    /// The merge waiting on a pull request, if one was asked for recently
    /// enough to still stand.
    async fn land_request(&self, pull_id: &str) -> Result<Option<LandRequest>> {
        let row = self
            .db
            .prepare("SELECT land_requested, land_requested_at, stalled FROM pulls WHERE id = ?")
            .bind(&[pull_id.into()])?
            .first::<LandRow>(None)
            .await?;
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
        let stalled = self
            .db
            .prepare("SELECT land_requested, land_requested_at, stalled FROM pulls WHERE id = ?")
            .bind(&[pull_id.into()])?
            .first::<LandRow>(None)
            .await?
            .and_then(|row| row.stalled);
        Ok((self.land_request(pull_id).await?.is_some(), stalled))
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
        let Outcome::Ok(repo) = repo else {
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
        // Its author can read both the repository and the pull request's source.
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: Some(pull.author.clone()),
            },
        )
        .await?;
        let Outcome::Ok(repo) = repo else {
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
        Ok(Some(LifecycleJob {
            pull_id: pull.id,
            source: pull.fork.unwrap_or_else(|| path.clone()),
            repo: path,
            number: pull.number,
            author: pull.author,
            branch: pull.branch,
            default_branch: repo.default_branch,
            title: pull.title,
            description: pull.body.unwrap_or_default(),
            issue,
            feedback: String::new(),
            round: 0,
        }))
    }

    pub(crate) async fn stall(&self, a: StallArgs) -> Result<bool> {
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
            .bind(&[a.reason.trim().into(), a.pull_id.into()])?
            .run()
            .await?;
        Ok(true)
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

    /// A pull request that is ready for review, with checks that passed
    /// and nothing else yet.
    fn facts() -> Facts {
        Facts {
            draft: false,
            stalled: None,
            working_on: None,
            check_status: Some(CheckStatus::Passed),
            review_pending: false,
            has_checks: true,
            revisions: 0,
            review: None,
            behind: false,
            auto_merge: false,
            require_up_to_date: false,
            agent_review: true,
            max_revisions: MAX_REVISIONS,
            approvals_missing: None,
            person_request: None,
            queued: None,
        }
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
            check_status: None,
            ..facts()
        };
        assert_eq!(outcome(unchecked), (Stage::Checking, "wait"));
        let running = Facts {
            check_status: Some(CheckStatus::Running),
            ..facts()
        };
        assert_eq!(outcome(running), (Stage::Checking, "wait"));
        assert_eq!(outcome(facts()), (Stage::Reviewing, "review"));
    }

    #[test]
    fn an_issue_without_checks_goes_straight_to_review() {
        let unchecked = Facts {
            has_checks: false,
            check_status: None,
            ..facts()
        };
        assert_eq!(outcome(unchecked), (Stage::Reviewing, "review"));
    }

    #[test]
    fn failed_checks_send_the_author_back() {
        let failed = Facts {
            check_status: Some(CheckStatus::Failed),
            ..facts()
        };
        assert_eq!(outcome(failed), (Stage::Revising, "revise for checks"));
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
    fn catching_up_reruns_the_checks_but_not_the_review() {
        // The merge moved the head, so the checks are waited for again.
        let merged_in = Facts {
            review: reviewed(Some(Verdict::Approve)),
            check_status: None,
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
