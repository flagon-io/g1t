//! g1t taking on what it is asked in a work item or a pull request:
//! assigned the work item (`work_item.assigned` adding `g1t`), or mentioned
//! in a comment (`comment.created` whose text says `@g1t`).
//!
//! g1t reacts 👀 to what asked it (the comment, or the work item for an
//! assignment) and starts a session on the workspace's own Claude, as the
//! person who asked ([`Integrations::start_agent_session`]): a pull
//! request's mention carries on with that pull request on its branch, and
//! a work item's works on the work item, in the repository it was filed in
//! (or its first target, or the first it touched). The comment is the
//! session's instruction, so "that's not what I meant" reaches it, along
//! with where to find what the sessions before it did. A mention on a thread where that same person's
//! session is still going is passed to that session instead of starting
//! another. The session shows in the thread's timeline as it goes.
//!
//! Only the workspace's members can ask; anyone else's mention is an
//! ordinary one. When the session cannot start (no Anthropic key, say),
//! g1t says why in the thread. Each ask is acted on once (`summons`), and
//! a thread is answered at most [`MAX_PER_HOUR`] times an hour, so a
//! session that writes `@g1t` itself cannot start sessions without end.

use g1t_contracts::agent_sessions::{AgentMode, Asked, StartAgentSessionArgs};
use g1t_contracts::events::Event;
use g1t_contracts::identity::UserIdArgs;
use g1t_contracts::repos::{PathByIdArgs, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::updates::update_command;
use g1t_contracts::work::{Comment, CommentKind, PullDetail, ReactArgs, ReactionContent, ViewArgs, WorkItemDetail, WorkItemViewArgs};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, system};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

use crate::Integrations;

/// The most times g1t answers one thread in an hour.
pub const MAX_PER_HOUR: u32 = 6;
const HOUR_MS: u64 = 60 * 60 * 1000;

/// A thread asked in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum On {
    /// Pull request `number` of the event's repository.
    Pull { number: u32 },
    /// Work item `number` of `workspace`.
    Item { workspace: String, number: u32 },
}

impl On {
    fn number(&self) -> u32 {
        match self {
            On::Pull { number } | On::Item { number, .. } => *number,
        }
    }
}

/// What g1t was asked, read from an event before anything is looked up.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// Assigned the work item.
    Assigned { on: On },
    /// Comment `comment_id` on a work item or a pull request may mention it.
    Commented { on: On, comment_id: String },
}

impl Ask {
    fn on(&self) -> &On {
        match self {
            Ask::Assigned { on } | Ask::Commented { on, .. } => on,
        }
    }
}

/// What an event asks of g1t, if anything.
pub fn ask_in(event: &Event) -> Option<Ask> {
    let actor = event.actor.as_deref()?;
    // g1t's own doings never ask it anything.
    if system::is_system_id(actor) {
        return None;
    }
    let number = event.data["number"].as_u64().and_then(|n| u32::try_from(n).ok())?;
    let item = || event.data["workspace"].as_str().filter(|slug| !slug.is_empty()).map(|slug| On::Item { workspace: slug.to_lowercase(), number });
    match event.kind.as_str() {
        "work_item.assigned" => {
            let added = event.data["added"].as_array()?;
            added.iter().any(|name| name.as_str() == Some(system::USERNAME)).then_some(Ask::Assigned { on: item()? })
        }
        "comment.created" => {
            // An agent writing as itself, from before agents were removed, never asks.
            if !event.data["agent"].is_null() {
                return None;
            }
            let comment_id = event.data["commentId"].as_str()?.to_owned();
            let on = if event.data["itemId"].is_string() { item()? } else { On::Pull { number } };
            Some(Ask::Commented { on, comment_id })
        }
        _ => None,
    }
}

/// Whether `text` mentions `@g1t`: outside code and quotes, and not as part
/// of a longer name (`@g1t-agent`) or a team (`@g1t/core`).
pub fn mentions_g1t(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    let mut fenced = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.starts_with('>') || line.starts_with("    ") || line.starts_with('\t') {
            continue;
        }
        // Inline code: every other run between backticks.
        for (at, part) in trimmed.split('`').enumerate() {
            if at % 2 == 1 {
                continue;
            }
            let bytes = part.as_bytes();
            let mut from = 0;
            while let Some(found) = part[from..].find("@g1t") {
                let start = from + found;
                let end = start + 4;
                let before = start.checked_sub(1).map(|i| bytes[i]);
                let after = bytes.get(end).copied();
                let word = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'/' | b'.' | b'@');
                let ends = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'/');
                if !before.is_some_and(word) && !after.is_some_and(ends) {
                    return true;
                }
                from = end;
            }
        }
    }
    false
}

