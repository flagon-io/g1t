//! The work service: intents, attempts and sessions.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntentStatus {
    Open,
    Shipped,
    Withdrawn,
}

/// A goal stated against a repo: the issue, and the home of every attempt
/// made for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    pub repo_id: String,
    /// Sequential per repo, shown as `#12`.
    pub number: u32,
    pub title: String,
    /// The goal in prose: what an agent is given to work from.
    pub brief: String,
    /// Commands that must pass for an attempt to be accepted.
    pub checks: Vec<String>,
    pub status: IntentStatus,
    pub author: User,
    /// RFC 3339.
    pub created_at: String,
    pub attempt_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptStatus {
    Working,
    Submitted,
    Shipped,
    Abandoned,
}

impl AttemptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptStatus::Working => "working",
            AttemptStatus::Submitted => "submitted",
            AttemptStatus::Shipped => "shipped",
            AttemptStatus::Abandoned => "abandoned",
        }
    }

    /// Whether the attempt can still be changed or shipped.
    pub fn is_active(self) -> bool {
        matches!(self, AttemptStatus::Working | AttemptStatus::Submitted)
    }
}

/// Where the agent runs: on g1t's sandboxes, or in someone's own session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptRuntime {
    Hosted,
    External,
}

/// One agent's or person's run at an intent, in its own fork.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub intent_id: String,
    pub repo_id: String,
    /// Sequential per intent.
    pub number: u32,
    /// A label for the agent doing the work, e.g. `claude-code`.
    pub agent: String,
    pub runtime: AttemptRuntime,
    pub status: AttemptStatus,
    /// The agent's own account of what it did, set on submit.
    pub summary: Option<String>,
    pub fork: RepoPath,
    /// The fork's repository id.
    pub fork_repo_id: String,
    pub head_commit: Option<String>,
    /// For a shipped attempt, what the branch pointed to before it landed.
    /// Comparing against it shows what the attempt changed.
    pub landed_base: Option<String>,
    pub started_by: User,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEntryKind {
    Prompt,
    Message,
    ToolCall,
    ToolResult,
    Note,
}

/// One step of an agent's session: the "why" behind an attempt's commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEntry {
    pub seq: u32,
    pub kind: SessionEntryKind,
    pub text: String,
    /// For tool calls and results.
    pub tool: Option<String>,
    /// The fork's head commit when this entry was recorded, if known.
    pub commit: Option<String>,
    /// RFC 3339.
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewSessionEntry {
    pub kind: SessionEntryKind,
    pub text: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IntentDetail {
    pub intent: Intent,
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttemptDetail {
    pub attempt: Attempt,
    pub intent: Intent,
}

/// `open_intent`. Returns `Outcome<Intent>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenIntentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub title: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub checks: Vec<String>,
}

/// `list_intents`. Returns `Outcome<Vec<Intent>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListIntentsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub status: Option<IntentStatus>,
}

/// `get_intent`. Returns `Outcome<IntentDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetIntentArgs {
    pub repo: RepoPath,
    pub number: u32,
    pub viewer: Viewer,
}

/// `withdraw_intent`. Returns `Outcome<Intent>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentActionArgs {
    pub actor: User,
    pub intent_id: String,
}

/// `start_attempt`: forks the repo for the agent and returns the attempt to
/// push to. Returns `Outcome<Attempt>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAttemptArgs {
    pub actor: User,
    pub intent_id: String,
    pub agent: String,
    pub runtime: AttemptRuntime,
}

/// `get_attempt` and `read_session`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptViewArgs {
    pub attempt_id: String,
    pub viewer: Viewer,
    /// For `read_session`: only entries after this sequence number.
    #[serde(default)]
    pub after_seq: u32,
}

/// `submit_attempt`, `abandon_attempt` and `ship_attempt`.
/// Each returns `Outcome<Attempt>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptActionArgs {
    pub actor: User,
    pub attempt_id: String,
    /// For `submit_attempt`: what changed and why.
    #[serde(default)]
    pub summary: String,
}

/// `list_active_attempts`: attempts in progress that the viewer started,
/// newest first. Returns `Vec<AttemptDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ViewerArgs {
    pub viewer: Viewer,
}

/// `append_session`. Returns `Outcome<Appended>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSessionArgs {
    pub actor: User,
    pub attempt_id: String,
    pub entries: Vec<NewSessionEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Appended {
    pub count: u32,
}
