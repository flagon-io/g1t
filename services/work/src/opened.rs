//! Telling everyone a pull request opened, and the sweep that tells them of
//! one whose opening was cut short.
//!
//! Opening a pull request writes it, then makes its head and merge refs and
//! publishes `pull.opened`, which starts its workflows and dependency
//! review. The request runs past a caller that leaves (`fetch`), but only
//! for the 30 s `wait_until` allows; one cut off before its event went out
//! leaves a pull request nothing has heard of, as #454 was. `opened_event_at`
//! says when its event went out, and the cron sends it for each open one
//! still without, once it is old enough not to be on its way.

use g1t_contracts::events::{CAUSED_BY_JOB, PullEvent};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::Pull;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// Marks `?2`'s event sent at `?1`.
const SENT: &str = "UPDATE pulls SET opened_event_at = ?1 WHERE id = ?2 AND opened_event_at IS NULL";

/// The open pull requests written before `?1` whose event never went
/// out, oldest first, `?2` of them.
pub(crate) const UNSENT: &str = "SELECT repo_id, number, opened_job_run FROM pulls
     WHERE opened_event_at IS NULL AND status IN ('draft', 'open') AND created_at < ?1
     ORDER BY created_at LIMIT ?2";

/// An opening this recent may still be under way.
const GRACE_MS: u64 = 2 * 60 * 1000;

/// How many each cron sends: each makes refs and an event.
const SWEEP: u32 = 10;

#[derive(Deserialize)]
pub(crate) struct UnsentRow {
    pub repo_id: String,
    pub number: u32,
    pub opened_job_run: Option<String>,
}

impl Work {
    /// Makes an opened pull request's refs, then tells everyone, and notes
    /// that it did. `job_run`: the workflow run whose job's token opened
    /// it, which its event says so it starts no workflows.
    pub(crate) async fn tell_opened(&self, pull: &Pull, actor: Option<String>, job_run: Option<&str>) -> Result<()> {
        // Its head and merge refs in the repository, before its events go out.
        self.keep_pull_refs(pull).await;
        // A coding agent's commits make it that agent's (cloud_agents.rs).
        self.mark_agent_pull(pull, None).await;
        let mut data =
            serde_json::to_value(PullEvent { agent: Some(pull.agent.clone()), base: pull.base.clone(), ..Self::pull_event(pull) })?;
        if let (Some(run), serde_json::Value::Object(map)) = (job_run, &mut data) {
            map.insert(CAUSED_BY_JOB.to_owned(), serde_json::Value::String(run.to_owned()));
        }
        self.publish_as("pull.opened", &pull.repo_id, actor, data).await?;
        self.db.prepare(SENT).bind(&[rfc3339(now_ms()).into(), pull.id.as_str().into()])?.run().await?;
        Ok(())
    }

    /// Sends the event of each open pull request whose opening was cut
    /// short before it went out.
    pub(crate) async fn sweep_opened(&self) -> Result<()> {
        let before = rfc3339(now_ms().saturating_sub(GRACE_MS));
        let unsent = self.db.prepare(UNSENT).bind(&[before.into(), SWEEP.into()])?.all().await?.results::<UnsentRow>()?;
        for row in unsent {
            if let Err(error) = self.send_opened(&row).await {
                worker::console_error!("work: telling of pull request {}#{}: {error}", row.repo_id, row.number);
            }
        }
        Ok(())
    }

    async fn send_opened(&self, row: &UnsentRow) -> Result<()> {
        let Some(mut pull) = self.pull(&row.repo_id, row.number).await? else { return Ok(()) };
        if let Some(repo) = self.target_of(&pull).await? {
            crate::fill_base(&mut pull, &repo);
        }
        worker::console_warn!("work: pull request {} ({}#{}) opened without its event; sending it now", pull.id, row.repo_id, row.number);
        // Whoever opened it, as on time.
        let actor = pull.requested_by.as_ref().unwrap_or(&pull.author).id.clone();
        self.tell_opened(&pull, Some(actor), row.opened_job_run.as_deref()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrated::database;

    #[test]
    fn only_open_pull_requests_old_enough_and_never_told_are_sent() {
        let db = database();
        let add = |id: &str, number: u32, status: &str, created: &str, sent: Option<&str>| {
            db.execute(
                "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, status, author_id, author_name,
                                    created_at, updated_at, opened_event_at)
                 VALUES (?1, 'rep_1', ?2, 'Change', 'ana', 'external', ?3, 'usr_1', 'ana', ?4, ?4, ?5)",
                rusqlite::params![id, number, status, created, sent],
            )
            .unwrap();
        };
        add("pul_cut", 1, "open", "2026-10-23T16:13:56Z", None);
        add("pul_draft", 2, "draft", "2026-10-23T16:12:00Z", None);
        add("pul_told", 3, "open", "2026-10-23T16:10:00Z", Some("2026-10-23T16:10:01Z"));
        add("pul_closed", 4, "closed", "2026-10-23T16:00:00Z", None);
        add("pul_new", 5, "open", "2026-10-23T16:19:30Z", None);
        let unsent = |before: &str| -> Vec<u32> {
            let mut statement = db.prepare(UNSENT).unwrap();
            statement.query_map(rusqlite::params![before, SWEEP], |row| row.get(1)).unwrap().map(Result::unwrap).collect()
        };
        // Oldest first; never one told, closed, or still being opened.
        assert_eq!(unsent("2026-10-23T16:18:00Z"), [2, 1]);
        db.execute(SENT, rusqlite::params!["2026-10-23T16:20:00Z", "pul_draft"]).unwrap();
        assert_eq!(unsent("2026-10-23T16:21:00Z"), [1, 5]);
        // Told once, its time is kept.
        db.execute(SENT, rusqlite::params!["2026-10-23T16:30:00Z", "pul_draft"]).unwrap();
        let sent: String = db.query_row("SELECT opened_event_at FROM pulls WHERE id = 'pul_draft'", [], |row| row.get(0)).unwrap();
        assert_eq!(sent, "2026-10-23T16:20:00Z");
    }

    #[test]
    fn pull_requests_from_before_are_counted_as_told() {
        let db = crate::migrated::database_before("0067_pull_opened_event.sql");
        db.execute(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, status, author_id, author_name, created_at, updated_at)
             VALUES ('pul_old', 'rep_1', 1, 'Change', 'ana', 'external', 'open', 'usr_1', 'ana', '2026-10-01T00:00:00Z', '')",
            [],
        )
        .unwrap();
        crate::migrated::migrate_from(&db, "0067_pull_opened_event.sql");
        // And one the code before this opens while it deploys, not naming the column.
        db.execute(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, status, author_id, author_name, created_at, updated_at)
             VALUES ('pul_deploying', 'rep_1', 2, 'Change', 'ana', 'external', 'open', 'usr_1', 'ana', '2026-10-23T17:00:00Z', '')",
            [],
        )
        .unwrap();
        let mut statement = db.prepare(UNSENT).unwrap();
        let unsent = statement.query_map(rusqlite::params!["2026-10-24T00:00:00Z", SWEEP], |row| row.get::<_, u32>(1)).unwrap().count();
        assert_eq!(unsent, 0);
    }
}
