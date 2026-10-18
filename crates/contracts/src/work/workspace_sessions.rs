//! Sessions across a workspace: what is cooking in every repository of it
//! the viewer may read, every kind of session in one shape, with the merge
//! queues and what just landed. Sessions' own page in the web, `GET
//! /workspaces/{workspace}/sessions`, the `session` tool's `list` with a
//! `workspace`, and `g1t session list --workspace`.
//!
//! Kinds of session:
//! - **harness**: someone's own harness (Claude Code, Codex, Cursor,
//!   Copilot, another) recording itself with `start_session`.
//! - **hosted**: a session g1t started for someone, from the web or a work
//!   item, on the workspace's Anthropic provider (`claude_managed_agents`).
//! - **agent**: a run of g1t's own agent on a pull request (`agent_runs`).
//! - **recorded**: what a coding agent recorded on a pull request with
//!   `record_session`, with no session of its own behind it.

use serde::{Deserialize, Serialize};

use super::{Harness, Pull, PullStatus, QueueView, Session, SessionDetail, SessionState, SESSION_IDLE_MS, SESSION_TIMEOUT_MS};
use crate::Viewer;

/// What kind of session one in a workspace's list is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Harness,
    Hosted,
    Agent,
    Recorded,
}

impl SessionKind {
    pub const ALL: [SessionKind; 4] = [SessionKind::Harness, SessionKind::Hosted, SessionKind::Agent, SessionKind::Recorded];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Harness => "harness",
            SessionKind::Hosted => "hosted",
            SessionKind::Agent => "agent",
            SessionKind::Recorded => "recorded",
        }
    }

    pub fn parse(name: &str) -> Option<SessionKind> {
        let name = name.trim().to_lowercase();
        SessionKind::ALL.into_iter().find(|kind| kind.as_str() == name)
    }

    /// The kind of a session recorded with `start_session`: g1t started
    /// those in Claude Managed Agents, the rest are someone's own harness.
    pub fn of(harness: Harness) -> SessionKind {
        match harness {
            Harness::ClaudeManagedAgents => SessionKind::Hosted,
            _ => SessionKind::Harness,
        }
    }
}

/// Which of a workspace's sessions to list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionsShown {
    /// Those going now: active or idle, a run queued or running.
    Live,
    /// Every one, most recently heard from first.
    #[default]
    Recent,
    /// Those that ended, or went quiet long enough to have.
    Ended,
}

impl SessionsShown {
    pub fn parse(name: &str) -> Option<SessionsShown> {
        match name.trim().to_lowercase().as_str() {
            "live" => Some(SessionsShown::Live),
            "recent" | "all" => Some(SessionsShown::Recent),
            "ended" => Some(SessionsShown::Ended),
            _ => None,
        }
    }

    pub fn admits(self, state: SessionState) -> bool {
        match self {
            SessionsShown::Live => state != SessionState::Ended,
            SessionsShown::Recent => true,
            SessionsShown::Ended => state == SessionState::Ended,
        }
    }
}

/// The state of a session as it is now: one that went quiet past the
/// timeout reads as ended, as the next sweep of its repository will make
/// it, so a list across a workspace never shows one as live.
pub fn settled_state(state: SessionState, last_seen_ms: u64, now_ms: u64) -> SessionState {
    if state != SessionState::Ended && now_ms.saturating_sub(last_seen_ms) >= SESSION_TIMEOUT_MS {
        SessionState::Ended
    } else {
        state
    }
}

/// The state of something heard from at `last_ms` with no state of its own
/// (a pull request's recorded session): active, idle or ended by how long
/// it has been quiet, unless something of it is still running.
pub fn quiet_state(running: bool, last_ms: u64, now_ms: u64) -> SessionState {
    let quiet = now_ms.saturating_sub(last_ms);
    if running || quiet < SESSION_IDLE_MS {
        SessionState::Active
    } else if quiet < SESSION_TIMEOUT_MS {
        SessionState::Idle
    } else {
        SessionState::Ended
    }
}

/// One session of a workspace, whatever its kind.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    pub kind: SessionKind,
    /// `ses_…` for a harness or hosted session, `run_…` for g1t's agent,
    /// the pull request's id for one recorded on it.
    pub id: String,
    /// The repository it is in, `owner/name`.
    pub repo: String,
    pub repo_id: String,
    pub title: Option<String>,
    /// Who runs it: whose token started it, who put g1t's agent to work, or
    /// who opened the pull request. `g1t` for g1t's own.
    pub actor: Option<String>,
    /// For a harness or hosted session.
    pub harness: Option<Harness>,
    /// For g1t's agent and a recorded one: the agent label (`g1t`, `claude-code`).
    pub agent: Option<String>,
    pub branch: Option<String>,
    /// The work item it is on, by number in the workspace.
    pub item: Option<u32>,
    pub item_title: Option<String>,
    pub pull: Option<u32>,
    pub pull_title: Option<String>,
    pub pull_status: Option<PullStatus>,
    pub state: SessionState,
    /// RFC 3339.
    pub started_at: String,
    /// RFC 3339: its last heartbeat, step or entry.
    pub last_activity_at: String,
    /// How many subagents it started.
    pub subagents: u32,
    /// For g1t's agent: what it is doing now, in one line.
    pub step: Option<String>,
    /// For a harness or hosted session: the session itself.
    pub session: Option<Session>,
    /// With `subagents`: its subagents and theirs, each naming its parent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Session>,
}

/// A repository of the workspace the viewer may read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsRepo {
    pub id: String,
    /// `owner/name`.
    pub path: String,
    pub default_branch: String,
}

/// One repository's merge queue, when something is waiting in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoQueue {
    /// `owner/name`.
    pub repo: String,
    pub default_branch: String,
    #[serde(flatten)]
    pub queue: QueueView,
}

