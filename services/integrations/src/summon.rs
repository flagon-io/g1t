//! g1t taking on what it is asked in an issue or a pull request: assigned
//! the issue (`issue.assigned` adding `g1t`), or mentioned in a comment
//! (`comment.created` whose text says `@g1t`).
//!
//! g1t reacts 👀 to what asked it (the comment, or the issue for an
//! assignment) and starts a session on the workspace's own Claude, as the
//! person who asked ([`Integrations::start_agent_session`]): a pull
//! request's mention carries on with that pull request on its branch, and
//! an issue's with the issue. The comment is the session's instruction, so
//! "that's not what I meant" reaches it, along with where to find what the
//! sessions before it did. A mention on a thread where that same person's
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
use g1t_contracts::work::{Comment, CommentKind, IssueDetail, PullDetail, ReactArgs, ReactionContent, ViewArgs};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, system};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

use crate::Integrations;

/// The most times g1t answers one thread in an hour.
pub const MAX_PER_HOUR: u32 = 6;
const HOUR_MS: u64 = 60 * 60 * 1000;

/// What g1t was asked, read from an event before anything is looked up.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// Assigned issue `number`.
    Assigned { number: u32 },
    /// Comment `comment_id` on issue or pull request `number` may mention it.
    Commented { number: u32, comment_id: String },
}

