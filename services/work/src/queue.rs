//! The merge queue: pull requests are tested together with the ones ahead
//! of them, and only a combination that passed reaches the default branch.
//!
//! A batch of up to the merge queue rule's `max_entries_to_build` entries (4 unless
//! the default branch's rules say otherwise) is tested at once, speculatively.
//! Each entry's state is built in the repository itself (repos
//! `build_queue_step`): the entry landed by its own method (merge commit,
//! squash, rebase or fast-forward: the one asked for when it was queued,
//! else the merge queue rule's) on the state of the entry ahead of it, or
//! on the default branch for the first, and pushed to
//! `g1t-queue/<entry>-<attempt>`. The repository's `merge_group` workflows then run
//! on that commit, and the default branch's required checks must pass
//! there. Entries land in order, each by moving the default branch to its
//! tested state once everything ahead has landed: a fast-forward to
//! exactly the commits that were tested, each built as its method makes
//! them. One that fails leaves
//! the queue with a failed check run; the entries behind it are tested
//! again without it. Which entry answers for a failure, which entries
//! ahead it breaks with, who is told and how it rejoins: integration.rs.

use futures_util::future::try_join_all;
use g1t_contracts::events::{ChecksEvent, QueueChanged};
use g1t_contracts::repos::{
    BuildQueueStepArgs, DeleteBranchArgs, GetByIdArgs, HeadArgs, LandArgs, Landed, QueueStep, Repo, RepoPath,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::checks::{hash, new_token};

/// How many entries that left the queue are shown.
const RECENT: u32 = 20;
/// Where tested states are pushed, in the repository itself.
pub(crate) const BRANCH_PREFIX: &str = "g1t-queue/";

// Each transition must still own the attempt when it writes: service
// calls between reading and writing allow removal, retries and callbacks
// from another request to interleave.
const CLAIM_BUILD: &str = "UPDATE queue_entries
    SET state = 'testing', attempt_id = ?1, token_hash = ?1, head_commit = ?2, base_commit = ?3,
        ahead = ?4, combined_commit = NULL, results = NULL, error = NULL,
        tested_at = ?5, dispatching = 0, tested_stack = ?7, workflow_runs = 0
    WHERE id = ?6 AND state = 'waiting' RETURNING id AS value";

const ENQUEUE: &str = "INSERT INTO queue_entries
    (id, repo_id, pull_id, number, state, enqueued_by, keep_issue_open, created_at, bypass_rules,
     merge_method, commit_title, commit_message)
    SELECT ?1, ?2, ?3, ?4, 'waiting', ?5, ?6, ?7, ?8, ?9, ?10, ?11
    WHERE NOT EXISTS (SELECT 1 FROM queue_entries WHERE pull_id = ?3 AND state IN ('waiting', 'testing', 'passed'))
    RETURNING id AS value";

const RETEST: &str = "UPDATE queue_entries
    SET state = 'waiting', token_hash = NULL, combined_commit = NULL,
        results = NULL, error = NULL, ahead = NULL, held = NULL, dispatching = 0, workflow_runs = 0
    WHERE id = ?1 AND state IN ('testing', 'passed')
      AND attempt_id IS ?2 AND landing_commit IS NULL";

const BEGIN_LANDING: &str = "UPDATE queue_entries SET landing_commit = combined_commit
    WHERE id = ?1 AND state = 'passed' AND combined_commit = ?2 AND attempt_id IS ?3
      AND (landing_commit = combined_commit OR EXISTS
        (SELECT 1 FROM pulls WHERE pulls.id = queue_entries.pull_id AND pulls.status = 'open'))
      AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(queue_entries.ahead, '[]')) dependency
        WHERE NOT EXISTS (SELECT 1 FROM queue_entries landed
          WHERE landed.repo_id = queue_entries.repo_id AND landed.number = dependency.value AND landed.state = 'landed'))
      AND NOT EXISTS (SELECT 1 FROM queue_entries earlier
        WHERE earlier.repo_id = queue_entries.repo_id AND earlier.state IN ('waiting', 'testing', 'passed')
          AND (earlier.created_at < queue_entries.created_at
            OR (earlier.created_at = queue_entries.created_at AND earlier.id < queue_entries.id)))
    RETURNING id AS value";

// The attempt was reset: no later claim or publication can use its branch.
const RETESTED: &str = "SELECT id AS value FROM queue_entries
    WHERE id = ?1 AND state = 'waiting' AND attempt_id IS ?2 AND landing_commit IS NULL";

const PUBLISHING: &str = "SELECT id AS value FROM queue_entries
    WHERE pull_id = ?1 AND state = 'passed' AND landing_commit IS NOT NULL LIMIT 1";

const STILL_LANDING: &str = "SELECT id AS value FROM queue_entries
    WHERE id = ?1 AND state = 'passed' AND landing_commit = ?2";

// Only the request that still holds the intent may give it up: one that
// lost Git's race to a concurrent publisher must not undo its intent.
const ABANDON_LANDING: &str = "UPDATE queue_entries SET landing_commit = NULL
    WHERE id = ?1 AND state = 'passed' AND landing_commit = ?2 RETURNING id AS value";

const FINISH_LANDING: &str = "UPDATE queue_entries SET state = 'landed', finished_at = ?1
    WHERE id = ?2 AND state = 'passed' AND landing_commit = combined_commit";

const LEAVE: &str =
    "UPDATE queue_entries SET state = ?1, error = COALESCE(?2, error), finished_at = ?3
    WHERE id = ?4 AND state IN ('waiting', 'testing', 'passed') AND landing_commit IS NULL
    RETURNING id AS value";

const ACCEPT_BUILD: &str =
    "UPDATE queue_entries SET combined_commit = ?1, token_hash = NULL, dispatching = 1
    WHERE id = ?2 AND state = 'testing' AND token_hash = ?3 RETURNING id AS value";

const REPORT_BUILD: &str = "UPDATE queue_entries
    SET state = ?, combined_commit = ?, results = ?, error = ?, token_hash = NULL, held = ?, workflow_runs = ?, dispatching = 0,
        finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
    WHERE id = ? AND state = 'testing' AND token_hash IS NULL AND held IS NULL
      AND attempt_id IS ? AND combined_commit IS ? RETURNING id AS value";

