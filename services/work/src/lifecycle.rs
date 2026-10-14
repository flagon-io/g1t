//! Where a pull request stands, and merging it on the repository's say.
//!
//! A pull request g1t's agent once made (`made_by_g1t`, `managed = 1`)
//! still shows where it stands: its checks, the approvals the branch
//! wants, the merge queue, and whether a person has to step in. Where the
//! repository's settings say ready pull requests land by themselves
//! (`auto_merge`), such a pull request is merged here once everything its
//! branch's rules ask for is met, attributed to `g1t` (`POLICY_ACTOR_ID`).
//!
//! A merge asked for while a pull request is behind is recorded here
//! (`request_landing`). Once the push that brings it up to date arrives
//! (`land_if_requested`), it lands when the checks the branch requires
//! pass on that new commit, as they must for any merge (`land_when_checked`,
//! also called as each of the commit's checks finishes).

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
const CATCH_UP_MINUTES: u64 = 30;
const MERGE_MINUTES: u64 = 2;
/// How long a merge that was brought up to date waits for the required
/// checks on the new commit; after that it is no longer pending.
const CHECKS_MINUTES: u64 = 180;
/// The step under way while it does (`working_on`).
const WAITING_FOR_CHECKS: &str = "checks";

/// How long a merge waits on the repository service for one write (the
/// catch-up push, the landing): long enough for a large merge, short
/// enough that the person who clicked hears back well before the site
/// stops waiting on the merge (apps/web/app/lib/deadline.ts, 60 s).
pub(crate) const REPOS_WRITE_WITHIN: std::time::Duration = std::time::Duration::from_secs(25);

/// What a merge says when the repository service did not answer in time.
pub(crate) fn repository_unreachable<T>() -> Outcome<T> {
    Outcome::fail(
        FailureCode::Unavailable,
        "g1t couldn't reach the repository to merge this. Try again in a moment.",
    )
}

/// What becomes of a merge that was brought up to date, by the checks the
/// branch requires on the commit that did it.
#[derive(Debug, PartialEq)]
pub(crate) enum Landing {
    /// None are required, or all of them passed.
    Now,
    /// Some are still running or have not reported yet.
    Wait,
    /// One failed: a person has to push a fix.
    Stall(String),
}

/// Whether a merge that was brought up to date lands now, by its new
/// commit's checks. The same checks hold it as hold any merge
/// (`merge_gate`): landing it before they report would only be refused.
pub(crate) fn landing_step(facts: &WorkflowFacts) -> Landing {
    let failed = facts.required_failed();
    if !failed.is_empty() {
        let one = failed.len() == 1;
        return Landing::Stall(format!(
            "It was brought up to date, but the required {} {} failed on that commit, so it was not merged. Push a fix, then merge again.",
            if one { "check" } else { "checks" },
            statuses::list(&failed),
        ));
    }
    if facts.required.iter().any(|check| check.state != RequiredState::Success) {
        return Landing::Wait;
    }
    Landing::Now
}

/// Who a merge made by a repository's settings is attributed to. Not an
/// account: `g1t` cannot be registered.
pub(crate) const POLICY_ACTOR_ID: &str = "g1t_policy";
pub(crate) const POLICY_ACTOR_NAME: &str = "g1t";
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
    /// The merger asked to merge past the checks, and the repository
    /// allows that: it lands without waiting for them.
    #[serde(default)]
    ignore_checks: bool,
}

#[derive(Deserialize)]
struct LandRow {
    land_requested: Option<String>,
    land_requested_at: Option<String>,
    stalled: Option<String>,
    #[serde(default)]
    working_on: Option<String>,
}

/// What should happen next, if it is g1t's turn.
pub(crate) enum Next {
    /// A step is under way, or it is a person's turn.
    Wait,
    /// Land it, because the repository says ready pull requests land.
    Merge,
}

