//! What a push to a branch settles, as a merge from the site would.
//!
//! An open pull request into the branch whose head the push brought in was
//! merged by it: it is recorded as merged by whoever pushed, through the
//! same bookkeeping as any merge (`Work::record_merge`). A push that landed
//! a pull request names it (`GitPush::landed_pull`): whoever landed it
//! records that one, and the merge queue's entry being landed is left to
//! the queue.
//!
//! A commit pushed to the default branch whose message names a work item
//! after a closing keyword (`Fixes #12`, items/refs.rs) lands it there, where
//! the repository closes work items that way, and the work item says which
//! commit and who pushed it; `Part of #12` links it.

use g1t_contracts::events::Event;
use g1t_contracts::repos::{GetByIdArgs, Landed, Pushed, PushedArgs, Repo};
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::work::*;
use g1t_contracts::{Outcome, User, Viewer};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::items::{self, Held};

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

/// A session (`?1`) of a repository (`?2`).
const SESSION_IN_REPO: &str = "SELECT id AS value FROM sessions WHERE id = ?1 AND repo_id = ?2";

/// The session, still going, of the caller (`?2`, or the person it acts
/// for, `?3`) that works on work item `?1`: attached to it or tied to it
/// since, in any repository; the one seen last.
const CALLER_SESSION: &str = "SELECT id AS value FROM sessions
     WHERE state = 'active' AND actor_id IN (?2, ?3)
       AND (item_id = ?1 OR EXISTS (SELECT 1 FROM session_links l
         WHERE l.session_id = sessions.id AND l.kind = 'item' AND l.item_id = ?1))
     ORDER BY last_seen_at DESC LIMIT 1";

/// A note of what closed a work item, and the session it was closed in.
pub(crate) fn closed_note(note: &str, session: Option<&str>) -> String {
    match session {
        Some(session) => format!("{note} via session {session}"),
        None => note.to_owned(),
    }
}

/// References, each with the commit that named it.
pub(crate) type CommitRefs = Vec<(refs::Ref, String)>;

/// The references a push's commits name after a closing keyword, and after
/// `Part of`, each with the first commit, oldest first, that names it: in
/// the order named, each once, no more than one pull request may close.
pub(crate) fn commit_refs(commits: &[g1t_contracts::repos::PushedCommit]) -> (CommitRefs, CommitRefs) {
    let mut closes: CommitRefs = Vec::new();
    let mut parts: CommitRefs = Vec::new();
    for commit in commits {
        let named = refs::named(&commit.message);
        for reference in named.closes {
            if !closes.iter().any(|(known, _)| *known == reference) {
                closes.push((reference, commit.hash.clone()));
            }
        }
        for reference in named.parts {
            if !parts.iter().any(|(known, _)| *known == reference) {
                parts.push((reference, commit.hash.clone()));
            }
        }
    }
    parts.retain(|(part, _)| !closes.iter().any(|(closed, _)| closed == part));
    closes.truncate(items::MAX_CLOSES);
    parts.truncate(items::MAX_CLOSES);
    (closes, parts)
}

