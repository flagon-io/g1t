//! Runs and recorded sessions. Kept by the work service.
//!
//! Every sandbox g1t starts for checks, the merge queue or a merge check is
//! an [`AgentRun`]: what it is doing, on which pull request, step by step,
//! and how it ended. Runs of the agents g1t once ran itself stay readable.
//!
//! A session is what a coding agent recorded on a pull request
//! (`append_session`, `read_session`), summed up and listed here.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::work::{Pull, PullStatus, SessionEntry};
use crate::{User, Viewer};

/// The work a run does. Only `Checks`, `Queue` and `Mergecheck` are
/// started now; the others are runs of the agents g1t once ran itself,
/// kept so the runs and run credentials already stored still parse. None
/// of them is started or granted any more.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    /// Making the change a work item asks for.
    Implement,
    /// Addressing failed checks or a review on its own pull request.
    Revise,
    /// Reviewing someone's pull request.
    Review,
    /// Answering another agent's question or handoff.
    Answer,
    /// Merging in the branch a pull request will land on.
    Update,
    /// Turning an outcome into a plan of work items.
    Plan,
    /// Running a work item's acceptance checks. Not an agent: a sandbox.
    Checks,
    /// Building and checking a state of the merge queue. Not an agent.
    Queue,
    /// Finding out whether a pull request merges cleanly. Not an agent.
    Mergecheck,
}

impl RunKind {
    pub const ALL: [RunKind; 9] = [
        RunKind::Implement,
        RunKind::Revise,
        RunKind::Review,
        RunKind::Answer,
        RunKind::Update,
        RunKind::Plan,
        RunKind::Checks,
        RunKind::Queue,
        RunKind::Mergecheck,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Implement => "implement",
            RunKind::Revise => "revise",
            RunKind::Review => "review",
            RunKind::Answer => "answer",
            RunKind::Update => "update",
            RunKind::Plan => "plan",
            RunKind::Checks => "checks",
            RunKind::Queue => "queue",
            RunKind::Mergecheck => "mergecheck",
        }
    }

    pub fn parse(value: &str) -> Option<RunKind> {
        RunKind::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Its sandbox is starting.
    Queued,
    Running,
    Succeeded,
    Failed,
    /// A person stopped it.
    Stopped,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<RunStatus> {
        [RunStatus::Queued, RunStatus::Running, RunStatus::Succeeded, RunStatus::Failed, RunStatus::Stopped]
            .into_iter()
            .find(|status| status.as_str() == value)
    }

    pub fn is_active(self) -> bool {
        matches!(self, RunStatus::Queued | RunStatus::Running)
    }
}

/// One step of a run, as one short line.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunStep {
    /// RFC 3339.
    pub at: String,
    pub text: String,
}

/// One sandbox g1t started: a run of checks, a merge queue build or a
/// merge check (or, on older rows, one of its former agents at work).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub repo: RepoPath,
    /// The pull request it works on; for a plan, none.
    pub number: Option<u32>,
    /// That pull request's title, or the plan's brief.
    pub title: Option<String>,
    pub kind: RunKind,
    /// Who is working: `g1t` for g1t's own agent and for a sandbox that
    /// runs commands.
    pub agent: String,
    /// The model, by its public name. Members only.
    pub model: Option<String>,
    pub status: RunStatus,
    /// What it is doing now, in one line.
    pub step: Option<String>,
    /// Every step so far, oldest first. Empty in lists.
    #[serde(default)]
    pub steps: Vec<RunStep>,
    /// How many steps there are.
    #[serde(default)]
    pub step_count: u32,
    /// Who put it to work, when a person did.
    pub started_by: Option<String>,
    /// Why it failed.
    pub error: Option<String>,
    /// What it cost, in US dollars, as the harness reported it. Members only.
    pub cost_usd: Option<f64>,
    pub turns: Option<u32>,
    /// The most it may cost, in US dollars, from its guardrails. None: no
    /// cap. Members only.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// The longest it may take, in minutes, from its guardrails.
    #[serde(default)]
    pub time_cap_minutes: Option<u32>,
    /// `budget` or `time` when g1t stopped it for reaching a cap.
    #[serde(default)]
    pub halted: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

