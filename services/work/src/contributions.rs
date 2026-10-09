//! A person's year, for the contribution calendar on their profile: how
//! many commits they pushed to a default branch (or `gh-pages`), issues and
//! pull requests they opened (or g1t opened for them, see `requested_by`)
//! and reviews they gave, day by day (UTC).
//!
//! Commits are the repos service's: it credits whoever pushed, as each
//! push lands (`commit_days`, services/repos/src/push_commits.rs), and
//! counts only repositories the viewer may read, by the same `readable`.
//!
//! As with `by_author` (authored.rs), only repositories the viewer may read
//! are counted: the repos service decides which (`readable`) over every
//! repository the person worked in that year, and every count here is then
//! confined to that set. A day's number never includes work in a private
//! repository the viewer could not open.

use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{CommitDaysArgs, ReadableArgs, Repo, MAX_READABLE};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// Every repository the person did something in since `?2`, busiest first.
const TOUCHED_SQL: &str = "SELECT repo_id, count(*) AS n FROM (
   SELECT repo_id FROM issues WHERE COALESCE(requested_by_id, author_id) = ?1 AND created_at >= ?2
   UNION ALL SELECT repo_id FROM pulls WHERE COALESCE(requested_by_id, author_id) = ?1 AND created_at >= ?2
   UNION ALL SELECT repo_id FROM comments WHERE author_id = ?1 AND created_at >= ?2 AND verdict IS NOT NULL
 ) GROUP BY repo_id ORDER BY n DESC LIMIT ?3";

/// What they did each day since `?3`, in the repositories `?2` (a JSON
/// array of ids) only.
const DAYS_SQL: &str = "SELECT day, count(*) AS n FROM (
   SELECT substr(created_at, 1, 10) AS day FROM issues
   WHERE COALESCE(requested_by_id, author_id) = ?1 AND created_at >= ?3
     AND repo_id IN (SELECT value FROM json_each(?2))
   UNION ALL
   SELECT substr(created_at, 1, 10) AS day FROM pulls
   WHERE COALESCE(requested_by_id, author_id) = ?1 AND created_at >= ?3
     AND repo_id IN (SELECT value FROM json_each(?2))
   UNION ALL
   SELECT substr(created_at, 1, 10) AS day FROM comments
   WHERE author_id = ?1 AND created_at >= ?3 AND verdict IS NOT NULL
     AND repo_id IN (SELECT value FROM json_each(?2))
 ) GROUP BY day ORDER BY day";

#[derive(Deserialize)]
struct RepoCount {
    repo_id: String,
}

#[derive(Deserialize)]
struct DayRow {
    day: String,
    n: u32,
}

/// The first day counted, `YYYY-MM-DD`, when it is `now_ms`: today and the
/// days before it, [`CONTRIBUTION_DAYS`] in all.
fn first_day(now_ms: u64) -> String {
    let back = (CONTRIBUTION_DAYS - 1) * 86_400_000;
    rfc3339(now_ms.saturating_sub(back))[..10].to_owned()
}

/// The rows and the days' commits as the calendar's days and their total.
fn tally(rows: Vec<DayRow>, commits: Vec<ContributionDay>, from: String) -> Contributions {
    let mut by_day = std::collections::BTreeMap::<String, (u32, u32)>::new();
    for row in rows {
        by_day.entry(row.day).or_default().0 += row.n;
    }
    for day in commits {
        by_day.entry(day.date).or_default().1 += day.commits;
    }
    let days: Vec<ContributionDay> = by_day
        .into_iter()
        .filter(|(day, (work, commits))| work + commits > 0 && day.len() == 10 && day.as_str() >= from.as_str())
        .map(|(date, (work, commits))| ContributionDay {
            date,
            count: work + commits,
            commits,
        })
        .collect();
    let total = days.iter().map(|day| day.count).sum();
    Contributions { days, total, from }
}

