//! Full-history aggregates, restricted to repositories the viewer can read.
use std::collections::BTreeMap;

use futures_util::StreamExt;
use g1t_contracts::actions::RunDetail;
use g1t_contracts::checks::{ActionsChecksArgs, job_statuses};
use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::work::{DeliveryDay, DeliveryInsights, DeliveryInsightsArgs, DeliveryMetrics};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;

/// Heads asked of the actions service at once: well under its 100 commits
/// and 200 runs a call, so no head's latest runs are cut off.
const HEADS_PER_CALL: usize = 20;

/// One open pull request's head and one status stored on it (none when it
/// has none).
#[derive(Deserialize)]
struct HeadRow {
    id: String,
    repo_id: String,
    sha: String,
    state: Option<String>,
}

impl Work {
    pub(crate) async fn delivery_insights(&self, a: DeliveryInsightsArgs) -> Result<DeliveryInsights> {
        // The web loader batches larger workspaces instead of silently truncating them.
        if a.repo_ids.len() > 100 || !valid_day(&a.from) || !valid_day(&a.until) || a.from > a.until {
            return Err(worker::Error::RustError("Invalid insights range or repository batch".into()));
        }
        let readable: Vec<Repo> = g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids: a.repo_ids, viewer: a.viewer }).await?;
        let ids: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
        if ids.is_empty() {
            return Ok(DeliveryInsights { projects: Vec::new(), days: Vec::new(), checks_unavailable: false });
        }
        let binds: [JsValue; 3] =
            [serde_json::to_string(&ids)?.into(), format!("{}T00:00:00", a.from).into(), format!("{}T24:00:00", a.until).into()];
        let projects = self.db.prepare(include_str!("insights.sql")).bind(&binds)?.all().await?.results::<DeliveryMetrics>()?;
        let days = self
            .db
            .prepare(
                "SELECT substr(merged_at, 1, 10) AS day, COUNT(*) AS merged FROM pulls
            WHERE repo_id IN (SELECT value FROM json_each(?1)) AND status = 'merged'
              AND merged_at >= ?2 AND merged_at < ?3 GROUP BY day ORDER BY day",
            )
            .bind(&binds)?
            .all()
            .await?
            .results::<DeliveryDay>()?;
        let (checks, checks_unavailable) = self.head_checks(&binds[0]).await?;
        // Include readable repositories with no pulls, but never inaccessible ones.
        let projects = ids
            .into_iter()
            .map(|id| {
                let mut row = projects
                    .iter()
                    .find(|row| row.repo_id == id)
                    .cloned()
                    .unwrap_or_else(|| DeliveryMetrics { repo_id: id.into(), ..Default::default() });
                (row.checking, row.failed) = checks.get(id).copied().unwrap_or_default();
                row
            })
            .collect();
        Ok(DeliveryInsights { projects, days, checks_unavailable })
    }

    /// Per repository, how many open pull requests have checks still going
    /// on their head and how many have one that failed, each counted once,
    /// as their pages add them up: the statuses and check runs stored here
    /// with the latest g1t Actions jobs. Beside it, whether g1t Actions
    /// could not be read for some of them.
    async fn head_checks(&self, ids: &JsValue) -> Result<(BTreeMap<String, (u32, u32)>, bool)> {
        let rows = self
            .db
            .prepare(
                "SELECT p.id, p.repo_id, p.head_commit AS sha, s.state FROM pulls p
                 LEFT JOIN commit_statuses s ON s.repo_id = p.repo_id AND s.sha = p.head_commit
                 WHERE p.repo_id IN (SELECT value FROM json_each(?1))
                   AND p.status IN ('draft', 'open') AND p.head_commit IS NOT NULL",
            )
            .bind(std::slice::from_ref(ids))?
            .all()
            .await?
            .results::<HeadRow>()?;
        // Each pull request's repository, head and stored states.
        let mut pulls: BTreeMap<String, (String, String, Vec<String>)> = BTreeMap::new();
        for row in rows {
            let pull = pulls.entry(row.id).or_insert_with(|| (row.repo_id, row.sha, Vec::new()));
            pull.2.extend(row.state);
        }
        let mut heads: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for (repo_id, sha, _) in pulls.values() {
            let shas = heads.entry(repo_id.as_str()).or_default();
            if !shas.contains(sha) {
                shas.push(sha.clone());
            }
        }
        let calls: Vec<ActionsChecksArgs> = heads
            .iter()
            .flat_map(|(repo_id, shas)| {
                shas.chunks(HEADS_PER_CALL).map(|chunk| ActionsChecksArgs {
                    repo_id: (*repo_id).to_owned(),
                    shas: chunk.to_vec(),
                    ..Default::default()
                })
            })
            .collect();
        let answers: Vec<(String, Result<Vec<RunDetail>>)> = futures_util::stream::iter(calls)
            .map(|args| async move {
                let found = g1t_kit::call(&self.actions, "check_runs", &args).await;
                (args.repo_id, found)
            })
            .buffer_unordered(6)
            .collect()
            .await;
        let mut unavailable = false;
        // Each call's heads are its own, so its runs stay newest first per head.
        let mut runs: BTreeMap<String, Vec<_>> = BTreeMap::new();
        for (repo_id, found) in answers {
            match found {
                Ok(found) => runs.entry(repo_id).or_default().extend(found.into_iter().map(|detail| (detail.run, detail.jobs))),
                Err(_) => unavailable = true,
            }
        }
        let mut counts: BTreeMap<String, (u32, u32)> = BTreeMap::new();
        for (repo_id, sha, mut states) in pulls.into_values() {
            if let Some(found) = runs.get(&repo_id) {
                states.extend(job_statuses(found, &sha).into_iter().map(|status| status.state));
            }
            let count = counts.entry(repo_id).or_default();
            match head_state(&states) {
                Some(HeadState::Failed) => count.1 += 1,
                Some(HeadState::Pending) => count.0 += 1,
                None => {}
            }
        }
        Ok((counts, unavailable))
    }
}

