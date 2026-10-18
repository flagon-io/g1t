//! What of a session each viewer sees.
//!
//! A session records someone's own work as it happens: what they typed to
//! their agent, the commands it ran, what came back. On a public
//! repository anyone may read the repository, but only the workspace's
//! members see inside its sessions; everyone else sees that one runs, who
//! runs it and what it is tied to ([`Sight::Outside`]). Members see what it
//! did, never the prompts someone else typed or the output a tool gave
//! them ([`Sight::Member`]), and a title, the team's one line on it, without
//! swearing. Whoever ran it sees it all ([`Sight::Own`]).
//!
//! Credentials are taken out of everything as it is recorded ([`clean`]),
//! and again as it is read, for what was recorded before that.

use g1t_contracts::Viewer;
use g1t_contracts::work::{Session, SessionDetail, SessionEntry, SessionEntryKind, SessionUpdate};
use g1t_scan::redact::{redact, soften};

/// How much of a session a viewer sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sight {
    /// Whoever ran it.
    Own,
    /// A member of the repository's workspace.
    Member,
    /// Anyone else who may read the repository.
    Outside,
}

impl Sight {
    pub(crate) fn of(viewer: &Viewer, namespace: &str, actor_id: &str) -> Sight {
        match viewer {
            Some(viewer) if viewer.id == actor_id => Sight::Own,
            Some(viewer) if viewer.is_member(&namespace.to_lowercase()) => Sight::Member,
            _ => Sight::Outside,
        }
    }
}

/// Text as it is kept: credentials out.
pub(crate) fn clean(text: &str) -> String {
    redact(text)
}

/// [`clean`], for a field that may be absent.
pub(crate) fn clean_opt(text: Option<String>) -> Option<String> {
    text.map(|text| redact(&text)).filter(|text| !text.trim().is_empty())
}

/// A session as `sight` sees it.
pub(crate) fn session(session: &mut Session, sight: Sight) {
    match sight {
        Sight::Own | Sight::Member => {
            session.title = match sight {
                Sight::Own => clean_opt(session.title.take()),
                _ => session.title.take().map(|title| soften(&title)).filter(|title| !title.is_empty()),
            };
            // Words typed by a person: theirs alone.
            session.first_prompt = match sight {
                Sight::Own => clean_opt(session.first_prompt.take()),
                _ => None,
            };
            session.task = clean_opt(session.task.take());
            session.prompt = clean_opt(session.prompt.take());
            session.result = clean_opt(session.result.take());
            session.end_reason = clean_opt(session.end_reason.take());
        }
        Sight::Outside => {
            session.title = None;
            session.first_prompt = None;
            session.task = None;
            session.prompt = None;
            session.result = None;
            session.model = None;
            session.branch = None;
            session.head_commit = None;
            session.harness_session_id = None;
            session.agent_type = None;
            session.cost_usd = None;
            session.cost_partial = false;
            session.end_reason = session.end_reason.take().filter(|reason| reason == "timed_out");
        }
    }
}

/// An entry as `sight` sees it; `None` when it is not shown at all.
pub(crate) fn entry(mut entry: SessionEntry, sight: Sight) -> Option<SessionEntry> {
    match sight {
        Sight::Outside => None,
        Sight::Member if matches!(entry.kind, SessionEntryKind::Prompt | SessionEntryKind::ToolResult) => {
            entry.text = String::new();
            entry.withheld = true;
            Some(entry)
        }
        _ => {
            entry.text = redact(&entry.text);
            Some(entry)
        }
    }
}

/// Every string in an update's data, credentials out.
fn clean_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = redact(text),
        serde_json::Value::Array(items) => items.iter_mut().for_each(clean_value),
        serde_json::Value::Object(fields) => fields.values_mut().for_each(clean_value),
        _ => {}
    }
}

/// What an update may say of another session that only members see.
const MEMBERS_ONLY: &[&str] = &[
    "title", "first_prompt", "prompt", "task", "result", "branch", "head_commit", "harness_session_id", "model", "agent_type", "end_reason",
    "cost_usd", "costUsd",
];

