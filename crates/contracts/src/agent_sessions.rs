//! Starting work on a work item in a session of its own, on the person's own
//! Claude (the integrations service, `src/agent_sessions.rs`).
//!
//! g1t runs no model. Work on a work item happens in someone's own harness:
//! their Claude Code with the g1t plugin, or a Claude Managed Agents
//! session that g1t starts with the workspace's own Anthropic key. Either
//! way the session is recorded on g1t (`work::Session`) and tied to the
//! work item and the pull requests it makes. `start_agent_session` is what
//! Ask, chat and the work item page call to hand work off.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::work::Session;
use crate::{User, Viewer};

/// What kind of work a session is asked for. A hint in its prompt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    /// Work out how, and say so on the work item; change nothing.
    Plan,
    /// Make the change and open a pull request.
    #[default]
    Implement,
    /// Review the work item's pull request.
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

/// Who asked g1t in a work item or a pull request, rather than from a
/// button: by assigning it the work item, or by mentioning `@g1t` in a comment.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Asked {
    /// Their username.
    pub by: String,
    /// What their comment said; none for an assignment.
    #[serde(default)]
    pub comment: Option<String>,
    /// Where they asked: the comment, or the work item.
    pub url: String,
}

/// `start_agent_session`: work on `item` (or a new work item from `title` and
/// `body`), or carry on with pull request `pull`, as `actor`. Returns
/// `Outcome<AgentSessionStarted>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StartAgentSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    #[serde(default)]
    pub item: Option<u32>,
    /// A pull request to carry on with, on its branch: in place of `item`.
    #[serde(default)]
    pub pull: Option<u32>,
    /// Set when g1t was asked in the thread (integrations' summon.rs).
    #[serde(default)]
    pub asked: Option<Asked>,
    /// Without `item`: a new work item's title, opened first.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    /// What to do beyond what the work item says.
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
    /// The work item it works on, by number in the workspace: for a pull
    /// request with none, the pull request's number.
    pub item: u32,
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

/// `agent_session_link`: where whoever started a Managed Agents session
/// opens it on the Anthropic account it runs on (the Claude Console).
/// Nobody else is given it: the session's events hold what it was asked
/// and every tool's output, which g1t shows no one but them. Returns
/// `Outcome<String>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentSessionLinkArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The g1t session (`ses_…`) at the top of its tree.
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

/// How long a Managed Agents session's tool call waits for someone to
/// allow or deny it before g1t declines it. The session sits idle while it
/// waits (on the workspace's own Anthropic account, which bills nothing for
/// idle time), so this is about not leaving a session stuck, not cost: long
/// enough for whoever is told to open the page, short enough that a session
/// started and forgotten carries on (with the call declined) the same hour.
pub const APPROVAL_WAIT_MS: u64 = 10 * 60 * 1000;

/// Who may answer a running Managed Agents session (allow or deny its
/// calls, send it a message): whoever started it, and the workspace's
/// members with write access to its repository, who could make the same
/// changes themselves. Never an agent or a token acting for one: a session
/// must not approve its own calls. `started_by` is the id of whoever
/// started it; `member` and `can_push` are the viewer's in the session's
/// workspace and repository.
pub fn may_answer(viewer: &User, started_by: &str, member: bool, can_push: bool) -> bool {
    if viewer.id.is_empty() || viewer.kind != crate::PrincipalKind::User || viewer.acting.is_some() || !viewer.verified {
        return false;
    }
    viewer.id == started_by || (member && can_push)
}

/// Where a call that waited for approval stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    /// Nobody has answered it yet.
    #[default]
    Waiting,
    Allowed,
    Denied,
    /// Nobody answered within [`APPROVAL_WAIT_MS`]: g1t declined it.
    Expired,
    /// The session ended while it waited.
    Ended,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalStatus::Waiting => "waiting",
            ApprovalStatus::Allowed => "allowed",
            ApprovalStatus::Denied => "denied",
            ApprovalStatus::Expired => "expired",
            ApprovalStatus::Ended => "ended",
        }
    }

    pub fn parse(name: &str) -> ApprovalStatus {
        match name {
            "allowed" => ApprovalStatus::Allowed,
            "denied" => ApprovalStatus::Denied,
            "expired" => ApprovalStatus::Expired,
            "ended" => ApprovalStatus::Ended,
            _ => ApprovalStatus::Waiting,
        }
    }
}

