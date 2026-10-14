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

use g1t_contracts::credentials::Principal;

use super::updates::push_delivery;
use super::{CLAIM_COLUMNS, ClaimRow, after_minutes, tidy, unwrap_or_fail};
use crate::Work;

/// The most claims one list returns.
const LIST_LIMIT: u32 = 100;

/// Resolve ownership and insert/renew in one SQLite statement. In particular,
/// two requests that both read no claim must converge on the same row.
/// Sessionless claims retain the caller-wide semantics of claim_is_mine.
pub(super) fn upsert_claim_sql() -> String {
    format!(
        "INSERT INTO claims
           (id, repo_id, issue, session_id, actor_id, actor_name, harness, note, state, ttl_minutes,
            created_at, expires_at)
         VALUES (COALESCE((SELECT id FROM claims
                    WHERE repo_id = ?2 AND issue = ?3 AND actor_id = ?5 AND state = 'active'
                      AND (session_id IS NULL OR ?4 IS NULL OR session_id = ?4)
                    ORDER BY created_at, id LIMIT 1), ?1),
                 ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           expires_at = MAX(claims.expires_at, excluded.expires_at), ttl_minutes = excluded.ttl_minutes,
           note = COALESCE(excluded.note, claims.note),
           session_id = COALESCE(excluded.session_id, claims.session_id),
           harness = COALESCE(excluded.harness, claims.harness)
         WHERE claims.state = 'active'
         RETURNING {CLAIM_COLUMNS}"
    )
}

fn text_or_null(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

impl Work {
    /// The caller's active claim on an issue, if they hold one.
    async fn own_claim(&self, repo_id: &str, issue: u32, actor: &User, session: Option<&str>) -> Result<Option<Claim>> {
        Ok(self
            .active_claims(repo_id, issue)
            .await?
            .into_iter()
            .find(|claim| claim_is_mine(&claim.actor.id, claim.session_id.as_deref(), &actor.id, session)))
    }

    /// `claim_issue`: the issue named, or with a `title` and no number, a
    /// new one opened for it, with the claim's session attached to it.
    pub(crate) async fn claim_issue(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        if a.number == 0 {
            return self.open_and_claim(a).await;
        }
        self.claim_number(a).await
    }

    /// Opens an issue from `title` and `body`, claims it, and attaches the
    /// claim's session to it. The session is checked before anything is
    /// opened, so a claim that would be refused opens no issue.
    async fn open_and_claim(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        let Some(title) = a.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).map(str::to_owned) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the issue by its number, or give a title (and body) to open one."));
        };
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let session_id = a.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned);
        if let Some(id) = &session_id {
            match self.session_row(&repo.id, id).await? {
                Some(row) if row.actor_id == a.actor.id => {
                    if row.at(now_ms()).state == SessionState::Ended {
                        return Ok(Outcome::fail(FailureCode::Invalid, "That session has ended. Start a new one."));
                    }
                }
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "session_id is not one of your sessions in this repository.")),
            }
        }
        let opened = unwrap_or_fail!(
            self.open_issue(OpenIssueArgs {
                actor: a.actor.clone(),
                repo: a.repo.clone(),
                title,
                body: a.body.clone().unwrap_or_default(),
                labels: Vec::new(),
                checks: Vec::new(),
                milestone: None,
            })
            .await?
        );
        let claimed = unwrap_or_fail!(
            self.claim_number(ClaimArgs { number: opened.number, title: None, body: None, session_id: session_id.clone(), ..a.clone() })
                .await?
        );
        // The session is on the issue now, not only tied to it by the claim.
        if let Some(id) = session_id {
            let attached = self
                .update_session(UpdateSessionArgs {
                    actor: a.actor.clone(),
                    repo: a.repo.clone(),
                    id,
                    issue: Some(opened.number),
                    pull: None,
                    branch: None,
                    head_commit: None,
                    title: None,
                    agent_type: None,
                    task: None,
                    prompt: None,
                    model: None,
                    result: None,
                })
                .await?;
            if let Outcome::Fail(failure) = attached {
                worker::console_error!("#{}: the session was not attached: {}", opened.number, failure.message);
            }
        }
        Ok(Outcome::Ok(Claimed { issue: Some(opened), ..claimed }))
    }

    async fn claim_number(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
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
        let (mine, others): (Vec<Claim>, Vec<Claim>) = standing
            .into_iter()
            .partition(|claim| claim_is_mine(&claim.actor.id, claim.session_id.as_deref(), &a.actor.id, session_id.as_deref()));
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
                if let Some(session_id) = &session_id {
                    self.link(session_id, &repo.id, LinkKind::Issue, issue.number, LinkVia::Claim).await;
                }
                return Ok(Outcome::Ok(Claimed { claim: renewed.into(), others, blocked_by, issue: None }));
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
        let proposed_id = new_id("clm", now);
        // A new claim is announced with itself; a renewal (the claim found
        // is an older one of the caller's) is not.
        let proposed = Claim {
            id: proposed_id.clone(),
            repo_id: repo.id.clone(),
            issue: issue.number,
            session_id: session_id.clone(),
            actor: Principal { id: a.actor.id.clone(), username: a.actor.username.clone() },
            harness: harness.as_deref().and_then(Harness::parse),
            note: note.clone(),
            state: ClaimState::Active,
            created_at: at.clone(),
            expires_at: expires_at.clone(),
            ended_at: None,
            end_reason: None,
            handoff_to: None,
        };
        let event = |claim: &Claim| {
            g1t_contracts::events::marked(
                ClaimEvent { others: Some(others.clone()), took_over: took_over.clone(), ..ClaimEvent::of(claim) },
                Some(&a.actor),
            )
        };
        let mut statements = vec![self
            .db
            .prepare(upsert_claim_sql())
            .bind(&[
                proposed_id.as_str().into(),
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
            ])?];
        let sent = push_delivery(
            &mut statements,
            self.delivery(
                "work.claimed",
                &repo.id,
                event(&proposed),
                &format!("{proposed_id}:claimed"),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7)",
                vec![proposed_id.as_str().into()],
            )?,
        );
        let created = match self.db.batch(statements).await?.into_iter().next() {
            Some(result) => result.results::<ClaimRow>()?.into_iter().next(),
            None => None,
        };
        let Some(created) = created else {
            return Err(worker::Error::RustError("the claim was not recorded".into()));
        };
        let claim = Claim::from(created);
        if let Some(session_id) = &claim.session_id {
            self.link(session_id, &repo.id, LinkKind::Issue, claim.issue, LinkVia::Claim).await;
        }
        if claim.id != proposed_id {
            return Ok(Outcome::Ok(Claimed { claim, others, blocked_by, issue: None }));
        }
        self.delivered(sent, "work.claimed", &repo.id, Some(a.actor.id.clone()), event(&claim)).await?;
        Ok(Outcome::Ok(Claimed { claim, others, blocked_by, issue: None }))
    }

    /// Ends the caller's active claim on an issue as `state`, announced as
    /// `kind` with the event `event` makes of it, or refuses when they hold
    /// none.
    #[allow(clippy::too_many_arguments)]
    async fn end_own_claim(
        &self,
        actor: &User,
        repo: &g1t_contracts::repos::RepoPath,
        number: u32,
        state: ClaimState,
        reason: &str,
        handoff: Option<(&Option<String>, &str)>,
        session: Option<&str>,
        kind: &'static str,
        event: impl Fn(&Claim) -> ClaimEvent,
    ) -> Result<Outcome<Claim>> {
        let repo = unwrap_or_fail!(self.participating_repo(repo, actor).await?);
        let Some(held) = self.own_claim(&repo.id, number, actor, session.map(str::trim).filter(|id| !id.is_empty())).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("You hold no claim on #{number}.")));
        };
        let at = rfc3339(now_ms());
        let expected = Claim {
            state,
            ended_at: Some(at.clone()),
            end_reason: Some(reason.to_owned()),
            handoff_to: handoff.and_then(|(to, _)| to.clone()),
            note: handoff.map(|(_, note)| note.to_owned()).or(held.note.clone()),
            ..held.clone()
        };
        let (handoff_to, note) = match handoff {
            Some((to, note)) => (text_or_null(to), JsValue::from(note)),
            None => (JsValue::NULL, JsValue::NULL),
        };
        let mut statements = vec![self
            .db
            .prepare(format!(
                "UPDATE claims
                 SET state = ?, ended_at = ?, end_reason = ?, handoff_to = ?, note = COALESCE(?, note)
                 WHERE id = ? AND state = 'active'
                 RETURNING {CLAIM_COLUMNS}"
            ))
            .bind(&[state.as_str().into(), at.as_str().into(), reason.into(), handoff_to, note, held.id.as_str().into()])?];
        // A claim ends once: its id and how it ended name the change.
        let sent = push_delivery(
            &mut statements,
            self.delivery(
                kind,
                &repo.id,
                g1t_contracts::events::marked(event(&expected), Some(actor)),
                &format!("{}:{}", held.id, state.as_str()),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7 AND state = ?8)",
                vec![held.id.as_str().into(), state.as_str().into()],
            )?,
        );
        let ended = match self.db.batch(statements).await?.into_iter().next() {
            Some(result) => result.results::<ClaimRow>()?.into_iter().next(),
            None => None,
        };
        let Some(row) = ended else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("You hold no claim on #{number}.")));
        };
        let claim = Claim::from(row);
        let data = g1t_contracts::events::marked(event(&claim), Some(actor));
        self.delivered(sent, kind, &repo.id, Some(actor.id.clone()), data).await?;
        Ok(Outcome::Ok(claim))
    }

    pub(crate) async fn release_claim(&self, a: ReleaseArgs) -> Result<Outcome<Claim>> {
        let reason = tidy(a.reason.as_deref(), MAX_NOTE_CHARS).unwrap_or_else(|| "released".to_owned());
        let claim = unwrap_or_fail!(
            self.end_own_claim(
                &a.actor,
                &a.repo,
                a.number,
                ClaimState::Released,
                &reason,
                None,
                a.session_id.as_deref(),
                "work.released",
                |claim| ClaimEvent { reason: Some(reason.clone()), ..ClaimEvent::of(claim) },
            )
            .await?
        );
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
            self.end_own_claim(
                &a.actor,
                &a.repo,
                a.number,
                ClaimState::HandedOff,
                "handed_off",
                Some((&to, &note)),
                a.session_id.as_deref(),
                "work.handoff_requested",
                |claim| ClaimEvent {
                    from: Some(a.actor.username.clone()),
                    to: to.clone(),
                    note: Some(note.clone()),
                    ..ClaimEvent::of(claim)
                },
            )
            .await?
        );
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
        let active = self.active_claims(repo_id, issue).await?;
        if active.is_empty() {
            return Ok(());
        }
        let event = |claim: &Claim| {
            g1t_contracts::events::marked(
                ClaimEvent { reason: Some("issue_closed".to_owned()), ..ClaimEvent::of(claim) },
                actor,
            )
        };
        // Each claim's release and its updates are one change, in one batch.
        let mut statements = Vec::new();
        let mut sent = Vec::new();
        for held in &active {
            statements.push(
                self.db
                    .prepare(format!(
                        "UPDATE claims SET state = 'released', ended_at = ?, end_reason = 'issue_closed'
                         WHERE id = ? AND state = 'active'
                         RETURNING {CLAIM_COLUMNS}"
                    ))
                    .bind(&[at.as_str().into(), held.id.as_str().into()])?,
            );
            let expected = Claim {
                state: ClaimState::Released,
                ended_at: Some(at.clone()),
                end_reason: Some("issue_closed".to_owned()),
                ..held.clone()
            };
            let delivery = self.delivery(
                "work.released",
                repo_id,
                event(&expected),
                &format!("{}:{}", held.id, ClaimState::Released.as_str()),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7 AND state = 'released')",
                vec![held.id.as_str().into()],
            )?;
            let index = statements.len() - 1;
            sent.push((index, push_delivery(&mut statements, delivery)));
        }
        let results = self.db.batch(statements).await?;
        for (index, sent) in sent {
            let Some(row) = results.get(index).map(|result| result.results::<ClaimRow>()).transpose()?.and_then(|rows| rows.into_iter().next())
            else {
                continue;
            };
            let claim = Claim::from(row);
            self.delivered(sent, "work.released", repo_id, actor.map(|actor| actor.id.clone()), event(&claim)).await?;
        }
        Ok(())
    }
}