/// What lets a sandbox, and nothing else, report on its run.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunTicket {
    pub run_id: String,
    pub token: String,
}

/// `open_run`: records a sandbox the runner is starting. Called by the
/// runner service only. Returns `Outcome<AgentRunTicket>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunArgs {
    /// Who the sandbox acts as.
    pub actor: User,
    pub repo: RepoPath,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub pull_id: Option<String>,
    /// For a run with no pull request, such as a plan: what it is about.
    #[serde(default)]
    pub title: Option<String>,
    pub kind: RunKind,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The sandbox's name, which stopping it needs.
    pub sandbox: String,
    #[serde(default)]
    pub started_by: Option<String>,
    /// Its cost cap, from its guardrails, in US dollars.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// Its time cap, from its guardrails, in minutes.
    #[serde(default)]
    pub time_cap_minutes: Option<u32>,
}

/// `report_run`: a sandbox telling how its run goes, with the run's token.
/// Steps are added, the current step replaced, and an outcome ends the run.
/// A finished run accepts nothing more. Returns `Outcome<RunStatus>`: the
/// run's status after the report, so a sandbox can tell it was stopped.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportRunArgs {
    pub run_id: String,
    pub token: String,
    pub steps: Vec<String>,
    pub step: Option<String>,
    pub cost_usd: Option<f64>,
    pub turns: Option<u32>,
    /// `succeeded` or `failed`, to end the run.
    pub outcome: Option<RunStatus>,
    pub error: Option<String>,
    /// `budget` or `time`: the run reached a cap of its guardrails and
    /// stopped. Ends it as stopped, like a person's stop.
    pub halt: Option<crate::guardrails::Halt>,
}

/// `list_runs`: runs in a repository, or with `workspace` instead, in every
/// repository of a workspace (members only), newest first. Returns
/// `Outcome<Vec<AgentRun>>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListRunsArgs {
    pub viewer: Viewer,
    pub repo: Option<RepoPath>,
    pub workspace: Option<String>,
    /// Only those queued or running.
    pub active: bool,
    pub kind: Option<RunKind>,
    pub status: Option<RunStatus>,
    /// Only those on this pull request.
    pub number: Option<u32>,
    /// At most 200; 50 if not given.
    pub limit: Option<u32>,
}

/// `get_run`: one run with all its steps. Returns `Outcome<AgentRun>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetRunArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub id: String,
}

/// A pull request's recorded session, summed up for a list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub number: u32,
    pub title: String,
    pub status: PullStatus,
    /// The agent label on the pull request, such as `g1t`.
    pub agent: String,
    pub entries: u32,
    /// How many tools it called.
    pub tools: u32,
    /// The start of the first prompt.
    pub prompt: Option<String>,
    /// The kinds of the runs g1t made for it.
    pub kinds: Vec<RunKind>,
    pub runs: u32,
    /// What its runs cost together. Members only.
    pub cost_usd: Option<f64>,
    /// Whether one of its runs is under way.
    pub active: bool,
    /// RFC 3339.
    pub started_at: String,
    pub last_at: String,
}

/// `list_sessions`: the pull requests of a repository that have a session,
/// most recently active first. Returns `Outcome<Vec<SessionSummary>>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListSessionsArgs {
    pub viewer: Viewer,
    pub repo: Option<RepoPath>,
    /// Only those with a run of this kind.
    pub kind: Option<RunKind>,
    /// The pull request's status: `draft`, `open`, `merged` or `closed`.
    pub outcome: Option<PullStatus>,
    pub number: Option<u32>,
}

/// `get_session`: one pull request's session in full, with its runs.
/// Returns `Outcome<SessionView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetSessionArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub number: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub pull: Pull,
    /// Oldest first; the first 2000.
    pub entries: Vec<SessionEntry>,
    /// Newest first, with their steps.
    pub runs: Vec<AgentRun>,
    /// Members only.
    pub cost_usd: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_statuses_round_trip() {
        for kind in RunKind::ALL {
            assert_eq!(RunKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(RunStatus::parse("stopped"), Some(RunStatus::Stopped));
        assert!(RunStatus::Queued.is_active() && !RunStatus::Failed.is_active());
    }
}