const FINISH_CHECKS: &str = "UPDATE queue_entries
    SET state = ?, held = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
    WHERE id = ? AND state = 'testing' AND held IS NULL
        AND combined_commit = ? AND token_hash IS NULL AND dispatching = 0 AND attempt_id IS ?
    RETURNING id AS value";

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;

#[derive(Clone, Deserialize)]
pub(crate) struct EntryRow {
    pub(crate) id: String,
    pub(crate) repo_id: String,
    pub(crate) pull_id: String,
    pub(crate) number: u32,
    state: String,
    enqueued_by: String,
    pub(crate) keep_issue_open: u32,
    pub(crate) head_commit: Option<String>,
    pub(crate) base_commit: Option<String>,
    ahead: Option<String>,
    combined_commit: Option<String>,
    results: Option<String>,
    error: Option<String>,
    pub(crate) tested_at: Option<String>,
    #[serde(default)]
    pub(crate) attempt_id: Option<String>,
    #[serde(default)]
    landing_commit: Option<String>,
    /// Whoever queued it asked to bypass the rules they may bypass.
    #[serde(default)]
    bypass_rules: u32,
    created_at: String,
    finished_at: Option<String>,
    /// What failed its combined state while entries ahead were still
    /// being tested (integration.rs), as JSON.
    #[serde(default)]
    pub(crate) held: Option<String>,
    /// What the queue worked out about its failure (integration.rs).
    #[serde(default)]
    pub(crate) diagnosis: Option<String>,
    /// The stack this attempt built, as JSON `[QueueStackItem]`.
    #[serde(default)]
    tested_stack: Option<String>,
    /// How many merge_group runs this attempt's dispatch registered.
    #[serde(default)]
    workflow_runs: u32,
    /// How it lands (`MergeMethod`); none for an entry queued before
    /// methods, whose states were built with merge commits.
    #[serde(default)]
    merge_method: Option<String>,
    /// What whoever queued it wrote for a merge or squash commit.
    #[serde(default)]
    commit_title: Option<String>,
    #[serde(default)]
    commit_message: Option<String>,
}

impl EntryRow {
    pub(crate) fn state(&self) -> QueueState {
        match self.state.as_str() {
            "testing" => QueueState::Testing,
            "passed" => QueueState::Passed,
            "failed" => QueueState::Failed,
            "landed" => QueueState::Landed,
            "removed" => QueueState::Removed,
            _ => QueueState::Waiting,
        }
    }

    pub(crate) fn actor(&self) -> Option<User> {
        serde_json::from_str(&self.enqueued_by).ok()
    }

    pub(crate) fn ahead(&self) -> Vec<u32> {
        self.ahead
            .as_deref()
            .and_then(|ahead| serde_json::from_str(ahead).ok())
            .unwrap_or_default()
    }

    fn branch(&self) -> String {
        attempt_branch(&self.id, self.attempt_id.as_deref())
    }

    /// How it lands.
    pub(crate) fn method(&self) -> MergeMethod {
        MergeMethod::ALL
            .into_iter()
            .find(|method| self.merge_method.as_deref() == Some(method.as_str()))
            .unwrap_or(MergeMethod::Merge)
    }

    /// Exactly what this attempt built, as recorded when it was claimed.
    pub(crate) fn tested_stack(&self) -> Option<Vec<QueueStackItem>> {
        self.tested_stack.as_deref().and_then(|stack| serde_json::from_str(stack).ok())
    }

    /// The attempt whose evidence decides this entry, once it has a commit.
    fn attempt(&self) -> Option<crate::statuses::Attempt<'_>> {
        Some(crate::statuses::Attempt {
            sha: self.combined_commit.as_deref()?,
            head_ref: format!("refs/heads/{}", self.branch()),
            since: self.tested_at.as_deref(),
            runs: self.workflow_runs,
        })
    }
}

fn attempt_branch(id: &str, attempt: Option<&str>) -> String {
    match attempt {
        Some(attempt) => format!("{BRANCH_PREFIX}{id}-{attempt}"),
        None => format!("{BRANCH_PREFIX}{id}"),
    }
}

/// What building one entry's state in the repository came to.
pub(crate) enum Built {
    /// The state's commit.
    State(String),
    /// Its change clashes with the state ahead in these files.
    Conflict { message: String, paths: Vec<String> },
    /// It could not be built, and why.
    Failed(String),
}

/// The nearest entry ahead (each with the files its pull request changes)
/// that changed one of `paths`, which an entry's change clashed in.
pub(crate) fn clashed_with(ahead: &[(QueueStackItem, Vec<String>)], paths: &[String]) -> Option<u32> {
    ahead
        .iter()
        .rev()
        .find(|(_, files)| paths.iter().any(|path| files.contains(path)))
        .map(|(item, _)| item.number)
}

/// Why an entry left because what it would build is gone.
const BRANCH_GONE: &str = "Its branch no longer exists.";
const PULL_GONE: &str = "Its pull request no longer exists.";

fn gone_note(reason: &str) -> String {
    let what = reason.trim_end_matches('.');
    let what = what.strip_prefix("Its ").map_or_else(|| what.to_owned(), |rest| format!("its {rest}"));
    format!("{what}, so it cannot be tested or landed. Push the branch again and merge to rejoin.")
}

fn minutes_ago(minutes: u64) -> String {
    rfc3339(now_ms().saturating_sub(minutes * 60 * 1000))
}

impl Work {
    pub(crate) async fn entries(&self, repo_id: &str, active: bool) -> Result<Vec<EntryRow>> {
        let sql = if active {
            "SELECT * FROM queue_entries
             WHERE repo_id = ? AND state IN ('waiting', 'testing', 'passed')
             ORDER BY created_at, id"
        } else {
            "SELECT * FROM queue_entries
             WHERE repo_id = ? AND state IN ('failed', 'landed', 'removed')
             ORDER BY finished_at DESC LIMIT ?"
        };
        let statement = self.db.prepare(sql);
        let statement = if active {
            statement.bind(&[repo_id.into()])?
        } else {
            statement.bind(&[repo_id.into(), RECENT.into()])?
        };
        statement.all().await?.results::<EntryRow>()
    }

