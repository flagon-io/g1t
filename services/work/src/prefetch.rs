//! Reading a page's worth of rows in one round trip.
//!
//! A pull request's page used to cost about twenty queries one after
//! another: the repository, the pull request, its issue, then where it
//! stands (its progress, latest review, settings, statuses, verdicts,
//! queue entry, the confidence signals), its comments, checks and
//! messages. Each is a round trip to the database, and from most places a
//! round trip is 20 to 40 ms. Here they go as one D1 batch, keyed by the
//! repository's id and the pull request's number, and the batch starts
//! while the repos service is still deciding whether the viewer may see
//! the repository ([`Work::repo_then`]).
//!
//! The helpers that answer those questions (`settings`, `statuses`,
//! `review_pending`, `approvals_gap` and the rest) look here first, so the
//! code that decides a pull request's lifecycle is the same code whether
//! its rows were batched or read one at a time. Only reads are kept; a
//! helper that writes and reads back (mergeability) reads the database.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;

use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{Outcome, Viewer};
use g1t_kit::now_ms;
use serde::de::DeserializeOwned;
use worker::wasm_bindgen::JsValue;
use worker::{D1PreparedStatement, D1Result, Result};

use crate::reviews::AGENT_ID;
use crate::rows::PULL_COLUMNS;
use crate::{ISSUE_COLUMNS, Work};

/// The pull request's id, from the batch's `?1` (repository) and `?2` (number).
const PULL_ID: &str = "(SELECT id FROM pulls WHERE repo_id = ?1 AND number = ?2)";

/// How long a review that never reported is waited for (reviews.rs).
pub(crate) const REVIEW_PENDING_MS: u64 = 30 * 60 * 1000;

/// Each statement of a pull request's batch, in order.
#[derive(Clone, Copy)]
pub(crate) enum Slot {
    Pull,
    Issue,
    Comments,
    Verdicts,
    Runs,
    RunHistory,
    Review,
    ReviewComments,
    ReviewPending,
    Statuses,
    Settings,
    Hold,
    Messages,
    Others,
    Queued,
    LatestRun,
    Halted,
    Denials,
    Unanswered,
    Planned,
}

/// How many runs `latest_checks` and `earlier_checks` show together.
pub(crate) const RECENT_RUNS: u32 = 11;

/// One pull request's rows, as read for this request.
pub(crate) struct Prefetched {
    pub(crate) pull_id: String,
    pub(crate) repo_id: String,
    /// Its head commit when read, which its statuses are for.
    pub(crate) head: Option<String>,
    results: Vec<D1Result>,
}

impl Prefetched {
    /// A slot's rows, as the helper that reads them would have.
    pub(crate) fn rows<T: DeserializeOwned>(&self, slot: Slot) -> Result<Vec<T>> {
        match self.results.get(slot as usize) {
            Some(result) => result.results::<T>(),
            None => Ok(Vec::new()),
        }
    }

    /// A slot's first row.
    pub(crate) fn first<T: DeserializeOwned>(&self, slot: Slot) -> Result<Option<T>> {
        Ok(self.rows::<T>(slot)?.into_iter().next())
    }
}

#[derive(serde::Deserialize)]
struct IdRow {
    id: String,
    head_commit: Option<String>,
}

