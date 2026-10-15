//! What a push to a branch settles, as a merge from the site would.
//!
//! An open pull request into the branch whose head the push brought in was
//! merged by it: it is recorded as merged by whoever pushed, through the
//! same bookkeeping as any merge (`Work::record_merge`). A push that landed
//! a pull request names it (`GitPush::landed_pull`): whoever landed it
//! records that one, and the merge queue's entry being landed is left to
//! the queue.
//!
//! A commit pushed to the default branch whose message names an issue
//! after a closing keyword (`Fixes #12`, closing.rs) closes it, where the
//! repository closes issues that way, and the issue says which commit and
//! who pushed it.

use g1t_contracts::events::{Event, IssueEvent};
use g1t_contracts::repos::{GetByIdArgs, Landed, Pushed, PushedArgs, Repo, RepoPath};
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Work, closing};

/// How many open pull requests into a branch are looked at after a push.
const MAX_CANDIDATES: u32 = 100;

/// An open pull request into the pushed branch, and the head it is at.
#[derive(Deserialize)]
struct CandidateRow {
    id: String,
    head_commit: String,
}

/// The open pull requests into a branch (`None`: the default branch) that
/// a push may have merged: those with a head, but not the one the push
/// landed, nor one the merge queue is landing.
const CANDIDATES: &str = "SELECT id, head_commit FROM pulls
     WHERE repo_id = ?1 AND status IN ('draft', 'open') AND base_branch IS ?2 AND head_commit IS NOT NULL
       AND number IS NOT ?3
       AND NOT EXISTS (SELECT 1 FROM queue_entries q
         WHERE q.pull_id = pulls.id AND q.state = 'passed' AND q.landing_commit IS NOT NULL)
     ORDER BY updated_at DESC LIMIT ?4";

/// Closes an open issue as done by a commit (`?1`), pushed by `?2`.
const CLOSE_BY_COMMIT: &str = "UPDATE issues
     SET state = 'closed', reason = 'completed', resolved_by = NULL, resolved_commit = ?1,
         resolved_pushed_by = ?2, closed_at = ?3, updated_at = ?4
     WHERE id = ?5 AND state = 'open' RETURNING id AS value";

/// The issues of a repository a commit closed.
const CLOSED_BY_COMMIT: &str = "SELECT number, title FROM issues WHERE repo_id = ?1 AND resolved_commit = ?2
     ORDER BY number LIMIT 50";

/// The issues a push's commits close, each with the first commit, oldest
/// first, that names it: in the order named, each once, no more than one
/// pull request may close.
pub(crate) fn commit_closes(commits: &[g1t_contracts::repos::PushedCommit], repo: &RepoPath) -> Vec<(u32, String)> {
    let mut closes: Vec<(u32, String)> = Vec::new();
    for commit in commits {
        for number in closing::references(&commit.message, repo) {
            if !closes.iter().any(|(named, _)| *named == number) {
                closes.push((number, commit.hash.clone()));
            }
        }
    }
    closes.truncate(closing::MAX_CLOSES);
    closes
}

impl Work {
    /// After a push moved `branch` of a repository: records the pull
    /// requests into it that the push merged, and, on the default branch,
    /// closes the issues its commits name. Returns the pull requests it
    /// recorded as merged. Never fails the push's handling: a problem is
    /// logged.
    pub(crate) async fn after_branch_push(&self, event: &Event, repo_id: &str, branch: &str, after: &str) -> Vec<String> {
        match self.settle_push(event, repo_id, branch, after).await {
            Ok(merged) => merged,
            Err(error) => {
                worker::console_error!("push to {branch} of {repo_id}: merges and closes not recorded: {error}");
                Vec::new()
            }
        }
    }

