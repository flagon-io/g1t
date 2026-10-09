//! Commits people push, for the contribution calendar on their profile.
//!
//! When a push lands on a repository's default branch (or `gh-pages`, which
//! publishes a site), the person who pushed is credited, for that UTC day,
//! with the push and the new commits it brought: the commits along the
//! branch's first-parent line from where it is now back to where it was,
//! at most [`MOST_PER_PUSH`]. A merge commit counts once, not the commits
//! it merged. A branch's first push counts one commit, so importing a long
//! history does not fill one day. Other branches count when they are
//! merged, which is a pull request.
//!
//! Only people are credited: pushes with an agent's, a workspace's or a
//! workflow job's token are not counted. The rows are in `push_commits`
//! (migrations/0017); `commit_days` reads them for work's `contributions`,
//! only for repositories the viewer may read (`Registry::readable`).

use g1t_contracts::Viewer;
use g1t_contracts::repos::Commit;
use g1t_contracts::work::ContributionDay;
use serde::Deserialize;
use worker::{D1Database, Result};

use crate::registry::Registry;

/// The most commits one push is credited with.
pub const MOST_PER_PUSH: u32 = 50;

/// Whether a push to `branch` counts on the calendar.
pub fn counts(branch: &str, default_branch: &str) -> bool {
    branch == default_branch || branch == "gh-pages"
}

/// How many new commits a push brought, from the branch's log after it
/// (newest first, first parents, at most `MOST_PER_PUSH + 1`) and where the
/// branch was before. A new branch is one; a log that ends without reaching
/// `before` (history rewritten onto an unrelated line) is one; one that
/// runs past the cap is the cap.
pub fn new_commits(log: &[Commit], before: Option<&str>) -> u32 {
    let Some(before) = before.filter(|before| !before.is_empty() && !before.bytes().all(|b| b == b'0')) else {
        return u32::from(!log.is_empty());
    };
    match log.iter().position(|commit| commit.hash == before) {
        Some(at) => (at as u32).min(MOST_PER_PUSH),
        None if log.len() as u32 > MOST_PER_PUSH => MOST_PER_PUSH,
        None => u32::from(!log.is_empty()),
    }
}

/// Credits `user_id` with one push of `commits` commits to `repo_id` on `day`.
pub async fn record(db: &D1Database, user_id: &str, repo_id: &str, day: &str, commits: u32) -> Result<()> {
    db.prepare(
        "INSERT INTO push_commits (user_id, repo_id, day, pushes, commits) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT (user_id, day, repo_id) DO UPDATE SET
           pushes = push_commits.pushes + 1, commits = push_commits.commits + excluded.commits",
    )
    .bind(&[user_id.into(), repo_id.into(), day.into(), commits.into()])?
    .run()
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct RepoRow {
    repo_id: String,
}

#[derive(Deserialize)]
struct DayRow {
    day: String,
    commits: u32,
}

/// What `commit_days` answers: a person's commits each day since `since`,
/// in the repositories the viewer may read.
pub async fn days(registry: &Registry, user_id: &str, since: &str, viewer: &Viewer) -> Result<Vec<ContributionDay>> {
    let pushed = registry
        .db
        .prepare(
            "SELECT repo_id FROM push_commits WHERE user_id = ?1 AND day >= ?2
             GROUP BY repo_id ORDER BY SUM(commits) DESC LIMIT ?3",
        )
        .bind(&[user_id.into(), since.into(), (g1t_contracts::repos::MAX_READABLE as u32).into()])?
        .all()
        .await?
        .results::<RepoRow>()?;
    if pushed.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = pushed.into_iter().map(|row| row.repo_id).collect();
    let readable = registry.readable(&ids, viewer).await?;
    if readable.is_empty() {
        return Ok(Vec::new());
    }
    let visible: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
    let rows = registry
        .db
        .prepare(DAYS_SQL)
        .bind(&[user_id.into(), since.into(), serde_json::to_string(&visible)?.into()])?
        .all()
        .await?
        .results::<DayRow>()?;
    Ok(rows
        .into_iter()
        .filter(|row| row.commits > 0)
        .map(|row| ContributionDay { date: row.day, count: row.commits, commits: row.commits })
        .collect())
}

/// Commits a day, in the repositories `?3` (a JSON array of ids) only.
const DAYS_SQL: &str = "SELECT day, SUM(commits) AS commits FROM push_commits
   WHERE user_id = ?1 AND day >= ?2 AND repo_id IN (SELECT value FROM json_each(?3))
   GROUP BY day ORDER BY day";

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::Signature;

    fn log(hashes: &[&str]) -> Vec<Commit> {
        hashes
            .iter()
            .map(|hash| Commit {
                hash: (*hash).to_owned(),
                tree_hash: String::new(),
                message: String::new(),
                author: Signature { name: String::new(), email: String::new() },
                parents: Vec::new(),
                authored_at: String::new(),
            })
            .collect()
    }

    #[test]
    fn the_default_branch_and_gh_pages_count() {
        assert!(counts("main", "main"));
        assert!(counts("gh-pages", "main"));
        assert!(!counts("feature", "main"));
    }

    #[test]
    fn a_push_brings_the_commits_after_where_the_branch_was() {
        assert_eq!(new_commits(&log(&["c", "b", "a"]), Some("a")), 2);
        assert_eq!(new_commits(&log(&["c", "b", "a"]), Some("c")), 0);
    }

    #[test]
    fn a_new_branch_or_a_rewrite_is_one() {
        assert_eq!(new_commits(&log(&["c", "b", "a"]), None), 1);
        assert_eq!(new_commits(&log(&["c", "b", "a"]), Some(&"0".repeat(40))), 1);
        assert_eq!(new_commits(&log(&["z", "y"]), Some("a")), 1);
        assert_eq!(new_commits(&[], Some("a")), 0);
    }

    #[test]
    fn a_push_is_credited_with_the_cap_at_most() {
        let hashes: Vec<String> = (0..=MOST_PER_PUSH).map(|n| format!("h{n}")).collect();
        let long = log(&hashes.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(new_commits(&long, Some("old")), MOST_PER_PUSH);
        assert_eq!(new_commits(&long, Some(&format!("h{MOST_PER_PUSH}"))), MOST_PER_PUSH);
    }

    #[test]
    fn days_are_confined_to_the_readable_set() {
        assert_eq!(DAYS_SQL.matches("json_each(?3)").count(), 1);
        assert!(DAYS_SQL.contains("user_id = ?1 AND day >= ?2"));
    }
}
