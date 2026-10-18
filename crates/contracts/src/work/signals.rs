//! What a workspace's work says over the last weeks: the reads behind
//! Home's daily signal and the Workspace overview. Each row is one
//! repository's, so a caller that asks in batches adds them up.
//!
//! A pull request is an agent's when g1t's agent opened it, it was opened
//! as an agent's, or a harness session is tied to it (by a link, by saying
//! so when it started, or by pushing its branch). Whose it is (`owner`) is
//! the person it was requested by, else its author: the one who
//! understood it.
use crate::Viewer;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSignalsArgs {
    /// The workspace the repositories belong to: its work items and milestones.
    pub workspace: String,
    /// Up to 100 repositories; the ones the viewer cannot read are left out.
    pub repo_ids: Vec<String>,
    pub viewer: Viewer,
    /// The last UTC day covered, `YYYY-MM-DD`: the last week ends with it.
    pub until: String,
    /// How many weeks of seven UTC days end with `until`: 1 through 13.
    pub weeks: u32,
    /// How many UTC days end with `until` for `days`: 1 through 28.
    pub days: u32,
    /// The first UTC day `pulls` reaches back to, `YYYY-MM-DD`: at most 400 days before `until`.
    pub since: String,
}

/// One repository's week, starting on UTC day `start`. Weeks with nothing
/// in them are left out.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalWeek {
    pub repo_id: String,
    pub start: String,
    pub merged: u32,
    /// Of `merged`, an agent's.
    pub agent_merged: u32,
    /// Of `agent_merged`, the ones a person asked for changes on before they merged.
    pub agent_reworked: u32,
    /// Agent pull requests opened in the week whose session started first,
    /// and the seconds from each session's start to its pull request opening.
    pub agent_drafted: u32,
    pub agent_draft_seconds: f64,
    /// First reviews given in the week (a person's approval or request for
    /// changes, as Insights counts them), and the seconds each waited.
    pub reviewed: u32,
    pub review_seconds: f64,
    /// Pull requests open when the week ended (now, for the current week),
    /// opened at least three days before, with no activity in the three
    /// days before it ended: no push, comment, review, timeline event,
    /// check or session entry.
    pub stalled: u32,
    /// What the harness sessions started in the week cost, as they
    /// reported it (estimated at list price from their token usage).
    pub session_cost_usd: f64,
}

/// One repository's UTC day. Days with nothing in them are left out.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalDay {
    pub repo_id: String,
    pub day: String,
    pub opened: u32,
    pub merged: u32,
    /// Of `merged`, an agent's.
    pub agent_merged: u32,
    /// A person's requests for changes.
    pub reworked: u32,
    /// Reviews and comments by people other than the pull request's owner.
    pub reviews: u32,
    /// Harness sessions started.
    pub sessions: u32,
}

/// An open pull request no one has reviewed yet, oldest first.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct WaitingPull {
    pub repo_id: String,
    pub number: u32,
    pub title: String,
    pub created_at: String,
    pub agent: bool,
    /// For an agent's: seconds from its first session's start to opening.
    pub draft_seconds: Option<f64>,
    /// The work item it is for, and the open work items blocked by that one.
    pub item: Option<u32>,
    pub blocks: Vec<u32>,
}

/// A pull request opened or merged since `since`.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalPull {
    pub repo_id: String,
    pub number: u32,
    pub title: String,
    /// draft, open, merged or closed.
    pub status: String,
    pub agent: bool,
    pub owner_id: String,
    pub owner_name: String,
    pub created_at: String,
    pub merged_at: Option<String>,
    /// The work item it is for, and that item's milestone.
    pub item: Option<u32>,
    pub milestone: Option<u32>,
    /// Its share of what the harness sessions tied to it cost: each
    /// session's cost split evenly among the pull requests it is tied to.
    pub session_cost_usd: f64,
}

/// One person's use of one harness in one repository: when they first
/// started a session with it there, and how many they have started.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalHarness {
    pub repo_id: String,
    pub owner_id: String,
    pub owner_name: String,
    /// claude_code, codex, cursor, copilot or other.
    pub harness: String,
    pub first_at: String,
    pub sessions: u32,
}

/// One person's merged pull requests in one repository, over its whole history.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalAuthor {
    pub repo_id: String,
    pub owner_id: String,
    pub owner_name: String,
    pub first_merged_at: String,
    pub last_merged_at: String,
    pub merged: u32,
    /// Of `merged`, the ones in the 90 days ending with `until`.
    pub recent: u32,
}

/// A work item `pulls` or `waiting` names.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalItem {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub milestone: Option<u32>,
}

/// One of the workspace's milestones.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all(serialize = "camelCase"))]
pub struct SignalMilestone {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub due_on: Option<String>,
    pub created_at: String,
    pub closed_at: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSignals {
    pub weeks: Vec<SignalWeek>,
    pub days: Vec<SignalDay>,
    /// At most 50.
    pub waiting: Vec<WaitingPull>,
    /// At most 3,000, newest first; `pulls_capped` when there were more.
    pub pulls: Vec<SignalPull>,
    pub pulls_capped: bool,
    pub authors: Vec<SignalAuthor>,
    /// People's harnesses, root sessions only (a subagent is its parent's).
    pub harnesses: Vec<SignalHarness>,
    pub items: Vec<SignalItem>,
    pub milestones: Vec<SignalMilestone>,
}