#[derive(Debug, PartialEq)]
enum HeadState {
    Pending,
    Failed,
}

/// Where a head's checks stand: failed if any did, else pending while any
/// is going; `None` when every one passed or none reported.
fn head_state(states: &[String]) -> Option<HeadState> {
    if states.iter().any(|state| matches!(state.as_str(), "failure" | "error")) {
        Some(HeadState::Failed)
    } else if states.iter().any(|state| state == "pending") {
        Some(HeadState::Pending)
    } else {
        None
    }
}

pub(crate) fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = value[..4].parse().unwrap();
    let month: usize = value[5..7].parse().unwrap();
    let day: u32 = value[8..].parse().unwrap();
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    year > 0 && (1..=12).contains(&month) && day > 0 && day <= lengths[month - 1]
}

#[cfg(test)]
mod tests {
    use super::HeadState;
    use rusqlite::{Connection, params};

    #[test]
    fn rejects_invalid_calendar_dates() {
        for day in ["", "2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "2026-10-01T00:00:00Z"] {
            assert!(!super::valid_day(day));
        }
        assert!(super::valid_day("2024-02-29"));
    }

    #[test]
    fn a_head_counts_once_and_failure_wins() {
        let states = |all: &[&str]| all.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::head_state(&states(&["pending", "failure"])), Some(HeadState::Failed));
        assert_eq!(super::head_state(&states(&["success", "error"])), Some(HeadState::Failed));
        assert_eq!(super::head_state(&states(&["success", "pending"])), Some(HeadState::Pending));
        assert_eq!(super::head_state(&states(&["success"])), None);
        assert_eq!(super::head_state(&[]), None, "a head nothing reported on is neither");
    }

    fn schema(db: &Connection) {
        db.execute_batch(
            "CREATE TABLE pulls (id TEXT, repo_id TEXT, number INTEGER, author_id TEXT, requested_by_id TEXT, status TEXT, created_at TEXT, merged_at TEXT, head_commit TEXT);
            CREATE TABLE comments (repo_id TEXT, number INTEGER, author_id TEXT, agent_id TEXT, verdict TEXT, created_at TEXT);
            CREATE TABLE queue_entries (pull_id TEXT, state TEXT);",
        )
        .unwrap();
    }

    /// (opened, merged, active, unreviewed, queued, lead, review, reviewed)
    fn metrics(db: &Connection, from: &str, until: &str) -> (u32, u32, u32, u32, u32, f64, f64, u32) {
        db.query_row(include_str!("insights.sql"), params![r#"["a"]"#, from, until], |row| {
            Ok((
                row.get("opened")?,
                row.get("merged")?,
                row.get("active")?,
                row.get("unreviewed")?,
                row.get("queued")?,
                row.get("lead_seconds")?,
                row.get("review_seconds")?,
                row.get("reviewed")?,
            ))
        })
        .unwrap()
    }

    #[test]
    fn aggregates_full_history_with_period_boundaries_and_current_waits() {
        let db = Connection::open_in_memory().unwrap();
        schema(&db);
        db.execute_batch("
            INSERT INTO pulls VALUES ('old', 'a', 1, 'author', NULL, 'merged', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', NULL);
            INSERT INTO pulls VALUES ('next', 'a', 2, 'author', NULL, 'merged', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', NULL);
            INSERT INTO pulls VALUES ('open', 'a', 3, 'author', NULL, 'open', '2026-09-01T00:00:00Z', NULL, 'current');
            INSERT INTO pulls VALUES ('secret', 'private', 1, 'author', NULL, 'merged', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', NULL);
            INSERT INTO comments VALUES ('a', 3, 'author', NULL, 'approve', '2026-10-02T00:00:00Z');
            INSERT INTO comments VALUES ('a', 1, 'reviewer', NULL, 'approve', '2026-10-01T00:00:00Z');
            INSERT INTO comments VALUES ('a', 1, 'reviewer', NULL, 'approve', '2026-10-02T00:00:00Z');
            INSERT INTO queue_entries VALUES ('open', 'waiting');
            INSERT INTO queue_entries VALUES ('open', 'testing');").unwrap();
        for n in 4..154 {
            db.execute("INSERT INTO pulls VALUES (?1, 'a', ?2, 'author', NULL, 'merged', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00.123Z', NULL)", params![format!("p{n}"), n]).unwrap();
        }
        let (opened, merged, active, unreviewed, queued, lead, _, reviewed) = metrics(&db, "2026-10-01T00:00:00", "2026-10-07T24:00:00");
        assert_eq!((opened, merged, active, unreviewed, queued, reviewed), (151, 151, 1, 1, 1, 1));
        // Timestamps with milliseconds, as rfc3339 writes them, count them.
        assert!((lead - (151.0 * 86400.0 + 150.0 * 0.123)).abs() < 0.01);
    }

    #[test]
    fn a_first_review_is_a_persons_other_than_the_owner() {
        let db = Connection::open_in_memory().unwrap();
        schema(&db);
        db.execute_batch(
            "
            INSERT INTO pulls VALUES ('mine', 'a', 1, 'usr_g1t_agent', 'owner', 'open', '2026-10-01T00:00:00Z', NULL, NULL);
            INSERT INTO comments VALUES ('a', 1, 'usr_g1t_agent', NULL, 'approve', '2026-10-01T01:00:00Z');
            INSERT INTO comments VALUES ('a', 1, 'owner', NULL, 'approve', '2026-10-01T02:00:00Z');
            INSERT INTO comments VALUES ('a', 1, 'agt_margo', 'agt_margo', 'approve', '2026-10-01T03:00:00Z');",
        )
        .unwrap();
        let (.., unreviewed, _, _, _, reviewed) = metrics(&db, "2026-10-01T00:00:00", "2026-10-01T24:00:00");
        assert_eq!((unreviewed, reviewed), (1, 0), "g1t, an agent and the owner are not reviewers");
        db.execute("INSERT INTO comments VALUES ('a', 1, 'reviewer', NULL, 'request_changes', '2026-10-01T04:00:00Z')", []).unwrap();
        let (.., unreviewed, _, _, review, reviewed) = metrics(&db, "2026-10-01T00:00:00", "2026-10-01T24:00:00");
        assert_eq!((unreviewed, reviewed), (0, 1));
        assert!((review - 4.0 * 3600.0).abs() < 1.0);
    }
}
