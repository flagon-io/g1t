//! Coordinating work between agents and people on one repository
//! (`g1t_contracts::work::coordination`): sessions of their own harnesses
//! (sessions.rs), advisory claims on issues (claims.rs), what an issue is
//! blocked by (dependencies.rs), pull requests that start changing the same
//! files (overlaps.rs), and the one call that gathers it all for an issue
//! (context.rs).
//!
//! Nothing here is a lock and nothing waits on a harness: sessions and
//! claims that went quiet are found when the repository's coordination is
//! next touched (`sweep`), and announced then as ended or expired.

mod claims;
mod context;
mod dependencies;
mod overlaps;
mod sessions;
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

const SESSION_COLUMNS: &str = "id, repo_id, issue, pull, branch, actor_id, actor_name, harness, harness_session_id,
  title, state, head_commit, started_at, last_seen_at, ended_at, end_reason";

const CLAIM_COLUMNS: &str = "id, repo_id, issue, session_id, actor_id, actor_name, harness, note, state,
  ttl_minutes, created_at, expires_at, ended_at, end_reason, handoff_to";

#[derive(Deserialize)]
pub(crate) struct SessionRow {
    id: String,
    repo_id: String,
    issue: Option<u32>,
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
}

impl SessionRow {
    /// The session as it reads at `now`.
    pub(crate) fn at(self, now: u64) -> Session {
        let last_seen = parse_rfc3339(&self.last_seen_at).unwrap_or(now);
        Session {
            state: SessionState::at(self.state == "ended", last_seen, now),
            id: self.id,
            repo_id: self.repo_id,
            issue: self.issue,
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
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct ClaimRow {
    id: String,
    repo_id: String,
    issue: u32,
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
            issue: row.issue,
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

/// Ends a repository's (`?1`) sessions last seen at or before `?2` as
/// `timed_out`, as of when they were last seen.
pub(crate) fn time_out_sessions_sql() -> String {
    format!(
        "UPDATE sessions SET state = 'ended', ended_at = last_seen_at, end_reason = 'timed_out'
         WHERE repo_id = ?1 AND state = 'active' AND last_seen_at <= ?2
         RETURNING {SESSION_COLUMNS}"
    )
}

/// Expires a repository's (`?1`) active claims due at or before `?2`.
pub(crate) fn expire_claims_sql() -> String {
    format!(
        "UPDATE claims SET state = 'expired', ended_at = expires_at, end_reason = 'expired'
         WHERE repo_id = ?1 AND state = 'active' AND expires_at <= ?2
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
    /// open issues and pull requests.
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

    /// Ends the repository's sessions that have gone two hours without a
    /// heartbeat (`timed_out`) and expires its claims past their time, and
    /// announces each. Run before the repository's coordination is read or
    /// changed, so that nobody sees a stale one as live.
    pub(crate) async fn sweep(&self, repo_id: &str) -> Result<()> {
        let now = now_ms();
        let quiet_since = rfc3339(now.saturating_sub(SESSION_TIMEOUT_MS));
        let at = rfc3339(now);
        let results = self
            .db
            .batch(vec![
                self.db.prepare(time_out_sessions_sql()).bind(&[repo_id.into(), quiet_since.as_str().into()])?,
                self.db.prepare(expire_claims_sql()).bind(&[repo_id.into(), at.as_str().into()])?,
            ])
            .await?;
        let mut results = results.into_iter();
        let ended: Vec<SessionRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let expired: Vec<ClaimRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        for row in ended {
            let session = row.at(now);
            self.publish_as("session.ended", repo_id, None, SessionEvent::of(&session)).await?;
        }
        for row in expired {
            let claim = Claim::from(row);
            self.publish_as("work.claim_expired", repo_id, None, ClaimEvent::of(&claim)).await?;
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

    /// Active claims on an issue, oldest first.
    pub(crate) async fn active_claims(&self, repo_id: &str, issue: u32) -> Result<Vec<Claim>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE repo_id = ? AND issue = ? AND state = 'active' ORDER BY created_at, id"
            ))
            .bind(&[repo_id.into(), issue.into()])?
            .all()
            .await?
            .results::<ClaimRow>()?
            .into_iter()
            .map(Claim::from)
            .collect())
    }
}
