//! Coordinating work between agents and people
//! (`g1t_contracts::work::coordination`): sessions of their own harnesses
//! on a repository (sessions.rs), advisory claims on work items
//! (claims.rs), what a work item is blocked by (dependencies.rs), pull
//! requests that start changing the same files (overlaps.rs), the one
//! call that gathers it all for a work item (context.rs), and what
//! harnesses' own telemetry says sessions used (telemetry.rs).
//!
//! Nothing here is a lock and nothing waits on a harness: sessions and
//! claims that went quiet are found when the repository's coordination is
//! next touched (`sweep`), and announced then as ended or expired.

pub(crate) mod updates;
mod claims;
mod context;
mod dependencies;
mod links;
mod overlaps;
mod sessions;
pub(crate) mod shown;
mod telemetry;
pub(crate) mod titles;
mod workspace;
#[cfg(test)]
mod tests;

use g1t_contracts::credentials::Principal;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! unwrap_or_fail {
    ($outcome:expr) => {
        match $outcome {
            g1t_contracts::Outcome::Ok(value) => value,
            g1t_contracts::Outcome::Fail(failure) => return Ok(g1t_contracts::Outcome::Fail(failure)),
        }
    };
}
pub(crate) use unwrap_or_fail;

/// A session's columns, with its work item's number beside its id.
const SESSION_COLUMNS: &str = concat!(
    "id, repo_id, item_id,
  ",
    crate::items::sql::item_number!("sessions.item_id"),
    " AS item,
  pull, branch, actor_id, actor_name, harness, harness_session_id,
  title, state, head_commit, started_at, last_seen_at, ended_at, end_reason,
  parent_id, agent_type, task, prompt, result, model, title_source, title_settled_at,
  usage, cost_usd"
);

/// A claim's columns, with its work item's workspace and number.
const CLAIM_COLUMNS: &str = concat!(
    "id, item_id, repo_id,
  ",
    crate::items::sql::item_workspace!("claims.item_id"),
    " AS workspace,
  ",
    crate::items::sql::item_number!("claims.item_id"),
    " AS item,
  session_id, actor_id, actor_name, harness, note, state,
  ttl_minutes, created_at, expires_at, ended_at, end_reason, handoff_to"
);

#[derive(Clone, Deserialize)]
pub(crate) struct SessionRow {
    id: String,
    repo_id: String,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    item: Option<u32>,
    pull: Option<u32>,
    branch: Option<String>,
    actor_id: String,
    actor_name: String,
    harness: String,
    harness_session_id: Option<String>,
    title: Option<String>,
    state: String,
    head_commit: Option<String>,
    started_at: String,
    last_seen_at: String,
    ended_at: Option<String>,
    end_reason: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    title_source: Option<String>,
    #[serde(default)]
    title_settled_at: Option<String>,
    /// Its token usage as last reported (JSON).
    #[serde(default)]
    usage: Option<String>,
    #[serde(default)]
    cost_usd: Option<f64>,
}

/// Whether some of a session's usage, as kept, was for models priced as unknown.
fn cost_partial(usage: Option<&str>) -> bool {
    usage
        .and_then(|usage| serde_json::from_str::<Vec<g1t_contracts::model_prices::ModelUsage>>(usage).ok())
        .is_some_and(|usage| g1t_contracts::model_prices::estimate(&usage).partial)
}