/// A pull request with the repository it is in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPull {
    /// `owner/name`.
    pub repo: String,
    #[serde(flatten)]
    pub pull: Pull,
}

/// `list_workspace_sessions`'s answer.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessions {
    /// Most recently heard from first; live ones first with `Live`.
    pub sessions: Vec<WorkspaceSession>,
    /// The merge queues with something waiting, busiest first.
    #[serde(default)]
    pub queue: Vec<RepoQueue>,
    /// The pull requests merged most recently, newest first.
    #[serde(default)]
    pub landed: Vec<RepoPull>,
    /// The repositories looked in: every one of the workspace the viewer
    /// may read, or the one asked for.
    #[serde(default)]
    pub repos: Vec<SessionsRepo>,
}

/// The most sessions one list gives.
pub const MAX_WORKSPACE_SESSIONS: u32 = 200;
/// The sessions a list gives when it does not say.
pub const DEFAULT_WORKSPACE_SESSIONS: u32 = 60;

/// `list_workspace_sessions`: the sessions of every repository of a
/// workspace the viewer may read. Returns `Outcome<WorkspaceSessions>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListWorkspaceSessionsArgs {
    pub viewer: Viewer,
    pub workspace: String,
    #[serde(default)]
    pub shown: SessionsShown,
    #[serde(default)]
    pub kind: Option<SessionKind>,
    #[serde(default)]
    pub harness: Option<Harness>,
    /// Only those this person runs, by username.
    #[serde(default)]
    pub person: Option<String>,
    /// Only those in this repository of the workspace, by name.
    #[serde(default)]
    pub repo: Option<String>,
    /// Only those on this work item, by number.
    #[serde(default)]
    pub item: Option<u32>,
    /// Each session's subagents too, in its `children`.
    #[serde(default)]
    pub subagents: bool,
    /// Leave out the merge queues and what landed.
    #[serde(default)]
    pub sessions_only: bool,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `get_workspace_session`: one harness or hosted session of a workspace by
/// its id, in whichever of its repositories it runs. Returns
/// `Outcome<WorkspaceSessionDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetWorkspaceSessionArgs {
    pub viewer: Viewer,
    pub workspace: String,
    pub id: String,
    #[serde(default)]
    pub after_seq: u32,
}

/// A session and the repository it runs in.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceSessionDetail {
    /// `owner/name`.
    pub repo: String,
    #[serde(flatten)]
    pub detail: SessionDetail,
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_791_800_000_000;

    #[test]
    fn a_session_started_by_g1t_is_hosted_and_the_rest_are_harnesses() {
        assert_eq!(SessionKind::of(Harness::ClaudeManagedAgents), SessionKind::Hosted);
        for harness in [Harness::ClaudeCode, Harness::Codex, Harness::Cursor, Harness::Copilot, Harness::Other] {
            assert_eq!(SessionKind::of(harness), SessionKind::Harness);
        }
        for kind in SessionKind::ALL {
            assert_eq!(SessionKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(SessionKind::parse("Agent"), Some(SessionKind::Agent));
        assert_eq!(SessionKind::parse("bot"), None);
    }

    #[test]
    fn a_quiet_session_settles_as_ended_and_live_shows_only_those_going() {
        assert_eq!(settled_state(SessionState::Active, NOW - 60_000, NOW), SessionState::Active);
        assert_eq!(settled_state(SessionState::Idle, NOW - SESSION_IDLE_MS, NOW), SessionState::Idle);
        assert_eq!(settled_state(SessionState::Idle, NOW - SESSION_TIMEOUT_MS, NOW), SessionState::Ended);
        assert!(SessionsShown::Live.admits(SessionState::Idle));
        assert!(!SessionsShown::Live.admits(SessionState::Ended));
        assert!(SessionsShown::Ended.admits(SessionState::Ended));
        assert!(!SessionsShown::Ended.admits(SessionState::Active));
        assert!(SessionsShown::Recent.admits(SessionState::Ended));
        assert_eq!(SessionsShown::parse("live"), Some(SessionsShown::Live));
        assert_eq!(SessionsShown::parse("all"), Some(SessionsShown::Recent));
        assert_eq!(SessionsShown::default(), SessionsShown::Recent);
    }

    #[test]
    fn a_recorded_session_reads_its_state_from_how_long_it_has_been_quiet() {
        assert_eq!(quiet_state(false, NOW - 1_000, NOW), SessionState::Active);
        assert_eq!(quiet_state(false, NOW - SESSION_IDLE_MS, NOW), SessionState::Idle);
        assert_eq!(quiet_state(false, NOW - SESSION_TIMEOUT_MS, NOW), SessionState::Ended);
        assert_eq!(quiet_state(true, NOW - SESSION_TIMEOUT_MS * 4, NOW), SessionState::Active);
    }

    #[test]
    fn a_detail_carries_its_repository_beside_the_session() {
        let detail: WorkspaceSessionDetail = serde_json::from_value(serde_json::json!({
            "repo": "acme/web",
            "session": {
                "id": "ses_1", "repoId": "rep_1", "item": 4, "pull": null, "branch": "main",
                "actor": { "id": "usr_1", "username": "ana" }, "harness": "codex", "harnessSessionId": null,
                "title": "Greet", "state": "active", "headCommit": null, "startedAt": "t", "lastSeenAt": "t",
                "endedAt": null, "endReason": null
            },
            "entries": []
        }))
        .unwrap();
        assert_eq!(detail.repo, "acme/web");
        let back = serde_json::to_value(&detail).unwrap();
        assert_eq!(back["repo"], "acme/web");
        assert_eq!(back["session"]["id"], "ses_1");
    }
}