/// A tool call of a Managed Agents session that waits for someone to allow
/// or deny it. What it would do is summarized as the transcript shows a
/// call (`tool: what`, secrets hidden), never its whole input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproval {
    /// The g1t session (`ses_…`) at the top of its tree.
    pub session_id: String,
    /// `owner/name`.
    pub repo: String,
    /// The work item the session works on, by number in the workspace.
    #[serde(default)]
    pub item: Option<u32>,
    /// The call's id with the provider: what an answer names.
    pub tool_use_id: String,
    /// The tool, as the transcript names it (`bash`, `g1t:work_item`).
    pub tool: String,
    /// What it wants to do, in one line.
    pub summary: String,
    pub status: ApprovalStatus,
    /// Who started the session (username).
    pub started_by: String,
    /// Who answered it (username), when someone did.
    #[serde(default)]
    pub answered_by: Option<String>,
    /// RFC 3339.
    pub asked_at: String,
    /// When g1t declines it if nobody answers. RFC 3339.
    pub expires_at: String,
}

/// `agent_session_approvals`: the calls waiting for approval in a
/// workspace's Managed Agents sessions that `viewer` may answer (see
/// [`may_answer`]), newest first; with `session`, that session's only.
/// Returns `Outcome<Vec<AgentApproval>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AgentApprovalsArgs {
    pub viewer: Viewer,
    pub workspace: String,
    /// A g1t session (`ses_…`) at the top of its tree.
    #[serde(default)]
    pub session: Option<String>,
}

/// An answer to a call that waits for approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalAnswer {
    Allow,
    Deny,
}

/// The most characters of a message sent to a running session.
pub const MAX_MESSAGE_CHARS: usize = 4_000;

/// `answer_agent_session`: allows or denies a call of a running Managed
/// Agents session that waits for approval. For whoever [`may_answer`]. An
/// answer after the session ended, after [`APPROVAL_WAIT_MS`], or after
/// someone else answered is refused, never sent. Returns
/// `Outcome<AgentApproval>`: the call as it now stands.
#[derive(Debug, Serialize, Deserialize)]
pub struct AnswerAgentSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The g1t session (`ses_…`) at the top of its tree.
    pub id: String,
    pub tool_use_id: String,
    pub answer: ApprovalAnswer,
    /// With a denial: why, told to the session.
    #[serde(default)]
    pub note: Option<String>,
}

/// `message_agent_session`: sends a message to a running Managed Agents
/// session, as its next instruction. For whoever [`may_answer`]. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageAgentSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The g1t session (`ses_…`) at the top of its tree.
    pub id: String,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: &str) -> User {
        User { id: id.into(), username: id.into(), verified: true, ..Default::default() }
    }

    #[test]
    fn whoever_started_it_and_writers_in_the_workspace_may_answer() {
        assert!(may_answer(&person("usr_a"), "usr_a", false, false));
        assert!(may_answer(&person("usr_b"), "usr_a", true, true));
        // A member who only reads, or a writer from outside the workspace, may not.
        assert!(!may_answer(&person("usr_b"), "usr_a", true, false));
        assert!(!may_answer(&person("usr_b"), "usr_a", false, true));
        // Nor anyone signed out, unverified, or anything but a person.
        assert!(!may_answer(&User::default(), "", true, true));
        assert!(!may_answer(&User { verified: false, ..person("usr_a") }, "usr_a", true, true));
        assert!(!may_answer(&User { kind: crate::PrincipalKind::Agent, ..person("usr_a") }, "usr_a", true, true));
        assert!(!may_answer(&User { kind: crate::PrincipalKind::Workspace, ..person("acme") }, "usr_a", true, true));
    }

    #[test]
    fn approval_states_are_named_one_way() {
        for status in [ApprovalStatus::Waiting, ApprovalStatus::Allowed, ApprovalStatus::Denied, ApprovalStatus::Expired, ApprovalStatus::Ended] {
            assert_eq!(ApprovalStatus::parse(status.as_str()), status);
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
        assert_eq!(serde_json::to_value(ApprovalAnswer::Deny).unwrap(), "deny");
    }

    #[test]
    fn modes_are_named_one_way() {
        assert_eq!(AgentMode::parse("Review"), Some(AgentMode::Review));
        assert_eq!(AgentMode::parse("nap"), None);
        assert_eq!(serde_json::to_value(AgentMode::Plan).unwrap(), "plan");
        assert_eq!(AgentMode::default(), AgentMode::Implement);
    }
}
