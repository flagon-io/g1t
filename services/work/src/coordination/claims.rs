//! Claims: an advisory, expiring "I'm working on #N".
//!
//! A claim is never a lock: anyone may claim a work item someone else has
//! claimed, and is told who else is on it. It lapses unless renewed, by
//! claiming again or by a heartbeat of the session it was made from, and
//! ends when released, handed off, or when its work item closes. It is on
//! a work item of a workspace, and made from a checkout of one of the
//! workspace's repositories when it names one.

use g1t_contracts::access::Capability;
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use g1t_contracts::credentials::Principal;

use super::updates::push_delivery;
use super::{CLAIM_COLUMNS, ClaimRow, SessionRow, after_minutes, tidy, unwrap_or_fail};
use crate::Work;
use crate::items::{self, Held, workspace_of};

/// The most claims one list returns.
const LIST_LIMIT: u32 = 100;

/// Resolve ownership and insert/renew in one SQLite statement. In particular,
/// two requests that both read no claim must converge on the same row.
/// Sessionless claims retain the caller-wide semantics of claim_is_mine.
/// `?2` is the work item, `?3` the repository it is claimed from.
pub(crate) fn upsert_claim_sql() -> String {
    format!(
        "INSERT INTO claims
           (id, item_id, repo_id, session_id, actor_id, actor_name, harness, note, state, ttl_minutes,
            created_at, expires_at)
         VALUES (COALESCE((SELECT id FROM claims
                    WHERE item_id = ?2 AND actor_id = ?5 AND state = 'active'
                      AND (session_id IS NULL OR ?4 IS NULL OR session_id = ?4)
                    ORDER BY created_at, id LIMIT 1), ?1),
                 ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           expires_at = MAX(claims.expires_at, excluded.expires_at), ttl_minutes = excluded.ttl_minutes,
           note = COALESCE(excluded.note, claims.note),
           session_id = COALESCE(excluded.session_id, claims.session_id),
           repo_id = COALESCE(excluded.repo_id, claims.repo_id),
           harness = COALESCE(excluded.harness, claims.harness)
         WHERE claims.state = 'active'
         RETURNING {CLAIM_COLUMNS}"
    )
}

fn text_or_null(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

/// The repositories a claim's updates go to: those its work item is linked
/// to, and the one it was made from.
fn claim_repos(held: &Held, repo_id: Option<&str>) -> Vec<String> {
    let mut repos = held.repo_ids();
    if let Some(repo_id) = repo_id
        && !repos.iter().any(|known| known == repo_id)
    {
        repos.push(repo_id.to_owned());
    }
    repos
}

/// Why a claim on a work item of `workspace` may not be made from the
/// repository in workspace `repo` (if one is named) or from a session
/// whose repository is in workspace `session` (if one is named; `None`
/// inside when the repository is not known): either in another
/// workspace. `None` when it may.
fn outside_workspace(workspace: &str, repo: Option<&str>, session: Option<Option<&str>>) -> Option<String> {
    let other = |slug: &str| !slug.eq_ignore_ascii_case(workspace);
    if repo.is_some_and(other) {
        return Some(format!("That repository is not in {workspace}, the work item's workspace."));
    }
    if session.is_some_and(|slug| slug.is_none_or(other)) {
        return Some(format!("That session is not in a repository of {workspace}, the work item's workspace."));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::outside_workspace;

    #[test]
    fn a_claim_is_made_only_from_the_work_items_workspace() {
        assert_eq!(outside_workspace("acme", None, None), None);
        assert_eq!(outside_workspace("acme", Some("Acme"), Some(Some("acme"))), None);
        assert!(outside_workspace("acme", Some("globex"), None).is_some());
        assert!(outside_workspace("acme", None, Some(Some("globex"))).is_some());
        assert!(outside_workspace("acme", None, Some(None)).is_some());
    }
}

impl Work {
    /// The caller's active claim on a work item, if they hold one.
    async fn own_claim(&self, item_id: &str, actor: &User, session: Option<&str>) -> Result<Option<Claim>> {
        Ok(self
            .active_claims(item_id)
            .await?
            .into_iter()
            .find(|claim| claim_is_mine(&claim.actor.id, claim.session_id.as_deref(), &actor.id, session)))
    }

    /// One of `actor`'s sessions, in `repo` when one is named, else in any
    /// repository.
    async fn actor_session(&self, repo: Option<&Repo>, actor: &User, id: &str) -> Result<Option<SessionRow>> {
        let row = match repo {
            Some(repo) => self.session_row(&repo.id, id).await?,
            None => self
                .db
                .prepare(format!("SELECT {} FROM sessions WHERE id = ?", super::SESSION_COLUMNS))
                .bind(&[id.into()])?
                .first::<SessionRow>(None)
                .await?,
        };
        Ok(row.filter(|row| row.actor_id == actor.id))
    }

    /// The repository a claim is made from, if `actor` may take part in it.
    async fn claiming_repo(&self, repo: Option<&RepoPath>, actor: &User) -> Result<Outcome<Option<Repo>>> {
        Ok(match repo {
            Some(path) => Outcome::Ok(Some(unwrap_or_fail!(self.participating_repo(path, actor).await?))),
            None => {
                if !actor.verified {
                    return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
                }
                Outcome::Ok(None)
            }
        })
    }

    /// `claim_work_item`: the work item named, or with a `title` and no
    /// number, a new one opened for it, with the claim's session attached
    /// to it.
    pub(crate) async fn claim_work_item(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        if a.number == 0 {
            return self.open_and_claim(a).await;
        }
        self.claim_number(a).await
    }

    /// Opens a work item from `title` and `body`, filed from `repo` when
    /// given, claims it, and attaches the claim's session to it. The
    /// session is checked before anything is opened, so a claim that would
    /// be refused opens nothing.
    async fn open_and_claim(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        let Some(title) = a.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).map(str::to_owned) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the work item by its number, or give a title (and body) to open one."));
        };
        let repo = unwrap_or_fail!(self.claiming_repo(a.repo.as_ref(), &a.actor).await?);
        let session_id = a.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned);
        let mut session_repo = None;
        if let Some(id) = &session_id {
            match self.actor_session(repo.as_ref(), &a.actor, id).await? {
                Some(row) => {
                    if row.clone().at(now_ms()).state == SessionState::Ended {
                        return Ok(Outcome::fail(FailureCode::Invalid, "That session has ended. Start a new one."));
                    }
                    session_repo = Some(row.repo_id.clone());
                }
                None => return Ok(Outcome::fail(FailureCode::Invalid, "session_id is not one of your sessions in this repository.")),
            }
        }
        let opened = unwrap_or_fail!(
            self.open_work_item(OpenWorkItemArgs {
                actor: a.actor.clone(),
                workspace: workspace_of(&a.workspace, a.repo.as_ref()),
                repo: a.repo.clone(),
                targets: Vec::new(),
                title,
                body: a.body.clone().unwrap_or_default(),
                labels: Vec::new(),
                milestone: None,
                parent: None,
                project: None,
            })
            .await?
        );
        let claimed = unwrap_or_fail!(
            self.claim_number(ClaimArgs {
                workspace: opened.workspace.clone(),
                number: opened.number,
                title: None,
                body: None,
                session_id: session_id.clone(),
                ..a.clone()
            })
            .await?
        );
        // The session is on the work item now, not only tied to it by the claim.
        if let (Some(id), Some(session_repo)) = (session_id, session_repo) {
            let path: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: session_repo }).await?;
            // A session in another workspace's repository names none of
            // this one's work items.
            if let Some(path) = path.filter(|path| path.namespace.eq_ignore_ascii_case(&opened.workspace)) {
                let attached = self
                    .update_session(UpdateSessionArgs {
                        actor: a.actor.clone(),
                        repo: path,
                        id,
                        item: Some(opened.number),
                        pull: None,
                        branch: None,
                        head_commit: None,
                        title: None,
                        agent_type: None,
                        task: None,
                        prompt: None,
                        model: None,
                        result: None,
                        usage: None,
                    })
                    .await?;
                if let Outcome::Fail(failure) = attached {
                    worker::console_error!("#{}: the session was not attached: {}", opened.number, failure.message);
                }
            }
        }
        Ok(Outcome::Ok(Claimed { item: Some(opened), ..claimed }))
    }

    async fn claim_number(&self, a: ClaimArgs) -> Result<Outcome<Claimed>> {
        let repo = unwrap_or_fail!(self.claiming_repo(a.repo.as_ref(), &a.actor).await?);
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        let held = unwrap_or_fail!(items::for_viewer(self, &Some(a.actor.clone()), &workspace, a.number, Capability::Participate).await?);
        if held.item.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("#{} is closed.", held.item.number)));
        }
        // The session it is made from, whose heartbeats renew it.
        let session = match a.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => match self.actor_session(repo.as_ref(), &a.actor, id).await? {
                Some(row) => Some(row.at(now_ms())),
                None => return Ok(Outcome::fail(FailureCode::Invalid, "session_id is not one of your sessions in this repository.")),
            },
            None => None,
        };
        if session.as_ref().is_some_and(|session| session.state == SessionState::Ended) {
            return Ok(Outcome::fail(FailureCode::Invalid, "That session has ended. Start a new one."));
        }
        // Only a repository, or a session in one, of the work item's own
        // workspace is tied to it.
        let session_workspace = match &session {
            Some(session) => Some(items::repo_workspace(self, &session.repo_id).await?),
            None => None,
        };
        if let Some(refusal) = outside_workspace(
            &held.item.workspace,
            repo.as_ref().map(|repo| repo.namespace.as_str()),
            session_workspace.as_ref().map(Option::as_deref),
        ) {
            return Ok(Outcome::fail(FailureCode::Invalid, refusal));
        }
        let repo_id = repo.as_ref().map(|repo| repo.id.clone()).or_else(|| session.as_ref().map(|session| session.repo_id.clone()));
        let minutes = claim_minutes(a.ttl_minutes);
        let note = tidy(a.note.as_deref(), MAX_NOTE_CHARS);
        let session_id = session.as_ref().map(|session| session.id.clone());
        let harness = session.as_ref().map(|session| session.harness.as_str().to_owned());
        let now = now_ms();
        let expires_at = after_minutes(now, minutes);
        let standing = self.active_claims(&held.item.id).await?;
        let (mine, others): (Vec<Claim>, Vec<Claim>) = standing
            .into_iter()
            .partition(|claim| claim_is_mine(&claim.actor.id, claim.session_id.as_deref(), &a.actor.id, session_id.as_deref()));
        // The others, as far as the actor may read where they are.
        let claimed_in: Vec<String> = others.iter().filter_map(|claim| claim.repo_id.clone()).collect();
        let readable = items::readable_repo_ids(self, Some(&a.actor), &claimed_in).await?;
        let others: Vec<Claim> =
            others.into_iter().filter(|claim| claim.repo_id.as_ref().is_none_or(|id| readable.contains(id))).collect();
        let blocked_by = self.blockers(Some(&a.actor), &held.item.workspace, &held.item.blocked_by).await?;
        let repos = claim_repos(&held, repo_id.as_deref());
        // Claiming what you hold renews it.
        if let Some(held_claim) = mine.into_iter().next() {
            let renewed = self
                .db
                .prepare(format!(
                    "UPDATE claims
                     SET expires_at = ?, ttl_minutes = ?, note = COALESCE(?, note),
                         session_id = COALESCE(?, session_id), harness = COALESCE(?, harness),
                         repo_id = COALESCE(?, repo_id)
                     WHERE id = ? AND state = 'active'
                     RETURNING {CLAIM_COLUMNS}"
                ))
                .bind(&[
                    expires_at.as_str().into(),
                    minutes.into(),
                    text_or_null(&note),
                    text_or_null(&session_id),
                    text_or_null(&harness),
                    text_or_null(&repo_id),
                    held_claim.id.as_str().into(),
                ])?
                .first::<ClaimRow>(None)
                .await?;
            if let Some(renewed) = renewed {
                if let (Some(session_id), Some(repo_id)) = (&session_id, &repo_id) {
                    self.link_item(session_id, repo_id, &held.item.id, LinkVia::Claim).await;
                }
                return Ok(Outcome::Ok(Claimed { claim: renewed.into(), others, blocked_by, item: None }));
            }
        }
        // Taking over what was handed off to you, or to anyone.
        let handed: Option<ClaimRow> = self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE item_id = ? AND state <> 'active' ORDER BY ended_at DESC, id DESC LIMIT 1"
            ))
            .bind(&[held.item.id.as_str().into()])?
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
            repo_id: repo_id.clone(),
            workspace: held.item.workspace.clone(),
            item: held.item.number,
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
                ClaimEvent { others: Some(others.clone()), took_over: took_over.clone(), ..ClaimEvent::of(claim, &repos) },
                Some(&a.actor),
            )
        };
        let mut statements = vec![self
            .db
            .prepare(upsert_claim_sql())
            .bind(&[
                proposed_id.as_str().into(),
                held.item.id.as_str().into(),
                text_or_null(&repo_id),
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
            self.delivery_to(
                "work.claimed",
                &repos,
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
        if let (Some(session_id), Some(repo_id)) = (&claim.session_id, &claim.repo_id) {
            self.link_item(session_id, repo_id, &held.item.id, LinkVia::Claim).await;
        }
        if claim.id != proposed_id {
            return Ok(Outcome::Ok(Claimed { claim, others, blocked_by, item: None }));
        }
        self.delivered(sent, "work.claimed", held.event_repo().unwrap_or_default(), Some(a.actor.id.clone()), event(&claim)).await?;
        Ok(Outcome::Ok(Claimed { claim, others, blocked_by, item: None }))
    }

    /// Ends the caller's active claim on a work item as `state`, announced
    /// as `kind` with the event `event` makes of it, or refuses when they
    /// hold none.
    #[allow(clippy::too_many_arguments)]
    async fn end_own_claim(
        &self,
        actor: &User,
        workspace: &str,
        repo: Option<&RepoPath>,
        number: u32,
        state: ClaimState,
        reason: &str,
        handoff: Option<(&Option<String>, &str)>,
        session: Option<&str>,
        kind: &'static str,
        event: impl Fn(&Claim, &[String]) -> ClaimEvent,
    ) -> Result<Outcome<Claim>> {
        unwrap_or_fail!(self.claiming_repo(repo, actor).await?);
        let workspace = workspace_of(workspace, repo);
        let held = unwrap_or_fail!(items::for_viewer(self, &Some(actor.clone()), &workspace, number, Capability::Read).await?);
        let Some(claim) = self.own_claim(&held.item.id, actor, session.map(str::trim).filter(|id| !id.is_empty())).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("You hold no claim on #{number}.")));
        };
        let repos = claim_repos(&held, claim.repo_id.as_deref());
        let at = rfc3339(now_ms());
        let expected = Claim {
            state,
            ended_at: Some(at.clone()),
            end_reason: Some(reason.to_owned()),
            handoff_to: handoff.and_then(|(to, _)| to.clone()),
            note: handoff.map(|(_, note)| note.to_owned()).or(claim.note.clone()),
            ..claim.clone()
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
            .bind(&[state.as_str().into(), at.as_str().into(), reason.into(), handoff_to, note, claim.id.as_str().into()])?];
        // A claim ends once: its id and how it ended name the change.
        let sent = push_delivery(
            &mut statements,
            self.delivery_to(
                kind,
                &repos,
                g1t_contracts::events::marked(event(&expected, &repos), Some(actor)),
                &format!("{}:{}", claim.id, state.as_str()),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7 AND state = ?8)",
                vec![claim.id.as_str().into(), state.as_str().into()],
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
        let data = g1t_contracts::events::marked(event(&claim, &repos), Some(actor));
        self.delivered(sent, kind, held.event_repo().unwrap_or_default(), Some(actor.id.clone()), data).await?;
        Ok(Outcome::Ok(claim))
    }

    pub(crate) async fn release_claim(&self, a: ReleaseArgs) -> Result<Outcome<Claim>> {
        let reason = tidy(a.reason.as_deref(), MAX_NOTE_CHARS).unwrap_or_else(|| "released".to_owned());
        let claim = unwrap_or_fail!(
            self.end_own_claim(
                &a.actor,
                &a.workspace,
                a.repo.as_ref(),
                a.number,
                ClaimState::Released,
                &reason,
                None,
                a.session_id.as_deref(),
                "work.released",
                |claim, repos| ClaimEvent { reason: Some(reason.clone()), ..ClaimEvent::of(claim, repos) },
            )
            .await?
        );
        Ok(Outcome::Ok(claim))
    }

    pub(crate) async fn hand_off_work_item(&self, a: HandOffArgs) -> Result<Outcome<Claim>> {
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
                &a.workspace,
                a.repo.as_ref(),
                a.number,
                ClaimState::HandedOff,
                "handed_off",
                Some((&to, &note)),
                a.session_id.as_deref(),
                "work.handoff_requested",
                |claim, repos| ClaimEvent {
                    from: Some(a.actor.username.clone()),
                    to: to.clone(),
                    note: Some(note.clone()),
                    ..ClaimEvent::of(claim, repos)
                },
            )
            .await?
        );
        Ok(Outcome::Ok(claim))
    }

    /// A workspace's claims on the work items the viewer may see; with a
    /// repository, those made from it or on work items linked to it.
    pub(crate) async fn list_claims(&self, a: ListClaimsArgs) -> Result<Outcome<Vec<Claim>>> {
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        let repo = match &a.repo {
            Some(path) => Some(unwrap_or_fail!(self.coordination_repo(path, &a.viewer).await?)),
            None => None,
        };
        let state = a.state.unwrap_or(ClaimState::Active);
        let rows = self
            .db
            .prepare(format!(
                "SELECT {CLAIM_COLUMNS} FROM claims
                 WHERE state = ?2 AND {workspace} = ?1 AND (?3 IS NULL OR {number} = ?3)
                   AND (?4 IS NULL OR repo_id = ?4 OR item_id IN {linked})
                 ORDER BY created_at DESC, id DESC LIMIT ?5",
                workspace = items::sql::item_workspace!("claims.item_id"),
                number = items::sql::item_number!("claims.item_id"),
                linked = items::sql::items_linked_to!("?4"),
            ))
            .bind(&[
                workspace.as_str().into(),
                state.as_str().into(),
                a.item.filter(|number| *number > 0).map_or(JsValue::NULL, JsValue::from),
                text_or_null(&repo.as_ref().map(|repo| repo.id.clone())),
                LIST_LIMIT.into(),
            ])?
            .all()
            .await?
            .results::<ClaimRow>()?;
        let mut ids: Vec<String> = rows.iter().map(|row| row.item_id.clone()).collect();
        ids.sort();
        ids.dedup();
        let seen: Vec<String> = items::by_ids(self, &ids)
            .await?
            .into_iter()
            .filter(|held| held.may(a.viewer.as_ref(), Capability::Read))
            .map(|held| held.item.id)
            .collect();
        Ok(Outcome::Ok(rows.into_iter().filter(|row| seen.contains(&row.item_id)).map(Claim::from).collect()))
    }

    /// A work item closed: its active claims end as released
    /// (`item_closed`), each announced.
    pub(crate) async fn release_claims_on_close(&self, held: &Held, actor: Option<&User>) -> Result<()> {
        let at = rfc3339(now_ms());
        let active = self.active_claims(&held.item.id).await?;
        if active.is_empty() {
            return Ok(());
        }
        let event = |claim: &Claim| {
            let repos = claim_repos(held, claim.repo_id.as_deref());
            g1t_contracts::events::marked(ClaimEvent { reason: Some("item_closed".to_owned()), ..ClaimEvent::of(claim, &repos) }, actor)
        };
        // Each claim's release and its updates are one change, in one batch.
        let mut statements = Vec::new();
        let mut sent = Vec::new();
        for claim in &active {
            statements.push(
                self.db
                    .prepare(format!(
                        "UPDATE claims SET state = 'released', ended_at = ?, end_reason = 'item_closed'
                         WHERE id = ? AND state = 'active'
                         RETURNING {CLAIM_COLUMNS}"
                    ))
                    .bind(&[at.as_str().into(), claim.id.as_str().into()])?,
            );
            let expected = Claim {
                state: ClaimState::Released,
                ended_at: Some(at.clone()),
                end_reason: Some("item_closed".to_owned()),
                ..claim.clone()
            };
            let delivery = self.delivery_to(
                "work.released",
                &claim_repos(held, claim.repo_id.as_deref()),
                event(&expected),
                &format!("{}:{}", claim.id, ClaimState::Released.as_str()),
                "EXISTS (SELECT 1 FROM claims WHERE id = ?7 AND state = 'released')",
                vec![claim.id.as_str().into()],
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
            let repo = claim.repo_id.clone().or_else(|| held.event_repo().map(str::to_owned)).unwrap_or_default();
            self.delivered(sent, "work.released", &repo, actor.map(|actor| actor.id.clone()), event(&claim)).await?;
        }
        Ok(())
    }
}