impl Work {
    /// After a push moved `branch` of a repository: records the pull
    /// requests into it that the push merged, and, on the default branch,
    /// lands the work items its commits name. Returns the pull requests it
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
        let closes_items = default && self.settings(repo_id).await?.auto_close_items;
        if candidates.is_empty() && !closes_items {
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
                messages: closes_items,
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
        if closes_items {
            let (closes, parts) = commit_refs(&pushed.commits);
            for (reference, commit) in closes.iter().map(|(r, c)| (r, c)).chain(parts.iter().map(|(r, c)| (r, c))) {
                let Some(id) = items::referenced(self, &repo, reference).await? else { continue };
                let closing = closes.iter().any(|(known, _)| known == reference);
                // Only what the pusher may close, or see: anything else is a
                // reference to nothing.
                let Some(held) = items::by_id(self, &id).await? else { continue };
                if !items::admits(&held, &[&actor], closing) {
                    continue;
                }
                let message = pushed.commits.iter().find(|pushed| pushed.hash == *commit).map(|pushed| pushed.message.as_str());
                let session = self.trailer_session(&repo.id, message.unwrap_or_default()).await?;
                // The session the commit names worked on what it lands: its
                // cost counts there when no pull request carries it (signals).
                if let Some(session) = &session {
                    self.link_item(session, &repo.id, &id, LinkVia::Trailer).await;
                }
                let landing =
                    items::Landing { pull: None, commit: Some(commit.clone()), pushed_by: Some(actor.username.clone()), tie: None };
                let (closes, parts) = if closing { (vec![id], Vec::new()) } else { (Vec::new(), vec![id]) };
                items::land(self, &repo, &landing, &actor, &closes, &parts, session.as_deref(), agent).await?;
            }
        }
        Ok(merged)
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

    /// The session closing a work item with a token: the caller's own
    /// session on it that is still going, the one seen last. A person
    /// signed in on the site closes it in none.
    pub(crate) async fn caller_session(&self, held: &Held, actor: &User) -> Result<Option<String>> {
        if actor.token.is_none() && actor.acting.is_none() {
            return Ok(None);
        }
        let person = actor.acting.as_ref().map_or(actor.id.as_str(), |acting| acting.on_behalf_of.id.as_str());
        Ok(self
            .db
            .prepare(CALLER_SESSION)
            .bind(&[held.item.id.as_str().into(), actor.id.as_str().into(), person.into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .map(|row| row.value))
    }
}

#[cfg(test)]
mod tests {
    use g1t_contracts::repos::{PushedCommit, RepoPath};
    use rusqlite::{Connection, OptionalExtension, params};

    use super::*;

    /// The work database as the migrations make it.
    fn database() -> Connection {
        crate::migrated::database()
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

    fn commit(hash: &str, message: &str) -> PushedCommit {
        PushedCommit { hash: hash.into(), message: message.into() }
    }

    fn here(number: u32) -> refs::Ref {
        refs::Ref { scope: refs::RefScope::Here, number }
    }

    #[test]
    fn each_reference_is_landed_by_the_first_commit_that_names_it() {
        let commits = [
            commit("a", "Fix the header\n\nFixes #12, closes #3"),
            commit("b", "Tidy up (#12)\n\nResolves #12 and resolves acme/web#7. Part of #20"),
            commit("c", "Mention #9 without a keyword; see `fixes #10` in code"),
            commit("d", "Refs #3, part of #21"),
        ];
        let (closes, parts) = commit_refs(&commits);
        let web = refs::Ref { scope: refs::RefScope::Repo(RepoPath { namespace: "acme".into(), name: "web".into() }), number: 7 };
        assert_eq!(closes, vec![(here(12), "a".into()), (here(3), "a".into()), (web, "b".into())]);
        // What a commit closes is not also only part of it.
        assert_eq!(parts, vec![(here(20), "b".into()), (here(21), "d".into())]);
    }

    #[test]
    fn no_more_than_a_pull_request_closes() {
        let message: String = (1..=80).map(|n| format!("Fixes #{n}\n")).collect();
        assert_eq!(commit_refs(&[commit("a", &message)]).0.len(), items::MAX_CLOSES);
    }

    #[test]
    fn a_close_names_the_session_it_was_made_in() {
        assert_eq!(closed_note("closed this in abc", Some("ses_1")), "closed this in abc via session ses_1");
        assert_eq!(closed_note("closed this as completed", None), "closed this as completed");
    }

    #[test]
    fn the_callers_session_on_the_work_item_is_the_one_still_going_seen_last() {
        let db = database();
        db.execute_batch(
            "INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
               VALUES ('wki_7', 'acme', 7, 't', '', 'u', 'u', '', ''), ('wki_8', 'acme', 8, 't', '', 'u', 'u', '', ''),
                      ('wki_9', 'acme', 9, 't', '', 'u', 'u', '', '');",
        )
        .unwrap();
        let session = |id: &str, repo: &str, actor: &str, item: Option<&str>, state: &str, seen: &str| {
            db.execute(
                "INSERT INTO sessions (id, repo_id, item_id, actor_id, actor_name, harness, state, started_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, 'claude_code', ?5, 'then', ?6)",
                params![id, repo, item, actor, state, seen],
            )
            .unwrap();
        };
        session("ses_old", "repo", "ana", Some("wki_7"), "active", "1");
        // In another repository of the workspace, on the same work item.
        session("ses_new", "other", "ana", Some("wki_7"), "active", "2");
        session("ses_ended", "repo", "ana", Some("wki_7"), "ended", "3");
        session("ses_other", "repo", "bo", Some("wki_7"), "active", "4");
        session("ses_elsewhere", "repo", "ana", Some("wki_8"), "active", "5");
        // Tied to work item 9 since it started, by a claim.
        session("ses_claimed", "repo", "ana", None, "active", "6");
        db.execute(
            "INSERT INTO session_links (session_id, repo_id, kind, number, item_id, via, at)
             VALUES ('ses_claimed', 'repo', 'item', 0, 'wki_9', 'claim', 'now')",
            [],
        )
        .unwrap();
        let caller = |item: &str, actor: &str, person: &str| -> Option<String> {
            db.query_row(CALLER_SESSION, params![item, actor, person], |row| row.get(0)).optional().unwrap()
        };
        assert_eq!(caller("wki_7", "ana", "ana").as_deref(), Some("ses_new"));
        // g1t acting for ana: ana's session.
        assert_eq!(caller("wki_7", "g1t", "ana").as_deref(), Some("ses_new"));
        assert_eq!(caller("wki_9", "ana", "ana").as_deref(), Some("ses_claimed"));
        assert_eq!(caller("wki_7", "cy", "cy"), None);
        let in_repo = |id: &str| -> Option<String> {
            db.query_row(SESSION_IN_REPO, params![id, "repo"], |row| row.get(0)).optional().unwrap()
        };
        assert_eq!(in_repo("ses_old").as_deref(), Some("ses_old"));
        assert_eq!(in_repo("ses_nowhere"), None);
    }
}
