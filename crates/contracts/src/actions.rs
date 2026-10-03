//! The actions service: GitHub Actions workflows, run on g1t as they are.
//!
//! A repository's `.github/workflows/*.yml` are read from the commit an
//! event is about (the default branch for issues, schedules and manual
//! runs). Each workflow an event starts becomes a run; each job of the run
//! (one per matrix combination) runs in a sandbox once the jobs it needs
//! have finished. Jobs report their steps and logs back as they go, and a
//! run on a pull request's head is a status on that pull request.
//!
//! Secrets and variables belong to a repository or to its workspace; a
//! repository's override its workspace's of the same name. Secret values
//! are sealed at rest and never returned.
//!
//! Mirrors `packages/contracts/src/actions.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// A note on something in a workflow that runs differently on g1t.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNote {
    /// `info`, `warning` or `unsupported`.
    pub severity: String,
    pub job: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    /// `.github/workflows/ci.yml`.
    pub path: String,
    pub name: String,
    /// The events that start it, such as `push` and `pull_request`.
    pub events: Vec<String>,
    /// `active`, or `disabled` when a member turned it off.
    pub state: String,
    /// Why the file cannot be used, if it cannot.
    pub error: Option<String>,
    pub notes: Vec<WorkflowNote>,
    /// `on.workflow_dispatch.inputs` as written, when it can be run by hand.
    pub dispatch: Option<Value>,
    pub last_run: Option<WorkflowRun>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub path: String,
    /// The workflow's name.
    pub name: String,
    /// `run-name`, or what started it: a commit's subject, a pull request's title.
    pub title: String,
    /// Counts the workflow's runs: 1, 2, 3…
    pub number: u64,
    pub attempt: u64,
    /// The GitHub event: `push`, `pull_request`, `schedule`…
    pub event: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
    /// The pull request it ran for, if any.
    pub pull: Option<u32>,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// When completed: `success`, `failure`, `cancelled` or `skipped`.
    pub conclusion: Option<String>,
    /// Why it could not start, such as a workflow file that does not read.
    pub error: Option<String>,
    /// Username of whoever caused it.
    pub actor: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    /// From 1.
    pub number: u32,
    pub name: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// `success`, `failure`, `cancelled` or `skipped`.
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// A message a step left with `::error::`, `::warning::` or `::notice::`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// `error`, `warning` or `notice`.
    pub level: String,
    pub message: String,
    pub title: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub run_id: String,
    /// Its key under `jobs:`.
    pub key: String,
    /// With its matrix combination: `test (ubuntu-latest, 20)`.
    pub name: String,
    pub needs: Vec<String>,
    /// `queued`, `waiting` (for the jobs it needs), `in_progress` or `completed`.
    pub status: String,
    pub conclusion: Option<String>,
    pub steps: Vec<StepState>,
    pub annotations: Vec<Annotation>,
    /// Why it did not run, or what stopped it.
    pub reason: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: WorkflowRun,
    pub jobs: Vec<Job>,
    /// The workflow's notes, as of the run's commit.
    pub notes: Vec<WorkflowNote>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub seq: u64,
    /// The step it belongs to, from 1; 0 for the job's setup.
    pub step: u32,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub chunks: Vec<LogChunk>,
    /// Whether the job has finished, so no more will come.
    pub done: bool,
}

/// A secret's or variable's name, and for a variable its value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub name: String,
    /// Variables only; secrets are never returned.
    pub value: Option<String>,
    /// `repository` or `workspace`.
    pub scope: String,
    pub updated_at: String,
}

// --- Methods ---------------------------------------------------------------

/// `workflows`. Returns `Outcome<Vec<Workflow>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkflowsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
}

/// `runs`: newest first. Returns `Outcome<Vec<WorkflowRun>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    /// A workflow's id or file name.
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    /// The pull request's number.
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `run`. Returns `Outcome<RunDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    pub id: String,
}

/// `logs`: a job's log after `after`. Returns `Outcome<JobLog>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LogsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    pub job: String,
    #[serde(default)]
    pub after: u64,
}

/// `dispatch`: run a workflow that has `workflow_dispatch`. Members only.
/// Returns `Outcome<WorkflowRun>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DispatchArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// A workflow's id or file name.
    pub workflow: String,
    /// A branch or tag; the default branch when absent.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub inputs: serde_json::Map<String, Value>,
}

/// `cancel` and `rerun` (all jobs, or with `failed_only` the ones that did
/// not succeed). Members only. Returns `Outcome<WorkflowRun>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunActionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub failed_only: bool,
}

/// `set_workflow_enabled`. Members only. Returns `Outcome<Workflow>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetWorkflowEnabledArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub workflow: String,
    pub enabled: bool,
}

/// Whose secrets or variables: a repository's, or with only `workspace`,
/// a workspace's.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SettingsOwner {
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub workspace: Option<String>,
}

/// `settings`: the secrets (`kind: secret`) or variables (`kind: variable`)
/// of a repository, with its workspace's, or of a workspace. Members only.
/// Returns `Outcome<Vec<Setting>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: SettingsOwner,
    pub kind: String,
}

/// `set_setting`: add or replace one. A repository's need a member; a
/// workspace's an owner. Returns `Outcome<Setting>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetSettingArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: SettingsOwner,
    pub kind: String,
    pub name: String,
    pub value: String,
}

/// `delete_setting`. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteSettingArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: SettingsOwner,
    pub kind: String,
    pub name: String,
}

/// `job_spec` and `job_report`: the sandbox running a job, with the job's
/// own token. `report` is one of:
/// `{"kind": "step", "number", "status", "conclusion"}`,
/// `{"kind": "log", "step", "text"}`,
/// `{"kind": "annotation", "level", "message", "title", "file", "line"}`,
/// `{"kind": "done", "conclusion", "outputs", "reason"}`.
#[derive(Debug, Serialize, Deserialize)]
pub struct JobCallArgs {
    pub job: String,
    pub token: String,
    #[serde(default)]
    pub report: Value,
}

/// What the runner needs to start a job's sandbox.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobArgs {
    pub job: String,
    pub token: String,
    pub repo: RepoPath,
    /// Minutes before the job is stopped.
    pub timeout_minutes: u32,
}