#[derive(Deserialize)]
struct Counted {
    n: u32,
}

#[derive(Deserialize)]
struct Running {
    provider_session_id: String,
    connection_id: String,
}

/// The thread asked in, as the asker sees it.
struct Thread {
    /// Its page on the site.
    url: String,
    /// `owner/name#number` for a pull request, `workspace#number` for a
    /// work item: what asks are counted against.
    key: String,
    /// The repository a session on it works in: a pull request's, or a
    /// work item's origin (else its first target, else the first it
    /// touched). None for a work item linked to no repository.
    repo: Option<RepoPath>,
    comments: Vec<Comment>,
    /// The work item's number, or the pull request's work item's, if any.
    item: Option<u32>,
    /// Set for a pull request: its number.
    pull: Option<u32>,
    /// A pull request g1t opened (an update), whose `@g1t` commands are
    /// the security service's.
    g1t_pull: bool,
    open: bool,
}

impl Integrations {
    /// Acts on what an event asks of g1t. Never fails the batch: a problem
    /// is logged, and the ask is not tried again.
    pub(crate) async fn summon(&self, event: &Event) {
        let Some(ask) = ask_in(event) else { return };
        if let Err(error) = self.answer_ask(event, ask).await {
            worker::console_error!("summon: {} {}: {error}", event.kind, event.id);
        }
    }

    async fn answer_ask(&self, event: &Event, ask: Ask) -> Result<()> {
        let Some(actor_id) = event.actor.as_deref() else { return Ok(()) };
        // A pull request's repository, which names its workspace.
        let pull_repo = match ask.on() {
            On::Pull { .. } => {
                let Some(repo_id) = event.repo_id.as_deref() else { return Ok(()) };
                let found: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await?;
                let Some(repo) = found else { return Ok(()) };
                Some(repo)
            }
            On::Item { .. } => None,
        };
        let workspace = match (ask.on(), &pull_repo) {
            (On::Item { workspace, .. }, _) => workspace.clone(),
            (_, Some(repo)) => repo.namespace.to_lowercase(),
            _ => return Ok(()),
        };
        // Who asked, as they are now: only the workspace's members may.
        let actor: Viewer = g1t_kit::call(&self.identity, "user_by_id", &UserIdArgs { id: actor_id.to_owned() }).await?;
        let Some(actor) = actor.filter(|actor| actor.verified && actor.is_member(&workspace)) else { return Ok(()) };
        let number = ask.on().number();
        let Some(thread) = self.thread(&actor, ask.on(), pull_repo).await? else { return Ok(()) };
        let site = self.site_url.trim_end_matches('/');
        let (comment, url) = match &ask {
            Ask::Assigned { .. } => (None, thread.url.clone()),
            Ask::Commented { comment_id, .. } => {
                let Some(comment) = thread.comments.iter().find(|comment| &comment.id == comment_id && comment.kind == CommentKind::Comment) else {
                    return Ok(());
                };
                if !mentions_g1t(&comment.body) {
                    return Ok(());
                }
                // `@g1t rebase` on an update g1t opened is the security service's.
                if thread.g1t_pull && update_command(&comment.body).is_some() {
                    return Ok(());
                }
                (Some(comment), format!("{}#{}", thread.url, comment.id))
            }
        };
        if !thread.open {
            return Ok(());
        }
        // Once per ask, and a few times an hour per thread.
        if !self.first_time(&event.id, &thread.key).await? {
            return Ok(());
        }
        let react_to = comment.map(|comment| comment.id.clone());
        let system = User::system(&workspace);
        // A pull request is named in its repository; a work item, in its workspace.
        let in_repo = thread.pull.and(thread.repo.clone());
        let _: Outcome<Value> = g1t_kit::call(
            &self.work,
            "react",
            &ReactArgs {
                actor: system.clone(),
                repo: in_repo.clone(),
                workspace: workspace.clone(),
                number,
                comment_id: react_to,
                content: ReactionContent::Eyes,
                remove: false,
            },
        )
        .await?;
        let text = comment.map(|comment| comment.body.clone());
        // The asker's session on this thread, still going: told, not doubled.
        let numbers: Vec<u32> = [thread.pull, thread.item].into_iter().flatten().collect();
        if let Some(text) = &text
            && self.tell_running(&workspace, in_repo.as_ref(), &actor, &numbers, text, &url).await?
        {
            return Ok(());
        }
        let Some(repo) = thread.repo.clone() else {
            let body = format!(
                "@{}, I can't take this on: the work item is linked to no repository. Link the repository the work is in, then ask again.",
                actor.username
            );
            return self.comment(&system, &workspace, None, number, body).await;
        };
        let started = self
            .start_agent_session(StartAgentSessionArgs {
                actor: actor.clone(),
                repo,
                item: thread.item.filter(|_| thread.pull.is_none()),
                pull: thread.pull,
                asked: Some(Asked { by: actor.username.clone(), comment: text, url }),
                title: None,
                body: None,
                instruction: None,
                prompt: None,
                mode: Some(AgentMode::Implement),
                handoff: Some(false),
            })
            .await?;
        if let Outcome::Fail(failure) = started {
            let mut body = format!("@{}, I can't take this on: {}.", actor.username, failure.message.trim().trim_end_matches('.'));
            // No Anthropic account to start on: where to add one.
            if failure.code == FailureCode::Conflict {
                body.push_str(&format!(" Add an Anthropic key in [the workspace's AI settings]({site}/{workspace}/-/settings/ai), then ask again."));
            }
            self.comment(&system, &workspace, in_repo.as_ref(), number, body).await?;
        }
        Ok(())
    }

