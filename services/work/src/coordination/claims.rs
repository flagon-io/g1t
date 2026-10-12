//! Claims: an advisory, expiring "I'm working on #N".
//!
//! A claim is never a lock: anyone may claim an issue someone else has
//! claimed, and is told who else is on it. It lapses unless renewed, by
//! claiming again or by a heartbeat of the session it was made from, and
//! ends when released, handed off, or when its issue closes.

use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{CLAIM_COLUMNS, ClaimRow, after_minutes, tidy, unwrap_or_fail};
use crate::Work;

/// The most claims one list returns.
const LIST_LIMIT: u32 = 100;

fn text_or_null(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

impl Work {
    /// The caller's active claim on an issue, if they hold one.
    async fn own_claim(&self, repo_id: &str, issue: u32, actor: &User) -> Result<Option<Claim>> {
        Ok(self.active_claims(repo_id, issue).await?.into_iter().find(|claim| claim.actor.id == actor.id))
    }

    pub(crate) async fn claim_issue(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let Some(issue) = self.issue(&repo.id, a.number).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Issue not found."));
        };
        if issue.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("#{} is closed.", issue.number)));
        }
        // The session it is made from, whose heartbeats renew it.
        let session = match a.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => match self.session_row(&repo.id, id).await? {
                Some(row) if row.actor_id == a.actor.id => Some(row.at(now_ms())),
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "session_id is not one of your sessions in this repository.")),
            },
            None => None,
        };
        if session.as_ref().is_some_and(|session| session.state == SessionState::Ended) {
            return Ok(Outcome::fail(FailureCode::Invalid, "That session has ended. Start a new one."));
        }
        let minutes = claim_minutes(a.ttl_minutes);
        let note = tidy(a.note.as_deref(), MAX_NOTE_CHARS);
        let session_id = session.as_ref().map(|session| session.id.clone());
        let harness = session.as_ref().map(|session| session.harness.as_str().to_owned());
        let now = now_ms();
        let expires_at = after_minutes(now, minutes);
        let standing = self.active_claims(&repo.id, issue.number).await?;
        let (mine, others): (Vec<Claim>, Vec<Claim>) = standing.into_iter().partition(|claim| claim.actor.id == a.actor.id);
        let blocked_by = self.blockers(&repo.id, &issue.blocked_by).await?;
        // Claiming what you hold renews it.
        if let Some(held) = mine.into_iter().next() {
            let renewed = self
                .db
                .prepare(format!(
                    "UPDATE claims
                     SET expires_at = ?, ttl_minutes = ?, note = COALESCE(?, note),
                         session_id = COALESCE(?, session_id), harness = COALESCE(?, harness)
                     WHERE id = ? AND state = 'active'
                     RETURNING {CLAIM_COLUMNS}"
                ))
                .bind(&[
                    expires_at.as_str().into(),
                    minutes.into(),
                    text_or_null(&note),
                    text_or_null(&session_id),
                    text_or_null(&harness),
                    held.id.as_str().into(),
                ])?
                .first::<ClaimRow>(None)
                .await?;
            if let Some(renewed) = renewed {
                return Ok(Outcome::Ok(Claimed { claim: renewed.into(), others, blocked_by }));
            }
        }
        // Taking over what was handed off to you, or to anyone.
        let handed: Option<ClaimRow> = self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE repo_id = ? AND issue = ? AND state <> 'active' ORDER BY ended_at DESC, id DESC LIMIT 1"
            ))
            .bind(&[repo.id.as_str().into(), issue.number.into()])?
            .first::<ClaimRow>(None)
            .await?;
        let took_over = handed
            .map(Claim::from)
            .filter(|last| last.state == ClaimState::HandedOff)
            .filter(|last| last.handoff_to.as_deref().is_none_or(|to| to == a.actor.username))
            .map(|last| last.id);
        let at = rfc3339(now);
        let created = self
            .db
            .prepare(format!(
                "INSERT INTO claims
                   (id, repo_id, issue, session_id, actor_id, actor_name, harness, note, state, ttl_minutes,
                    created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
                 RETURNING {CLAIM_COLUMNS}"
            ))
            .bind(&[
                new_id("clm", now).into(),
                repo.id.as_str().into(),
                issue.number.into(),
                text_or_null(&session_id),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                text_or_null(&harness),
                text_or_null(&note),
                minutes.into(),
                at.as_str().into(),
                expires_at.as_str().into(),
            ])?
            .first::<ClaimRow>(None)
            .await?;
        let Some(created) = created else {
            return Err(worker::Error::RustError("the claim was not recorded".into()));
        };
        let claim = Claim::from(created);
        self.publish(
            "work.claimed",
            &repo.id,
            &a.actor,
            ClaimEvent { others: Some(others.clone()), took_over, ..ClaimEvent::of(&claim) },
        )
        .await?;
        Ok(Outcome::Ok(Claimed { claim, others, blocked_by }))
    }

    /// Ends the caller's active claim on an issue as `state`, or refuses
    /// when they hold none.
    async fn end_own_claim(
        &self,
        actor: &User,
        repo: &g1t_contracts::repos::RepoPath,
        number: u32,
        state: ClaimState,
        reason: &str,
        handoff: Option<(&Option<String>, &str)>,
    ) -> Result<Outcome<Claim>> {
        let repo = unwrap_or_fail!(self.participating_repo(repo, actor).await?);
        let Some(held) = self.own_claim(&repo.id, number, actor).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("You hold no claim on #{number}.")));
        };
        let at = rfc3339(now_ms());
        let (handoff_to, note) = match handoff {
            Some((to, note)) => (text_or_null(to), JsValue::from(note)),
            None => (JsValue::NULL, JsValue::NULL),
        };
        let ended = self
            .db
            .prepare(format!(
                "UPDATE claims
                 SET state = ?, ended_at = ?, end_reason = ?, handoff_to = ?, note = COALESCE(?, note)
                 WHERE id = ? AND state = 'active'
                 RETURNING {CLAIM_COLUMNS}"
            ))
            .bind(&[state.as_str().into(), at.into(), reason.into(), handoff_to, note, held.id.as_str().into()])?
            .first::<ClaimRow>(None)
            .await?;
        Ok(match ended {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, format!("You hold no claim on #{number}.")),
        })
    }

    pub(crate) async fn release_claim(&self, a: ReleaseArgs) -> Result<Outcome<Claim>> {
        let reason = tidy(a.reason.as_deref(), MAX_NOTE_CHARS).unwrap_or_else(|| "released".to_owned());
        let claim = unwrap_or_fail!(
            self.end_own_claim(&a.actor, &a.repo, a.number, ClaimState::Released, &reason, None).await?
        );
        self.publish(
            "work.released",
            &claim.repo_id.clone(),
            &a.actor,
            ClaimEvent { reason: Some(reason), ..ClaimEvent::of(&claim) },
        )
        .await?;
        Ok(Outcome::Ok(claim))
    }

    pub(crate) async fn hand_off_issue(&self, a: HandOffArgs) -> Result<Outcome<Claim>> {
        let Some(note) = tidy(Some(&a.note), MAX_NOTE_CHARS) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say where the work stands in note, for whoever picks it up."));
        };
        let to = tidy(a.to.as_deref().map(|to| to.trim().trim_start_matches('@')), 100).map(|to| to.to_lowercase());
        if let Some(name) = &to {
            let account: Viewer =
                g1t_kit::call(&self.identity, "user_by_username", &UsernameArgs { username: name.clone() }).await?;
            if account.is_none() {
                return Ok(Outcome::fail(FailureCode::Invalid, format!("There is no account named {name}.")));
            }
        }
        let claim = unwrap_or_fail!(
            self.end_own_claim(&a.actor, &a.repo, a.number, ClaimState::HandedOff, "handed_off", Some((&to, &note)))
                .await?
        );
        self.publish(
            "work.handoff_requested",
            &claim.repo_id.clone(),
            &a.actor,
            ClaimEvent { from: Some(a.actor.username.clone()), to, note: Some(note), ..ClaimEvent::of(&claim) },
        )
        .await?;
        Ok(Outcome::Ok(claim))
    }

    pub(crate) async fn list_claims(&self, a: ListClaimsArgs) -> Result<Outcome<Vec<Claim>>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let state = a.state.unwrap_or(ClaimState::Active);
        let rows = self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE repo_id = ?1 AND state = ?2 AND (?3 IS NULL OR issue = ?3)
                 ORDER BY created_at DESC, id DESC LIMIT ?4"
            ))
            .bind(&[
                repo.id.as_str().into(),
                state.as_str().into(),
                a.issue.filter(|number| *number > 0).map_or(JsValue::NULL, JsValue::from),
                LIST_LIMIT.into(),
            ])?
            .all()
            .await?
            .results::<ClaimRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Claim::from).collect()))
    }

    /// An issue closed: its active claims end as released (`issue_closed`),
    /// each announced.
    pub(crate) async fn release_claims_on_close(&self, repo_id: &str, issue: u32, actor: Option<&User>) -> Result<()> {
        let at = rfc3339(now_ms());
        let released = self
            .db
            .prepare(format!(
                "UPDATE claims SET state = 'released', ended_at = ?, end_reason = 'issue_closed'
                 WHERE repo_id = ? AND issue = ? AND state = 'active'
                 RETURNING {CLAIM_COLUMNS}"
            ))
            .bind(&[at.into(), repo_id.into(), issue.into()])?
            .all()
            .await?
            .results::<ClaimRow>()?;
        for row in released {
            let claim = Claim::from(row);
            let data = ClaimEvent { reason: Some("issue_closed".to_owned()), ..ClaimEvent::of(&claim) };
            match actor {
                Some(actor) => self.publish("work.released", repo_id, actor, data).await?,
                None => self.publish_as("work.released", repo_id, None, data).await?,
            }
        }
        Ok(())
    }
}