impl SessionRow {
    /// The session as it reads at `now`.
    pub(crate) fn at(self, now: u64) -> Session {
        let last_seen = parse_rfc3339(&self.last_seen_at).unwrap_or(now);
        Session {
            state: SessionState::at(self.state == "ended", last_seen, now),
            id: self.id,
            repo_id: self.repo_id,
            item: self.item,
            pull: self.pull,
            branch: self.branch,
            actor: Principal { id: self.actor_id, username: self.actor_name },
            harness: Harness::parse(&self.harness).unwrap_or(Harness::Other),
            harness_session_id: self.harness_session_id,
            title: self.title,
            head_commit: self.head_commit,
            started_at: self.started_at,
            last_seen_at: self.last_seen_at,
            ended_at: self.ended_at,
            end_reason: self.end_reason,
            parent_id: self.parent_id,
            agent_type: self.agent_type,
            task: self.task,
            prompt: self.prompt,
            result: self.result,
            model: self.model,
            subagents: 0,
            first_prompt: None,
            title_source: self.title_source.as_deref().and_then(TitleSource::parse),
            title_settled_at: self.title_settled_at,
            cost_partial: cost_partial(self.usage.as_deref()),
            cost_usd: self.cost_usd,
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct ClaimRow {
    id: String,
    pub(crate) item_id: String,
    #[serde(default)]
    repo_id: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    item: Option<u32>,
    session_id: Option<String>,
    actor_id: String,
    actor_name: String,
    harness: Option<String>,
    note: Option<String>,
    state: String,
    #[allow(dead_code)]
    ttl_minutes: u32,
    created_at: String,
    expires_at: String,
    ended_at: Option<String>,
    end_reason: Option<String>,
    handoff_to: Option<String>,
}

impl From<ClaimRow> for Claim {
    fn from(row: ClaimRow) -> Self {
        Claim {
            id: row.id,
            repo_id: row.repo_id,
            workspace: row.workspace.unwrap_or_default(),
            item: row.item.unwrap_or_default(),
            session_id: row.session_id,
            actor: Principal { id: row.actor_id, username: row.actor_name },
            harness: row.harness.as_deref().and_then(Harness::parse),
            note: row.note,
            state: ClaimState::parse(&row.state).unwrap_or(ClaimState::Expired),
            created_at: row.created_at,
            expires_at: row.expires_at,
            ended_at: row.ended_at,
            end_reason: row.end_reason,
            handoff_to: row.handoff_to,
        }
    }
}

/// Text as given, trimmed and cut to `limit` characters; none when empty.
pub(crate) fn tidy(text: Option<&str>, limit: usize) -> Option<String> {
    let text = text?.trim();
    (!text.is_empty()).then(|| text.chars().take(limit).collect())
}

/// The most sessions, and claims, one sweep ends; the rest wait for the next.
const SWEEP_LIMIT: u32 = 50;

/// Ends a repository's (`?1`) session `?3` if last seen at or before `?2`,
/// as `timed_out`, as of when it was last seen; its title is settled a
/// last time (titles.rs).
pub(crate) fn time_out_sessions_sql() -> String {
    format!(
        "UPDATE sessions SET state = 'ended', ended_at = last_seen_at, end_reason = 'timed_out', {final_due}
         WHERE repo_id = ?1 AND state = 'active' AND last_seen_at <= ?2 AND id = ?3
         RETURNING {SESSION_COLUMNS}",
        final_due = titles::final_due("last_seen_at")
    )
}

/// Expires active claim `?3` if due at or before `?2` (`?1` unused, so
/// the binds are the sessions').
pub(crate) fn expire_claims_sql() -> String {
    format!(
        "UPDATE claims SET state = 'expired', ended_at = expires_at, end_reason = 'expired'
         WHERE ?1 IS NOT NULL AND state = 'active' AND expires_at <= ?2 AND id = ?3
         RETURNING {CLAIM_COLUMNS}"
    )
}

/// RFC 3339 for `minutes` after `now`.
pub(crate) fn after_minutes(now: u64, minutes: u32) -> String {
    rfc3339(now + u64::from(minutes) * 60_000)
}

impl Work {
    /// The repository as `viewer` sees it, for reading its coordination.
    pub(crate) async fn coordination_repo(&self, path: &RepoPath, viewer: &Viewer) -> Result<Outcome<Repo>> {
        let repo = unwrap_or_fail!(self.repo(path, viewer).await?);
        self.sweep(&repo.id).await?;
        Ok(Outcome::Ok(repo))
    }

    /// The repository, if `actor` may take part in it: a confirmed email
    /// address, a repository that is not archived, and a role that may
    /// open work items and pull requests.
    pub(crate) async fn participating_repo(&self, path: &RepoPath, actor: &User) -> Result<Outcome<Repo>> {
        if !actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let repo = unwrap_or_fail!(self.repo(path, &Some(actor.clone())).await?);
        unwrap_or_fail!(crate::retired::writable(&repo));
        unwrap_or_fail!(crate::allowed(Some(actor), &repo, g1t_contracts::access::Capability::Participate));
        self.sweep(&repo.id).await?;
        Ok(Outcome::Ok(repo))
    }

    /// Ends the repository's sessions that have gone 30 minutes without a
    /// heartbeat (`timed_out`) and expires the claims made from it or on
    /// work items linked to it past their time, and announces each. Run
    /// before the repository's coordination is read or changed, so that
    /// nobody sees a stale one as live.
    pub(crate) async fn sweep(&self, repo_id: &str) -> Result<()> {
        let now = now_ms();
        let quiet_since = rfc3339(now.saturating_sub(SESSION_TIMEOUT_MS));
        let at = rfc3339(now);
        // Read first: most of the time nothing is due, and nothing is written.
        let due = self
            .db
            .batch(vec![
                self.db
                    .prepare(format!(
                        "SELECT {SESSION_COLUMNS} FROM sessions
                         WHERE repo_id = ?1 AND state = 'active' AND last_seen_at <= ?2 LIMIT ?3"
                    ))
                    .bind(&[repo_id.into(), quiet_since.as_str().into(), SWEEP_LIMIT.into()])?,
                self.db
                    .prepare(format!(
                        "SELECT {CLAIM_COLUMNS} FROM claims
                         WHERE state = 'active' AND expires_at <= ?2 AND (repo_id = ?1 OR item_id IN {linked})
                         LIMIT ?3",
                        linked = crate::items::sql::items_linked_to!("?1"),
                    ))
                    .bind(&[repo_id.into(), at.as_str().into(), SWEEP_LIMIT.into()])?,
            ])
            .await?;
        let mut due = due.into_iter();
        let quiet: Vec<SessionRow> = match due.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let lapsed: Vec<ClaimRow> = match due.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        if quiet.is_empty() && lapsed.is_empty() {
            return Ok(());
        }
        // Each one's end and its updates are one change: a sweep running at
        // the same moment ends it, and delivers it, once.
        let mut statements = Vec::new();
        let mut sessions = Vec::new();
        for row in quiet {
            statements.push(
                self.db
                    .prepare(time_out_sessions_sql())
                    .bind(&[repo_id.into(), quiet_since.as_str().into(), row.id.as_str().into()])?,
            );
            let index = statements.len() - 1;
            let ended_at = row.last_seen_at.clone();
            let expected = SessionRow {
                state: "ended".to_owned(),
                ended_at: Some(ended_at.clone()),
                end_reason: Some("timed_out".to_owned()),
                ..row
            }
            .at(now);
            let delivery = self.delivery(
                "session.ended",
                repo_id,
                serde_json::to_value(SessionEvent::of(&expected))?,
                &format!("{}:ended:{ended_at}", expected.id),
                "EXISTS (SELECT 1 FROM sessions WHERE id = ?7 AND state = 'ended' AND ended_at = ?8)",
                vec![expected.id.as_str().into(), ended_at.as_str().into()],
            )?;
            sessions.push((index, updates::push_delivery(&mut statements, delivery)));
        }
        let mut claims = Vec::new();
        for row in lapsed {
            statements.push(
                self.db.prepare(expire_claims_sql()).bind(&[repo_id.into(), at.as_str().into(), row.id.as_str().into()])?,
            );
            let index = statements.len() - 1;
            let held = Claim::from(row);
            let expected = Claim {
                state: ClaimState::Expired,
                ended_at: Some(held.expires_at.clone()),
                end_reason: Some("expired".to_owned()),
                ..held
            };
            let delivery = self.delivery(
                "work.claim_expired",
                repo_id,
                serde_json::to_value(ClaimEvent::of(&expected, &[repo_id.to_owned()]))?,
                &format!("{}:{}", expected.id, ClaimState::Expired.as_str()),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7 AND state = 'expired')",
                vec![expected.id.as_str().into()],
            )?;
            claims.push((index, updates::push_delivery(&mut statements, delivery)));
        }
        let results = self.db.batch(statements).await?;
        let returned = |index: usize| results.get(index);
        for (index, sent) in sessions {
            let Some(row) = returned(index).map(|result| result.results::<SessionRow>()).transpose()?.and_then(|rows| rows.into_iter().next())
            else {
                continue;
            };
            let session = row.at(now);
            self.delivered(sent, "session.ended", repo_id, None, serde_json::to_value(SessionEvent::of(&session))?).await?;
        }
        for (index, sent) in claims {
            let Some(row) = returned(index).map(|result| result.results::<ClaimRow>()).transpose()?.and_then(|rows| rows.into_iter().next())
            else {
                continue;
            };
            let claim = Claim::from(row);
            let data = serde_json::to_value(ClaimEvent::of(&claim, &[repo_id.to_owned()]))?;
            self.delivered(sent, "work.claim_expired", repo_id, None, data).await?;
        }
        Ok(())
    }

    pub(crate) async fn session_row(&self, repo_id: &str, id: &str) -> Result<Option<SessionRow>> {
        self.db
            .prepare(format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE repo_id = ? AND id = ?"))
            .bind(&[repo_id.into(), id.into()])?
            .first::<SessionRow>(None)
            .await
    }

    /// Active claims on a work item, oldest first.
    pub(crate) async fn active_claims(&self, item_id: &str) -> Result<Vec<Claim>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE item_id = ? AND state = 'active' ORDER BY created_at, id"
            ))
            .bind(&[item_id.into()])?
            .all()
            .await?
            .results::<ClaimRow>()?
            .into_iter()
            .map(Claim::from)
            .collect())
    }
}