/// What an event asks of g1t, if anything.
pub fn ask_in(event: &Event) -> Option<Ask> {
    let actor = event.actor.as_deref()?;
    // g1t's own doings never ask it anything.
    if system::is_system_id(actor) {
        return None;
    }
    let number = event.data["number"].as_u64().and_then(|n| u32::try_from(n).ok())?;
    match event.kind.as_str() {
        "issue.assigned" => {
            let added = event.data["added"].as_array()?;
            added.iter().any(|name| name.as_str() == Some(system::USERNAME)).then_some(Ask::Assigned { number })
        }
        "comment.created" => {
            // An agent writing as itself, from before agents were removed, never asks.
            if !event.data["agent"].is_null() {
                return None;
            }
            let comment_id = event.data["commentId"].as_str()?.to_owned();
            Some(Ask::Commented { number, comment_id })
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
    /// `issues` or `pull`, for links.
    page: &'static str,
    comments: Vec<Comment>,
    /// The issue's number, or the pull request's issue's, if any.
    issue: Option<u32>,
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
        let (Some(repo_id), Some(actor_id)) = (event.repo_id.as_deref(), event.actor.as_deref()) else { return Ok(()) };
        let Some(repo): Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await? else {
            return Ok(());
        };
        let workspace = repo.namespace.to_lowercase();
        // Who asked, as they are now: only the workspace's members may.
        let actor: Viewer = g1t_kit::call(&self.identity, "user_by_id", &UserIdArgs { id: actor_id.to_owned() }).await?;
        let Some(actor) = actor.filter(|actor| actor.verified && actor.is_member(&workspace)) else { return Ok(()) };
        let number = match &ask {
            Ask::Assigned { number } | Ask::Commented { number, .. } => *number,
        };
        let Some(thread) = self.thread(&actor, &repo, number).await? else { return Ok(()) };
        let site = self.site_url.trim_end_matches('/');
        let thread_url = format!("{site}/{}/{}/{}/{number}", repo.namespace, repo.name, thread.page);
        let (comment, url) = match &ask {
            Ask::Assigned { .. } => (None, thread_url.clone()),
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
                (Some(comment), format!("{thread_url}#{}", comment.id))
            }
        };
        if !thread.open {
            return Ok(());
        }
        // Once per ask, and a few times an hour per thread.
        if !self.first_time(&event.id, &repo, number).await? {
            return Ok(());
        }
        let react_to = comment.map(|comment| comment.id.clone());
        let system = User::system(&workspace);
        let _: Outcome<Value> = g1t_kit::call(
            &self.work,
            "react",
            &ReactArgs { actor: system.clone(), repo: repo.clone(), number, comment_id: react_to, content: ReactionContent::Eyes, remove: false },
        )
        .await?;
        let text = comment.map(|comment| comment.body.clone());
        // The asker's session on this thread, still going: told, not doubled.
        if let Some(text) = &text
            && self.tell_running(&repo, &actor, &[Some(number), thread.issue].into_iter().flatten().collect::<Vec<_>>(), text, &url).await?
        {
            return Ok(());
        }
        let started = self
            .start_agent_session(StartAgentSessionArgs {
                actor: actor.clone(),
                repo: repo.clone(),
                issue: thread.issue.filter(|_| thread.pull.is_none()),
                pull: thread.pull,
                asked: Some(Asked { by: actor.username.clone(), comment: text, url }),
                title: None,
                body: None,
                instruction: None,
                mode: Some(AgentMode::Implement),
                handoff: Some(false),
            })
            .await?;
        if let Outcome::Fail(failure) = started {
            let mut body = format!("@{}, I can't take this on: {}.", actor.username, failure.message.trim().trim_end_matches('.'));
            // No Anthropic account to start on: where to add one.
            if failure.code == FailureCode::Conflict {
                body.push_str(&format!(" Add an Anthropic key in [the workspace's AI settings]({site}/{workspace}/-/ai), then ask again."));
            }
            self.comment(&system, &repo, number, body).await?;
        }
        Ok(())
    }

    /// The thread `number`, issue or pull request, as `actor` may see it.
    async fn thread(&self, actor: &User, repo: &RepoPath, number: u32) -> Result<Option<Thread>> {
        let view = ViewArgs { repo: repo.clone(), number, viewer: Some(actor.clone()), after_seq: 0 };
        let issue: Outcome<IssueDetail> = g1t_kit::call(&self.work, "get_issue", &view).await?;
        if let Outcome::Ok(detail) = issue {
            return Ok(Some(Thread {
                page: "issues",
                open: detail.issue.state == g1t_contracts::work::State::Open,
                comments: detail.comments,
                issue: Some(number),
                pull: None,
                g1t_pull: false,
            }));
        }
        let pull: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view).await?;
        Ok(match pull {
            Outcome::Ok(detail) => Some(Thread {
                page: "pull",
                open: detail.pull.status.is_active(),
                g1t_pull: detail.pull.author.is_system() || system::is_system_id(&detail.pull.author.id),
                issue: detail.pull.issue,
                pull: Some(number),
                comments: detail.comments,
            }),
            Outcome::Fail(_) => None,
        })
    }

    /// Records ask `event_id` on thread `number`: whether it is new and the
    /// thread has not been answered [`MAX_PER_HOUR`] times this hour.
    async fn first_time(&self, event_id: &str, repo: &RepoPath, number: u32) -> Result<bool> {
        let now = now_ms();
        let thread = format!("{}/{}#{number}", repo.namespace.to_lowercase(), repo.name);
        let recent = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM summons WHERE thread = ? AND at > ?")
            .bind(&[thread.as_str().into(), rfc3339(now.saturating_sub(HOUR_MS)).into()])?
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
            .bind(&[event_id.into(), thread.as_str().into(), rfc3339(now).into()])?
            .first::<Value>(None)
            .await?;
        Ok(inserted.is_some())
    }

    /// Passes `text` to `actor`'s own session on `numbers` in `repo` that
    /// g1t started and is still going. Whether there was one.
    async fn tell_running(&self, repo: &RepoPath, actor: &User, numbers: &[u32], text: &str, url: &str) -> Result<bool> {
        let repo_name = format!("{}/{}", repo.namespace.to_lowercase(), repo.name);
        let running = self
            .db
            .prepare(
                "SELECT provider_session_id, connection_id FROM agent_runs
                 WHERE repo = ? AND status = 'running' AND json_extract(actor, '$.id') = ?
                   AND issue IN (SELECT value FROM json_each(?))
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&[repo_name.as_str().into(), actor.id.as_str().into(), serde_json::to_string(numbers)?.into()])?
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
        assert_eq!(
            ask_in(&event("issue.assigned", "usr_ana", json!({ "number": 4, "added": ["g1t"] }))),
            Some(Ask::Assigned { number: 4 })
        );
        assert_eq!(ask_in(&event("issue.assigned", "usr_ana", json!({ "number": 4, "added": ["bo"] }))), None);
        assert_eq!(
            ask_in(&event("comment.created", "usr_ana", json!({ "number": 4, "commentId": "cmt_1" }))),
            Some(Ask::Commented { number: 4, comment_id: "cmt_1".into() })
        );
        assert_eq!(ask_in(&event("comment.created", "g1t", json!({ "number": 4, "commentId": "cmt_1" }))), None);
        assert_eq!(
            ask_in(&event("comment.created", "usr_ana", json!({ "number": 4, "commentId": "cmt_1", "agent": { "id": "agt_1" } }))),
            None
        );
        assert_eq!(ask_in(&event("issue.closed", "usr_ana", json!({ "number": 4 }))), None);
    }
}
