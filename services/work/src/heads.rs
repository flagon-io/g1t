//! A push moving the pull requests it concerns, however many times its
//! event is handled, and the sweep that finds the pushes whose event never
//! was.
//!
//! The queue hands `git.push` to this service until handling it succeeds,
//! and then gives up (the dead-letter queue). Moving the heads is the first
//! step: when a later one fails, the retry must find the same pull
//! requests, or their checks never start. `head_event` names the push that
//! last moved each, so the same event moves it again.
//!
//! When every retry failed, the pull request's branch is ahead of its head
//! and nothing says so. Every few minutes the cron compares a few open pull
//! requests' branches with their heads, least recently compared first, and
//! a branch that moved is handled as its push would have been: the push's
//! own event, from the log, so who pushed it still counts for rules about
//! the most recent push.

use g1t_contracts::events::{Event, ListArgs};
use g1t_contracts::repos::HeadArgs;
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// What moving a pull request's head sets: `?1` the commit, `?2` now, `?3`
/// who pushed, `?4` the push's event and `?5` when it was pushed (the
/// event's time). Whatever the checks said no longer applies, and whatever
/// step g1t was waiting on has been taken.
pub(crate) const MOVE: &str = "UPDATE pulls
     SET head_commit = ?1, updated_at = ?2, head_pushed_by = ?3, head_pushed_at = ?5, head_event = ?4,
         check_status = NULL, check_run_id = NULL, working_on = NULL, working_until = NULL, stalled = NULL";

/// The pull requests a push moves: open, not at its commit yet or moved by
/// this same event before, and not moved since by a later push (an earlier
/// one retried, or handled late, must not take the head back).
pub(crate) const ACTIVE: &str = "status IN ('draft', 'open') AND (head_commit IS NOT ?1 OR head_event = ?4)
     AND (head_pushed_at IS NULL OR head_pushed_at <= ?5)";

/// The open pull requests compared least recently, `?2` of them, marked
/// compared at `?1`.
pub(crate) const DUE: &str = "UPDATE pulls SET head_swept_at = ?1
     WHERE id IN (SELECT id FROM pulls WHERE status IN ('draft', 'open') ORDER BY head_swept_at LIMIT ?2)
     RETURNING id, repo_id, number, head_repo_id, fork_repo_id, source_branch, head_commit";

/// How many pull requests each cron compares: each is a read of its
/// branch, and of the log when it moved. Every five minutes, 240 an hour.
const SWEEP: u32 = 20;

/// A push this recent may still be on its way through the queue: the sweep
/// leaves it to arrive.
const GRACE_MS: u64 = 5 * 60 * 1000;

/// How many of the source repository's latest pushes are looked through
/// for the one that moved the branch.
const PUSHES: u32 = 50;

#[derive(Deserialize)]
pub(crate) struct DueRow {
    pub id: String,
    pub repo_id: String,
    pub number: u32,
    pub head_repo_id: Option<String>,
    pub fork_repo_id: Option<String>,
    pub source_branch: Option<String>,
    pub head_commit: Option<String>,
}

impl DueRow {
    /// Where its change is: the repository and branch (empty for a working
    /// copy's default branch) a push to which moves it. None for one with
    /// no branch to compare.
    fn source(&self) -> Option<(&str, &str)> {
        match (&self.fork_repo_id, &self.head_repo_id, &self.source_branch) {
            (Some(fork), _, _) => Some((fork, "")),
            (None, Some(head), Some(branch)) => Some((head, branch)),
            (None, None, Some(branch)) => Some((&self.repo_id, branch)),
            _ => None,
        }
    }
}

/// Whether `event` is the push that put `branch` (empty: the default
/// branch) at `commit`.
pub(crate) fn pushed_to(event: &Event, branch: &str, commit: &str) -> bool {
    event.kind == "git.push"
        && event.data["after"].as_str() == Some(commit)
        && if branch.is_empty() {
            event.data["defaultBranch"].as_bool() == Some(true)
        } else {
            event.data["ref"].as_str().and_then(|name| name.strip_prefix("refs/heads/")) == Some(branch)
        }
}