    /// The thread asked in, as `actor` may see it: a pull request of
    /// `pull_repo`, or a work item.
    async fn thread(&self, actor: &User, on: &On, pull_repo: Option<RepoPath>) -> Result<Option<Thread>> {
        let site = self.site_url.trim_end_matches('/');
        match (on, pull_repo) {
            (On::Item { workspace, number }, _) => {
                let view = WorkItemViewArgs { workspace: workspace.clone(), number: *number, viewer: Some(actor.clone()) };
                let found: Outcome<WorkItemDetail> = g1t_kit::call(&self.work, "get_work_item", &view).await?;
                let Outcome::Ok(detail) = found else { return Ok(None) };
                // Origin first, then targets, then those it touched.
                let repo = detail.item.repos.iter().find_map(|link| {
                    let (namespace, name) = link.path.split_once('/')?;
                    Some(RepoPath { namespace: namespace.to_lowercase(), name: name.to_owned() })
                });
                Ok(Some(Thread {
                    url: format!("{site}/{workspace}/-/work/{number}"),
                    key: format!("{workspace}#{number}"),
                    repo,
                    open: detail.item.state == g1t_contracts::work::State::Open,
                    comments: detail.comments,
                    item: Some(*number),
                    pull: None,
                    g1t_pull: false,
                }))
            }
            (On::Pull { number }, Some(repo)) => {
                let view = ViewArgs { repo: repo.clone(), number: *number, viewer: Some(actor.clone()), after_seq: 0 };
                let found: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view).await?;
                let Outcome::Ok(detail) = found else { return Ok(None) };
                let path = format!("{}/{}", repo.namespace.to_lowercase(), repo.name);
                Ok(Some(Thread {
                    url: format!("{site}/{path}/pull/{number}"),
                    key: format!("{path}#{number}"),
                    open: detail.pull.status.is_active(),
                    g1t_pull: detail.pull.author.is_system() || system::is_system_id(&detail.pull.author.id),
                    item: detail.pull.item,
                    pull: Some(*number),
                    comments: detail.comments,
                    repo: Some(repo),
                }))
            }
            (On::Pull { .. }, None) => Ok(None),
        }
    }

    /// Records ask `event_id` on `thread` (a [`Thread`]'s key): whether it
    /// is new and the thread has not been answered [`MAX_PER_HOUR`] times
    /// this hour.
    async fn first_time(&self, event_id: &str, thread: &str) -> Result<bool> {
        let now = now_ms();
        let recent = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM summons WHERE thread = ? AND at > ?")
            .bind(&[thread.into(), rfc3339(now.saturating_sub(HOUR_MS)).into()])?
            .first::<Counted>(None)
            .await?
            .map_or(0, |row| row.n);
        if recent >= MAX_PER_HOUR {
            worker::console_log!("summon: {thread} asked {recent} times this hour; {event_id} let be");
            return Ok(false);
        }
        let inserted = self
            .db
            .prepare("INSERT INTO summons (event_id, thread, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING event_id")
            .bind(&[event_id.into(), thread.into(), rfc3339(now).into()])?
            .first::<Value>(None)
            .await?;
        Ok(inserted.is_some())
    }

    /// Passes `text` to `actor`'s own session on `numbers` in `workspace`
    /// (in `repo`, for a pull request's) that g1t started and is still
    /// going. Whether there was one.
    async fn tell_running(&self, workspace: &str, repo: Option<&RepoPath>, actor: &User, numbers: &[u32], text: &str, url: &str) -> Result<bool> {
        let repo_name = repo.map(|repo| format!("{}/{}", repo.namespace.to_lowercase(), repo.name));
        let running = self
            .db
            .prepare(
                "SELECT provider_session_id, connection_id FROM agent_runs
                 WHERE workspace = ?1 AND (?2 IS NULL OR repo = ?2) AND status = 'running' AND json_extract(actor, '$.id') = ?3
                   AND item IN (SELECT value FROM json_each(?4))
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&[workspace.into(), crate::optional(repo_name.as_deref()), actor.id.as_str().into(), serde_json::to_string(numbers)?.into()])?
            .first::<Running>(None)
            .await?;
        let Some(running) = running else { return Ok(false) };
        let Some(row) = self.ai_row(&running.connection_id).await? else { return Ok(false) };
        let key = self.ai_secret(&row).unwrap_or_default();
        let message = format!(
            "@{} said, in a comment on g1t ({url}):\n\n<comment>\n{}\n</comment>\n\nTake it into account; your report answers them, on this session's card in that thread.",
            actor.username,
            text.trim()
        );
        let sent = self
            .call_anthropic(&key, worker::Method::Post, &format!("/v1/sessions/{}/events", running.provider_session_id), Some(crate::agent_sessions::message_event(&message)))
            .await?;
        Ok(sent.is_ok())
    }
}

