//! A person's year, for the contribution calendar on their profile: how
//! many issues and pull requests they opened (or g1t opened for them, see
//! `requested_by`) and how many reviews they gave, day by day (UTC).
//!
//! As with `by_author` (authored.rs), only repositories the viewer may read
//! are counted: the repos service decides which (`readable`) over every
//! repository the person worked in that year, and every count here is then
//! confined to that set. A day's number never includes work in a private
//! repository the viewer could not open.

use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{ReadableArgs, Repo, MAX_READABLE};
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

/// The rows as the calendar's days and their total.
fn tally(rows: Vec<DayRow>, from: String) -> Contributions {
    let days: Vec<ContributionDay> = rows
        .into_iter()
        .filter(|row| row.n > 0 && row.day.len() == 10 && row.day.as_str() >= from.as_str())
        .map(|row| ContributionDay {
            date: row.day,
            count: row.n,
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

        let touched = self
            .db
            .prepare(TOUCHED_SQL)
            .bind(&[
                person.id.as_str().into(),
                from.as_str().into(),
                (MAX_READABLE as u32).into(),
            ])?
            .all()
            .await?
            .results::<RepoCount>()?;
        if touched.is_empty() {
            return Ok(Outcome::Ok(tally(Vec::new(), from)));
        }
        let readable: Vec<Repo> = g1t_kit::call(
            &self.repos,
            "readable",
            &ReadableArgs {
                ids: touched.into_iter().map(|row| row.repo_id).collect(),
                viewer: a.viewer,
            },
        )
        .await?;
        if readable.is_empty() {
            return Ok(Outcome::Ok(tally(Vec::new(), from)));
        }
        let ids: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
        let visible = serde_json::to_string(&ids)?;
        let rows = self
            .db
            .prepare(DAYS_SQL)
            .bind(&[person.id.as_str().into(), visible.as_str().into(), from.as_str().into()])?
            .all()
            .await?
            .results::<DayRow>()?;
        Ok(Outcome::Ok(tally(rows, from)))
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
        let year = tally(rows, "2025-10-09".into());
        assert_eq!(year.total, 5);
        assert_eq!(
            year.days,
            vec![
                ContributionDay { date: "2025-10-09".into(), count: 2 },
                ContributionDay { date: "2026-10-08".into(), count: 3 },
            ]
        );
        assert_eq!(tally(Vec::new(), "2025-10-09".into()).total, 0);
    }
}
