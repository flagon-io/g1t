//! Sessions: one run of someone's own harness on a repository.
//!
//! Starting one is idempotent on the harness's own session id, so a hook
//! that fires twice, or a harness that reconnects, gets the same session
//! back. Every update, and every batch of entries, is a heartbeat: it keeps
//! the session active, brings back one that timed out, and renews the
//! claims made from it. Only the person whose token started a session
//! changes it; anyone with write access may also end it, for one left
//! behind (recorded as ended by hand by them).
//!
//! A subagent is a session of its own with a parent (`parent_id`): a
//! Claude Code subagent, a Managed Agents thread. It starts on what its
//! parent is on unless it says otherwise, keeps the task, prompt and
//! result its parent gave and got (cut short), and once ended stays ended
//! even if a late hook starts it again: a subagent never comes back. Its
//! heartbeats keep its parent seen, and ending a session ends the
//! subagents it left going.

use g1t_contracts::events::SessionAppended;
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::links::{PULL_SESSIONS, PullSessionRow, count_subagents, end_tree_sql, pull_sessions_of, tree_sql};

/// The most pull requests one `pull_sessions` asks about.
const MAX_PULL_SESSIONS: usize = 100;
use super::updates::push_delivery;
use super::{SESSION_COLUMNS, SessionRow, after_minutes, shown, tidy, titles, unwrap_or_fail};
use crate::Work;
use crate::items;
use crate::rows::NumberRow;

/// The most entries one look at a session returns.
const ENTRY_PAGE: u32 = 500;
/// The most sessions one list returns.
const LIST_LIMIT: u32 = 100;
const MAX_TITLE_CHARS: usize = MAX_SESSION_TITLE_CHARS;
const MAX_BRANCH_CHARS: usize = 255;
const MAX_ID_CHARS: usize = 200;
const MAX_COMMIT_CHARS: usize = 64;
const MAX_AGENT_CHARS: usize = 100;
const MAX_MODEL_CHARS: usize = 100;
/// How long one prompt entry may be before its `#N` go unread.
const MAX_REF_TEXT: usize = 8_000;

fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Session not found.")
}