impl Work {
    /// Compares a few open pull requests' branches with their heads, and
    /// handles the push of each that moved without its event arriving.
    pub(crate) async fn sweep_heads(&self) -> Result<()> {
        let now = now_ms();
        let due = self.db.prepare(DUE).bind(&[rfc3339(now).into(), SWEEP.into()])?.all().await?.results::<DueRow>()?;
        for pull in due {
            if let Err(error) = self.sweep_head(&pull, now).await {
                worker::console_error!("work: comparing pull request {} with its branch: {error}", pull.id);
            }
        }
        Ok(())
    }

    async fn sweep_head(&self, pull: &DueRow, now: u64) -> Result<()> {
        let Some((source, branch)) = pull.source() else { return Ok(()) };
        let head: Option<String> =
            g1t_kit::call(&self.repos, "head", &HeadArgs { repo_id: source.to_owned(), branch: branch.to_owned() }).await?;
        // A branch deleted is not a push to follow.
        let Some(head) = head.filter(|head| pull.head_commit.as_deref() != Some(head.as_str())) else {
            return Ok(());
        };
        let pushes: Vec<Event> = g1t_kit::call(
            &self.events,
            "list",
            &ListArgs { repo_id: Some(source.to_owned()), types: vec!["git.push".to_owned()], limit: Some(PUSHES), ..ListArgs::default() },
        )
        .await?;
        let Some(push) = pushes.into_iter().find(|event| pushed_to(event, branch, &head)) else {
            // Moved by something the log never heard of: nobody to say
            // pushed it, so it is left for a person to look at.
            worker::console_error!(
                "work: pull request {} ({}#{}) is at {:?} but its branch is at {head}, and no push to it is in the log",
                pull.id,
                pull.repo_id,
                pull.number,
                pull.head_commit
            );
            return Ok(());
        };
        let pushed_at = parse_rfc3339(&push.time).unwrap_or(0);
        if now.saturating_sub(pushed_at) < GRACE_MS {
            return Ok(());
        }
        worker::console_warn!(
            "work: pull request {} ({}#{}) missed push {} to {head}; handling it now",
            pull.id,
            pull.repo_id,
            pull.number,
            push.id
        );
        self.on_event(&push).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrated::database;
    use rusqlite::Connection;
    use serde_json::json;

    fn pull(db: &Connection, id: &str, number: u32, status: &str, head: &str) {
        db.execute(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, status, author_id, author_name,
                                created_at, updated_at, source_branch, head_commit)
             VALUES (?1, 'rep_1', ?2, 'Change', 'ana', 'external', ?3, 'usr_1', 'ana', '', '', 'fix', ?4)",
            rusqlite::params![id, number, status, head],
        )
        .unwrap();
    }

