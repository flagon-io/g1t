//! Sessions: one run of someone's own harness on a repository.
//!
//! Starting one is idempotent on the harness's own session id, so a hook
//! that fires twice, or a harness that reconnects, gets the same session
//! back. Every update, and every batch of entries, is a heartbeat: it keeps
//! the session active, brings back one that timed out, and renews the
//! claims made from it. Only the person whose token started a session
//! changes it.

use g1t_contracts::events::SessionAppended;
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{SESSION_COLUMNS, SessionRow, after_minutes, tidy, unwrap_or_fail};
use crate::Work;
use crate::rows::NumberRow;

/// The most entries one look at a session returns.
const ENTRY_PAGE: u32 = 500;
/// The most sessions one list returns.
const LIST_LIMIT: u32 = 100;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BRANCH_CHARS: usize = 255;
const MAX_ID_CHARS: usize = 200;
const MAX_COMMIT_CHARS: usize = 64;

fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Session not found.")
}

fn text_or_null(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

fn number_or_null(value: Option<u32>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// What a session's heartbeat may change, tidied.
struct Fields {
    issue: Option<u32>,
    pull: Option<u32>,
    branch: Option<String>,
    head_commit: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
struct RenewRow {
    id: String,
    ttl_minutes: u32,
    expires_at: String,
}

/// Starts a session; nothing when one with the same harness session id
/// was started already.
pub(crate) fn insert_session_sql() -> String {
    format!(
        "INSERT INTO sessions
           (id, repo_id, issue, pull, branch, actor_id, actor_name, harness, harness_session_id,
            title, state, head_commit, started_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?12, ?13)
         ON CONFLICT (repo_id, actor_id, harness, harness_session_id)
           WHERE harness_session_id IS NOT NULL DO NOTHING
         RETURNING {SESSION_COLUMNS}"
    )
}

/// A person's session by its harness's id for it.
pub(crate) fn harness_session_sql() -> String {
    format!(
        "SELECT {SESSION_COLUMNS} FROM sessions
         WHERE repo_id = ?1 AND actor_id = ?2 AND harness = ?3 AND harness_session_id = ?4"
    )
}

/// A heartbeat: seen now (`?6`), active again, with whichever fields are
/// given.
pub(crate) fn resume_sql() -> String {
    format!(
        "UPDATE sessions
         SET issue = COALESCE(?1, issue), pull = COALESCE(?2, pull), branch = COALESCE(?3, branch),
             head_commit = COALESCE(?4, head_commit), title = COALESCE(?5, title),
             last_seen_at = ?6, state = 'active', ended_at = NULL, end_reason = NULL
         WHERE id = ?7
         RETURNING {SESSION_COLUMNS}"
    )
}

/// Records one entry in session `?7`, and in pull request `?1` when it
/// is on one. Each takes the next number of the session, and of its pull
/// request, itself, so two batches at once cannot collide; an entry whose
/// key (`?8`) the session has recorded already is skipped.
pub(crate) const INSERT_ENTRY: &str = "INSERT INTO session_entries
       (pull_id, seq, kind, text, tool, \"commit\", at, session_id, session_seq, key)
     SELECT ?1,
       CASE WHEN ?1 IS NULL
         THEN (SELECT COALESCE(MAX(session_seq), 0) + 1 FROM session_entries WHERE session_id = ?7)
         ELSE (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_entries WHERE pull_id = ?1) END,
       ?2, ?3, ?4, ?5, ?6, ?7,
       (SELECT COALESCE(MAX(session_seq), 0) + 1 FROM session_entries WHERE session_id = ?7),
       ?8
     WHERE true
     ON CONFLICT (session_id, key) WHERE session_id IS NOT NULL AND key IS NOT NULL DO NOTHING
     RETURNING session_seq AS n";

/// Entries of session `?3` recorded before it named its pull request
/// `?1` join it, numbered after its last (`?2`), in their order.
pub(crate) const MOVE_ENTRIES: &str = "UPDATE session_entries SET pull_id = ?1, seq = ?2 + session_seq
     WHERE session_id = ?3 AND pull_id IS NULL";

/// Renews active claim `?2` to `?1`.
pub(crate) const RENEW_CLAIM: &str = "UPDATE claims SET expires_at = ?1 WHERE id = ?2 AND state = 'active'";

/// When a claim of `minutes` renewed at `now` lapses, if that is later
/// than it does already (`expires_at`): a heartbeat never shortens one.
pub(crate) fn renewal(now: u64, minutes: u32, expires_at: &str) -> Option<String> {
    let renewed = after_minutes(now, minutes);
    (renewed.as_str() > expires_at).then_some(renewed)
}

impl Work {
    /// The issue and pull request a session names, checked: each is one of
    /// the repository's, of the right kind. A pull request for an issue
    /// names that issue when no issue was given.
    async fn session_subjects(&self, repo: &Repo, issue: Option<u32>, pull: Option<u32>) -> Result<Outcome<(Option<u32>, Option<u32>)>> {
        let mut issue = issue.filter(|number| *number > 0);
        let pull = pull.filter(|number| *number > 0);
        if let Some(number) = issue
            && self.issue(&repo.id, number).await?.is_none()
        {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not an issue in this repository.")));
        }
        if let Some(number) = pull {
            match self.pull(&repo.id, number).await? {
                Some(found) => issue = issue.or(found.issue),
                None => {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not a pull request in this repository.")));
                }
            }
        }
        Ok(Outcome::Ok((issue, pull)))
    }

    pub(crate) async fn start_session(&self, a: StartSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let (issue, pull) = unwrap_or_fail!(self.session_subjects(&repo, a.issue, a.pull).await?);
        let fields = Fields {
            issue,
            pull,
            branch: tidy(a.branch.as_deref(), MAX_BRANCH_CHARS),
            head_commit: tidy(a.head_commit.as_deref(), MAX_COMMIT_CHARS),
            title: tidy(a.title.as_deref(), MAX_TITLE_CHARS),
        };
        let harness_session_id = tidy(a.harness_session_id.as_deref(), MAX_ID_CHARS);
        let now = now_ms();
        let at = rfc3339(now);
        // The same harness session again: the one already started.
        if let Some(harness_id) = &harness_session_id
            && let Some(row) = self.harness_session(&repo.id, &a.actor, a.harness, harness_id).await?
        {
            return self.resume(&repo, row, &a.actor, fields).await;
        }
        let inserted = self
            .db
            .prepare(insert_session_sql())
            .bind(&[
                new_id("ses", now).into(),
                repo.id.as_str().into(),
                number_or_null(fields.issue),
                number_or_null(fields.pull),
                text_or_null(&fields.branch),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                a.harness.as_str().into(),
                text_or_null(&harness_session_id),
                text_or_null(&fields.title),
                text_or_null(&fields.head_commit),
                at.as_str().into(),
                at.as_str().into(),
            ])?
            .first::<SessionRow>(None)
            .await?;
        let Some(row) = inserted else {
            // Started at the same moment by another call: that one.
            let Some(harness_id) = &harness_session_id else {
                return Ok(not_found());
            };
            return match self.harness_session(&repo.id, &a.actor, a.harness, harness_id).await? {
                Some(row) => Ok(Outcome::Ok(row.at(now))),
                None => Ok(not_found()),
            };
        };
        let session = row.at(now);
        self.publish("session.started", &repo.id, &a.actor, SessionEvent::of(&session)).await?;
        Ok(Outcome::Ok(session))
    }

    async fn harness_session(&self, repo_id: &str, actor: &User, harness: Harness, harness_id: &str) -> Result<Option<SessionRow>> {
        self.db
            .prepare(harness_session_sql())
            .bind(&[repo_id.into(), actor.id.as_str().into(), harness.as_str().into(), harness_id.into()])?
            .first::<SessionRow>(None)
            .await
    }

    /// A heartbeat, with whatever `fields` change: the session is seen now,
    /// brought back if it had ended (announced as started again), its
    /// claims renewed, and entries recorded before it named its pull
    /// request moved onto it.
    async fn resume(&self, repo: &Repo, row: SessionRow, actor: &User, fields: Fields) -> Result<Outcome<Session>> {
        let now = now_ms();
        let was_ended = row.state == "ended";
        let had_pull = row.pull;
        let id = row.id.clone();
        let at = rfc3339(now);
        let updated = self
            .db
            .prepare(resume_sql())
            .bind(&[
                number_or_null(fields.issue),
                number_or_null(fields.pull),
                text_or_null(&fields.branch),
                text_or_null(&fields.head_commit),
                text_or_null(&fields.title),
                at.as_str().into(),
                id.as_str().into(),
            ])?
            .first::<SessionRow>(None)
            .await?;
        let Some(updated) = updated else {
            return Ok(not_found());
        };
        let session = updated.at(now);
        self.renew_claims(&id, now).await?;
        if let Some(number) = session.pull
            && had_pull != Some(number)
        {
            self.move_entries_onto_pull(&repo.id, &id, number).await?;
        }
        if was_ended {
            self.publish("session.started", &repo.id, actor, SessionEvent::of(&session)).await?;
        }
        Ok(Outcome::Ok(session))
    }

    /// Renews the active claims made from a session by their own length.
    async fn renew_claims(&self, session_id: &str, now: u64) -> Result<()> {
        let claims = self
            .db
            .prepare("SELECT id, ttl_minutes, expires_at FROM claims WHERE session_id = ? AND state = 'active'")
            .bind(&[session_id.into()])?
            .all()
            .await?
            .results::<RenewRow>()?;
        let mut statements = Vec::new();
        for claim in claims {
            if let Some(renewed) = renewal(now, claim.ttl_minutes, &claim.expires_at) {
                statements.push(self.db.prepare(RENEW_CLAIM).bind(&[renewed.into(), claim.id.into()])?);
            }
        }
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        Ok(())
    }

    /// Entries a session recorded before it named its pull request join
    /// that pull request's session, after what it has, in their order.
    async fn move_entries_onto_pull(&self, repo_id: &str, session_id: &str, number: u32) -> Result<()> {
        let Some(pull) = self.pull(repo_id, number).await? else {
            return Ok(());
        };
        let base = self
            .db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM session_entries WHERE pull_id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n);
        let moved = self
            .db
            .prepare(MOVE_ENTRIES)
            .bind(&[pull.id.as_str().into(), base.into(), session_id.into()])?
            .run()
            .await;
        // An entry recorded on the pull request at the same moment took a
        // number these needed: they stay the session's alone.
        if let Err(error) = moved {
            worker::console_error!("session {session_id}: entries not moved onto #{number}: {error}");
        }
        Ok(())
    }

    /// The caller's own session, as stored.
    async fn own_session(&self, repo: &Repo, actor: &User, id: &str) -> Result<Outcome<SessionRow>> {
        Ok(match self.session_row(&repo.id, id.trim()).await? {
            Some(row) if row.actor_id == actor.id => Outcome::Ok(row),
            _ => not_found(),
        })
    }

    pub(crate) async fn update_session(&self, a: UpdateSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let row = unwrap_or_fail!(self.own_session(&repo, &a.actor, &a.id).await?);
        if row.state == "ended" && row.end_reason.as_deref() != Some("timed_out") {
            return Ok(Outcome::fail(FailureCode::Conflict, "This session has ended. Start a new one."));
        }
        let (issue, pull) = unwrap_or_fail!(self.session_subjects(&repo, a.issue, a.pull).await?);
        let fields = Fields {
            issue,
            pull,
            branch: tidy(a.branch.as_deref(), MAX_BRANCH_CHARS),
            head_commit: tidy(a.head_commit.as_deref(), MAX_COMMIT_CHARS),
            title: tidy(a.title.as_deref(), MAX_TITLE_CHARS),
        };
        self.resume(&repo, row, &a.actor, fields).await
    }

    pub(crate) async fn end_session(&self, a: EndSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let row = unwrap_or_fail!(self.own_session(&repo, &a.actor, &a.id).await?);
        let now = now_ms();
        if row.state == "ended" {
            return Ok(Outcome::Ok(row.at(now)));
        }
        let reason = tidy(a.reason.as_deref(), MAX_NOTE_CHARS).unwrap_or_else(|| "ended".to_owned());
        let at = rfc3339(now);
        let ended = self
            .db
            .prepare(format!(
                "UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ?, last_seen_at = ?
                 WHERE id = ? AND state = 'active'
                 RETURNING {SESSION_COLUMNS}"
            ))
            .bind(&[at.as_str().into(), reason.into(), at.as_str().into(), row.id.as_str().into()])?
            .first::<SessionRow>(None)
            .await?;
        let Some(ended) = ended else {
            // Ended by another call meanwhile.
            return Ok(match self.session_row(&repo.id, &row.id).await? {
                Some(row) => Outcome::Ok(row.at(now)),
                None => not_found(),
            });
        };
        let session = ended.at(now);
        self.publish("session.ended", &repo.id, &a.actor, SessionEvent::of(&session)).await?;
        Ok(Outcome::Ok(session))
    }

    pub(crate) async fn get_work_session(&self, a: WorkSessionArgs) -> Result<Outcome<SessionDetail>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let Some(row) = self.session_row(&repo.id, a.id.trim()).await? else {
            return Ok(not_found());
        };
        let entries = self
            .db
            .prepare(
                "SELECT session_seq AS seq, kind, text, tool, \"commit\", at FROM session_entries
                 WHERE session_id = ? AND session_seq > ? ORDER BY session_seq LIMIT ?",
            )
            .bind(&[row.id.as_str().into(), a.after_seq.into(), ENTRY_PAGE.into()])?
            .all()
            .await?
            .results::<crate::rows::SessionRow>()?
            .into_iter()
            .map(SessionEntry::from)
            .collect();
        Ok(Outcome::Ok(SessionDetail { session: row.at(now_ms()), entries }))
    }

    pub(crate) async fn list_work_sessions(&self, a: ListWorkSessionsArgs) -> Result<Outcome<Vec<Session>>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let now = now_ms();
        let idle_since = rfc3339(now.saturating_sub(SESSION_IDLE_MS));
        // Every statement names each bind it is given.
        let state = match a.state {
            None => "AND ?2 IS NOT NULL",
            Some(SessionState::Active) => "AND state = 'active' AND last_seen_at > ?2",
            Some(SessionState::Idle) => "AND state = 'active' AND last_seen_at <= ?2",
            Some(SessionState::Ended) => "AND state = 'ended' AND ?2 IS NOT NULL",
        };
        let rows = self
            .db
            .prepare(format!(
                "SELECT {SESSION_COLUMNS} FROM sessions
                 WHERE repo_id = ?1 {state}
                   AND (?3 IS NULL OR issue = ?3) AND (?4 IS NULL OR pull = ?4)
                 ORDER BY last_seen_at DESC LIMIT ?5"
            ))
            .bind(&[
                repo.id.as_str().into(),
                idle_since.as_str().into(),
                number_or_null(a.issue),
                number_or_null(a.pull),
                LIST_LIMIT.into(),
            ])?
            .all()
            .await?
            .results::<SessionRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(|row| row.at(now)).collect()))
    }

    pub(crate) async fn record_session_entries(&self, a: RecordEntriesArgs) -> Result<Outcome<Recorded>> {
        if a.entries.len() > crate::MAX_ENTRY_BATCH {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Send at most {} entries at a time.", crate::MAX_ENTRY_BATCH),
            ));
        }
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let row = unwrap_or_fail!(self.own_session(&repo, &a.actor, &a.id).await?);
        if row.state == "ended" && row.end_reason.as_deref() != Some("timed_out") {
            return Ok(Outcome::fail(FailureCode::Conflict, "This session has ended. Start a new one."));
        }
        // Recording is a heartbeat too.
        let fields = Fields { issue: None, pull: None, branch: None, head_commit: None, title: None };
        let session = unwrap_or_fail!(self.resume(&repo, row, &a.actor, fields).await?);
        if a.entries.is_empty() {
            return Ok(Outcome::Ok(Recorded::default()));
        }
        let pull = match session.pull {
            Some(number) => self.pull(&repo.id, number).await?,
            None => None,
        };
        let pull_id: JsValue = pull.as_ref().map_or(JsValue::NULL, |pull| pull.id.as_str().into());
        let at = rfc3339(now_ms());
        let total = a.entries.len() as u32;
        let mut statements = Vec::with_capacity(a.entries.len());
        for keyed in a.entries {
            let entry = keyed.entry;
            let kind = serde_json::to_value(entry.kind)?;
            let text: String = entry.text.chars().take(crate::MAX_ENTRY_CHARS).collect();
            let key = tidy(keyed.key.as_deref(), MAX_KEY_CHARS);
            // Each takes the next number of the session, and of its pull
            // request when it has one, itself, so two batches at once
            // cannot collide; a key already recorded is skipped.
            statements.push(
                self.db
                    .prepare(INSERT_ENTRY)
                    .bind(&[
                        pull_id.clone(),
                        kind.as_str().unwrap_or("note").into(),
                        text.into(),
                        text_or_null(&entry.tool),
                        text_or_null(&entry.commit.or_else(|| session.head_commit.clone())),
                        at.as_str().into(),
                        session.id.as_str().into(),
                        text_or_null(&key),
                    ])?,
            );
        }
        let mut recorded = 0;
        for result in self.db.batch(statements).await? {
            recorded += result.results::<NumberRow>()?.len() as u32;
        }
        if let Some(pull) = pull
            && recorded > 0
        {
            self.publish(
                "session.appended",
                &repo.id,
                &a.actor,
                SessionAppended { pull_id: pull.id, repo_id: repo.id.clone(), number: pull.number, count: recorded },
            )
            .await?;
        }
        Ok(Outcome::Ok(Recorded { recorded, duplicates: total - recorded }))
    }
}