/// Whether g1t's agent made this pull request, and so g1t shows where it
/// stands. Only pull requests from before g1t stopped hosting agents.
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
    revisions: u32,
    /// Whether the branch it would land on has moved without it.
    behind: bool,
    /// Whether it is known to conflict with the branch it would land on.
    conflicting: bool,
    /// Whether the repository lands a ready pull request by itself.
    auto_merge: bool,
    /// Whether the repository refuses to merge one that is behind.
    require_up_to_date: bool,
    /// What the repository's approval rule still wants, if anything.
    approvals_missing: Option<String>,
    /// The person who asked for changes since the last revision, if one did.
    person_request: Option<String>,
    /// Its place in the merge queue, and what is ahead of it there.
    queued: Option<(QueueState, Vec<u32>)>,
    /// What the checks on its head say, against the required ones.
    workflows: WorkflowFacts,
}

/// Where a pull request stands, and whether to merge it.
///
/// The order is: nothing while a step is under way; a person asking for
/// changes holds it; its checks must finish, and the required ones pass;
/// it must not conflict, and where the repository insists, it must be up
/// to date; then the approvals the branch wants. Once everything is met,
/// it merges where the repository says so.
fn decide(facts: Facts) -> (Lifecycle, Next) {
    let revisions = facts.revisions;
    let wait = |stage, detail: &str| (at(stage, detail, revisions), Next::Wait);

    if facts.draft {
        return wait(Stage::Working, "It is still a draft.");
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
        Some("catch_up") => {
            return wait(Stage::CatchingUp, "Bringing it up to date with the branch it will land on.");
        }
        Some("merge") => return wait(Stage::Ready, "Merging."),
        Some(WAITING_FOR_CHECKS) => {
            return wait(
                Stage::Checking,
                "Brought up to date. It lands once the required checks pass on that commit.",
            );
        }
        _ => {}
    }
    if let Some(name) = &facts.person_request {
        return wait(Stage::NeedsYou, &format!("{name} asked for changes."));
    }
    match facts.check_status {
        Some(CheckStatus::Failed) => return wait(Stage::NeedsYou, "It failed in the merge queue."),
        Some(CheckStatus::Errored) => return wait(Stage::NeedsYou, "Its checks could not be run."),
        _ => {}
    }
    // Only the checks the branch requires hold it.
    let required = facts.workflows.required_failed();
    if !required.is_empty() {
        return wait(
            Stage::NeedsYou,
            &format!(
                "The required {} {} {}.",
                if required.len() == 1 { "check" } else { "checks" },
                statuses::list(&required),
                if required.len() == 1 { "fails" } else { "fail" },
            ),
        );
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
    if facts.conflicting {
        return wait(
            Stage::NeedsYou,
            "It conflicts with the branch it will land on. Merge that branch in, resolve the conflicts and push.",
        );
    }
    if facts.behind && facts.require_up_to_date {
        return wait(
            Stage::NeedsYou,
            "The branch it will land on has moved, and this repository requires pull requests to be up to date. Catch up with it first.",
        );
    }
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
    /// Where a pull request stands and whether g1t merges it, remembered
    /// so lists can show it without working it out again. `None` for one
    /// g1t is not seeing through.
    pub(crate) async fn assess(
        &self,
        pull: &Pull,
        _issue: &Option<Issue>,
        behind: bool,
    ) -> Result<Option<(Lifecycle, Next)>> {
        let assessed = self.assess_now(pull, behind).await?;
        if let Some((lifecycle, _)) = &assessed
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

    /// Saves where a pull request stands.
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

    async fn assess_now(&self, pull: &Pull, behind: bool) -> Result<Option<(Lifecycle, Next)>> {
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
        let settings = self.settings_for(pull).await?;
        let statuses = self.statuses(&pull.repo_id, pull.head_commit.as_deref()).await?;
        let workflows = self.workflow_facts(&pull.repo_id, pull.head_commit.as_deref(), &statuses, &settings.required_checks).await?;
        // The rules of the branch it merges into, as g1t sees them when it
        // merges by itself: what people must still do, and whether an
        // agent's change may land here unattended.
        let gate = match self.repo_for(pull).await? {
            Some(repo) => Some(self.merge_gate(&repo, pull, Some(&User::system(&repo.namespace)), false, true).await?),
            None => None,
        };
        let rules_allow_auto_merge = gate
            .as_ref()
            .is_none_or(|gate| g1t_rules::merge::auto_merge_refusal(&gate.requirements).is_none());
        let (lifecycle, next) = decide(Facts {
            draft: pull.status == PullStatus::Draft,
            stalled: progress.stalled,
            working_on,
            check_status: pull.check_status,
            revisions: progress.revisions,
            behind,
            conflicting: self.conflicting_files(pull).await?.is_some(),
            auto_merge: settings.auto_merge && rules_allow_auto_merge,
            require_up_to_date: settings.require_up_to_date,
            approvals_missing: gate.as_ref().and_then(|gate| gate.people_gap()),
            person_request: self.person_request(pull, progress.revised_at.as_deref()).await?,
            queued: self.queued_entry(&pull.id).await?,
            workflows,
        });
        Ok(Some((lifecycle, next)))
    }

    /// Who last asked for changes, if it was a person other than its owner
    /// (whoever asked g1t for it, or its author), that person's latest
    /// verdict, and after the last revision.
    async fn person_request(&self, pull: &Pull, revised_at: Option<&str>) -> Result<Option<String>> {
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
            .map(|row| row.author_name))
    }

    /// Takes a step for a pull request, if nobody else has. One statement,
    /// so that two callers cannot both take it.
    pub(crate) async fn claim(&self, pull_id: &str, step: &str, minutes: u64) -> Result<bool> {
        let now = now_ms();
        Ok(self
            .db
            .prepare(
                "UPDATE pulls SET working_on = ?2, working_until = ?3
                 WHERE id = ?4 AND status = 'open' AND stalled IS NULL
                   AND (working_until IS NULL OR working_until < ?1)
                 RETURNING id AS value",
            )
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

    /// Merges a pull request g1t is seeing through once it is ready, where
    /// the repository's settings say ready pull requests land by
    /// themselves. Returns what the runner is to do, which is now always
    /// nothing: no step is carried out in a sandbox any more.
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
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(Advance::None);
        };
        let behind = self.is_behind(&repo.id, &pull).await?;
        if let Some((_, Next::Merge)) = self.assess(&pull, &None, behind).await? {
            self.merge_by_policy(&repo, &pull).await?;
        }
        Ok(Advance::None)
    }

    /// Lands a pull request that is ready, on the authority of the
    /// repository's settings instead of a person's click.
    async fn merge_by_policy(&self, repo: &Repo, pull: &Pull) -> Result<()> {
        if !self.claim(&pull.id, "merge", MERGE_MINUTES).await? {
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
                bypass_rules: false,
            })
            .await?;
        match merged {
            Outcome::Ok(_) => Ok(()),
            // Most likely the branch moved in the moment between: let go, and
            // the next look at it tries again.
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
    /// behind, so that it lands once the push that brings it up to date
    /// arrives, and announces it.
    pub(crate) async fn request_landing(
        &self,
        pull: &Pull,
        actor: &User,
        keep_issue_open: bool,
        ignore_checks: bool,
    ) -> Result<()> {
        let now = now_ms();
        let request = serde_json::to_string(&LandRequest {
            actor: actor.clone(),
            keep_issue_open,
            ignore_checks,
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
        let now = now_ms();
        Ok(row
            .filter(|row| {
                // Waiting for checks on the caught-up commit stands longer
                // than waiting for the push.
                let minutes = if row.working_on.as_deref() == Some(WAITING_FOR_CHECKS) {
                    CHECKS_MINUTES
                } else {
                    CATCH_UP_MINUTES
                };
                let oldest = rfc3339(now.saturating_sub(minutes * 60 * 1000));
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
            .prepare("SELECT land_requested, land_requested_at, stalled, working_on FROM pulls WHERE id = ?")
            .bind(&[pull_id.into()])?
            .first::<LandRow>(None)
            .await
    }

    /// Forgets a merge that was waiting on a pull request, and the step
    /// that was bringing it up to date or waiting for its checks.
    pub(crate) async fn forget_landing(&self, pull_id: &str) -> Result<()> {
        self.take_landing(pull_id).await?;
        Ok(())
    }

    /// Forgets a merge that was waiting on a pull request and returns it,
    /// in one statement, so that of two callers deciding to land it at
    /// once (two checks finishing together) only one does.
    async fn take_landing(&self, pull_id: &str) -> Result<Option<LandRequest>> {
        // SET sees the row as it was: the CASEs read the old `working_on`.
        let taken = self
            .db
            .prepare(
                "UPDATE pulls SET land_requested = NULL, land_requested_at = NULL,
                   working_on = CASE WHEN working_on IN ('catch_up', 'checks') THEN NULL ELSE working_on END,
                   working_until = CASE WHEN working_on IN ('catch_up', 'checks') THEN NULL ELSE working_until END
                 WHERE id = ? AND land_requested IS NOT NULL
                 RETURNING land_requested AS value",
            )
            .bind(&[pull_id.into()])?
            .first::<ValueRow>(None)
            .await?;
        Ok(taken.and_then(|row| serde_json::from_str(&row.value).ok()))
    }

    /// Notes that a merge which was brought up to date waits for the
    /// required checks on its new commit, from now: on the first look at
    /// this commit (a later push clears the step and starts it again).
    async fn wait_for_checks(&self, pull_id: &str) -> Result<()> {
        let now = now_ms();
        self.db
            .prepare(
                "UPDATE pulls SET working_on = 'checks', working_until = ?1, land_requested_at = ?2
                 WHERE id = ?3 AND land_requested IS NOT NULL AND status = 'open'
                   AND (working_on IS NULL OR working_on <> 'checks')",
            )
            .bind(&[
                rfc3339(now + CHECKS_MINUTES * 60 * 1000).into(),
                rfc3339(now).into(),
                pull_id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Moves on a merge that was waiting for a pull request's head to move
    /// (the push that brought it up to date): it lands once the checks the
    /// branch requires pass on that commit ([`Work::land_when_checked`]).
    /// The commit is new, so they are waited for, as for any merge: a
    /// ruleset that requires them refuses a merge that skips them.
    pub(crate) async fn land_if_requested(&self, pull_id: &str) -> Result<()> {
        if self.land_request(pull_id).await?.is_none() {
            return Ok(());
        }
        self.land_when_checked(pull_id).await
    }

    /// Lands a pull request that was brought up to date for a merge, once
    /// the checks the branch requires pass on its head: at once when none
    /// are required, never when one failed (it stops and says which), and
    /// otherwise when the last of them reports (statuses.rs `store_status`
    /// calls this as the commit's checks finish).
    pub(crate) async fn land_when_checked(&self, pull_id: &str) -> Result<()> {
        let Some(request) = self.land_request(pull_id).await? else {
            return Ok(());
        };
        let Some(pull) = self.pull_by_id(pull_id).await? else {
            return Ok(());
        };
        if pull.status != PullStatus::Open {
            return self.forget_landing(pull_id).await;
        }
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
            return self.forget_landing(pull_id).await;
        };
        let step = if request.ignore_checks {
            Landing::Now
        } else {
            let settings = self.settings_on(&repo, &pull).await?;
            let statuses = self.statuses(&pull.repo_id, pull.head_commit.as_deref()).await?;
            let facts = self
                .workflow_facts(&pull.repo_id, pull.head_commit.as_deref(), &statuses, &settings.required_checks)
                .await?;
            landing_step(&facts)
        };
        match step {
            Landing::Wait => return self.wait_for_checks(pull_id).await,
            Landing::Stall(reason) => {
                self.stall(StallArgs {
                    pull_id: pull.id,
                    reason,
                    by: None,
                })
                .await?;
                return Ok(());
            }
            Landing::Now => {}
        }
        // Taken by one caller: two checks finishing together land it once.
        let Some(request) = self.take_landing(pull_id).await? else {
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
                ignore_checks: request.ignore_checks,
                bypass_rules: false,
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

    #[test]
    fn a_verdict_from_whoever_asked_for_g1t_s_change_is_not_someone_else_s() {
        use crate::rows::stored::{ASKER, G1T, pull};
        let made = pull(G1T, Some(ASKER));
        assert!(made_by_g1t(&made));
        assert!(!from_someone_else(&made, ASKER.0));
        assert!(!from_someone_else(&made, AGENT_ID));
        assert!(from_someone_else(&made, "usr_reviewer"));
        let own = pull(ASKER, None);
        assert!(!from_someone_else(&own, ASKER.0));
        assert!(from_someone_else(&own, "usr_reviewer"));
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
                check_run_id: None,
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
            revisions: 0,
            behind: false,
            conflicting: false,
            auto_merge: false,
            require_up_to_date: false,
            approvals_missing: None,
            person_request: None,
            queued: None,
            workflows: checks(&[("CI / pull_request", "success")], &["CI"]),
        }
    }

    /// The stage, and a word for the step to take.
    fn outcome(facts: Facts) -> (Stage, &'static str) {
        let (lifecycle, next) = decide(facts);
        let step = match next {
            Next::Wait => "wait",
            Next::Merge => "merge",
        };
        (lifecycle.stage, step)
    }

    #[test]
    fn a_ready_change_lands_by_itself_only_where_the_repository_says_so() {
        assert_eq!(outcome(facts()), (Stage::Ready, "wait"));
        assert_eq!(outcome(Facts { auto_merge: true, ..facts() }), (Stage::Ready, "merge"));
        // One that is behind is merged too: merging brings it up to date.
        assert_eq!(outcome(Facts { auto_merge: true, behind: true, ..facts() }), (Stage::Ready, "merge"));
        // Unless the repository wants it caught up first.
        let strict = Facts { auto_merge: true, behind: true, require_up_to_date: true, ..facts() };
        assert_eq!(outcome(strict), (Stage::NeedsYou, "wait"));
    }

    #[test]
    fn approvals_the_repository_wants_are_waited_for() {
        let short = Facts {
            approvals_missing: Some("This repository requires 1 approving review.".to_owned()),
            auto_merge: true,
            ..facts()
        };
        let (lifecycle, next) = decide(short);
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(lifecycle.detail, "This repository requires 1 approving review.");
        assert!(matches!(next, Next::Wait));
    }

    #[test]
    fn checks_are_waited_for_and_a_failing_required_one_needs_a_person() {
        let running = Facts { workflows: checks(&[("CI / pull_request", "pending")], &["CI"]), auto_merge: true, ..facts() };
        let (lifecycle, next) = decide(running);
        assert_eq!(lifecycle.stage, Stage::Checking);
        assert!(lifecycle.detail.contains("Waiting for CI / pull_request"));
        assert!(matches!(next, Next::Wait));
        let failed = Facts { workflows: checks(&[("CI / pull_request", "failure")], &["CI"]), ..facts() };
        let (lifecycle, _) = decide(failed);
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(lifecycle.detail, "The required check CI fails.");
        // A check the branch does not require does not hold it.
        let lint = checks(&[("CI / pull_request", "success"), ("Lint / pull_request", "failure")], &["CI"]);
        assert_eq!(outcome(Facts { workflows: lint, ..facts() }), (Stage::Ready, "wait"));
        let missing = Facts { workflows: checks(&[("CI / pull_request", "success")], &["CI", "Deploy"]), auto_merge: true, ..facts() };
        let (lifecycle, next) = decide(missing);
        assert_eq!(lifecycle.detail, "Waiting for the required check Deploy to report on its latest commit.");
        assert!(matches!(next, Next::Wait), "auto-merge must not land it");
    }

    #[test]
    fn the_merge_queue_conflicts_and_people_hold_it() {
        let queued = Facts { queued: Some((QueueState::Testing, vec![12, 14])), auto_merge: true, ..facts() };
        let (lifecycle, _) = decide(queued);
        assert_eq!(lifecycle.stage, Stage::Queued);
        assert!(lifecycle.detail.contains("#12, #14"));
        assert_eq!(outcome(Facts { check_status: Some(CheckStatus::Failed), auto_merge: true, ..facts() }), (Stage::NeedsYou, "wait"));
        assert_eq!(outcome(Facts { check_status: Some(CheckStatus::Errored), ..facts() }), (Stage::NeedsYou, "wait"));
        assert_eq!(outcome(Facts { conflicting: true, auto_merge: true, ..facts() }), (Stage::NeedsYou, "wait"));
        let asked = Facts { person_request: Some("ana".to_owned()), auto_merge: true, ..facts() };
        let (lifecycle, next) = decide(asked);
        assert_eq!(lifecycle.detail, "ana asked for changes.");
        assert!(matches!(next, Next::Wait));
    }

    #[test]
    fn a_merge_brought_up_to_date_lands_once_its_required_checks_pass_on_the_new_commit() {
        // The catch-up's merge commit, just pushed: nothing has reported yet.
        assert_eq!(landing_step(&checks(&[], &["CI"])), Landing::Wait);
        assert_eq!(landing_step(&checks(&[("CI / pull_request", "pending")], &["CI"])), Landing::Wait);
        assert_eq!(landing_step(&checks(&[("CI / pull_request", "success")], &["CI"])), Landing::Now);
        // Every required one, not just the first to report.
        assert_eq!(
            landing_step(&checks(&[("CI / pull_request", "success")], &["CI", "Deploy"])),
            Landing::Wait
        );
        // Nothing required: it lands at once, whatever else runs or failed.
        assert_eq!(landing_step(&checks(&[], &[])), Landing::Now);
        assert_eq!(landing_step(&checks(&[("Lint / pull_request", "failure")], &[])), Landing::Now);
        assert_eq!(
            landing_step(&checks(&[("CI / pull_request", "success"), ("Lint / pull_request", "failure")], &["CI"])),
            Landing::Now
        );
        // A required one that failed stops it, saying which.
        let Landing::Stall(reason) = landing_step(&checks(&[("CI / pull_request", "failure")], &["CI"])) else {
            panic!("a failing required check must stop it");
        };
        assert_eq!(
            reason,
            "It was brought up to date, but the required check CI failed on that commit, so it was not merged. Push a fix, then merge again."
        );
        let Landing::Stall(reason) =
            landing_step(&checks(&[("CI / push", "error"), ("Deploy", "failure")], &["CI", "Deploy"]))
        else {
            panic!("failing required checks must stop it");
        };
        assert!(reason.contains("required checks CI and Deploy failed"), "{reason}");
    }

    #[test]
    fn a_merge_that_cannot_reach_the_repository_says_so() {
        let Outcome::Fail(failure) = repository_unreachable::<()>() else {
            panic!("it must fail");
        };
        assert_eq!(failure.code, FailureCode::Unavailable);
        assert!(failure.message.contains("couldn't reach the repository"));
        assert!(failure.message.contains("Try again"));
        // Well inside the site's own 60 s wait on a merge, catch-up and landing both.
        assert!(REPOS_WRITE_WITHIN.as_secs() * 2 < 60);
    }

    #[test]
    fn a_landing_asked_for_before_it_carried_ignore_checks_still_reads() {
        let old: LandRequest = serde_json::from_value(serde_json::json!({
            "actor": serde_json::to_value(User::default()).unwrap(),
            "keepIssueOpen": true,
        }))
        .unwrap();
        assert!(old.keep_issue_open && !old.ignore_checks);
    }

    #[test]
    fn drafts_steps_under_way_and_stops_wait() {
        assert_eq!(
            outcome(Facts { working_on: Some(WAITING_FOR_CHECKS.into()), auto_merge: true, ..facts() }),
            (Stage::Checking, "wait")
        );
        assert_eq!(outcome(Facts { draft: true, ..facts() }), (Stage::Working, "wait"));
        assert_eq!(outcome(Facts { working_on: Some("catch_up".into()), auto_merge: true, ..facts() }), (Stage::CatchingUp, "wait"));
        assert_eq!(outcome(Facts { working_on: Some("merge".into()), auto_merge: true, ..facts() }), (Stage::Ready, "wait"));
        let (lifecycle, next) = decide(Facts { stalled: Some("It could not be merged.".to_owned()), auto_merge: true, ..facts() });
        assert_eq!(lifecycle.stage, Stage::NeedsYou);
        assert_eq!(lifecycle.detail, "It could not be merged.");
        assert!(matches!(next, Next::Wait));
    }
}