    /// Moves the pull requests on branch `fix` of `rep_1` to `after`, as
    /// `on_event` does for push `event` made at `at`, and returns the ids it
    /// moved.
    fn push(db: &Connection, after: &str, event: &str, at: &str) -> Vec<String> {
        let sql = format!("{MOVE} WHERE {} AND {ACTIVE} RETURNING id", crate::head_repo::ON_BRANCH);
        let mut statement = db.prepare(&sql).unwrap();
        statement
            .query_map(rusqlite::params![after, "now", "usr_2", event, at, "rep_1", "rep_1", "fix"], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn the_same_push_handled_again_moves_the_same_pull_requests() {
        let db = database();
        pull(&db, "pul_open", 1, "open", "aaa");
        pull(&db, "pul_draft", 2, "draft", "aaa");
        pull(&db, "pul_merged", 3, "merged", "aaa");
        let (t1, t2, t3) = ("2026-10-22T22:23:54.000Z", "2026-10-22T22:30:00.000Z", "2026-10-22T22:36:00.000Z");
        assert_eq!(push(&db, "bbb", "evt_1", t1), ["pul_open", "pul_draft"]);
        // Retried after a later step failed: the same two again.
        assert_eq!(push(&db, "bbb", "evt_1", t1), ["pul_open", "pul_draft"]);
        // Another event at the same commit (a branch pushed twice) moves nothing.
        assert!(push(&db, "bbb", "evt_2", t2).is_empty());
        // The next push moves them on, and the first, retried late, does not take them back.
        assert_eq!(push(&db, "ccc", "evt_3", t3), ["pul_open", "pul_draft"]);
        assert!(push(&db, "bbb", "evt_1", t1).is_empty());
        let pushed: (String, String, String) = db
            .query_row("SELECT head_commit, head_pushed_by, head_pushed_at FROM pulls WHERE id = 'pul_draft'", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(pushed, ("ccc".to_owned(), "usr_2".to_owned(), t3.to_owned()));
    }

    #[test]
    fn the_sweep_takes_open_pull_requests_least_recently_compared_first() {
        let db = database();
        for (id, number, status) in [("pul_a", 1, "open"), ("pul_b", 2, "draft"), ("pul_c", 3, "open"), ("pul_d", 4, "closed")] {
            pull(&db, id, number, status, "aaa");
        }
        db.execute("UPDATE pulls SET head_swept_at = '2026-10-22T00:00:00Z' WHERE id = 'pul_a'", []).unwrap();
        let due = |at: &str, n: u32| -> Vec<String> {
            let mut statement = db.prepare(DUE).unwrap();
            let mut ids: Vec<String> =
                statement.query_map(rusqlite::params![at, n], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
            ids.sort();
            ids
        };
        // Never compared before the one that was; never one that is closed.
        assert_eq!(due("2026-10-22T01:00:00Z", 2), ["pul_b", "pul_c"]);
        assert_eq!(due("2026-10-22T02:00:00Z", 2), ["pul_a", "pul_b"]);
        assert_eq!(due("2026-10-22T03:00:00Z", 5), ["pul_a", "pul_b", "pul_c"]);
    }

    fn event(data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: "git.push".into(),
            source: "repos".into(),
            time: "2026-10-22T22:36:00Z".into(),
            repo_id: Some("rep_1".into()),
            actor: Some("usr_1".into()),
            data,
        }
    }

    #[test]
    fn the_push_that_moved_a_branch_is_found_by_its_ref_and_commit() {
        let to_fix = event(json!({ "ref": "refs/heads/fix", "after": "bbb", "defaultBranch": false }));
        assert!(pushed_to(&to_fix, "fix", "bbb"));
        assert!(!pushed_to(&to_fix, "fix", "ccc"));
        assert!(!pushed_to(&to_fix, "fixes", "bbb"));
        assert!(!pushed_to(&to_fix, "", "bbb"));
        let to_default = event(json!({ "ref": "refs/heads/main", "after": "bbb", "defaultBranch": true }));
        assert!(pushed_to(&to_default, "", "bbb"));
    }

    #[test]
    fn each_kind_of_pull_request_is_compared_with_its_own_branch() {
        let row = |head_repo: Option<&str>, fork: Option<&str>, branch: Option<&str>| DueRow {
            id: "pul_1".into(),
            repo_id: "rep_1".into(),
            number: 1,
            head_repo_id: head_repo.map(Into::into),
            fork_repo_id: fork.map(Into::into),
            source_branch: branch.map(Into::into),
            head_commit: None,
        };
        assert_eq!(row(None, None, Some("fix")).source(), Some(("rep_1", "fix")));
        assert_eq!(row(Some("rep_fork"), None, Some("fix")).source(), Some(("rep_fork", "fix")));
        assert_eq!(row(None, Some("rep_copy"), Some("fix")).source(), Some(("rep_copy", "")));
        assert_eq!(row(None, None, None).source(), None);
    }
}