/// An update's data without what only members see: what other sessions
/// are titled, were asked, reported and run on.
fn outside_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => items.iter_mut().for_each(outside_value),
        serde_json::Value::Object(fields) => {
            for key in MEMBERS_ONLY {
                if fields.get(*key).is_some_and(|value| !value.is_null()) {
                    fields.insert((*key).to_owned(), serde_json::Value::Null);
                }
            }
            fields.values_mut().for_each(outside_value);
        }
        _ => {}
    }
}

/// An update as its session's agent reads it: credentials out, and for
/// someone outside the workspace (on a public repository, their own
/// session hears of members' sessions) only what an outsider may see.
fn update(mut update: SessionUpdate, member: bool) -> SessionUpdate {
    clean_value(&mut update.data);
    if !member {
        outside_value(&mut update.data);
    }
    update
}

/// A session's page as `viewer` sees it, on a repository of `namespace`.
pub(crate) fn detail(mut detail: SessionDetail, viewer: &Viewer, namespace: &str) -> SessionDetail {
    let sight = Sight::of(viewer, namespace, &detail.session.actor.id);
    session(&mut detail.session, sight);
    detail.entries = detail.entries.into_iter().filter_map(|one| entry(one, sight)).collect();
    for child in &mut detail.children {
        session(child, Sight::of(viewer, namespace, &child.actor.id));
    }
    if let Some(root) = &mut detail.root {
        session(root, Sight::of(viewer, namespace, &root.actor.id));
    }
    if sight == Sight::Outside {
        detail.touched.clear();
        detail.skills.clear();
        detail.updates.clear();
        detail.children.clear();
        detail.limited = true;
    } else {
        let member = viewer.as_ref().is_some_and(|viewer| viewer.is_member(&namespace.to_lowercase()));
        detail.updates = detail.updates.into_iter().map(|one| update(one, member)).collect();
    }
    detail
}