fn text_or_null(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

fn number_or_null(value: Option<u32>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// Long text as kept: trimmed, cut to `limit` characters with an ellipsis.
fn clip(text: Option<&str>, limit: usize) -> Option<String> {
    let text = text?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= limit {
        return Some(text.to_owned());
    }
    let cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// What a session's heartbeat may change, tidied.
#[derive(Default)]
struct Fields {
    /// Its work item, by id and number.
    item: Option<(String, u32)>,
    pull: Option<u32>,
    branch: Option<String>,
    head_commit: Option<String>,
    title: Option<String>,
    agent_type: Option<String>,
    task: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    result: Option<String>,
}

impl Fields {
    fn binds(&self) -> Vec<JsValue> {
        vec![
            self.item.as_ref().map_or(JsValue::NULL, |(id, _)| JsValue::from(id.as_str())),
            number_or_null(self.pull),
            text_or_null(&self.branch),
            text_or_null(&self.head_commit),
            text_or_null(&self.title),
            text_or_null(&self.agent_type),
            text_or_null(&self.task),
            text_or_null(&self.prompt),
            text_or_null(&self.model),
            text_or_null(&self.result),
        ]
    }

    /// The text whose `#N` tie the session to work items and pull requests.
    fn named(&self) -> String {
        [&self.title, &self.task, &self.prompt].into_iter().flatten().cloned().collect::<Vec<_>>().join("\n")
    }
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
           (id, repo_id, item_id, pull, branch, actor_id, actor_name, harness, harness_session_id,
            title, state, head_commit, started_at, last_seen_at, parent_id, agent_type, task, prompt, model,
            title_source, title_settled_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
            CASE WHEN ?10 IS NULL THEN NULL ELSE 'agent' END, CASE WHEN ?10 IS NULL THEN NULL ELSE ?12 END)
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

/// The fields `?1`–`?10` of [`Fields::binds`], each kept when not given;
/// a title as [`titles::SET_TITLE`] takes it, from `?13` (`?11` now).
const SET_FIELDS: &str = "item_id = COALESCE(?1, item_id), pull = COALESCE(?2, pull), branch = COALESCE(?3, branch),
     head_commit = COALESCE(?4, head_commit),
     agent_type = COALESCE(?6, agent_type), task = COALESCE(?7, task), prompt = COALESCE(?8, prompt),
     model = COALESCE(?9, model), result = COALESCE(?10, result)";

/// A heartbeat: seen now (`?11`), active again, with whichever fields are
/// given, of session `?12`; a title given came from `?13`. One that ended
/// is named again as it ends again.
pub(crate) fn resume_sql() -> String {
    format!(
        "UPDATE sessions
         SET {SET_FIELDS}, {set_title},
             title_final = CASE WHEN state = 'ended' THEN 0 ELSE title_final END,
             last_seen_at = ?11, state = 'active', ended_at = NULL, end_reason = NULL
         WHERE id = ?12
         RETURNING {SESSION_COLUMNS}",
        set_title = titles::SET_TITLE,
    )
}

/// The fields of session `?12`, changed without bringing it back: for a
/// subagent's late hooks (the binds are the same).
pub(crate) fn refresh_sql() -> String {
    format!(
        "UPDATE sessions SET {SET_FIELDS}, {set_title}
         WHERE id = ?12 AND ?11 IS NOT NULL
         RETURNING {SESSION_COLUMNS}",
        set_title = titles::SET_TITLE,
    )
}

/// Session `?3`'s token usage (`?1`, JSON as reported) and the cost
/// estimated from it (`?2`): cumulative, so each report replaces the last.
pub(crate) const SET_USAGE: &str = "UPDATE sessions SET usage = ?1, cost_usd = ?2 WHERE id = ?3";

/// A subagent's heartbeat keeps its parent `?2` seen at `?1`.
pub(crate) const SEE_PARENT: &str = "UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2 AND state = 'active' AND last_seen_at < ?1";

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

/// Marks session `?2` as announced at `?1` when it was last announced at
/// or before `?3` (or never): a row back means it is time to announce.
pub(crate) const MARK_PROGRESS: &str = "UPDATE sessions SET progressed_at = ?1
     WHERE id = ?2 AND (progressed_at IS NULL OR progressed_at <= ?3) RETURNING progressed_at";

/// When a claim of `minutes` renewed at `now` lapses, if that is later
/// than it does already (`expires_at`): a heartbeat never shortens one.
pub(crate) fn renewal(now: u64, minutes: u32, expires_at: &str) -> Option<String> {
    let renewed = after_minutes(now, minutes);
    (renewed.as_str() > expires_at).then_some(renewed)
}

/// Whether a session is a subagent that ended on purpose: it stays ended.
fn finished_subagent(row: &SessionRow) -> bool {
    row.parent_id.is_some() && row.state == "ended" && !revives(row.end_reason.as_deref())
}

impl Work {
    /// The work item and pull request a session names, checked: a work
    /// item of the repository's workspace, and a pull request of the
    /// repository. A pull request for a work item names that item when no
    /// item was given.
    async fn session_subjects(&self, repo: &Repo, item: Option<u32>, pull: Option<u32>) -> Result<Outcome<(Option<(String, u32)>, Option<u32>)>> {
        let workspace = repo.namespace.to_lowercase();
        let mut found_item = None;
        if let Some(number) = item.filter(|number| *number > 0) {
            match items::by_number(self, &workspace, number).await? {
                Some(held) => found_item = Some((held.item.id, number)),
                None => return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not a work item in {workspace}."))),
            }
        }
        let pull = pull.filter(|number| *number > 0);
        if let Some(number) = pull {
            match self.pull(&repo.id, number).await? {
                Some(found) => {
                    if found_item.is_none()
                        && let (Some(id), Some(number)) = (self.pull_item_id(&found.id).await?, found.item)
                    {
                        found_item = Some((id, number));
                    }
                }
                None => {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not a pull request in this repository.")));
                }
            }
        }
        Ok(Outcome::Ok((found_item, pull)))
    }

    /// Ties a session to what it said it is on, and what its text names.
    async fn link_fields(&self, session: &Session, fields: &Fields) -> Result<()> {
        if let Some((id, _)) = &fields.item {
            self.link_item(&session.id, &session.repo_id, id, LinkVia::Attached).await;
        }
        if let Some(number) = fields.pull {
            self.link_pull(&session.id, &session.repo_id, number, LinkVia::Attached).await;
        }
        if let Some(branch) = &fields.branch {
            self.link_branch(&session.id, &session.repo_id, branch).await?;
        }
        let named = fields.named();
        if !named.is_empty() {
            self.link_refs(&session.id, &session.repo_id, &named).await?;
        }
        Ok(())
    }

    pub(crate) async fn start_session(&self, a: StartSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        // A subagent's parent: one of the actor's sessions here.
        let parent = match a.parent_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => match self.session_row(&repo.id, id).await? {
                Some(row) if row.actor_id == a.actor.id => Some(row),
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "parent_id is not one of your sessions in this repository.")),
            },
            None => None,
        };
        let (item, pull) = unwrap_or_fail!(self.session_subjects(&repo, a.item, a.pull).await?);
        let mut fields = Fields {
            item,
            pull,
            branch: tidy(a.branch.as_deref(), MAX_BRANCH_CHARS),
            head_commit: tidy(a.head_commit.as_deref(), MAX_COMMIT_CHARS),
            title: tidy(a.title.as_deref().map(shown::clean).as_deref(), MAX_TITLE_CHARS),
            agent_type: tidy(a.agent_type.as_deref(), MAX_AGENT_CHARS),
            task: clip(a.task.as_deref().map(shown::clean).as_deref(), MAX_TASK_CHARS),
            prompt: clip(a.prompt.as_deref().map(shown::clean).as_deref(), MAX_PROMPT_CHARS),
            model: tidy(a.model.as_deref(), MAX_MODEL_CHARS),
            result: None,
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
        // A subagent works on what its parent does unless it says.
        if let Some(parent) = &parent {
            fields.item = fields.item.clone().or(parent.item_id.clone().zip(parent.item));
            fields.pull = fields.pull.or(parent.pull);
            fields.branch = fields.branch.clone().or(parent.branch.clone());
            fields.head_commit = fields.head_commit.clone().or(parent.head_commit.clone());
        }
        let parent_id = parent.as_ref().map(|parent| parent.id.clone());
        let id = new_id("ses", now);
        // The session as the insert makes it, announced with it.
        let expected = SessionRow {
            id: id.clone(),
            repo_id: repo.id.clone(),
            item_id: fields.item.as_ref().map(|(id, _)| id.clone()),
            item: fields.item.as_ref().map(|(_, number)| *number),
            pull: fields.pull,
            branch: fields.branch.clone(),
            actor_id: a.actor.id.clone(),
            actor_name: a.actor.username.clone(),
            harness: a.harness.as_str().to_owned(),
            harness_session_id: harness_session_id.clone(),
            title: fields.title.clone(),
            state: "active".to_owned(),
            head_commit: fields.head_commit.clone(),
            started_at: at.clone(),
            last_seen_at: at.clone(),
            ended_at: None,
            end_reason: None,
            parent_id: parent_id.clone(),
            agent_type: fields.agent_type.clone(),
            task: fields.task.clone(),
            prompt: fields.prompt.clone(),
            result: None,
            model: fields.model.clone(),
            title_source: fields.title.as_ref().map(|_| TitleSource::Agent.as_str().to_owned()),
            title_settled_at: fields.title.as_ref().map(|_| at.clone()),
            usage: None,
            cost_usd: None,
        }
        .at(now);
        let started = |session: &Session| g1t_contracts::events::marked(SessionEvent::of(session), Some(&a.actor));
        let mut statements = vec![self
            .db
            .prepare(insert_session_sql())
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                fields.item.as_ref().map_or(JsValue::NULL, |(id, _)| JsValue::from(id.as_str())),
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
                text_or_null(&parent_id),
                text_or_null(&fields.agent_type),
                text_or_null(&fields.task),
                text_or_null(&fields.prompt),
                text_or_null(&fields.model),
            ])?];
        // Started at the same moment by another call: none, and no update.
        let sent = push_delivery(
            &mut statements,
            self.delivery(
                "session.started",
                &repo.id,
                started(&expected),
                &format!("{id}:started"),
                "EXISTS (SELECT 1 FROM sessions WHERE id = ?7)",
                vec![id.as_str().into()],
            )?,
        );
        let inserted = match self.db.batch(statements).await?.into_iter().next() {
            Some(result) => result.results::<SessionRow>()?.into_iter().next(),
            None => None,
        };
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
        self.link_fields(&session, &fields).await?;
        if let Some(parent) = &parent_id {
            self.db.prepare(SEE_PARENT).bind(&[at.as_str().into(), parent.as_str().into()])?.run().await?;
        }
        self.delivered(sent, "session.started", &repo.id, Some(a.actor.id.clone()), started(&session)).await?;
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
    /// request moved onto it. A subagent that finished only takes the
    /// fields, and stays ended.
    async fn resume(&self, repo: &Repo, row: SessionRow, actor: &User, fields: Fields) -> Result<Outcome<Session>> {
        let now = now_ms();
        let was_ended = row.state == "ended";
        let finished = finished_subagent(&row);
        let had_pull = row.pull;
        let parent_id = row.parent_id.clone();
        let id = row.id.clone();
        let at = rfc3339(now);
        let current_source = row.title_source.as_deref().and_then(TitleSource::parse);
        // A title given: its agent's, unless it is what g1t calls it already.
        let given = fields.title.as_deref().map(|title| titles::given_source(title, row.title.as_deref(), current_source));
        let pinned = current_source == Some(TitleSource::Person);
        let mut binds = fields.binds();
        binds.push(at.as_str().into());
        binds.push(id.as_str().into());
        binds.push(given.map_or(JsValue::NULL, |source| source.as_str().into()));
        let sql = if finished { refresh_sql() } else { resume_sql() };
        let mut statements = vec![self.db.prepare(sql).bind(&binds)?];
        // Brought back from having ended: announced with the change.
        let sent = if was_ended && !finished {
            let expected = SessionRow {
                item_id: fields.item.as_ref().map(|(id, _)| id.clone()).or(row.item_id.clone()),
                item: fields.item.as_ref().map(|(_, number)| *number).or(row.item),
                pull: fields.pull.or(row.pull),
                branch: fields.branch.clone().or(row.branch.clone()),
                head_commit: fields.head_commit.clone().or(row.head_commit.clone()),
                title: if pinned { row.title.clone() } else { fields.title.clone().or(row.title.clone()) },
                title_source: if pinned { row.title_source.clone() } else { given.map(|source| source.as_str().to_owned()).or(row.title_source.clone()) },
                agent_type: fields.agent_type.clone().or(row.agent_type.clone()),
                task: fields.task.clone().or(row.task.clone()),
                prompt: fields.prompt.clone().or(row.prompt.clone()),
                model: fields.model.clone().or(row.model.clone()),
                result: fields.result.clone().or(row.result.clone()),
                last_seen_at: at.clone(),
                state: "active".to_owned(),
                ended_at: None,
                end_reason: None,
                ..row.clone()
            }
            .at(now);
            push_delivery(
                &mut statements,
                self.delivery(
                    "session.started",
                    &repo.id,
                    g1t_contracts::events::marked(SessionEvent::of(&expected), Some(actor)),
                    &format!("{id}:started:{at}"),
                    "EXISTS (SELECT 1 FROM sessions WHERE id = ?7 AND state = 'active' AND last_seen_at = ?8)",
                    vec![id.as_str().into(), at.as_str().into()],
                )?,
            )
        } else {
            None
        };
        let updated = match self.db.batch(statements).await?.into_iter().next() {
            Some(result) => result.results::<SessionRow>()?.into_iter().next(),
            None => None,
        };
        let Some(updated) = updated else {
            return Ok(not_found());
        };
        let session = updated.at(now);
        self.link_fields(&session, &fields).await?;
        if finished {
            return Ok(Outcome::Ok(session));
        }
        self.renew_claims(&id, now).await?;
        if let Some(parent) = &parent_id {
            self.db.prepare(SEE_PARENT).bind(&[at.as_str().into(), parent.as_str().into()])?.run().await?;
        }
        if let Some(number) = session.pull
            && had_pull != Some(number)
        {
            self.move_entries_onto_pull(&repo.id, &id, number).await?;
        }
        if was_ended {
            let data = g1t_contracts::events::marked(SessionEvent::of(&session), Some(actor));
            self.delivered(sent, "session.started", &repo.id, Some(actor.id.clone()), data).await?;
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
        if row.state == "ended" && !revives(row.end_reason.as_deref()) && !finished_subagent(&row) {
            return Ok(Outcome::fail(FailureCode::Conflict, "This session has ended. Start a new one."));
        }
        let (item, pull) = unwrap_or_fail!(self.session_subjects(&repo, a.item, a.pull).await?);
        let fields = Fields {
            item,
            pull,
            branch: tidy(a.branch.as_deref(), MAX_BRANCH_CHARS),
            head_commit: tidy(a.head_commit.as_deref(), MAX_COMMIT_CHARS),
            title: tidy(a.title.as_deref().map(shown::clean).as_deref(), MAX_TITLE_CHARS),
            agent_type: tidy(a.agent_type.as_deref(), MAX_AGENT_CHARS),
            task: clip(a.task.as_deref().map(shown::clean).as_deref(), MAX_TASK_CHARS),
            prompt: clip(a.prompt.as_deref().map(shown::clean).as_deref(), MAX_PROMPT_CHARS),
            model: tidy(a.model.as_deref(), MAX_MODEL_CHARS),
            result: clip(a.result.as_deref().map(shown::clean).as_deref(), MAX_RESULT_CHARS),
        };
        // Its usage first, so the session returned carries the cost.
        if let Some(usage) = &a.usage {
            let usage = match g1t_contracts::model_prices::parse_usage(&serde_json::to_value(usage).unwrap_or_default()) {
                Ok(usage) => usage,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            let cost = g1t_contracts::model_prices::estimate(&usage).cost_usd;
            let json = serde_json::to_string(&usage).unwrap_or_else(|_| "[]".to_owned());
            self.db
                .prepare(SET_USAGE)
                .bind(&[json.into(), cost.map_or(JsValue::NULL, JsValue::from), row.id.as_str().into()])?
                .run()
                .await?;
        }
        self.resume(&repo, row, &a.actor, fields).await
    }

    /// A session `actor` may end: their own, or anyone's when they have
    /// write access to the repository (one left behind by a harness that
    /// was killed or never said it ended).
    async fn endable_session(&self, repo: &Repo, actor: &User, id: &str) -> Result<Outcome<SessionRow>> {
        let Some(row) = self.session_row(&repo.id, id.trim()).await? else {
            return Ok(not_found());
        };
        let can_push = matches!(crate::allowed(Some(actor), repo, g1t_contracts::access::Capability::Push), Outcome::Ok(()));
        Ok(if may_end_session(&row.actor_id, &actor.id, can_push) {
            Outcome::Ok(row)
        } else {
            Outcome::fail(FailureCode::Forbidden, "Only whoever runs this session, or someone with write access to the repository, can end it.")
        })
    }

    pub(crate) async fn end_session(&self, a: EndSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let row = unwrap_or_fail!(self.endable_session(&repo, &a.actor, &a.id).await?);
        let own = row.actor_id == a.actor.id;
        let now = now_ms();
        let at = rfc3339(now);
        // What it reported is its own to say: someone else ending it says nothing for it.
        let result = if own { clip(a.result.as_deref(), MAX_RESULT_CHARS) } else { None };
        if row.state == "ended" {
            // Ended already: it keeps what it reported, or takes it now.
            if row.result.is_none()
                && let Some(result) = &result
            {
                let updated = self
                    .db
                    .prepare(format!("UPDATE sessions SET result = ? WHERE id = ? RETURNING {SESSION_COLUMNS}"))
                    .bind(&[result.as_str().into(), row.id.as_str().into()])?
                    .first::<SessionRow>(None)
                    .await?;
                if let Some(updated) = updated {
                    return Ok(Outcome::Ok(updated.at(now)));
                }
            }
            return Ok(Outcome::Ok(row.at(now)));
        }
        let reason = session_end_reason(own, a.by_hand, &a.actor.username, tidy(a.reason.as_deref(), MAX_NOTE_CHARS).as_deref());
        let ended_event = |session: &Session| g1t_contracts::events::marked(SessionEvent::of(session), Some(&a.actor));
        // Its subagents still going end with it, all in one change with
        // their updates. (One started meanwhile ends with it too, and is
        // announced on its own below.)
        let going: Vec<SessionRow> = self
            .db
            .prepare(tree_sql())
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .filter(|child| child.state == "active")
            .collect();
        let end_one = |session: SessionRow, reason: &str, result: Option<String>| {
            SessionRow {
                state: "ended".to_owned(),
                ended_at: Some(at.clone()),
                end_reason: Some(reason.to_owned()),
                last_seen_at: at.clone(),
                result: result.or(session.result.clone()),
                ..session
            }
            .at(now)
        };
        let guard = "EXISTS (SELECT 1 FROM sessions WHERE id = ?7 AND state = 'ended' AND ended_at = ?8)";
        let mut statements = vec![self
            .db
            .prepare(format!(
                "UPDATE sessions SET state = 'ended', ended_at = ?1, end_reason = ?2, last_seen_at = ?1, result = COALESCE(?3, result),
                   {final_due}
                 WHERE id = ?4 AND state = 'active'
                 RETURNING {SESSION_COLUMNS}",
                final_due = titles::final_due("?1"),
            ))
            .bind(&[at.as_str().into(), reason.as_str().into(), text_or_null(&result), row.id.as_str().into()])?];
        let expected = end_one(row.clone(), &reason, result.clone());
        let sent = push_delivery(
            &mut statements,
            self.delivery(
                "session.ended",
                &repo.id,
                ended_event(&expected),
                &format!("{}:ended:{at}", row.id),
                guard,
                vec![row.id.as_str().into(), at.as_str().into()],
            )?,
        );
        // Only once it ended here, so a call that lost the race ends nothing.
        statements.push(self.db.prepare(end_tree_sql()).bind(&[row.id.as_str().into(), at.as_str().into(), "parent ended".into()])?);
        let tree_index = statements.len() - 1;
        let mut orphans_sent = Vec::new();
        for child in going {
            let child_id = child.id.clone();
            let expected = end_one(child, "parent ended", None);
            let delivery = self.delivery(
                "session.ended",
                &repo.id,
                ended_event(&expected),
                &format!("{child_id}:ended:{at}"),
                guard,
                vec![child_id.as_str().into(), at.as_str().into()],
            )?;
            orphans_sent.push((child_id, push_delivery(&mut statements, delivery)));
        }
        let mut results = self.db.batch(statements).await?;
        let orphans: Vec<SessionRow> = match results.get(tree_index) {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        let ended = match results.drain(..).next() {
            Some(result) => result.results::<SessionRow>()?.into_iter().next(),
            None => None,
        };
        let Some(ended) = ended else {
            // Ended by another call meanwhile.
            return Ok(match self.session_row(&repo.id, &row.id).await? {
                Some(row) => Outcome::Ok(row.at(now)),
                None => not_found(),
            });
        };
        let session = ended.at(now);
        if let Some(result) = &result {
            self.link_refs(&session.id, &session.repo_id, &result.chars().take(MAX_REF_TEXT).collect::<String>()).await?;
        }
        self.delivered(sent, "session.ended", &repo.id, Some(a.actor.id.clone()), ended_event(&session)).await?;
        for orphan in orphans {
            let orphan = orphan.at(now);
            match orphans_sent.iter().position(|(id, _)| *id == orphan.id) {
                Some(index) => {
                    let (_, sent) = orphans_sent.swap_remove(index);
                    self.delivered(sent, "session.ended", &repo.id, Some(a.actor.id.clone()), ended_event(&orphan)).await?;
                }
                None => self.publish("session.ended", &repo.id, &a.actor, SessionEvent::of(&orphan)).await?,
            }
        }
        Ok(Outcome::Ok(session))
    }

    /// A person names a session from the site (`TitleSessionArgs`): pinned,
    /// or with no title, unpinned for g1t to name again.
    pub(crate) async fn title_session(&self, a: TitleSessionArgs) -> Result<Outcome<Session>> {
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let Some(row) = self.session_row(&repo.id, a.id.trim()).await? else {
            return Ok(not_found());
        };
        let can_push = matches!(crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::Push), Outcome::Ok(()));
        if !may_end_session(&row.actor_id, &a.actor.id, can_push) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only whoever runs this session, or someone with write access to the repository, can name it."));
        }
        let at = rfc3339(now_ms());
        let title = tidy(a.title.as_deref().map(shown::clean).as_deref(), MAX_TITLE_CHARS);
        let statement = match &title {
            Some(title) => self.db.prepare(titles::PIN_TITLE).bind(&[title.as_str().into(), at.as_str().into(), row.id.as_str().into()])?,
            None => self.db.prepare(titles::UNPIN_TITLE).bind(&[at.as_str().into(), row.id.as_str().into()])?,
        };
        statement.run().await?;
        let Some(row) = self.session_row(&repo.id, &row.id).await? else {
            return Ok(not_found());
        };
        let session = row.at(now_ms());
        self.publish_as(
            "session.progressed",
            &repo.id,
            Some(a.actor.id.clone()),
            SessionProgressed { repo_id: repo.id.clone(), number: session.pull.or(session.item), session_id: session.id.clone(), root_id: None },
        )
        .await?;
        let mut sessions = [session];
        shown::sessions(&mut sessions, &Some(a.actor.clone()), &repo.namespace);
        let [session] = sessions;
        Ok(Outcome::Ok(session))
    }

    pub(crate) async fn get_work_session(&self, a: WorkSessionArgs) -> Result<Outcome<SessionDetail>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let Some(row) = self.session_row(&repo.id, a.id.trim()).await? else {
            return Ok(not_found());
        };
        let now = now_ms();
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
        let mut session = row.at(now);
        let children = self.subagents_of(&session.id, now).await?;
        session.subagents = children.iter().filter(|child| child.parent_id.as_deref() == Some(session.id.as_str())).count() as u32;
        // A subagent's page names the session at the top of its tree.
        let root = match &session.parent_id {
            Some(_) => {
                let mut top = None;
                let mut at = session.parent_id.clone();
                for _ in 0..8 {
                    let Some(id) = at else { break };
                    let Some(found) = self.session_row(&repo.id, &id).await? else { break };
                    at = found.parent_id.clone();
                    top = Some(found.at(now));
                }
                top
            }
            None => None,
        };
        let mut ids: Vec<String> = vec![session.id.clone()];
        ids.extend(children.iter().map(|child| child.id.clone()));
        let (touched, links, skills) = self.tree_facts(&repo.id, &ids).await?;
        let updates = self.pending_updates(&session.id).await?;
        let detail = SessionDetail { session, entries, children, touched, links, skills, root, updates, limited: false };
        Ok(Outcome::Ok(shown::detail(detail, &a.viewer, &repo.namespace)))
    }

    /// The sessions tied to some pull requests, for Home (`PullSessionsArgs`).
    pub(crate) async fn pull_sessions(&self, a: PullSessionsArgs) -> Result<Outcome<Vec<PullSessions>>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let mut numbers = a.numbers;
        numbers.sort_unstable();
        numbers.dedup();
        numbers.truncate(MAX_PULL_SESSIONS);
        if numbers.is_empty() {
            return Ok(Outcome::Ok(Vec::new()));
        }
        let rows = self
            .db
            .prepare(PULL_SESSIONS)
            .bind(&[repo.id.as_str().into(), serde_json::to_string(&numbers)?.into()])?
            .all()
            .await?
            .results::<PullSessionRow>()?;
        Ok(Outcome::Ok(pull_sessions_of(rows)))
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
        // On a work item or pull request: attached, or tied to it any way.
        let mut linked: Vec<String> = Vec::new();
        let mut item_id = None;
        if let Some(number) = a.item {
            let Some(held) = items::by_number(self, &repo.namespace, number).await? else {
                return Ok(Outcome::Ok(Vec::new()));
            };
            linked.extend(self.item_sessions(&repo.id, &held.item.id).await?);
            // And those on its pull requests here.
            let pulls: Vec<u32> = self
                .db
                .prepare("SELECT number AS n FROM pulls WHERE repo_id = ? AND item_id = ?")
                .bind(&[repo.id.as_str().into(), held.item.id.as_str().into()])?
                .all()
                .await?
                .results::<NumberRow>()?
                .into_iter()
                .map(|row| row.n)
                .collect();
            for pull in &pulls {
                linked.extend(self.linked_sessions(&repo.id, *pull).await?);
            }
            linked.extend(self.branch_sessions(&repo.id, &pulls).await?);
            item_id = Some(held.item.id);
        }
        if let Some(number) = a.pull {
            linked.extend(self.linked_sessions(&repo.id, number).await?);
            linked.extend(self.branch_sessions(&repo.id, &[number]).await?);
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT {SESSION_COLUMNS} FROM sessions
                 WHERE repo_id = ?1 {state}
                   AND (?6 = 1 OR parent_id IS NULL OR id IN (SELECT value FROM json_each(?7)))
                   AND (?3 IS NULL OR item_id = ?3 OR id IN (SELECT value FROM json_each(?7)))
                   AND (?4 IS NULL OR pull = ?4 OR id IN (SELECT value FROM json_each(?7)))
                   AND (?8 IS NULL OR id IN (SELECT session_id FROM session_touches WHERE repo_id = ?1 AND kind = 'file'
                     AND (value = ?8 OR (substr(?8, -1) = '/' AND substr(value, 1, length(?8)) = ?8))))
                 ORDER BY last_seen_at DESC LIMIT ?5"
            ))
            .bind(&[
                repo.id.as_str().into(),
                idle_since.as_str().into(),
                text_or_null(&item_id),
                number_or_null(a.pull),
                LIST_LIMIT.into(),
                u32::from(a.subagents).into(),
                serde_json::to_string(&linked)?.into(),
                text_or_null(&tidy(a.path.as_deref().map(|path| path.trim_start_matches("./")), MAX_TOUCH_CHARS)),
            ])?
            .all()
            .await?
            .results::<SessionRow>()?;
        let mut sessions: Vec<Session> = rows.into_iter().map(|row| row.at(now)).collect();
        // With subagents, each tree whole: its subagents, and its top.
        if a.subagents {
            let mut more: Vec<Session> = Vec::new();
            for session in sessions.iter().filter(|session| session.parent_id.is_none()).take(20) {
                more.extend(self.subagents_of(&session.id, now).await?);
            }
            let parents: Vec<String> = sessions
                .iter()
                .filter_map(|session| session.parent_id.clone())
                .filter(|parent| !sessions.iter().any(|session| &session.id == parent))
                .collect();
            more.extend(self.sessions_by_id(&repo.id, &parents).await?);
            for session in more {
                if !sessions.iter().any(|known| known.id == session.id) {
                    sessions.push(session);
                }
            }
            count_subagents(&mut sessions);
        } else {
            self.fill_subagents(&mut sessions).await?;
        }
        self.fill_first_prompts(&mut sessions).await?;
        shown::sessions(&mut sessions, &a.viewer, &repo.namespace);
        Ok(Outcome::Ok(sessions))
    }

    /// Notes `text` (from g1t) in the live harness sessions on `pull` or
    /// its work item, so an agent reading its session hears of it. Never
    /// fails what it follows: a problem is logged.
    pub(crate) async fn note_sessions(&self, pull: &Pull, text: &str) {
        let noted = async {
            let sessions: Vec<SessionRow> = self
                .db
                .prepare(format!(
                    "SELECT {SESSION_COLUMNS} FROM sessions
                     WHERE state = 'active' AND ((repo_id = ?1 AND pull = ?2)
                       OR item_id = (SELECT item_id FROM pulls WHERE repo_id = ?1 AND number = ?2))"
                ))
                .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
                .all()
                .await?
                .results()?;
            let at = rfc3339(now_ms());
            let mut statements = Vec::new();
            for session in sessions {
                // Kept by the session alone: the pull request's own session
                // has the note already.
                statements.push(self.db.prepare(INSERT_ENTRY).bind(&[
                    JsValue::NULL,
                    "note".into(),
                    text.into(),
                    JsValue::NULL,
                    text_or_null(&pull.head_commit),
                    at.as_str().into(),
                    session.id.as_str().into(),
                    JsValue::NULL,
                ])?);
            }
            if !statements.is_empty() {
                self.db.batch(statements).await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = noted.await {
            worker::console_error!("#{}: sessions were not told: {error}", pull.number);
        }
    }

    pub(crate) async fn record_session_entries(&self, a: RecordEntriesArgs) -> Result<Outcome<Recorded>> {
        if a.acknowledge.len() > 100 || a.acknowledge.iter().any(|id| id.len() > 100) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Acknowledge at most 100 update IDs."));
        }
        if a.entries.len() > crate::MAX_ENTRY_BATCH {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Send at most {} entries at a time.", crate::MAX_ENTRY_BATCH),
            ));
        }
        if a.touched.len() > MAX_TOUCHES {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Say at most {MAX_TOUCHES} things touched at a time.")));
        }
        let repo = unwrap_or_fail!(self.participating_repo(&a.repo, &a.actor).await?);
        let row = unwrap_or_fail!(self.own_session(&repo, &a.actor, &a.id).await?);
        if row.state == "ended" && !revives(row.end_reason.as_deref()) {
            return Ok(Outcome::fail(FailureCode::Conflict, "This session has ended. Start a new one."));
        }
        // Recording is a heartbeat too.
        let session = unwrap_or_fail!(self.resume(&repo, row, &a.actor, Fields::default()).await?);
        let touched = self.record_touches(&session, &a.touched).await?;
        if a.entries.is_empty() {
            if touched > 0 {
                self.announce_progress(&session).await?;
            }
            let acknowledged = self.acknowledge_updates(&session.id, &a.acknowledge).await?;
            return Ok(Outcome::Ok(Recorded { acknowledged, ..Recorded::default() }));
        }
        let pull = match session.pull {
            Some(number) => self.pull(&repo.id, number).await?,
            None => None,
        };
        let pull_id: JsValue = pull.as_ref().map_or(JsValue::NULL, |pull| pull.id.as_str().into());
        let at = rfc3339(now_ms());
        let total = a.entries.len() as u32;
        let mut statements = Vec::with_capacity(a.entries.len());
        let mut prompts = String::new();
        // Each prompt's place among the statements, and what the first one with one is for.
        let mut prompt_at: Vec<usize> = Vec::new();
        let mut intent: Option<String> = None;
        for keyed in a.entries {
            let entry = keyed.entry;
            let kind = serde_json::to_value(entry.kind)?;
            // Kept without credentials: a session's page may show it to a
            // whole team, and its prompts to its author on any device.
            let mut text: String = shown::clean(&entry.text.chars().take(crate::MAX_ENTRY_CHARS).collect::<String>());
            if entry.kind == SessionEntryKind::Skill {
                // A skill is its name, nothing more.
                text = text.trim().chars().take(MAX_AGENT_CHARS).collect();
            }
            if entry.kind == SessionEntryKind::Prompt {
                if prompts.len() < MAX_REF_TEXT {
                    prompts.push_str(&text);
                    prompts.push('\n');
                }
                prompt_at.push(statements.len());
                if intent.is_none() {
                    intent = titles::intent_title(&text);
                }
            }
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
        let mut prompted = 0;
        for (index, result) in self.db.batch(statements).await?.into_iter().enumerate() {
            let new = result.results::<NumberRow>()?.len() as u32;
            recorded += new;
            if prompt_at.contains(&index) {
                prompted += new;
            }
        }
        if prompted > 0 {
            // The first prompt names the session for now; enough of them settle its title (titles.rs).
            let now = now_ms();
            self.db
                .prepare(titles::prompted_sql())
                .bind(&[
                    session.id.as_str().into(),
                    prompted.into(),
                    text_or_null(&intent),
                    rfc3339(now).into(),
                    after_minutes(now, titles::SETTLE_AFTER_MINUTES).into(),
                ])?
                .run()
                .await?;
        }
        if !prompts.is_empty() && recorded > 0 {
            self.link_refs(&session.id, &repo.id, &prompts).await?;
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
        if recorded > 0 || touched > 0 {
            self.announce_progress(&session).await?;
        }
        let acknowledged = self.acknowledge_updates(&session.id, &a.acknowledge).await?;
        Ok(Outcome::Ok(Recorded { recorded, duplicates: total - recorded, acknowledged }))
    }

    /// `session.progressed`, at most every [`PROGRESS_EVERY_MS`] for a
    /// session, so the pages showing it follow along.
    async fn announce_progress(&self, session: &Session) -> Result<()> {
        let now = now_ms();
        let due = self
            .db
            .prepare(MARK_PROGRESS)
            .bind(&[rfc3339(now).into(), session.id.as_str().into(), rfc3339(now.saturating_sub(PROGRESS_EVERY_MS)).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if due.is_none() {
            return Ok(());
        }
        let mut root_id = None;
        let mut up = session.parent_id.clone();
        for _ in 0..8 {
            let Some(id) = up else { break };
            up = self.session_row(&session.repo_id, &id).await?.and_then(|row| row.parent_id);
            root_id = Some(id);
        }
        self.publish_as(
            "session.progressed",
            &session.repo_id,
            Some(session.actor.id.clone()),
            SessionProgressed {
                repo_id: session.repo_id.clone(),
                number: session.pull.or(session.item),
                session_id: session.id.clone(),
                root_id,
            },
        )
        .await
    }
}