thread_local! {
    /// Repository ids by path, as the repos service last answered: a guess
    /// that lets a page's batch start before the answer comes. Never
    /// trusted: nothing read with a guess is used unless the repos service
    /// then says the viewer may see that very repository.
    static REPO_IDS: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// Guesses kept at most; the map is emptied past this.
const MAX_GUESSES: usize = 1024;

fn path_key(path: &RepoPath) -> String {
    format!("{}/{}", path.namespace.to_lowercase(), path.name.to_lowercase())
}

fn guess(path: &RepoPath) -> Option<String> {
    REPO_IDS.with(|ids| ids.borrow().get(&path_key(path)).cloned())
}

fn learn(path: &RepoPath, id: Option<&str>) {
    REPO_IDS.with(|ids| {
        let mut ids = ids.borrow_mut();
        match id {
            Some(id) => {
                if ids.len() >= MAX_GUESSES {
                    ids.clear();
                }
                ids.insert(path_key(path), id.to_owned());
            }
            None => {
                ids.remove(&path_key(path));
            }
        }
    });
}

impl Work {
    /// The repository at `path` if `viewer` may see it, and what `load`
    /// reads for it. When this isolate has seen the repository before,
    /// `load` starts with its id at once, beside the access check, instead
    /// of after it: one round trip instead of two. What it read is
    /// discarded unless the check passes for that same repository.
    pub(crate) async fn repo_then<T, F, Fut>(&self, path: &RepoPath, viewer: &Viewer, load: F) -> Result<Outcome<(Repo, T)>>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let guessed = guess(path);
        let (found, early) = match &guessed {
            Some(id) => {
                let (found, early) = futures_util::future::join(self.repo(path, viewer), load(id.clone())).await;
                (found?, Some(early))
            }
            None => (self.repo(path, viewer).await?, None),
        };
        let repo = match found {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => {
                learn(path, None);
                return Ok(Outcome::Fail(failure));
            }
        };
        if let (Some(id), Some(Ok(value))) = (&guessed, early)
            && *id == repo.id
        {
            return Ok(Outcome::Ok((repo, value)));
        }
        learn(path, Some(&repo.id));
        let value = load(repo.id.clone()).await?;
        Ok(Outcome::Ok((repo, value)))
    }

    fn statement(&self, sql: &str, binds: &[JsValue]) -> Result<D1PreparedStatement> {
        self.db.prepare(sql).bind(binds)
    }

    /// Everything a pull request's page and its lifecycle read, in one
    /// batch. `None` when there is no such pull request.
    pub(crate) async fn prefetch_pull(&self, repo_id: String, number: u32) -> Result<Option<Prefetched>> {
        let key = || -> [JsValue; 2] { [repo_id.as_str().into(), number.into()] };
        let with = |extra: JsValue| -> [JsValue; 3] { [repo_id.as_str().into(), number.into(), extra] };
        let repo_only = || -> [JsValue; 1] { [repo_id.as_str().into()] };
        let statements = vec![
            // Slot::Pull: the row, with everything the lifecycle tracks on it.
            self.statement(&format!("SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ?1 AND number = ?2"), &key())?,
            // Slot::Issue
            self.statement(
                &format!(
                    "SELECT {ISSUE_COLUMNS} FROM issues
                     WHERE repo_id = ?1 AND number = (SELECT issue_number FROM pulls WHERE repo_id = ?1 AND number = ?2)"
                ),
                &key(),
            )?,
            // Slot::Comments (lib.rs `comments`)
            self.statement("SELECT * FROM comments WHERE repo_id = ?1 AND number = ?2 ORDER BY id LIMIT 500", &key())?,
            // Slot::Verdicts: every verdict, oldest first, for the approval
            // rule, a person's request for changes and a person's approval.
            self.statement(
                "SELECT author_id, author_name, verdict, created_at FROM comments
                 WHERE repo_id = ?1 AND number = ?2 AND verdict IS NOT NULL ORDER BY id",
                &key(),
            )?,
            // Slot::Runs: the latest and the ten before it (checks.rs).
            self.statement(
                &format!("SELECT * FROM check_runs WHERE pull_id = {PULL_ID} ORDER BY id DESC LIMIT ?3"),
                &with(RECENT_RUNS.into()),
            )?,
            // Slot::RunHistory (confidence.rs `signals`)
            self.statement(
                &format!("SELECT head_commit, status FROM check_runs WHERE pull_id = {PULL_ID} ORDER BY id LIMIT 50"),
                &key(),
            )?,
            // Slot::Review (lifecycle.rs `assess_now`)
            self.statement(
                &format!(
                    "SELECT finished_at, verdict FROM review_runs
                     WHERE pull_id = {PULL_ID} AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1"
                ),
                &key(),
            )?,
            // Slot::ReviewComments: lines that latest review commented on
            // (confidence.rs `review_comments`).
            self.statement(
                &format!(
                    "SELECT count(*) AS n FROM comments
                     WHERE repo_id = ?1 AND number = ?2 AND author_id = ?3 AND path IS NOT NULL
                       AND created_at = (SELECT finished_at FROM review_runs
                         WHERE pull_id = {PULL_ID} AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1)"
                ),
                &with(AGENT_ID.into()),
            )?,
            // Slot::ReviewPending (reviews.rs `review_pending`)
            self.statement(
                &format!(
                    "SELECT id AS value FROM review_runs
                     WHERE pull_id = {PULL_ID} AND finished_at IS NULL AND created_at > ?3 LIMIT 1"
                ),
                &with(rfc3339(now_ms().saturating_sub(REVIEW_PENDING_MS)).into()),
            )?,
            // Slot::Statuses: on its head (statuses.rs `statuses`).
            self.statement(
                "SELECT context, state, description, target_url, updated_at, source FROM commit_statuses
                 WHERE repo_id = ?1 AND sha = (SELECT head_commit FROM pulls WHERE repo_id = ?1 AND number = ?2)
                 ORDER BY context",
                &key(),
            )?,
            // Slot::Settings and Slot::Hold (settings.rs `settings`)
            self.statement("SELECT * FROM repo_settings WHERE repo_id = ?1", &repo_only())?,
            self.statement("SELECT hold_low AS n FROM confidence_rules WHERE repo_id = ?1", &repo_only())?,
            // Slot::Messages (messages.rs `messages`)
            self.statement(
                &format!("SELECT * FROM agent_messages WHERE pull_id = {PULL_ID} ORDER BY created_at, id"),
                &key(),
            )?,
            // Slot::Others (reviews.rs `overlaps`)
            self.statement(
                "SELECT number, title, issue_number, files FROM pulls
                 WHERE repo_id = ?1 AND number != ?2 AND status IN ('draft', 'open')
                 ORDER BY number LIMIT 200",
                &key(),
            )?,
            // Slot::Queued (queue.rs `queued_entry`)
            self.statement(
                &format!(
                    "SELECT * FROM queue_entries
                     WHERE pull_id = {PULL_ID} AND state IN ('waiting', 'testing', 'passed') LIMIT 1"
                ),
                &key(),
            )?,
            // Slot::LatestRun, Halted, Denials, Unanswered, Planned
            // (confidence.rs `signals`)
            self.statement(
                &format!(
                    "SELECT r.id, r.cost_usd, r.budget_usd, r.time_cap_minutes,
                       (julianday(COALESCE(r.finished_at, r.updated_at)) - julianday(COALESCE(r.started_at, r.created_at))) * 1440 AS minutes,
                       c.self_level, c.uncertain_about
                     FROM agent_runs r LEFT JOIN run_confidence c ON c.run_id = r.id
                     WHERE r.pull_id = {PULL_ID} AND r.kind IN ('implement', 'revise')
                     ORDER BY r.created_at DESC LIMIT 1"
                ),
                &key(),
            )?,
            self.statement(
                &format!(
                    "SELECT halted FROM agent_runs WHERE pull_id = {PULL_ID} AND halted IS NOT NULL
                     ORDER BY created_at DESC LIMIT 1"
                ),
                &key(),
            )?,
            self.statement(
                &format!(
                    "SELECT count(*) AS n FROM session_entries
                     WHERE pull_id = {PULL_ID} AND kind = 'note' AND text LIKE 'Denied:%'"
                ),
                &key(),
            )?,
            self.statement(
                "SELECT count(*) AS n FROM agent_messages
                 WHERE repo_id = ?1 AND from_number = ?2 AND kind IN ('question', 'handoff')
                   AND answered_at IS NULL",
                &key(),
            )?,
            self.statement(
                "SELECT json_extract(planned.value, '$.files') AS files
                 FROM plans, json_each(plans.issues) AS planned
                 WHERE plans.repo_id = ?1 AND plans.status = 'applied'
                   AND json_extract(planned.value, '$.number') = (SELECT issue_number FROM pulls WHERE repo_id = ?1 AND number = ?2)
                 LIMIT 1",
                &key(),
            )?,
        ];
        let count = statements.len() as u32;
        let results = self.timing.db(count, self.db.batch(statements)).await?;
        let Some(row) = results
            .first()
            .map(|result| result.results::<IdRow>())
            .transpose()?
            .and_then(|rows| rows.into_iter().next())
        else {
            return Ok(None);
        };
        Ok(Some(Prefetched {
            pull_id: row.id,
            repo_id,
            head: row.head_commit,
            results,
        }))
    }

    /// The rows read for pull request `pull_id` in this request, if any.
    pub(crate) fn prefetched_pull(&self, pull_id: &str) -> Option<Rc<Prefetched>> {
        self.prefetched
            .borrow()
            .as_ref()
            .filter(|found| found.pull_id == pull_id)
            .cloned()
    }

    /// The rows read in this request for a pull request of `repo_id`.
    pub(crate) fn prefetched_repo(&self, repo_id: &str) -> Option<Rc<Prefetched>> {
        self.prefetched
            .borrow()
            .as_ref()
            .filter(|found| found.repo_id == repo_id)
            .cloned()
    }

    /// Keeps `found` for the rest of this request.
    pub(crate) fn keep_prefetched(&self, found: Option<Prefetched>) {
        *self.prefetched.borrow_mut() = found.map(Rc::new);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(namespace: &str, name: &str) -> RepoPath {
        RepoPath { namespace: namespace.to_owned(), name: name.to_owned() }
    }

    #[test]
    fn guesses_ignore_case_and_are_forgotten_on_refusal() {
        learn(&at("Flagon-IO", "G1T"), Some("repo_1"));
        assert_eq!(guess(&at("flagon-io", "g1t")).as_deref(), Some("repo_1"));
        learn(&at("flagon-io", "g1t"), None);
        assert_eq!(guess(&at("flagon-io", "g1t")), None);
    }
}
