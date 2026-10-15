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
use g1t_contracts::repos::{BranchDriftArgs, BranchDrifts, Commit, GetByIdArgs, Landed, LogArgs, Pushed, PushedArgs, Repo, RepoPath};
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
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

/// A session (`?1`) of a repository (`?2`).
const SESSION_IN_REPO: &str = "SELECT id AS value FROM sessions WHERE id = ?1 AND repo_id = ?2";

/// The session, still going, of the caller (`?3`, or the person it acts
/// for, `?4`) that works on issue `?2` of a repository (`?1`): attached to
/// it or tied to it since; the one seen last.
const CALLER_SESSION: &str = "SELECT id AS value FROM sessions
     WHERE repo_id = ?1 AND state = 'active' AND actor_id IN (?3, ?4)
       AND (issue = ?2 OR EXISTS (SELECT 1 FROM session_links l
         WHERE l.session_id = sessions.id AND l.kind = 'issue' AND l.number = ?2))
     ORDER BY last_seen_at DESC LIMIT 1";

/// A note of what closed an issue, and the session it was closed in.
pub(crate) fn closed_note(note: &str, session: Option<&str>) -> String {
    match session {
        Some(session) => format!("{note} via session {session}"),
        None => note.to_owned(),
    }
}

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

        // A session g1t started pushed it: what it closes is g1t's, for the pusher.
        let agent = event.data["agent"].as_str().is_some();
        if closes_issues {
            let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
            for (number, commit) in commit_closes(&pushed.commits, &path) {
                let message = pushed.commits.iter().find(|pushed| pushed.hash == commit).map(|pushed| pushed.message.as_str());
                let session = self.trailer_session(&repo.id, message.unwrap_or_default()).await?;
                self.close_by_commit(&repo, number, &commit, &actor, session.as_deref(), agent).await?;
            }
        }
        Ok(merged)
    }

    /// Closes an open issue as completed by a commit pushed to the default
    /// branch: says so on the issue, with the session it was closed in when
    /// one is known, and lets go of what waited on it. `agent` when an agent
    /// pushed it for `actor` (GitPush::agent): the note is then g1t's, for
    /// them. Whether it closed it: not when it was closed already.
    pub(crate) async fn close_by_commit(
        &self,
        repo: &Repo,
        number: u32,
        commit: &str,
        actor: &User,
        session: Option<&str>,
        agent: bool,
    ) -> Result<bool> {
        let Some(issue) = self.issue(&repo.id, number).await?.filter(|issue| issue.state == State::Open) else {
            return Ok(false);
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
            return Ok(false);
        }
        self.publish(
            "issue.closed",
            &repo.id,
            actor,
            IssueEvent {
                reason: Some(IssueReason::Completed.as_str()),
                commit: Some(commit.to_owned()),
                session: session.map(str::to_owned),
                ..Self::issue_event(&issue)
            },
        )
        .await?;
        let by = match crate::rows::By::from(actor) {
            by if agent && by.acting_for.is_none() && by.id == actor.id => crate::rows::By {
                id: g1t_contracts::identity::AGENT_ID,
                name: g1t_contracts::identity::AGENT_NAME,
                acting_for: Some((&actor.id, &actor.username)),
            },
            by => by,
        };
        self.note(&repo.id, number, by, &closed_note(&format!("closed this in {commit}"), session)).await?;
        self.issue_resolved(&repo.id, number, actor, true, None).await;
        Ok(true)
    }

    /// `close_issue` with a commit: the commit, on the default branch of
    /// `repo`, whose message names issue `number` after a closing keyword,
    /// with the session it names, if it names one of this repository's.
    /// Anything else is refused, saying why.
    pub(crate) async fn closing_commit(
        &self,
        repo: &Repo,
        number: u32,
        commit: &str,
        actor: &User,
    ) -> Result<Outcome<(String, Option<String>)>> {
        let commit = commit.trim().to_lowercase();
        if !(4..=64).contains(&commit.len()) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(Outcome::fail(FailureCode::Invalid, "commit is a commit's hash."));
        }
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let log = |at: Option<String>| LogArgs { path: path.clone(), viewer: Some(actor.clone()), git_ref: at, limit: 1 };
        let (named, tip) = (log(Some(commit.clone())), log(None));
        let (found, head) = futures_util::future::join(
            g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &named),
            g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &tip),
        )
        .await;
        let found = match found? {
            Outcome::Ok(commits) => commits.into_iter().next().filter(|found| found.hash.starts_with(&commit)),
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(found) = found else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("There is no commit {commit} in {}/{}; give its full hash.", repo.namespace, repo.name),
            ));
        };
        let short = &found.hash[..7.min(found.hash.len())];
        if !closing::references(&found.message, &path).contains(&number) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Commit {short} does not close #{number}: its message names it after no closing keyword (Fixes #{number})."),
            ));
        }
        let head = match head? {
            Outcome::Ok(commits) => commits.into_iter().next(),
            Outcome::Fail(_) => None,
        };
        let Some(head) = head else {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Commit {short} is not on {}.", repo.default_branch)));
        };
        if head.hash != found.hash {
            let drifts: Outcome<BranchDrifts> = g1t_kit::call(
                &self.repos,
                "branch_drift",
                &BranchDriftArgs { path: path.clone(), viewer: Some(actor.clone()), base: head.hash, heads: vec![found.hash.clone()] },
            )
            .await?;
            let drift = match drifts {
                Outcome::Ok(drifts) => drifts.branches.into_iter().next().and_then(|branch| branch.drift),
                Outcome::Fail(_) => None,
            };
            match drift {
                Some(drift) if drift.ahead == 0 => {}
                Some(_) => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Commit {short} is not on {}, the default branch: only a commit there closes an issue.", repo.default_branch),
                    ));
                }
                None => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Could not tell whether commit {short} is on {}: it is too far back.", repo.default_branch),
                    ));
                }
            }
        }
        let session = self.trailer_session(&repo.id, &found.message).await?;
        Ok(Outcome::Ok((found.hash, session)))
    }

    /// The session a commit message names in a `G1t-Session` trailer, when
    /// it is one of this repository's.
    pub(crate) async fn trailer_session(&self, repo_id: &str, message: &str) -> Result<Option<String>> {
        let Some(id) = session_trailers(message).into_iter().next() else { return Ok(None) };
        Ok(self
            .db
            .prepare(SESSION_IN_REPO)
            .bind(&[id.as_str().into(), repo_id.into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .map(|row| row.value))
    }

    /// The session closing an issue with a token: the caller's own session
    /// on the issue that is still going, the one seen last. A person
    /// signed in on the site closes it in none.
    pub(crate) async fn caller_session(&self, repo_id: &str, number: u32, actor: &User) -> Result<Option<String>> {
        if actor.token.is_none() && actor.acting.is_none() {
            return Ok(None);
        }
        let person = actor.acting.as_ref().map_or(actor.id.as_str(), |acting| acting.on_behalf_of.id.as_str());
        Ok(self
            .db
            .prepare(CALLER_SESSION)
            .bind(&[repo_id.into(), number.into(), actor.id.as_str().into(), person.into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .map(|row| row.value))
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

    #[test]
    fn a_close_names_the_session_it_was_made_in() {
        assert_eq!(closed_note("closed this in abc", Some("ses_1")), "closed this in abc via session ses_1");
        assert_eq!(closed_note("closed this as completed", None), "closed this as completed");
    }

    #[test]
    fn the_callers_session_on_the_issue_is_the_one_still_going_seen_last() {
        let db = database();
        let session = |id: &str, actor: &str, issue: Option<u32>, state: &str, seen: &str| {
            db.execute(
                "INSERT INTO sessions (id, repo_id, issue, actor_id, actor_name, harness, state, started_at, last_seen_at)
                 VALUES (?1, 'repo', ?2, ?3, ?3, 'claude_code', ?4, 'then', ?5)",
                params![id, issue, actor, state, seen],
            )
            .unwrap();
        };
        session("ses_old", "ana", Some(7), "active", "1");
        session("ses_new", "ana", Some(7), "active", "2");
        session("ses_ended", "ana", Some(7), "ended", "3");
        session("ses_other", "bo", Some(7), "active", "4");
        session("ses_elsewhere", "ana", Some(8), "active", "5");
        // Tied to issue 9 since it started, by a claim.
        session("ses_claimed", "ana", None, "active", "6");
        db.execute(
            "INSERT INTO session_links (session_id, repo_id, kind, number, via, at) VALUES ('ses_claimed', 'repo', 'issue', 9, 'claim', 'now')",
            [],
        )
        .unwrap();
        let caller = |number: u32, actor: &str, person: &str| -> Option<String> {
            db.query_row(CALLER_SESSION, params!["repo", number, actor, person], |row| row.get(0)).optional().unwrap()
        };
        assert_eq!(caller(7, "ana", "ana").as_deref(), Some("ses_new"));
        // g1t acting for ana: ana's session.
        assert_eq!(caller(7, "g1t", "ana").as_deref(), Some("ses_new"));
        assert_eq!(caller(9, "ana", "ana").as_deref(), Some("ses_claimed"));
        assert_eq!(caller(7, "cy", "cy"), None);
        let in_repo = |id: &str| -> Option<String> {
            db.query_row(SESSION_IN_REPO, params![id, "repo"], |row| row.get(0)).optional().unwrap()
        };
        assert_eq!(in_repo("ses_old").as_deref(), Some("ses_old"));
        assert_eq!(in_repo("ses_nowhere"), None);
    }
}