/// Sessions in a list, each as `viewer` sees it.
pub(crate) fn sessions(sessions: &mut [Session], viewer: &Viewer, namespace: &str) {
    for one in sessions {
        let sight = Sight::of(viewer, namespace, &one.actor.id);
        session(one, sight);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use g1t_contracts::{Membership, User};
    use g1t_contracts::credentials::Principal;
    use g1t_contracts::work::{Harness, SessionState};

    fn person(id: &str, workspaces: &[&str]) -> Viewer {
        Some(User {
            id: id.into(),
            username: id.into(),
            workspaces: workspaces.iter().map(|slug| Membership::member(slug.to_string())).collect(),
            ..User::default()
        })
    }

    pub(crate) fn a_session() -> Session {
        Session {
            id: "ses_1".into(),
            repo_id: "rep_1".into(),
            item: Some(4),
            pull: None,
            branch: Some("secret-plans".into()),
            actor: Principal { id: "usr_a".into(), username: "a".into() },
            harness: Harness::ClaudeCode,
            harness_session_id: Some("d1485".into()),
            title: Some("Fix this fucking login with G1T_TOKEN=abc123def456".into()),
            state: SessionState::Active,
            head_commit: Some("58def40".into()),
            started_at: String::new(),
            last_seen_at: String::new(),
            ended_at: None,
            end_reason: None,
            parent_id: None,
            agent_type: None,
            task: None,
            prompt: None,
            result: Some("done; token ghp_A1b2C3d4E5f6G7h8I9j0".into()),
            model: Some("claude-opus-5-5".into()),
            subagents: 0,
            first_prompt: Some("ugh fix it".into()),
            title_source: None,
            title_settled_at: None,
            cost_usd: Some(4.12),
            cost_partial: true,
        }
    }

    fn an_entry(kind: SessionEntryKind, text: &str) -> SessionEntry {
        SessionEntry { seq: 1, kind, text: text.into(), tool: None, commit: None, at: String::new(), withheld: false }
    }

    #[test]
    fn who_sees_what() {
        assert_eq!(Sight::of(&person("usr_a", &[]), "acme", "usr_a"), Sight::Own);
        assert_eq!(Sight::of(&person("usr_b", &["acme"]), "Acme", "usr_a"), Sight::Member);
        assert_eq!(Sight::of(&person("usr_c", &["other"]), "acme", "usr_a"), Sight::Outside);
        assert_eq!(Sight::of(&None, "acme", "usr_a"), Sight::Outside);
    }

    #[test]
    fn an_outsider_sees_that_it_runs_and_nothing_inside() {
        let mut one = a_session();
        session(&mut one, Sight::Outside);
        assert_eq!(one.title, None);
        assert_eq!(one.first_prompt, None);
        assert_eq!(one.result, None);
        assert_eq!(one.branch, None);
        assert_eq!(one.model, None);
        assert_eq!((one.cost_usd, one.cost_partial), (None, false));
        assert_eq!(one.item, Some(4));
        assert_eq!(one.actor.username, "a");
        for kind in [SessionEntryKind::Prompt, SessionEntryKind::ToolCall, SessionEntryKind::Note, SessionEntryKind::Message] {
            assert!(entry(an_entry(kind, "x"), Sight::Outside).is_none());
        }
    }

    #[test]
    fn a_member_sees_the_work_not_someone_elses_words() {
        let mut one = a_session();
        session(&mut one, Sight::Member);
        assert_eq!(one.title.as_deref(), Some("Fix this login with G1T_TOKEN=[redacted]"));
        assert_eq!(one.first_prompt, None);
        assert_eq!(one.result.as_deref(), Some("done; token ghp_[redacted]"));
        assert_eq!((one.cost_usd, one.cost_partial), (Some(4.12), true));
        let prompt = entry(an_entry(SessionEntryKind::Prompt, "wtf, fix it"), Sight::Member).unwrap();
        assert!(prompt.withheld && prompt.text.is_empty());
        let output = entry(an_entry(SessionEntryKind::ToolResult, "AWS_SECRET=x"), Sight::Member).unwrap();
        assert!(output.withheld);
        let call = entry(an_entry(SessionEntryKind::ToolCall, "bash: curl -H 'Authorization: Bearer abcdefgh1234'"), Sight::Member).unwrap();
        assert!(!call.withheld && !call.text.contains("abcdefgh1234"));
    }

    #[test]
    fn an_outsiders_own_session_hears_of_members_sessions_as_an_outsider() {
        let data = serde_json::json!({"session": {"title": "Rotate keys", "prompt": "secret plan", "id": "ses_2", "actor": {"username": "b"}}, "files": ["a.rs"]});
        let one = SessionUpdate { id: "upd_1".into(), kind: "overlap.detected".into(), data, at: String::new() };
        let shown = update(one.clone(), false);
        assert_eq!(shown.data["session"]["title"], serde_json::Value::Null);
        assert_eq!(shown.data["session"]["prompt"], serde_json::Value::Null);
        assert_eq!(shown.data["session"]["id"], "ses_2");
        assert_eq!(shown.data["files"][0], "a.rs");
        assert_eq!(update(one, true).data["session"]["title"], "Rotate keys");
    }

    #[test]
    fn its_author_sees_it_all_without_credentials() {
        let mut one = a_session();
        session(&mut one, Sight::Own);
        assert_eq!(one.title.as_deref(), Some("Fix this fucking login with G1T_TOKEN=[redacted]"));
        assert_eq!(one.first_prompt.as_deref(), Some("ugh fix it"));
        let prompt = entry(an_entry(SessionEntryKind::Prompt, "use G1T_TOKEN=abc123def456"), Sight::Own).unwrap();
        assert!(!prompt.withheld);
        assert_eq!(prompt.text, "use G1T_TOKEN=[redacted]");
    }
}