impl Work {
    pub(crate) async fn contributions(&self, a: ContributionsArgs) -> Result<Outcome<Contributions>> {
        let person: Viewer = g1t_kit::call(
            &self.identity,
            "user_by_username",
            &UsernameArgs {
                username: a.username.trim().to_lowercase(),
            },
        )
        .await?;
        let Some(person) = person else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no such account."));
        };
        let from = first_day(now_ms());
        // Commits come from the repos service, asked at once; a calendar
        // without them is better than none.
        let (commits, rows) = futures_util::future::join(
            g1t_kit::call::<_, Vec<ContributionDay>>(
                &self.repos,
                "commit_days",
                &CommitDaysArgs {
                    user_id: person.id.clone(),
                    since: from.clone(),
                    viewer: a.viewer.clone(),
                },
            ),
            self.work_days(&person.id, &from, a.viewer),
        )
        .await;
        let commits = commits.unwrap_or_else(|error| {
            worker::console_error!("commit_days for {} failed: {error}", person.username);
            Vec::new()
        });
        Ok(Outcome::Ok(tally(rows?, commits, from)))
    }

    /// Issues, pull requests and reviews a day, in repositories the viewer may read.
    async fn work_days(&self, person: &str, from: &str, viewer: Viewer) -> Result<Vec<DayRow>> {
        let touched = self
            .db
            .prepare(TOUCHED_SQL)
            .bind(&[person.into(), from.into(), (MAX_READABLE as u32).into()])?
            .all()
            .await?
            .results::<RepoCount>()?;
        if touched.is_empty() {
            return Ok(Vec::new());
        }
        let readable: Vec<Repo> = g1t_kit::call(
            &self.repos,
            "readable",
            &ReadableArgs {
                ids: touched.into_iter().map(|row| row.repo_id).collect(),
                viewer,
            },
        )
        .await?;
        if readable.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
        let visible = serde_json::to_string(&ids)?;
        self.db
            .prepare(DAYS_SQL)
            .bind(&[person.into(), visible.as_str().into(), from.into()])?
            .all()
            .await?
            .results::<DayRow>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_count_is_confined_to_the_readable_set() {
        // One `json_each(?2)` per kind of work: nothing is counted outside it.
        assert_eq!(DAYS_SQL.matches("json_each(?2)").count(), 3);
        assert_eq!(DAYS_SQL.matches("created_at >= ?3").count(), 3);
        // Reviews are comments with a verdict; plain comments are not counted.
        assert_eq!(DAYS_SQL.matches("verdict IS NOT NULL").count(), 1);
        assert_eq!(TOUCHED_SQL.matches("created_at >= ?2").count(), 3);
    }

    #[test]
    fn the_year_is_today_and_the_364_days_before() {
        // 2026-10-08T12:00:00Z.
        let now = 1_791_460_800_000;
        assert_eq!(&rfc3339(now)[..10], "2026-10-08");
        assert_eq!(first_day(now), "2025-10-09");
        assert_eq!(first_day(0), "1970-01-01");
    }

    #[test]
    fn tallies_days_and_drops_the_empty_and_the_early() {
        let rows = vec![
            DayRow { day: "2025-10-08".into(), n: 4 },
            DayRow { day: "2025-10-09".into(), n: 2 },
            DayRow { day: "2026-01-01".into(), n: 0 },
            DayRow { day: "2026-10-08".into(), n: 3 },
        ];
        let year = tally(rows, Vec::new(), "2025-10-09".into());
        assert_eq!(year.total, 5);
        assert_eq!(
            year.days,
            vec![
                ContributionDay { date: "2025-10-09".into(), count: 2, commits: 0 },
                ContributionDay { date: "2026-10-08".into(), count: 3, commits: 0 },
            ]
        );
        assert_eq!(tally(Vec::new(), Vec::new(), "2025-10-09".into()).total, 0);
    }

    #[test]
    fn commits_join_the_days_they_were_pushed() {
        let rows = vec![DayRow { day: "2026-10-01".into(), n: 2 }];
        let commits = vec![
            ContributionDay { date: "2026-10-01".into(), count: 3, commits: 3 },
            ContributionDay { date: "2026-10-02".into(), count: 1, commits: 1 },
            ContributionDay { date: "2025-01-01".into(), count: 9, commits: 9 },
        ];
        let year = tally(rows, commits, "2025-10-09".into());
        assert_eq!(year.total, 6);
        assert_eq!(
            year.days,
            vec![
                ContributionDay { date: "2026-10-01".into(), count: 5, commits: 3 },
                ContributionDay { date: "2026-10-02".into(), count: 1, commits: 1 },
            ]
        );
    }
}