/// The cron: asks older than a week are forgotten.
pub async fn forget_old(service: &Integrations) {
    let before = rfc3339(now_ms().saturating_sub(7 * 24 * HOUR_MS));
    let forgot = async { service.db.prepare("DELETE FROM summons WHERE at < ?").bind(&[before.into()])?.run().await };
    if let Err(error) = forgot.await {
        worker::console_error!("summon: old asks not cleared: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, actor: &str, data: Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "work".into(),
            time: String::new(),
            repo_id: Some("rep_1".into()),
            actor: Some(actor.into()),
            data,
        }
    }

    #[test]
    fn a_mention_is_an_at_g1t_outside_code_and_quotes() {
        assert!(mentions_g1t("@g1t try again, the test is still red"));
        assert!(mentions_g1t("Thanks. @g1t: use the other API."));
        assert!(mentions_g1t("(@g1t) please"));
        assert!(mentions_g1t("Hey @G1T"));
        assert!(!mentions_g1t("@g1t-agent was retired"), "a longer name");
        assert!(!mentions_g1t("ask @g1t/core"), "a team");
        assert!(!mentions_g1t("mail g1t@users.noreply.g1t.sh"));
        assert!(!mentions_g1t("run `@g1t rebase` on updates"), "inline code");
        assert!(!mentions_g1t("```\n@g1t\n```"), "a code block");
        assert!(!mentions_g1t("> @g1t do it\n\nI disagree."), "a quote");
        assert!(mentions_g1t("```\nlog\n```\n@g1t look at the log above"));
    }

    #[test]
    fn assigning_g1t_and_commenting_ask_and_nothing_g1t_does_does() {
        let item = On::Item { workspace: "acme".into(), number: 4 };
        assert_eq!(
            ask_in(&event("work_item.assigned", "usr_ana", json!({ "itemId": "wki_1", "workspace": "acme", "number": 4, "added": ["g1t"] }))),
            Some(Ask::Assigned { on: item.clone() })
        );
        assert_eq!(ask_in(&event("work_item.assigned", "usr_ana", json!({ "workspace": "acme", "number": 4, "added": ["bo"] }))), None);
        assert_eq!(
            ask_in(&event("comment.created", "usr_ana", json!({ "number": 4, "commentId": "cmt_1", "pullId": "pr_1" }))),
            Some(Ask::Commented { on: On::Pull { number: 4 }, comment_id: "cmt_1".into() })
        );
        assert_eq!(
            ask_in(&event("comment.created", "usr_ana", json!({ "number": 4, "commentId": "cmt_1", "itemId": "wki_1", "workspace": "Acme" }))),
            Some(Ask::Commented { on: item, comment_id: "cmt_1".into() })
        );
        assert_eq!(ask_in(&event("comment.created", "g1t", json!({ "number": 4, "commentId": "cmt_1" }))), None);
        assert_eq!(
            ask_in(&event("comment.created", "usr_ana", json!({ "number": 4, "commentId": "cmt_1", "agent": { "id": "agt_1" } }))),
            None
        );
        assert_eq!(ask_in(&event("work_item.closed", "usr_ana", json!({ "workspace": "acme", "number": 4 }))), None);
    }
}
