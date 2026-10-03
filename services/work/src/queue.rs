//! The merge queue: pull requests are tested together with the ones ahead
//! of them, and only a combination that passed reaches the default branch.
//!
//! A batch of up to [`BATCH`] entries is tested at once, speculatively: one
//! sandbox per entry builds the default branch with that entry and every
//! entry ahead of it merged in, runs all of their acceptance checks, and
//! pushes the result to `g1t-queue/<entry>`. Entries land in order, each by
//! moving the default branch to its tested state, once everything ahead has
//! landed. One that fails leaves the queue with a failed check run, which
//! sends a g1t agent back to fix it; the entries behind it are tested again
//! without it.

use futures_util::future::try_join_all;
use g1t_contracts::events::{ChecksEvent, QueueChanged};
use g1t_contracts::repos::{DeleteBranchArgs, GetByIdArgs, HeadArgs, LandArgs, Landed, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::checks::{hash, new_token};

/// How many entries are tested at once.
const BATCH: usize = 4;
/// How long a batch may take before it is tested again.
const TESTING_MINUTES: u64 = 45;
/// How many entries that left the queue are shown.
const RECENT: u32 = 20;
/// How many completed issues' checks make up the default branch's contract.
const CONTRACT_ISSUES: u32 = 30;
/// Where tested states are pushed, in the repository itself.
const BRANCH_PREFIX: &str = "g1t-queue/";

#[derive(Clone, Deserialize)]
pub(crate) struct EntryRow {
    id: String,
    repo_id: String,
    pull_id: String,
    number: u32,
    state: String,
    enqueued_by: String,
    keep_issue_open: u32,
    head_commit: Option<String>,
    base_commit: Option<String>,
    ahead: Option<String>,
    combined_commit: Option<String>,
    results: Option<String>,
    error: Option<String>,
    tested_at: Option<String>,
    created_at: String,
    finished_at: Option<String>,
}

impl EntryRow {
    fn state(&self) -> QueueState {
        match self.state.as_str() {
            "testing" => QueueState::Testing,
            "passed" => QueueState::Passed,
            "failed" => QueueState::Failed,
            "landed" => QueueState::Landed,
            "removed" => QueueState::Removed,
            _ => QueueState::Waiting,
        }
    }

    fn actor(&self) -> Option<User> {
        serde_json::from_str(&self.enqueued_by).ok()
    }

    fn ahead(&self) -> Vec<u32> {
        self.ahead
            .as_deref()
            .and_then(|ahead| serde_json::from_str(ahead).ok())
            .unwrap_or_default()
    }

    fn branch(&self) -> String {
        format!("{BRANCH_PREFIX}{}", self.id)
    }
}

fn minutes_ago(minutes: u64) -> String {
    rfc3339(now_ms().saturating_sub(minutes * 60 * 1000))
}

impl Work {
    async fn entries(&self, repo_id: &str, active: bool) -> Result<Vec<EntryRow>> {
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
    pub(crate) async fn queued_entry(&self, pull_id: &str) -> Result<Option<(QueueState, Vec<u32>)>> {
        let row = self
            .db
            .prepare(
                "SELECT * FROM queue_entries
                 WHERE pull_id = ? AND state IN ('waiting', 'testing', 'passed') LIMIT 1",
            )
            .bind(&[pull_id.into()])?
            .first::<EntryRow>(None)
            .await?;
        Ok(row.map(|row| (row.state(), row.ahead())))
    }

    async fn changed(&self, repo_id: &str) -> Result<()> {
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

    /// Puts a pull request that may merge into the queue instead. Merging
    /// it again while it is queued changes nothing.
    pub(crate) async fn enqueue(
        &self,
        repo: &Repo,
        pull: &Pull,
        actor: &User,
        keep_issue_open: bool,
    ) -> Result<Outcome<Pull>> {
        if self.queued_entry(&pull.id).await?.is_some() {
            return Ok(Outcome::Ok(pull.clone()));
        }
        let now = now_ms();
        self.db
            .prepare(
                "INSERT INTO queue_entries
                   (id, repo_id, pull_id, number, state, enqueued_by, keep_issue_open, created_at)
                 VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)",
            )
            .bind(&[
                new_id("qen", now).into(),
                repo.id.as_str().into(),
                pull.id.as_str().into(),
                pull.number.into(),
                serde_json::to_string(actor)?.into(),
                u32::from(keep_issue_open).into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
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
        let enabled = self.settings(&repo.id).await?.merge_queue;
        let (active, recent) = (self.entries(&repo.id, true).await?, self.entries(&repo.id, false).await?);
        let numbers: Vec<u32> = active.iter().chain(&recent).map(|row| row.number).collect();
        let pulls = try_join_all(numbers.iter().map(|number| self.pull(&repo.id, *number))).await?;
        let view = |rows: Vec<EntryRow>, pulls: &[Option<Pull>]| -> Vec<QueueEntry> {
            rows.into_iter()
                .zip(pulls)
                .map(|(row, pull)| QueueEntry {
                    state: row.state(),
                    ahead: row.ahead(),
                    enqueued_by: row.actor().map_or_else(|| "g1t".to_owned(), |actor| actor.username),
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

    /// Takes a pull request out of the queue, by a member's hand.
    pub(crate) async fn remove_from_queue(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let viewer = Some(a.actor.clone());
        let (repo, pull) = match self.pull_at(&a.repo, a.number, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified || !a.actor.is_member(&repo.namespace) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members of the repository's workspace can change its merge queue.",
            ));
        }
        if self.leave(&repo.id, &pull, QueueState::Removed, None).await? {
            let who = (a.actor.id.as_str(), a.actor.username.as_str());
            self.note(&repo.id, pull.number, who, "removed this from the merge queue")
                .await?;
            self.changed(&repo.id).await?;
        }
        Ok(Outcome::Ok(pull))
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
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE queue_entries SET state = ?, error = COALESCE(?, error), finished_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                state.as_str().into(),
                error.map_or(JsValue::NULL, JsValue::from),
                now.as_str().into(),
                entry.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.drop_branch(entry).await;
        let behind: Vec<&EntryRow> = active
            .iter()
            .filter(|row| row.state() != QueueState::Waiting && row.ahead().contains(&pull.number))
            .collect();
        self.retest(&behind).await?;
        Ok(true)
    }

    /// Removes an entry's tested state from the repository once it has
    /// left the queue, as GitHub does with its queue's branches. A branch
    /// left behind is untidy, not wrong, so a failure only logs.
    async fn drop_branch(&self, row: &EntryRow) {
        let deleted: Result<Outcome<bool>> = g1t_kit::call(
            &self.repos,
            "delete_branch",
            &DeleteBranchArgs {
                repo_id: row.repo_id.clone(),
                branch: row.branch(),
            },
        )
        .await;
        match deleted {
            Ok(Outcome::Ok(_)) => {}
            Ok(Outcome::Fail(failure)) => worker::console_warn!("{}: {}", row.branch(), failure.message),
            Err(error) => worker::console_warn!("{}: {error}", row.branch()),
        }
    }

    /// Sends entries back to waiting, to be tested again.
    async fn retest(&self, rows: &[&EntryRow]) -> Result<()> {
        for row in rows {
            self.db
                .prepare(
                    "UPDATE queue_entries
                     SET state = 'waiting', token_hash = NULL, combined_commit = NULL,
                         results = NULL, error = NULL, ahead = NULL
                     WHERE id = ? AND state IN ('testing', 'passed')",
                )
                .bind(&[row.id.as_str().into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    /// The next batch to test, if nothing is being tested now: one job per
    /// entry, each building the default branch with that entry and every
    /// entry ahead of it.
    pub(crate) async fn queue_build(&self, a: QueueBuildArgs) -> Result<Vec<QueueJob>> {
        let active = self.entries(&a.repo_id, true).await?;
        // A batch that has taken too long is tested again.
        let stale = minutes_ago(TESTING_MINUTES);
        let stuck: Vec<&EntryRow> = active
            .iter()
            .filter(|row| {
                row.state() == QueueState::Testing
                    && row.tested_at.as_deref().is_none_or(|at| at < stale.as_str())
            })
            .collect();
        if !stuck.is_empty() {
            self.retest(&stuck).await?;
            return Box::pin(self.queue_build(a)).await;
        }
        if active.iter().any(|row| row.state() != QueueState::Waiting) {
            return Ok(Vec::new());
        }
        let batch: Vec<EntryRow> = active.into_iter().take(BATCH).collect();
        let Some(first) = batch.first() else {
            return Ok(Vec::new());
        };
        let Some(actor) = first.actor() else {
            return Ok(Vec::new());
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
        let Outcome::Ok(repo) = repo else {
            return Ok(Vec::new());
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
            return Ok(Vec::new());
        };

        // Each entry's change, as it is now, and the checks it brings.
        let mut items: Vec<(EntryRow, Pull, QueueStackItem, Vec<String>)> = Vec::new();
        for row in batch {
            let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
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
                    repo_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                    branch: pull.branch.clone().unwrap_or_else(|| repo.default_branch.clone()),
                },
            )
            .await?;
            let Some(commit) = head else {
                continue;
            };
            let checks = match pull.issue {
                Some(number) => self
                    .issue(&repo.id, number)
                    .await?
                    .map(|issue| issue.checks)
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            let source = pull.fork.clone().unwrap_or_else(|| RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            });
            let item = QueueStackItem {
                number: pull.number,
                title: pull.title.clone(),
                source,
                branch: pull.branch.clone().unwrap_or_else(|| repo.default_branch.clone()),
                commit,
            };
            items.push((row, pull, item, checks));
        }

        // What the default branch has promised so far: every check an issue
        // passed when it landed, newest first.
        #[derive(Deserialize)]
        struct ChecksRow {
            checks: String,
        }
        let mut contract: Vec<String> = Vec::new();
        for row in self
            .db
            .prepare(
                "SELECT checks FROM issues
                 WHERE repo_id = ? AND state = 'closed' AND reason = 'completed' AND checks != '[]'
                 ORDER BY closed_at DESC LIMIT ?",
            )
            .bind(&[repo.id.as_str().into(), CONTRACT_ISSUES.into()])?
            .all()
            .await?
            .results::<ChecksRow>()?
        {
            for check in serde_json::from_str::<Vec<String>>(&row.checks).unwrap_or_default() {
                if !contract.contains(&check) {
                    contract.push(check);
                }
            }
        }

        let now = rfc3339(now_ms());
        let mut jobs = Vec::new();
        for index in 0..items.len() {
            let (row, pull, _, _) = &items[index];
            let stack: Vec<QueueStackItem> = items[..=index].iter().map(|(_, _, item, _)| item.clone()).collect();
            let mut checks: Vec<String> = Vec::new();
            for (_, _, _, theirs) in &items[..=index] {
                for check in theirs {
                    if !checks.contains(check) {
                        checks.push(check.clone());
                    }
                }
            }
            let ahead: Vec<u32> = stack[..index].iter().map(|item| item.number).collect();
            let token = new_token();
            self.db
                .prepare(
                    "UPDATE queue_entries
                     SET state = 'testing', token_hash = ?, head_commit = ?, base_commit = ?,
                         ahead = ?, combined_commit = NULL, results = NULL, error = NULL,
                         tested_at = ?
                     WHERE id = ? AND state = 'waiting'",
                )
                .bind(&[
                    hash(&token).into(),
                    stack[index].commit.as_str().into(),
                    base.as_str().into(),
                    serde_json::to_string(&ahead)?.into(),
                    now.as_str().into(),
                    row.id.as_str().into(),
                ])?
                .run()
                .await?;
            // The sandbox reads the change and pushes the tested state as
            // the pull request's author: a real account, whose token carries
            // its memberships. (Whoever queued it may be g1t itself.)
            let actor = pull.author.clone();
            jobs.push(QueueJob {
                entry_id: row.id.clone(),
                token,
                repo: RepoPath {
                    namespace: repo.namespace.clone(),
                    name: repo.name.clone(),
                },
                default_branch: repo.default_branch.clone(),
                base_commit: base.clone(),
                branch: row.branch(),
                contract_checks: contract.iter().filter(|check| !checks.contains(check)).cloned().collect(),
                stack,
                checks,
                actor,
            });
        }
        Ok(jobs)
    }

    /// A sandbox's result for one combined state.
    pub(crate) async fn report_queue(&self, a: ReportQueueArgs) -> Result<Outcome<QueueState>> {
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
        let passed = a.error.is_none() && a.results.iter().all(|result| result.passed);
        // A state that passed its checks still runs the repository's
        // `merge_group` workflows, as GitHub's merge queue does; it stays in
        // testing until they finish (see `statuses`).
        let workflows = match (&a.combined_commit, passed) {
            (Some(commit), true) => self.start_merge_group(&row, commit).await.unwrap_or(0),
            _ => 0,
        };
        let state = if !passed {
            QueueState::Failed
        } else if workflows > 0 {
            QueueState::Testing
        } else {
            QueueState::Passed
        };
        self.db
            .prepare(
                "UPDATE queue_entries
                 SET state = ?, combined_commit = ?, results = ?, error = ?, token_hash = NULL,
                     finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
                 WHERE id = ?",
            )
            .bind(&[
                state.as_str().into(),
                a.combined_commit.as_deref().map_or(JsValue::NULL, JsValue::from),
                serde_json::to_string(&a.results)?.into(),
                a.error.as_deref().map_or(JsValue::NULL, JsValue::from),
                state.as_str().into(),
                rfc3339(now_ms()).into(),
                row.id.as_str().into(),
            ])?
            .run()
            .await?;
        if !passed {
            self.eject(&row, &a).await?;
        }
        self.settle(&row.repo_id).await?;
        self.changed(&row.repo_id).await?;
        Ok(Outcome::Ok(state))
    }

    /// Asks the actions service to run the repository's `merge_group`
    /// workflows on a combined state. Returns how many runs started.
    async fn start_merge_group(&self, row: &EntryRow, commit: &str) -> Result<u32> {
        #[derive(serde::Deserialize)]
        struct Started {
            runs: u32,
        }
        let started: Outcome<Started> = g1t_kit::call(
            &self.actions,
            "merge_group",
            &serde_json::json!({
                "repoId": row.repo_id,
                "entry": row.id,
                "sha": commit,
                "headRef": format!("refs/heads/{}", row.branch()),
                "baseSha": row.base_commit,
                "number": row.number,
                "ahead": row.ahead(),
            }),
        )
        .await?;
        Ok(match started {
            Outcome::Ok(started) => started.runs,
            Outcome::Fail(_) => 0,
        })
    }

    /// Workflows on a combined state finished: it passes and lands in turn,
    /// or fails and leaves the queue as for failed checks.
    pub(crate) async fn merge_group_finished(&self, repo_id: &str, commit: &str, failed: &[String]) -> Result<()> {
        let row = self
            .db
            .prepare(
                "SELECT * FROM queue_entries WHERE repo_id = ? AND combined_commit = ? AND state = 'testing' AND token_hash IS NULL",
            )
            .bind(&[repo_id.into(), commit.into()])?
            .first::<EntryRow>(None)
            .await?;
        let Some(row) = row else { return Ok(()) };
        let passed = failed.is_empty();
        self.db
            .prepare("UPDATE queue_entries SET state = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END WHERE id = ?")
            .bind(&[
                (if passed { "passed" } else { "failed" }).into(),
                (if passed { "passed" } else { "failed" }).into(),
                rfc3339(now_ms()).into(),
                row.id.as_str().into(),
            ])?
            .run()
            .await?;
        if !passed {
            let report = ReportQueueArgs {
                entry_id: row.id.clone(),
                token: String::new(),
                combined_commit: Some(commit.to_owned()),
                results: Vec::new(),
                error: Some(format!(
                    "the workflow {} failed on it",
                    crate::statuses::list(failed)
                )),
                conflict_with: None,
            };
            self.eject(&row, &report).await?;
        }
        self.settle(repo_id).await?;
        self.changed(repo_id).await?;
        Ok(())
    }

    /// An entry whose combined state failed: the entries tested on top of
    /// it are tested again without it, and the failure is recorded as a
    /// failed check run of its pull request, so a g1t agent is sent back.
    async fn eject(&self, row: &EntryRow, report: &ReportQueueArgs) -> Result<()> {
        self.drop_branch(row).await;
        let active = self.entries(&row.repo_id, true).await?;
        let behind: Vec<&EntryRow> = active
            .iter()
            .filter(|other| other.state() != QueueState::Waiting && other.ahead().contains(&row.number))
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
                ahead.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", ")
            )
        };
        let why = match (&report.error, report.conflict_with) {
            (_, Some(other)) if other != row.number => format!(
                "Its change conflicts with #{other}, which is ahead of it in the merge queue. Bring it up to date with the default branch once #{other} lands, and merge it again."
            ),
            (Some(error), _) if error.starts_with("the workflow ") => {
                format!("{} when it was combined with {state}.", error.replacen("the workflow", "The workflow", 1).trim_end_matches(" on it"))
            }
            (Some(error), _) => format!("Its combined state could not be built or checked: {error}"),
            (None, _) => format!(
                "The acceptance checks failed when it was combined with {state}, though it may pass on its own."
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
                    .prepare("UPDATE pulls SET check_status = 'failed', check_run_id = ? WHERE id = ?")
                    .bind(&[run_id.as_str().into(), pull.id.as_str().into()])?,
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
        let Outcome::Ok(repo) = repo else {
            return Ok(());
        };
        for row in active {
            if row.state() != QueueState::Passed {
                // The front has not passed yet: nothing behind it may land.
                return Ok(());
            }
            let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
                continue;
            };
            let Some(actor) = row.actor() else {
                continue;
            };
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
                    repo_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo_id.to_owned()),
                    branch: pull.branch.clone().unwrap_or_else(|| repo.default_branch.clone()),
                },
            )
            .await?;
            if head.is_some() && head != row.head_commit {
                let active = self.entries(repo_id, true).await?;
                let again: Vec<&EntryRow> = active
                    .iter()
                    .filter(|other| other.id == row.id || other.ahead().contains(&row.number))
                    .collect();
                self.retest(&again).await?;
                return Ok(());
            }
            let landed: Outcome<Landed> = g1t_kit::call(
                &self.repos,
                "land",
                &LandArgs {
                    source_id: repo_id.to_owned(),
                    branch: Some(row.branch()),
                    actor: actor.clone(),
                },
            )
            .await?;
            let landed = match landed {
                Outcome::Ok(landed) => landed,
                Outcome::Fail(_) => {
                    // The default branch moved outside the queue: every
                    // tested state is built on something that is gone.
                    let active = self.entries(repo_id, true).await?;
                    let all: Vec<&EntryRow> = active.iter().collect();
                    self.retest(&all).await?;
                    return Ok(());
                }
            };
            self.db
                .prepare(
                    "UPDATE queue_entries SET state = 'landed', finished_at = ? WHERE id = ?",
                )
                .bind(&[rfc3339(now_ms()).into(), row.id.as_str().into()])?
                .run()
                .await?;
            self.drop_branch(&row).await;
            self.record_merge(&repo, pull, &actor, row.keep_issue_open != 0, landed)
                .await?;
        }
        Ok(())
    }
}