    async fn settle_push(&self, event: &Event, repo_id: &str, branch: &str, after: &str) -> Result<Vec<String>> {
        // Who pushed is who merged; a push nobody made (an import) settles nothing.
        let Some(actor_id) = event.actor.as_deref() else { return Ok(Vec::new()) };
        let default = event.data["defaultBranch"].as_bool() == Some(true);
        let landed_pull = event.data["landedPull"].as_u64().and_then(|n| u32::try_from(n).ok());
        let base = if default { JsValue::NULL } else { branch.into() };
        let candidates = self
            .db
            .prepare(CANDIDATES)
            .bind(&[repo_id.into(), base, landed_pull.map_or(JsValue::NULL, Into::into), MAX_CANDIDATES.into()])?
            .all()
            .await?
            .results::<CandidateRow>()?;
        let closes_issues = default && self.settings(repo_id).await?.auto_close_issues;
        if candidates.is_empty() && !closes_issues {
            return Ok(Vec::new());
        }
        let pushed: Pushed = g1t_kit::call(
            &self.repos,
            "pushed",
            &PushedArgs {
                repo_id: repo_id.to_owned(),
                before: event.data["before"].as_str().map(str::to_owned),
                after: after.to_owned(),
                heads: candidates.iter().map(|row| row.head_commit.clone()).collect(),
                messages: closes_issues,
                // No `before` on the default branch: the repository's first push.
                first: default && event.data["before"].as_str().is_none(),
            },
        )
        .await?;
        if pushed.landed.is_empty() && pushed.commits.is_empty() {
            return Ok(Vec::new());
        }
        let actor: Viewer =
            g1t_kit::call(&self.identity, "user_by_id", &g1t_contracts::identity::UserIdArgs { id: actor_id.to_owned() }).await?;
        let Some(actor) = actor else { return Ok(Vec::new()) };
        let repo: Outcome<Repo> =
            g1t_kit::call(&self.repos, "get_by_id", &GetByIdArgs { id: repo_id.to_owned(), viewer: Some(actor.clone()) }).await?;
        let Outcome::Ok(repo) = repo else { return Ok(Vec::new()) };

        let mut merged = Vec::new();
        for row in candidates.iter().filter(|row| pushed.landed.contains(&row.head_commit)) {
            let Some(pull) = self.pull_by_id(&row.id).await? else { continue };
            let landed = Landed {
                commit: after.to_owned(),
                previous: event.data["before"].as_str().map(str::to_owned),
                method: if row.head_commit == after { MergeMethod::FastForward } else { MergeMethod::Merge },
                rebased: Vec::new(),
            };
            let recorded = self.record_merge(&repo, pull, &actor, false, landed, Some(branch)).await?;
            if recorded.status != PullStatus::Merged {
                continue;
            }
            // Waiting in the merge queue: it has nothing left to land.
            if self.leave(repo_id, &recorded, QueueState::Removed, Some("A push merged it.")).await? {
                self.publish_as(
                    "queue.changed",
                    repo_id,
                    None,
                    g1t_contracts::events::QueueChanged { repo_id: repo_id.to_owned() },
                )
                .await?;
            }
            merged.push(recorded.id);
        }

        if closes_issues {
            let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
            for (number, commit) in commit_closes(&pushed.commits, &path) {
                self.close_by_commit(&repo, number, &commit, &actor).await?;
            }
        }
        Ok(merged)
    }

