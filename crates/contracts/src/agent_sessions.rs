//! Starting work on an issue in a session of its own, on the person's own
//! Claude (the integrations service, `src/agent_sessions.rs`).
//!
//! g1t runs no model. Work on an issue happens in someone's own harness:
//! their Claude Code with the g1t plugin, or a Claude Managed Agents
//! session that g1t starts with the workspace's own Anthropic key. Either
//! way the session is recorded on g1t (`work::Session`) and tied to the
//! issue and the pull requests it makes. `start_agent_session` is what
//! Ask, chat and the issue page call to hand work off.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::work::Session;
use crate::{User, Viewer};

/// What kind of work a session is asked for. A hint in its prompt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    /// Work out how, and say so on the issue; change nothing.
    Plan,
    /// Make the change and open a pull request.
    #[default]
    Implement,
    /// Review the issue's pull request.
    Review,
}

impl AgentMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentMode::Plan => "plan",
            AgentMode::Implement => "implement",
            AgentMode::Review => "review",
        }
    }

    pub fn parse(name: &str) -> Option<AgentMode> {
        match name.trim().to_ascii_lowercase().as_str() {
            "plan" => Some(AgentMode::Plan),
            "implement" => Some(AgentMode::Implement),
            "review" => Some(AgentMode::Review),
            _ => None,
        }
    }
}

/// The most characters of an instruction kept.
pub const MAX_INSTRUCTION_CHARS: usize = 4_000;

/// Who asked g1t in an issue or a pull request, rather than from a
/// button: by assigning it the issue, or by mentioning `@g1t` in a comment.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Asked {
    /// Their username.
    pub by: String,
    /// What their comment said; none for an assignment.
    #[serde(default)]
    pub comment: Option<String>,
    /// Where they asked: the comment, or the issue.
    pub url: String,
}

/// `start_agent_session`: work on `issue` (or a new issue from `title` and
/// `body`), or carry on with pull request `pull`, as `actor`. Returns
/// `Outcome<AgentSessionStarted>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StartAgentSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    #[serde(default)]
    pub issue: Option<u32>,
    /// A pull request to carry on with, on its branch: in place of `issue`.
    #[serde(default)]
    pub pull: Option<u32>,
    /// Set when g1t was asked in the thread (integrations' summon.rs).
    #[serde(default)]
    pub asked: Option<Asked>,
    /// Without `issue`: a new issue's title, opened first.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    /// What to do beyond what the issue says.
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub mode: Option<AgentMode>,
    /// `true`: a hand-off to run in Claude Code, never a session started
    /// here. `false`: a session here or a refusal. None: a session here
    /// when the workspace has an Anthropic connection, else the hand-off.
    #[serde(default)]
    pub handoff: Option<bool>,
}

/// What `start_agent_session` started, or the hand-off to run.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStarted {
    /// The issue it works on: for a pull request with none, its number.
    pub issue: u32,
    /// The pull request it carries on with, when it was started on one.
    #[serde(default)]
    pub pull: Option<u32>,
    /// The session on g1t, when one was started here.
    #[serde(default)]
    pub session: Option<Session>,
    /// Its page on g1t.
    #[serde(default)]
    pub session_url: Option<String>,
    /// Who runs it: `anthropic`, or none for a hand-off.
    #[serde(default)]
    pub provider: Option<String>,
    /// Its own id with the provider (`sesn_…`).
    #[serde(default)]
    pub provider_session_id: Option<String>,
    /// Where the provider shows it, when it says.
    #[serde(default)]
    pub provider_session_url: Option<String>,
    /// Whether this is a hand-off: nothing was started.
    pub handoff: bool,
    /// For a hand-off: the Claude Code command line that starts it.
    #[serde(default)]
    pub command: Option<String>,
    /// What the session is asked: the prompt sent, or to paste.
    pub prompt: String,
}

/// `agent_sessions_setup`: whether `viewer` can start sessions on the
/// workspace's Anthropic key. Returns `Outcome<AgentSessionsSetup>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSessionsSetupArgs {
    pub viewer: Viewer,
    pub workspace: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsSetup {
    /// A session can be started with the workspace's Anthropic key.
    pub available: bool,
    /// The Anthropic connection used.
    #[serde(default)]
    pub connection_name: Option<String>,
    /// The model sessions run on.
    #[serde(default)]
    pub model: Option<String>,
    /// Why not, when not.
    #[serde(default)]
    pub problem: Option<String>,
}

/// `sync_agent_session`: brings a Managed Agents session's record on g1t
/// up to date now (it is otherwise followed every minute). Returns
/// `Outcome<bool>`: whether it is still going.
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncAgentSessionArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    /// The g1t session (`ses_…`).
    pub id: String,
}

/// `stop_agent_session`: interrupts a Managed Agents session and ends its
/// record. Only whoever started it. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StopAgentSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_are_named_one_way() {
        assert_eq!(AgentMode::parse("Review"), Some(AgentMode::Review));
        assert_eq!(AgentMode::parse("nap"), None);
        assert_eq!(serde_json::to_value(AgentMode::Plan).unwrap(), "plan");
        assert_eq!(AgentMode::default(), AgentMode::Implement);
    }
}