    /// The entry a pull request has in the queue now, if any.
    pub(crate) async fn queued_entry(
        &self,
        pull_id: &str,
    ) -> Result<Option<(QueueState, Vec<u32>)>> {
        let row = match self.prefetched_pull(pull_id) {
            Some(found) => found.first::<EntryRow>(crate::prefetch::Slot::Queued)?,
            None => {
                self.db
                    .prepare(
                        "SELECT * FROM queue_entries
                     WHERE pull_id = ? AND state IN ('waiting', 'testing', 'passed') LIMIT 1",
                    )
                    .bind(&[pull_id.into()])?
                    .first::<EntryRow>(None)
                    .await?
            }
        };
        Ok(row.map(|row| (row.state(), row.ahead())))
    }

    pub(crate) async fn changed(&self, repo_id: &str) -> Result<()> {
        self.publish_as(
            "queue.changed",
            repo_id,
            None,
            QueueChanged {
                repo_id: repo_id.to_owned(),
            },
        )
        .await
    }

    /// Puts a pull request that may merge into the queue instead, to land
    /// by `method` with the commit message `message` (title, body) asked
    /// for, if any. Merging it again while it is queued changes nothing.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn enqueue(
        &self,
        repo: &Repo,
        pull: &Pull,
        actor: &User,
        keep_issue_open: bool,
        bypass_rules: bool,
        method: MergeMethod,
        message: (Option<&str>, Option<&str>),
    ) -> Result<Outcome<Pull>> {
        if self.queued_entry(&pull.id).await?.is_some() {
            return Ok(Outcome::Ok(pull.clone()));
        }
        let now = now_ms();
        let inserted = self
            .db
            .prepare(ENQUEUE)
            .bind(&[
                new_id("qen", now).into(),
                repo.id.as_str().into(),
                pull.id.as_str().into(),
                pull.number.into(),
                serde_json::to_string(actor)?.into(),
                u32::from(keep_issue_open).into(),
                rfc3339(now).into(),
                u32::from(bypass_rules).into(),
                method.as_str().into(),
                message.0.map_or(JsValue::NULL, JsValue::from),
                message.1.map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if inserted.is_none() {
            return Ok(Outcome::Ok(pull.clone()));
        }
        let who = (actor.id.as_str(), actor.username.as_str());
        self.note(&repo.id, pull.number, who, "added this to the merge queue")
            .await?;
        self.changed(&repo.id).await?;
        Ok(Outcome::Ok(pull.clone()))
    }

    pub(crate) async fn queue(&self, a: QueueArgs) -> Result<Outcome<QueueView>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let enabled = self.default_branch_settings(&repo).await?.merge_queue;
        let (active, recent) = (
            self.entries(&repo.id, true).await?,
            self.entries(&repo.id, false).await?,
        );
        let numbers: Vec<u32> = active.iter().chain(&recent).map(|row| row.number).collect();
        let pulls = try_join_all(numbers.iter().map(|number| self.pull(&repo.id, *number))).await?;
        let view = |rows: Vec<EntryRow>, pulls: &[Option<Pull>]| -> Vec<QueueEntry> {
            rows.into_iter()
                .zip(pulls)
                .map(|(row, pull)| QueueEntry {
                    state: row.state(),
                    ahead: row.ahead(),
                    enqueued_by: row
                        .actor()
                        .map_or_else(|| "g1t".to_owned(), |actor| actor.username),
                    title: pull.as_ref().map(|p| p.title.clone()).unwrap_or_default(),
                    agent: pull.as_ref().map(|p| p.agent.clone()).unwrap_or_default(),
                    results: row
                        .results
                        .as_deref()
                        .and_then(|results| serde_json::from_str(results).ok())
                        .unwrap_or_default(),
                    id: row.id,
                    number: row.number,
                    base_commit: row.base_commit,
                    combined_commit: row.combined_commit,
                    error: row.error,
                    created_at: row.created_at,
                    finished_at: row.finished_at,
                })
                .collect()
        };
        let split = active.len();
        Ok(Outcome::Ok(QueueView {
            enabled,
            active: view(active, &pulls[..split]),
            recent: view(recent, &pulls[split..]),
        }))
    }

    /// Takes a pull request out of the queue, by the hand of someone who
    /// may merge.
    pub(crate) async fn remove_from_queue(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let viewer = Some(a.actor.clone());
        let (repo, pull) = match self.pull_at(&a.repo, a.number, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if let Outcome::Fail(failure) = crate::allowed(
            Some(&a.actor),
            &repo,
            g1t_contracts::access::Capability::Merge,
        ) {
            return Ok(Outcome::Fail(failure));
        }
        if self
            .leave(&repo.id, &pull, QueueState::Removed, None)
            .await?
        {
            let who = (a.actor.id.as_str(), a.actor.username.as_str());
            self.note(
                &repo.id,
                pull.number,
                who,
                "removed this from the merge queue",
            )
            .await?;
            self.changed(&repo.id).await?;
        } else if self.publishing(&pull.id).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This tested commit is already being published. Wait for landing to finish.",
            ));
        }
        Ok(Outcome::Ok(pull))
    }

    /// Whether a pull request's tested commit is being published: its
    /// entry holds publication intent, which removal cannot revoke.
    pub(crate) async fn publishing(&self, pull_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare(PUBLISHING)
            .bind(&[pull_id.into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .is_some())
    }

    /// Takes a pull request's entry out of the queue, and sends every entry
    /// whose tested state included it back to waiting. Whether it had one.
    pub(crate) async fn leave(
        &self,
        repo_id: &str,
        pull: &Pull,
        state: QueueState,
        error: Option<&str>,
    ) -> Result<bool> {
        let active = self.entries(repo_id, true).await?;
        let Some(entry) = active.iter().find(|row| row.pull_id == pull.id) else {
            return Ok(false);
        };
        self.leave_entry(&active, entry, state, error).await
    }

    /// Takes `entry`, one of `active`, out of the queue, as `leave` does.
    async fn leave_entry(
        &self,
        active: &[EntryRow],
        entry: &EntryRow,
        state: QueueState,
        error: Option<&str>,
    ) -> Result<bool> {
        let now = rfc3339(now_ms());
        let removed = self
            .db
            .prepare(LEAVE)
            .bind(&[
                state.as_str().into(),
                error.map_or(JsValue::NULL, JsValue::from),
                now.as_str().into(),
                entry.id.as_str().into(),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if removed.is_none() {
            return Ok(false);
        }
        self.drop_branch(entry).await;
        let behind: Vec<&EntryRow> = active
            .iter()
            .filter(|row| row.state() != QueueState::Waiting && row.ahead().contains(&entry.number))
            .collect();
        self.retest(&behind).await?;
        Ok(true)
    }

    /// An entry whose pull request or branch no longer exists cannot be
    /// built or landed: it leaves the queue, saying why, rather than wait
    /// at the front for ever and hold up every entry behind it.
    async fn leave_gone(&self, entry: &EntryRow, reason: &str) -> Result<()> {
        let active = self.entries(&entry.repo_id, true).await?;
        let Some(entry) = active.iter().find(|row| row.id == entry.id) else {
            return Ok(());
        };
        if !self.leave_entry(&active, entry, QueueState::Removed, Some(reason)).await? {
            return Ok(());
        }
        // A pull request that is gone has no conversation to say so in.
        if reason != PULL_GONE {
            self.note(
                &entry.repo_id,
                entry.number,
                ("g1t", "g1t"),
                &format!("removed this from the merge queue: {}", gone_note(reason)),
            )
            .await?;
        }
        self.changed(&entry.repo_id).await
    }

    /// Removes an entry's tested state from the repository once it has
    /// left the queue, as GitHub does with its queue's branches. A branch
    /// left behind is untidy, not wrong, so a failure only logs.
    async fn drop_branch(&self, row: &EntryRow) {
        self.drop_branch_named(&row.repo_id, &row.branch()).await;
    }

    /// Removes one of the queue's branches.
    pub(crate) async fn drop_branch_named(&self, repo_id: &str, branch: &str) {
        let deleted: Result<Outcome<bool>> = g1t_kit::call(
            &self.repos,
            "delete_branch",
            &DeleteBranchArgs {
                repo_id: repo_id.to_owned(),
                branch: branch.to_owned(),
                head: None,
            },
        )
        .await;
        match deleted {
            Ok(Outcome::Ok(_)) => {}
            Ok(Outcome::Fail(failure)) => worker::console_warn!("{branch}: {}", failure.message),
            Err(error) => worker::console_warn!("{branch}: {error}"),
        }
    }

    /// Sends entries back to waiting, to be tested again.
    async fn retest(&self, rows: &[&EntryRow]) -> Result<()> {
        for row in rows {
            let attempt = row
                .attempt_id
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from);
            self.db
                .prepare(RETEST)
                .bind(&[row.id.as_str().into(), attempt.clone()])?
                .run()
                .await?;
            // Each attempt pushes its own branch; one that was given up is
            // never landed from, so remove it rather than leave one behind
            // per retry. Only once the reset took: an attempt that is being
            // published keeps its branch.
            if row.attempt_id.is_some()
                && self
                    .db
                    .prepare(RETESTED)
                    .bind(&[row.id.as_str().into(), attempt])?
                    .first::<crate::rows::ValueRow>(None)
                    .await?
                    .is_some()
            {
                self.drop_branch(row).await;
            }
        }
        Ok(())
    }

    /// Builds the next batch, if nothing is being tested now: each entry
    /// landed by its own method on the state of the entries ahead of it,
    /// in the repository itself (`build_step`), and its `merge_group`
    /// workflows started there. No sandbox builds anything, so the jobs
    /// returned are always none.
    ///
    /// Smaller combinations a failure is being narrowed down with
    /// (integration.rs) are built alongside, whatever the queue is doing.
    pub(crate) async fn queue_build(&self, a: QueueBuildArgs) -> Result<Vec<QueueJob>> {
        // Also resumes a publication interrupted after the Git update.
        self.settle(&a.repo_id).await?;
        self.build_probes(&a.repo_id).await?;
        self.queue_batch(a).await?;
        Ok(Vec::new())
    }

    async fn queue_batch(&self, a: QueueBuildArgs) -> Result<()> {
        let active = self.entries(&a.repo_id, true).await?;
        // How the default branch's merge queue rule batches (rulesets.rs).
        let rule = self.queue_rule(&a.repo_id).await?;
        // A batch that has taken too long is tested again.
        let stale = minutes_ago(u64::from(rule.check_response_timeout_minutes).max(1));
        let stuck: Vec<&EntryRow> = active
            .iter()
            .filter(|row| {
                row.state() == QueueState::Testing
                    && row
                        .tested_at
                        .as_deref()
                        .is_none_or(|at| at < stale.as_str())
            })
            .collect();
        if !stuck.is_empty() {
            self.retest(&stuck).await?;
            return Box::pin(self.queue_batch(a)).await;
        }
        if active.iter().any(|row| row.state() != QueueState::Waiting) {
            return Ok(());
        }
        let batch: Vec<EntryRow> = active
            .into_iter()
            .take(rule.max_entries_to_build.max(1) as usize)
            .collect();
        let Some(first) = batch.first() else {
            return Ok(());
        };
        // Too few to start yet, and the oldest has not waited long enough.
        if batch.len() < rule.min_entries_to_merge as usize
            && first.created_at.as_str()
                > minutes_ago(u64::from(rule.min_entries_wait_minutes)).as_str()
        {
            return Ok(());
        }
        let Some(actor) = first.actor() else {
            return Ok(());
        };
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: a.repo_id.clone(),
                viewer: Some(actor),
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(());
        };
        let base: Option<String> = g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs {
                repo_id: repo.id.clone(),
                branch: repo.default_branch.clone(),
            },
        )
        .await?;
        let Some(base) = base else {
            return Ok(());
        };

        let settings = self.settings(&repo.id).await?;
        // Each entry's change, as it is now.
        let mut items: Vec<(EntryRow, Pull, QueueStackItem)> = Vec::new();
        for row in batch {
            let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
                self.leave_gone(&row, PULL_GONE).await?;
                continue;
            };
            if pull.status != PullStatus::Open {
                self.leave(&repo.id, &pull, QueueState::Removed, Some("It was closed."))
                    .await?;
                continue;
            }
            let head: Option<String> = g1t_kit::call(
                &self.repos,
                "head",
                &HeadArgs {
                    repo_id: pull.source_id().to_owned(),
                    branch: pull
                        .branch
                        .clone()
                        .unwrap_or_else(|| repo.default_branch.clone()),
                },
            )
            .await?;
            let Some(commit) = head else {
                self.leave_gone(&row, BRANCH_GONE).await?;
                continue;
            };
            let source = pull.source_path(&RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            });
            // How it lands, and the commit message it lands with: worked
            // out once, so that the state is the one landing makes and
            // building it again makes the same commits.
            let method = row.method();
            let message = match self
                .merge_message_for(&repo, &pull, &settings, method, row.commit_title.as_deref(), row.commit_message.as_deref())
                .await?
            {
                Ok(message) => message,
                Err(problem) => {
                    self.leave(&repo.id, &pull, QueueState::Removed, Some(problem)).await?;
                    continue;
                }
            };
            let item = QueueStackItem {
                number: pull.number,
                title: pull.title.clone(),
                source,
                branch: pull
                    .branch
                    .clone()
                    .unwrap_or_else(|| repo.default_branch.clone()),
                commit,
                method,
                message,
                author: crate::merging::squash_author(&pull, method),
            };
            items.push((row, pull, item));
        }

        // Each built on the one before it: landing them in order moves the
        // default branch to each tested state in turn.
        let now = rfc3339(now_ms());
        let mut onto = base.clone();
        let mut built: Vec<(QueueStackItem, Vec<String>)> = Vec::new();
        for (row, pull, item) in items {
            let mut stack: Vec<QueueStackItem> = built.iter().map(|(item, _)| item.clone()).collect();
            stack.push(item.clone());
            let ahead: Vec<u32> = built.iter().map(|(item, _)| item.number).collect();
            let token = new_token();
            let claimed = self
                .db
                .prepare(CLAIM_BUILD)
                .bind(&[
                    hash(&token).into(),
                    item.commit.as_str().into(),
                    base.as_str().into(),
                    serde_json::to_string(&ahead)?.into(),
                    now.as_str().into(),
                    row.id.as_str().into(),
                    // Diagnosis rebuilds exactly these commits (integration.rs).
                    serde_json::to_string(&stack)?.into(),
                ])?
                .first::<crate::rows::ValueRow>(None)
                .await?;
            // Another request is building it: what follows waits for it.
            if claimed.is_none() {
                break;
            }
            let Some(actor) = row.actor() else { break };
            let branch = attempt_branch(&row.id, Some(&hash(&token)));
            let step = self.build_step(&repo, &onto, &item, &branch, &actor, settings.require_web_commit_sign_off).await?;
            let mut report = ReportQueueArgs {
                entry_id: row.id.clone(),
                token,
                combined_commit: None,
                results: Vec::new(),
                error: None,
                conflict_with: None,
                conflicts: Vec::new(),
            };
            let next = match step {
                Built::State(commit) => {
                    report.combined_commit = Some(commit.clone());
                    Some(commit)
                }
                Built::Conflict { message, paths } => {
                    // The entry ahead whose change touched the same files.
                    report.conflict_with = clashed_with(&built, &paths);
                    report.error = Some(message);
                    report.conflicts = paths;
                    None
                }
                Built::Failed(message) => {
                    report.error = Some(message);
                    None
                }
            };
            self.report_queue(report).await?;
            // One that could not be built leaves; those behind it are built
            // in the next batch, without it.
            let Some(next) = next else { break };
            onto = next;
            built.push((item, pull.files.iter().map(|file| file.path.clone()).collect()));
        }
        Ok(())
    }

    /// `item` landed by its method on `onto`, a state of the queue, in the
    /// repository itself (repos `build_queue_step`), and `branch` pointed at
    /// the state that makes, as `actor` (whoever queued it).
    pub(crate) async fn build_step(
        &self,
        repo: &Repo,
        onto: &str,
        item: &QueueStackItem,
        branch: &str,
        actor: &User,
        sign_off: bool,
    ) -> Result<Built> {
        let Some(source_id) = self.source_of(repo, item).await? else {
            return Ok(Built::Failed(format!("#{}'s repository is no longer there.", item.number)));
        };
        // A state recorded before methods: merged in as it was then.
        let message = item.message.clone().or_else(|| {
            matches!(item.method, MergeMethod::Merge | MergeMethod::Squash).then(|| format!("Merge #{}: {}", item.number, item.title))
        });
        let step: Outcome<QueueStep> = g1t_kit::call(
            &self.repos,
            "build_queue_step",
            &BuildQueueStepArgs {
                target_id: repo.id.clone(),
                onto: onto.to_owned(),
                source_id,
                branch: item.branch.clone(),
                commit: item.commit.clone(),
                method: item.method,
                message,
                author: item.author.clone(),
                sign_off,
                actor: actor.clone(),
                push_branch: branch.to_owned(),
            },
        )
        .await?;
        Ok(match step {
            Outcome::Ok(QueueStep::Built { commit, .. }) => Built::State(commit),
            Outcome::Ok(QueueStep::Conflict { message, paths }) => Built::Conflict { message, paths },
            Outcome::Ok(QueueStep::Refused { message }) => Built::Failed(message),
            Outcome::Fail(failure) => Built::Failed(failure.message),
        })
    }

    /// The repository holding a stack item's change: the queue's own, or
    /// its pull request's fork.
    async fn source_of(&self, repo: &Repo, item: &QueueStackItem) -> Result<Option<String>> {
        if item.source.namespace == repo.namespace && item.source.name == repo.name {
            return Ok(Some(repo.id.clone()));
        }
        // A fork's, through its pull request, whoever can read the fork.
        Ok(self.pull(&repo.id, item.number).await?.map(|pull| pull.source_id().to_owned()))
    }

    /// The result of building one combined state.
    pub(crate) async fn report_queue(&self, a: ReportQueueArgs) -> Result<Outcome<QueueState>> {
        // A smaller combination built to narrow down a failure.
        if a.entry_id.starts_with("qpr_") {
            return self.report_probe(a).await;
        }
        let row = self
            .db
            .prepare("SELECT * FROM queue_entries WHERE id = ? AND token_hash = ?")
            .bind(&[a.entry_id.as_str().into(), hash(&a.token).into()])?
            .first::<EntryRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such queue entry."));
        };
        if row.state() != QueueState::Testing {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This state is no longer being tested.",
            ));
        }
        if a.combined_commit.is_none() && a.error.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "A successful build must name the combined commit it tested.",
            ));
        }
        // Publish the commit before dispatching workflows: a very fast callback
        // must be able to find it. Only the winning report dispatches work.
        let accepted = self
            .db
            .prepare(ACCEPT_BUILD)
            .bind(&[
                a.combined_commit
                    .as_deref()
                    .map_or(JsValue::NULL, JsValue::from),
                row.id.as_str().into(),
                hash(&a.token).into(),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if accepted.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This build attempt is no longer being tested.",
            ));
        }
        let built = a.error.is_none() && a.results.iter().all(|result| result.passed);
        // A state that was built runs the repository's `merge_group`
        // workflows; it stays in testing until they finish (see `statuses`),
        // and the branch's required checks must pass on it.
        let workflows = match (&a.combined_commit, built) {
            (Some(commit), true) => {
                let dispatched = self
                    .run_merge_group(
                        &row.repo_id,
                        &row.id,
                        &row.branch(),
                        row.base_commit.as_deref(),
                        row.number,
                        &row.ahead(),
                        commit,
                    )
                    .await;
                match dispatched {
                    Ok(runs) => runs,
                    Err(error) => {
                        // The token is spent and the fence stays up, so no
                        // report or callback could ever move this attempt
                        // on: build it again now rather than after the
                        // check response timeout.
                        self.retest(&[&row]).await?;
                        return Err(error);
                    }
                }
            }
            _ => 0,
        };
        let required = self.settings_by_id(&row.repo_id).await?.required_checks;
        // Nothing runs on it, so the required checks never would report.
        let unchecked = (built && workflows == 0 && !required.is_empty()).then(|| {
            format!(
                "the required {} {} cannot report on it: no workflow runs on merge_group events. Add merge_group to the on: of the workflows the branch requires",
                if required.len() == 1 { "check" } else { "checks" },
                crate::statuses::list(&required)
            )
        });
        let passed = built && unchecked.is_none();
        let error = a.error.clone().or(unchecked.clone());
        let report = ReportQueueArgs {
            error: error.clone(),
            ..a
        };
        let failure = (!passed).then(|| {
            crate::integration::Failure::of_report(
                &report,
                unchecked.is_some().then_some(&required[..]),
            )
        });
        // Failed while an entry ahead of it is still being tested: held
        // until those ahead are settled, so that it is not blamed for
        // theirs (integration.rs).
        let held = match &failure {
            Some(failure) if self.ahead_unsettled(&row).await? => {
                Some(serde_json::to_string(failure)?)
            }
            _ => None,
        };
        let state = if passed && workflows == 0 {
            QueueState::Passed
        } else if passed || held.is_some() {
            QueueState::Testing
        } else {
            QueueState::Failed
        };
        let moved = self
            .db
            .prepare(REPORT_BUILD)
            .bind(&[
                state.as_str().into(),
                report
                    .combined_commit
                    .as_deref()
                    .map_or(JsValue::NULL, JsValue::from),
                serde_json::to_string(&report.results)?.into(),
                error.as_deref().map_or(JsValue::NULL, JsValue::from),
                held.as_deref().map_or(JsValue::NULL, JsValue::from),
                workflows.into(),
                state.as_str().into(),
                rfc3339(now_ms()).into(),
                row.id.as_str().into(),
                row.attempt_id
                    .as_deref()
                    .map_or(JsValue::NULL, JsValue::from),
                report
                    .combined_commit
                    .as_deref()
                    .map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if moved.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This build attempt is no longer being tested.",
            ));
        }
        if passed && workflows > 0 {
            // A workflow may have finished while dispatching was fenced. Read
            // the whole registered group now so that callback is not lost.
            self.merge_group_finished(&row.repo_id, report.combined_commit.as_deref().unwrap())
                .await?;
        }
        if let Some(failure) = failure.filter(|_| held.is_none()) {
            self.eject(&row, &report).await?;
            self.diagnose(&row, failure).await?;
        }
        if state == QueueState::Passed {
            self.integration_passed(&row, report.combined_commit.as_deref())
                .await?;
            self.resolve_held(&row.repo_id).await?;
        }
        self.settle(&row.repo_id).await?;
        self.changed(&row.repo_id).await?;
        Ok(Outcome::Ok(state))
    }

    /// Asks the actions service to run the repository's `merge_group`
    /// workflows on a combined state: `entry`'s, pushed to `branch`, with
    /// `ahead` merged in before `number`. Returns how many runs started.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_merge_group(
        &self,
        repo_id: &str,
        entry: &str,
        branch: &str,
        base_commit: Option<&str>,
        number: u32,
        ahead: &[u32],
        commit: &str,
    ) -> Result<u32> {
        #[derive(serde::Deserialize)]
        struct Started {
            runs: u32,
        }
        let started: Outcome<Started> = g1t_kit::call(
            &self.actions,
            "merge_group",
            &serde_json::json!({
                "repoId": repo_id,
                "entry": entry,
                "sha": commit,
                "headRef": format!("refs/heads/{branch}"),
                "baseSha": base_commit,
                "number": number,
                "ahead": ahead,
            }),
        )
        .await?;
        Ok(match started {
            Outcome::Ok(started) => started.runs,
            Outcome::Fail(failure) => {
                return Err(worker::Error::RustError(format!(
                    "Merge-group dispatch failed: {}",
                    failure.message
                )));
            }
        })
    }

    /// Workflows on a combined state finished: it passes and lands in turn
    /// when they all passed and so did every required check, or fails and
    /// leaves the queue.
    pub(crate) async fn merge_group_finished(
        &self,
        repo_id: &str,
        commit: &str,
    ) -> Result<()> {
        let row = self
            .db
            .prepare(
                "SELECT * FROM queue_entries
                 WHERE repo_id = ? AND combined_commit = ? AND state = 'testing' AND token_hash IS NULL AND held IS NULL AND dispatching = 0",
            )
            .bind(&[repo_id.into(), commit.into()])?
            .first::<EntryRow>(None)
            .await?;
        let Some(row) = row else {
            // Or a smaller combination built to narrow down a failure.
            if self.probe_finished(repo_id, commit).await? {
                self.changed(repo_id).await?;
            }
            return Ok(());
        };
        // Only this attempt's own runs, and what reported since it was
        // claimed, decide it: the same commit may have been built before.
        let Some(attempt) = row.attempt() else { return Ok(()) };
        let facts = self.attempt_facts(repo_id, &attempt).await?;
        if !facts.pending.is_empty() {
            return Ok(());
        }
        let missing = facts.expected();
        let passed = facts.passed();
        let failure = if passed {
            None
        } else {
            let error = if facts.failed.is_empty() && facts.required_failed().is_empty() {
                format!(
                    "the required {} {} did not report on it. Add merge_group to the on: of the workflows the branch requires",
                    if missing.len() == 1 {
                        "check"
                    } else {
                        "checks"
                    },
                    crate::statuses::list(&missing)
                )
            } else if facts.failed.is_empty() {
                format!(
                    "the required {} failed on it",
                    crate::statuses::list(&facts.required_failed())
                )
            } else {
                format!(
                    "the workflow {} failed on it",
                    crate::statuses::list(&facts.failed)
                )
            };
            // Where to see the check that failed: its run's page.
            let statuses = self.statuses(repo_id, Some(commit)).await?;
            let url = |name: &str| {
                statuses
                    .iter()
                    .find(|status| status.context == name || check_name(&status.context).0 == name)
                    .and_then(|status| status.target_url.clone())
            };
            Some(crate::integration::Failure::of_workflows(
                commit,
                &facts.failed,
                &facts.required_failed(),
                &missing,
                error,
                url,
            ))
        };
        let held = match &failure {
            Some(failure) if self.ahead_unsettled(&row).await? => {
                Some(serde_json::to_string(failure)?)
            }
            _ => None,
        };
        let state = if passed {
            "passed"
        } else if held.is_some() {
            "testing"
        } else {
            "failed"
        };
        let moved = self
            .db
            .prepare(FINISH_CHECKS)
            .bind(&[
                state.into(),
                held.as_deref().map_or(JsValue::NULL, JsValue::from),
                state.into(),
                rfc3339(now_ms()).into(),
                row.id.as_str().into(),
                commit.into(),
                row.attempt_id.as_deref().map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if moved.is_none() {
            return Ok(());
        }
        if let Some(failure) = failure.filter(|_| held.is_none()) {
            self.eject(&row, &failure.report(&row.id)).await?;
            self.diagnose(&row, failure).await?;
        }
        if passed {
            self.integration_passed(&row, Some(commit)).await?;
            self.resolve_held(repo_id).await?;
        }
        self.settle(repo_id).await?;
        self.changed(repo_id).await?;
        Ok(())
    }

    /// An entry whose combined state failed: the entries tested on top of
    /// it are tested again without it, and the failure is recorded as a
    /// failed check run of its pull request.
    pub(crate) async fn eject(&self, row: &EntryRow, report: &ReportQueueArgs) -> Result<()> {
        self.drop_branch(row).await;
        let active = self.entries(&row.repo_id, true).await?;
        let behind: Vec<&EntryRow> = active
            .iter()
            .filter(|other| {
                other.state() != QueueState::Waiting && other.ahead().contains(&row.number)
            })
            .collect();
        self.retest(&behind).await?;

        let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
            return Ok(());
        };
        let ahead = row.ahead();
        let state = if ahead.is_empty() {
            "the default branch as it is now".to_owned()
        } else {
            format!(
                "the default branch with {} merged in first",
                ahead
                    .iter()
                    .map(|n| format!("#{n}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        // Named in backticks, so the conversation can link each to the diff.
        let files = crate::mergeability::tidy(report.conflicts.clone())
            .iter()
            .map(|path| format!("`{path}`"))
            .collect::<Vec<_>>()
            .join(", ");
        let why = match (&report.error, report.conflict_with) {
            (_, Some(other)) if other != row.number && !files.is_empty() => format!(
                "Its change conflicts with #{other}, which is ahead of it in the merge queue, in {files}. Bring it up to date with the default branch once #{other} lands and push: it rejoins the merge queue once its checks pass."
            ),
            (_, Some(other)) if other != row.number => format!(
                "Its change conflicts with #{other}, which is ahead of it in the merge queue. Bring it up to date with the default branch once #{other} lands and push: it rejoins the merge queue once its checks pass."
            ),
            (Some(_), None) if !files.is_empty() => format!(
                "Its change conflicts with the default branch in {files}. Bring it up to date with the default branch and push: it rejoins the merge queue once its checks pass."
            ),
            (Some(error), _) if error.starts_with("the workflow ") => {
                format!(
                    "{} when it was combined with {state}.",
                    error
                        .replacen("the workflow", "The workflow", 1)
                        .trim_end_matches(" on it")
                )
            }
            (Some(error), _) if error.starts_with("the required ") => {
                format!("Combined with {state}, {error}.")
            }
            (Some(error), _) => {
                format!("Its combined state could not be built or checked: {error}")
            }
            (None, _) => format!(
                "It failed when it was combined with {state}, though it may pass on its own."
            ),
        };
        let now = now_ms();
        let run_id = new_id("chk", now);
        let mut results = report.results.clone();
        for result in &mut results {
            result.command = format!("{} (merge queue, on {state})", result.command);
        }
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO check_runs
                           (id, pull_id, head_commit, status, results, error, token_hash,
                            created_at, finished_at)
                         VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        run_id.as_str().into(),
                        pull.id.as_str().into(),
                        row.head_commit.as_deref().unwrap_or_default().into(),
                        serde_json::to_string(&results)?.into(),
                        why.as_str().into(),
                        hash(&new_token()).into(),
                        rfc3339(now).into(),
                        rfc3339(now).into(),
                    ])?,
                self.db
                    .prepare(
                        "UPDATE pulls SET check_status = 'failed', check_run_id = ? WHERE id = ?",
                    )
                    .bind(&[run_id.as_str().into(), pull.id.as_str().into()])?,
                // Its merge stays asked for: it rejoins once a fix's checks
                // pass (integration.rs `requeue_if_fixed`).
                self.db
                    .prepare("UPDATE queue_entries SET requeue = 1 WHERE id = ?")
                    .bind(&[row.id.as_str().into()])?,
            ])
            .await?;
        self.note(
            &row.repo_id,
            pull.number,
            ("g1t", "g1t"),
            &format!("was taken out of the merge queue. {why}"),
        )
        .await?;
        self.publish_as(
            "checks.completed",
            &row.repo_id,
            None,
            ChecksEvent {
                pull_id: pull.id.clone(),
                repo_id: row.repo_id.clone(),
                number: pull.number,
                status: "failed",
                commit: row.head_commit.clone().unwrap_or_default(),
            },
        )
        .await?;
        Ok(())
    }

    /// Lands every entry at the front of the queue whose tested state
    /// passed, in order.
    async fn settle(&self, repo_id: &str) -> Result<()> {
        let active = self.entries(repo_id, true).await?;
        let Some(viewer) = active.first().and_then(EntryRow::actor) else {
            return Ok(());
        };
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: repo_id.to_owned(),
                viewer: Some(viewer),
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(());
        };
        for row in active {
            if row.state() != QueueState::Passed {
                // The front has not passed yet: nothing behind it may land.
                return Ok(());
            }
            let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
                self.leave_gone(&row, PULL_GONE).await?;
                return Ok(());
            };
            let Some(actor) = row.actor() else {
                continue;
            };
            // Git may have succeeded before a previous request stopped. Once
            // the merge record exists, only queue bookkeeping remains.
            if row.landing_commit.is_some()
                && pull.status == PullStatus::Merged
                && pull.merge_commit == row.landing_commit
            {
                self.finish_landing(&row).await?;
                continue;
            }
            if row.landing_commit.is_none() {
                // Pushed to since it was tested: test it again as it is now.
                if pull.status != PullStatus::Open {
                    self.leave(repo_id, &pull, QueueState::Removed, Some("It was closed."))
                        .await?;
                    continue;
                }
                let head: Option<String> = g1t_kit::call(
                    &self.repos,
                    "head",
                    &HeadArgs {
                        repo_id: pull.source_id().to_owned(),
                        branch: pull
                            .branch
                            .clone()
                            .unwrap_or_else(|| repo.default_branch.clone()),
                    },
                )
                .await?;
                if head.is_none() {
                    self.leave_gone(&row, BRANCH_GONE).await?;
                    return Ok(());
                }
                if head != row.head_commit || row.combined_commit.is_none() {
                    let active = self.entries(repo_id, true).await?;
                    let again: Vec<&EntryRow> = active
                        .iter()
                        .filter(|other| other.id == row.id || other.ahead().contains(&row.number))
                        .collect();
                    self.retest(&again).await?;
                    return Ok(());
                }
                // Judged on this attempt's own evidence on the tested commit,
                // not on an earlier attempt's or the pull request's own.
                let Some(attempt) = row.attempt() else { return Ok(()) };
                let evidence = self.attempt_statuses(repo_id, &attempt).await?;
                if evidence.runs_missing {
                    // Its runs cannot be read just now: try again later.
                    return Ok(());
                }
                let gate = self
                    .queue_landing_gate(
                        &repo,
                        &pull,
                        &actor,
                        row.combined_commit.as_deref().unwrap(),
                        row.bypass_rules != 0,
                        evidence.all(),
                        row.method(),
                    )
                    .await?;
                if let Some(refusal) = gate.refusal() {
                    self.record_merge_evaluations(&repo, &pull, &gate).await;
                    self.leave(repo_id, &pull, QueueState::Removed, Some(&refusal))
                        .await?;
                    self.changed(repo_id).await?;
                    return Ok(());
                }
            }
            let acquired = self
                .db
                .prepare(BEGIN_LANDING)
                .bind(&[
                    row.id.as_str().into(),
                    row.combined_commit
                        .as_deref()
                        .map_or(JsValue::NULL, JsValue::from),
                    row.attempt_id
                        .as_deref()
                        .map_or(JsValue::NULL, JsValue::from),
                ])?
                .first::<crate::rows::ValueRow>(None)
                .await?;
            if acquired.is_none() {
                return Ok(());
            }
            let land = LandArgs {
                source_id: repo_id.to_owned(),
                branch: Some(row.branch()),
                actor: actor.clone(),
                // The queue lands on the default branch.
                target_branch: None,
                expected_commit: row.combined_commit.clone(),
                target_id: None,
                // The state tested was built by the entry's method on what
                // landed before it: it lands exactly as tested, the default
                // branch moving to it.
                method: Some(MergeMethod::FastForward),
                message: None,
                author: None,
                sign_off: false,
            };
            let mut landed: Outcome<Landed> = g1t_kit::call(&self.repos, "land", &land).await?;
            if matches!(landed, Outcome::Fail(_)) {
                // BEGIN_LANDING lets a crashed publication resume, so another
                // request may be publishing this same commit: its push makes
                // ours lose Git's compare-and-swap, and its bookkeeping may
                // already have dropped the tested branch. Ask Git again before
                // giving up on a commit that may already be published.
                if !self.still_landing(&row).await? {
                    return Ok(());
                }
                landed = g1t_kit::call(&self.repos, "land", &land).await?;
            }
            let landed = match landed {
                // Recorded as the method it was built by.
                Outcome::Ok(landed) => Landed { method: row.method(), ..landed },
                Outcome::Fail(_) => {
                    let abandoned = self
                        .db
                        .prepare(ABANDON_LANDING)
                        .bind(&[
                            row.id.as_str().into(),
                            row.combined_commit.as_deref().map_or(JsValue::NULL, JsValue::from),
                        ])?
                        .first::<crate::rows::ValueRow>(None)
                        .await?;
                    if abandoned.is_none() {
                        // Another request finished (or abandoned) it.
                        return Ok(());
                    }
                    // The default branch moved outside the queue: every
                    // tested state is built on something that is gone.
                    let active = self.entries(repo_id, true).await?;
                    let all: Vec<&EntryRow> = active.iter().collect();
                    self.retest(&all).await?;
                    return Ok(());
                }
            };
            // Record the merge before removing its recoverable queue intent.
            let head = row.head_commit.clone();
            let merged = self.record_merge(&repo, pull, &actor, row.keep_issue_open != 0, landed)
                .await?;
            self.finish_landing(&row).await?;
            // Its branch, where the repository deletes branches on merge,
            // if it is still where it was tested.
            if merged.status == PullStatus::Merged {
                self.delete_branch_after_merge(&repo, &merged, &actor, None, head).await?;
            }
        }
        Ok(())
    }

    async fn finish_landing(&self, row: &EntryRow) -> Result<()> {
        self.db
            .prepare(FINISH_LANDING)
            .bind(&[rfc3339(now_ms()).into(), row.id.as_str().into()])?
            .run()
            .await?;
        self.drop_branch(row).await;
        Ok(())
    }

    /// Whether `row` still holds the publication intent it was read with.
    async fn still_landing(&self, row: &EntryRow) -> Result<bool> {
        Ok(self
            .db
            .prepare(STILL_LANDING)
            .bind(&[
                row.id.as_str().into(),
                row.combined_commit.as_deref().map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .is_some())
    }
}