    /// Closes an open issue as completed by a commit pushed to the default
    /// branch: says so on the issue, and lets go of what waited on it.
    async fn close_by_commit(&self, repo: &Repo, number: u32, commit: &str, actor: &User) -> Result<()> {
        let Some(issue) = self.issue(&repo.id, number).await?.filter(|issue| issue.state == State::Open) else {
            return Ok(());
        };
        let now = rfc3339(now_ms());
        let closed = self
            .db
            .prepare(CLOSE_BY_COMMIT)
            .bind(&[
                commit.into(),
                actor.username.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
                issue.id.as_str().into(),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if closed.is_none() {
            return Ok(());
        }
        self.publish(
            "issue.closed",
            &repo.id,
            actor,
            IssueEvent {
                reason: Some(IssueReason::Completed.as_str()),
                commit: Some(commit.to_owned()),
                ..Self::issue_event(&issue)
            },
        )
        .await?;
        self.note(&repo.id, number, (&actor.id, &actor.username), &format!("closed this in {commit}")).await?;
        self.issue_resolved(&repo.id, number, actor, true, None).await;
        Ok(())
    }

    /// `closed_by_commit`: the issues a commit closed (`close_by_commit`),
    /// for anyone who may read the repository.
    pub(crate) async fn closed_by_commit(&self, a: ClosedByCommitArgs) -> Result<Outcome<Vec<ClosedIssue>>> {
        let Some(commit) = crate::commit_comments::valid_commit(&a.commit).filter(|commit| commit.len() >= 40) else {
            return Ok(Outcome::Ok(Vec::new()));
        };
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(
            self.db
                .prepare(CLOSED_BY_COMMIT)
                .bind(&[repo.id.as_str().into(), commit.into()])?
                .all()
                .await?
                .results::<ClosedIssue>()?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use g1t_contracts::repos::PushedCommit;
    use rusqlite::{Connection, OptionalExtension, params};

    use super::*;

    /// The work database as the migrations make it.
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut paths: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
            .collect();
        paths.sort();
        for path in paths {
            db.execute_batch(&std::fs::read_to_string(path).unwrap()).unwrap();
        }
        db
    }

    fn pull(db: &Connection, id: &str, number: u32, status: &str, base: Option<&str>, head: Option<&str>) {
        db.execute(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, status,
               base_branch, head_commit, created_at, updated_at)
             VALUES (?1, 'repo', ?2, 'Change', 'codex', 'external', 'user', 'user', ?3, ?4, ?5, 'now', 'now')",
            params![id, number, status, base, head],
        )
        .unwrap();
    }

    fn candidates(db: &Connection, base: Option<&str>, landed: Option<u32>) -> Vec<String> {
        let mut statement = db.prepare(CANDIDATES).unwrap();
        let mut ids: Vec<String> = statement
            .query_map(params!["repo", base, landed, MAX_CANDIDATES], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        ids.sort();
        ids
    }

    #[test]
    fn the_open_pull_requests_into_the_branch_are_looked_at() {
        let db = database();
        pull(&db, "open", 1, "open", None, Some("h1"));
        pull(&db, "draft", 2, "draft", None, Some("h2"));
        pull(&db, "closed", 3, "closed", None, Some("h3"));
        pull(&db, "merged", 4, "merged", None, Some("h4"));
        pull(&db, "empty", 5, "open", None, None);
        pull(&db, "release", 6, "open", Some("release"), Some("h6"));
        assert_eq!(candidates(&db, None, None), vec!["draft", "open"]);
        assert_eq!(candidates(&db, Some("release"), None), vec!["release"]);
        // The pull request the push landed is recorded by whoever landed it.
        assert_eq!(candidates(&db, None, Some(1)), vec!["draft"]);
    }

    #[test]
    fn the_entry_the_merge_queue_is_landing_is_left_to_it() {
        let db = database();
        pull(&db, "landing", 1, "open", None, Some("h1"));
        pull(&db, "waiting", 2, "open", None, Some("h2"));
        db.execute_batch(
            "INSERT INTO queue_entries (id, state, repo_id, pull_id, number, enqueued_by, created_at, landing_commit)
               VALUES ('e1', 'passed', 'repo', 'landing', 1, '{}', 'now', 'c1');
             INSERT INTO queue_entries (id, state, repo_id, pull_id, number, enqueued_by, created_at)
               VALUES ('e2', 'waiting', 'repo', 'waiting', 2, '{}', 'now');",
        )
        .unwrap();
        assert_eq!(candidates(&db, None, None), vec!["waiting"]);
    }

    #[test]
    fn a_commit_closes_an_open_issue_once_and_says_which() {
        let db = database();
        db.execute_batch(
            "INSERT INTO issues (id, repo_id, number, title, body, labels, state, author_id, author_name, created_at, updated_at)
               VALUES ('iss', 'repo', 7, 'Broken header', '', '[]', 'open', 'user', 'user', 'now', 'now');",
        )
        .unwrap();
        let close = |commit: &str| {
            db.query_row(CLOSE_BY_COMMIT, params![commit, "ana", "later", "later", "iss"], |row| row.get::<_, String>(0))
                .optional()
                .unwrap()
        };
        assert_eq!(close("c1").as_deref(), Some("iss"));
        // Already closed: a later commit naming it changes nothing.
        assert_eq!(close("c2"), None);
        let (state, commit, by, resolved_by): (String, String, String, Option<u32>) = db
            .query_row("SELECT state, resolved_commit, resolved_pushed_by, resolved_by FROM issues WHERE id = 'iss'", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap();
        assert_eq!((state.as_str(), commit.as_str(), by.as_str(), resolved_by), ("closed", "c1", "ana", None));
        let closed: Vec<(u32, String)> = db
            .prepare(CLOSED_BY_COMMIT)
            .unwrap()
            .query_map(params!["repo", "c1"], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(closed, vec![(7, "Broken header".to_owned())]);
    }

    fn commit(hash: &str, message: &str) -> PushedCommit {
        PushedCommit { hash: hash.into(), message: message.into() }
    }

    #[test]
    fn each_issue_is_closed_by_the_first_commit_that_names_it() {
        let repo = RepoPath { namespace: "acme".into(), name: "web".into() };
        let commits = [
            commit("a", "Fix the header\n\nFixes #12, closes #3"),
            commit("b", "Tidy up (#12)\n\nResolves #12 and resolves acme/web#7"),
            commit("c", "Mention #9 without a keyword; see `fixes #10` in code"),
            commit("d", "Closes other/repo#4"),
        ];
        assert_eq!(commit_closes(&commits, &repo), vec![(12, "a".into()), (3, "a".into()), (7, "b".into())]);
    }

    #[test]
    fn no_more_than_a_pull_request_closes() {
        let repo = RepoPath { namespace: "acme".into(), name: "web".into() };
        let message: String = (1..=80).map(|n| format!("Fixes #{n}\n")).collect();
        assert_eq!(commit_closes(&[commit("a", &message)], &repo).len(), closing::MAX_CLOSES);
    }
}
