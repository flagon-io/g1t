//! The actions service: GitHub Actions workflows, run on g1t as they are.
//!
//! A repository's `.g1t/workflows/*.yml`, in GitHub's format, are read
//! from the commit an
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
    /// `.g1t/workflows/ci.yml`.
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
    /// Why it did not run, what stopped it, or what it waits for.
    pub reason: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// The environment it names, once its needs are done (an expression
    /// read by then). A job held by the environment's protection rules is
    /// `pending` until they let it through.
    #[serde(default)]
    pub environment: Option<String>,
    /// Its `runs-on` names self-hosted runners (see `runners`).
    #[serde(default)]
    pub self_hosted: bool,
    /// The self-hosted runner that took it, by name.
    #[serde(default)]
    pub runner: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: WorkflowRun,
    pub jobs: Vec<Job>,
    /// The workflow's notes, as of the run's commit.
    pub notes: Vec<WorkflowNote>,
    /// For a run of a pull request from outside: whether it waits for, or
    /// had, someone's approval (`status` is `action_required` while it waits).
    #[serde(default)]
    pub approval: Option<RunApproval>,
    /// The environments whose protection rules hold its jobs, this attempt.
    #[serde(default)]
    pub pending_deployments: Vec<PendingDeployment>,
}

/// A run that needed approval before it started.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunApproval {
    /// `required` while it waits, then `approved`.
    pub state: String,
    /// Why it waits, in words.
    pub reason: String,
    /// Who approved it.
    pub approved_by: Option<String>,
}

/// One person or team who may approve a job's deployment to an
/// environment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentReviewer {
    /// `user` or `team`.
    #[serde(rename = "type")]
    pub kind: String,
    /// A username, or a team's slug in the repository's workspace.
    pub name: String,
}

/// A branch or tag pattern an environment lets deploy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchPattern {
    /// fnmatch-style, as branch filters are: `main`, `release/*`, `v*`.
    pub name: String,
    /// `branch` or `tag`.
    #[serde(rename = "type", default = "branch_kind")]
    pub kind: String,
}

fn branch_kind() -> String {
    "branch".to_owned()
}

/// The most reviewers an environment may have, as on GitHub.
pub const MAX_ENVIRONMENT_REVIEWERS: usize = 6;
/// The longest wait timer, in minutes: 30 days.
pub const MAX_WAIT_MINUTES: u32 = 43_200;

/// An environment and its protection rules. Jobs that name it with
/// `environment:` wait until the rules let them through; only then does the
/// job get the environment's secrets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// Lowercase.
    pub name: String,
    /// Who may approve its jobs; none means no review is needed.
    pub reviewers: Vec<EnvironmentReviewer>,
    /// Whoever started a run may not approve its jobs, even as a reviewer.
    pub prevent_self_review: bool,
    /// Minutes each job waits before it may start.
    pub wait_minutes: u32,
    /// Which refs may deploy: `all`, `protected` (branches the rules
    /// protect, the default branch included) or `selected` (`branch_patterns`).
    pub branch_policy: String,
    pub branch_patterns: Vec<BranchPattern>,
    /// Admins may approve without being reviewers, which also skips the wait.
    pub admins_bypass: bool,
    /// Whether it has rules saved; false for one only named by a workflow,
    /// a secret or a deployment.
    pub protected: bool,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
}

/// An environment holding a run's jobs, and where its rules stand.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeployment {
    pub environment: String,
    /// `waiting`, `approved` or `rejected`.
    pub state: String,
    /// Whether a reviewer must approve it before its jobs start.
    pub needs_review: bool,
    /// When its wait timer lets its jobs start, if it has one.
    pub wait_until: Option<String>,
    pub reviewers: Vec<EnvironmentReviewer>,
    /// The jobs it holds, by name.
    pub jobs: Vec<String>,
    /// Whether the viewer may approve or reject it now.
    #[serde(default)]
    pub can_review: bool,
    pub reviewed_by: Option<String>,
    pub comment: Option<String>,
    pub reviewed_at: Option<String>,
}

/// A repository's choices for its workflows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsSettings {
    /// What a workflow without `permissions:` gets: `read` (contents and
    /// packages read) or `write` (every permission). Unchosen, a repository
    /// made before restricted tokens keeps `write`; a newer one takes its
    /// workspace's default. Never more than the workspace's maximum.
    pub default_permissions: String,
    /// Whether the repository chose it, rather than taking it as above.
    #[serde(default)]
    pub default_chosen: bool,
    /// The most the workspace lets a repository's default be.
    #[serde(default = "write")]
    pub max_permissions: String,
    /// Which pull requests' runs wait for approval: `first_time_contributors`,
    /// `outside_contributors` (the default) or `all_external_contributors`.
    pub approval_policy: String,
    /// Whether a job's token may open pull requests and approve them. Off
    /// unless the repository turns it on, and only where the workspace
    /// allows it.
    #[serde(default)]
    pub can_approve_pull_requests: bool,
    /// Whether the workspace lets its repositories turn that on.
    #[serde(default)]
    pub workspace_allows_pull_requests: bool,
}

fn write() -> String {
    "write".to_owned()
}

/// A workspace's policy for its repositories' tokens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActionsSettings {
    /// What a repository made from now on gets by default: `read` (the
    /// default) or `write`.
    pub default_permissions: String,
    /// The most any repository's default may be: `write` (the default) or
    /// `read`, which holds every repository to read-only.
    pub max_permissions: String,
    /// Whether its repositories may let jobs open and approve pull
    /// requests. Off by default.
    pub can_approve_pull_requests: bool,
}

/// `workspace_actions_settings`: members only. Returns
/// `Outcome<WorkspaceActionsSettings>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceActionsSettingsArgs {
    pub viewer: Viewer,
    pub workspace: String,
}

/// `set_workspace_actions_settings`: owners only. Fields left out stay as
/// they are. Returns `Outcome<WorkspaceActionsSettings>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceActionsSettingsArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub default_permissions: Option<String>,
    #[serde(default)]
    pub max_permissions: Option<String>,
    #[serde(default)]
    pub can_approve_pull_requests: Option<bool>,
}

/// The approval policies, least strict first.
pub const APPROVAL_POLICIES: [&str; 3] = ["first_time_contributors", "outside_contributors", "all_external_contributors"];

/// `actions_settings`. Returns `Outcome<ActionsSettings>`; anyone who can
/// read the repository may see them.
#[derive(Debug, Serialize, Deserialize)]
pub struct ActionsSettingsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
}

/// `set_actions_settings`: Admins only. Fields left out stay as they are.
/// Returns `Outcome<ActionsSettings>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActionsSettingsArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// `read` or `write`; `inherit` goes back to the workspace's (or, for a
    /// repository made before restricted tokens, `write`).
    #[serde(default)]
    pub default_permissions: Option<String>,
    #[serde(default)]
    pub approval_policy: Option<String>,
    #[serde(default)]
    pub can_approve_pull_requests: Option<bool>,
}

/// `environments`: every environment a repository's workflows, secrets,
/// deployments or rules name, with its rules. `environment`: one, by
/// `name`. Returns `Outcome<Vec<Environment>>` and `Outcome<Environment>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvironmentsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(default)]
    pub name: Option<String>,
}

/// `set_environment`: create an environment's rules or change them. Fields
/// left out stay as they are (none, for a new one). Admins only. Returns
/// `Outcome<Environment>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEnvironmentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub name: String,
    #[serde(default)]
    pub reviewers: Option<Vec<EnvironmentReviewer>>,
    #[serde(default)]
    pub prevent_self_review: Option<bool>,
    #[serde(default)]
    pub wait_minutes: Option<u32>,
    #[serde(default)]
    pub branch_policy: Option<String>,
    #[serde(default)]
    pub branch_patterns: Option<Vec<BranchPattern>>,
    #[serde(default)]
    pub admins_bypass: Option<bool>,
}

/// `delete_environment`: its rules go; jobs naming it run without them.
/// Its secrets' rows stay. Admins only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteEnvironmentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub name: String,
}

/// `pending_deployments`: the environments holding a run's jobs. Returns
/// `Outcome<Vec<PendingDeployment>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct PendingDeploymentsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub id: String,
}

/// `review_deployments`: approve or reject a run's jobs for `environments`
/// (every one waiting, if empty). Returns `Outcome<Vec<PendingDeployment>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewDeploymentsArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub environments: Vec<String>,
    /// `approved` or `rejected`.
    pub state: String,
    #[serde(default)]
    pub comment: Option<String>,
}

/// `repository_dispatch`: start the default branch's workflows that run
/// `on: repository_dispatch` for `event_type`. Needs the Write role (a
/// token's `code:write`). Returns `Outcome<u32>`: how many started.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDispatchArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub event_type: String,
    #[serde(default)]
    pub client_payload: Value,
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

/// Who may read a secret or variable: workflows (`secrets.*` and `vars.*`
/// in GitHub Actions) and deployments (a deploy build's environment and the
/// running app's bindings). Agents, checks and the merge queue read none.
pub const CONSUMERS: [&str; 2] = ["workflows", "deployments"];

/// One row of a repository's or workspace's secrets and variables, as
/// Vercel lists environment variables: a key, its type, the environments
/// it applies to and who reads it. A key may have one row per environment.
/// Secrets' values are never returned.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// `secret`, or `variable` (shown as Config).
    #[serde(default)]
    pub kind: String,
    /// A variable's value; secrets' are never returned.
    pub value: Option<String>,
    /// `project` (a repository's, which belong to its project) or
    /// `workspace`.
    pub scope: String,
    pub updated_at: String,
    /// `workflows` and/or `deployments`.
    #[serde(default)]
    pub available_to: Vec<String>,
    /// The environments it applies to; empty is every environment.
    #[serde(default)]
    pub environments: Vec<String>,
    /// A workspace's row: the projects it reaches, by slug; empty is every
    /// project.
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub updated_by: Option<String>,
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
    /// `secret` or `variable`. Changing a variable's row to `secret` seals
    /// it; a secret cannot become a variable.
    pub kind: String,
    pub name: String,
    /// The row to change. Left out, the key's row for every environment, as
    /// GitHub's API addresses a secret by name alone.
    #[serde(default)]
    pub id: Option<String>,
    /// Needed for a new row; left out, an existing row keeps its value.
    #[serde(default)]
    pub value: Option<String>,
    /// `workflows` and/or `deployments`; left out, unchanged (both, for a
    /// new row).
    // Named as callers send it: an `alias` is not honoured beside the
    // flattened owner in the Worker's build.
    #[serde(default, rename = "availableTo")]
    pub available_to: Option<Vec<String>>,
    /// The environments it applies to; empty is every one. Left out,
    /// unchanged.
    #[serde(default)]
    pub environments: Option<Vec<String>>,
    /// A workspace's row: project slugs; empty for every one.
    #[serde(default)]
    pub projects: Option<Vec<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

/// `resolve_settings`: the secrets and variables one reader gets, for the
/// services that hand them out (the deployments service). Returns
/// `ResolvedSettings`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSettingsArgs {
    pub repo_id: String,
    pub repo: RepoPath,
    /// The project being read for; its repository's primary project if left
    /// out.
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_slug: Option<String>,
    /// `workflows` or `deployments`.
    pub consumer: String,
    /// The environment being read for, such as `production` or `preview`.
    #[serde(default)]
    pub environment: Option<String>,
    /// Whether the run is trusted; an untrusted one gets no secrets.
    pub trusted: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ResolvedSettings {
    pub secrets: serde_json::Map<String, serde_json::Value>,
    pub variables: serde_json::Map<String, serde_json::Value>,
}

/// `delete_setting`. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteSettingArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: SettingsOwner,
    pub kind: String,
    pub name: String,
    /// One row; left out, every row of the key.
    #[serde(default)]
    pub id: Option<String>,
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
    /// The workflow file the job is in (`.g1t/workflows/deploy.yml`), for
    /// the guardrails' workflow-only domains.
    #[serde(default)]
    pub workflow: Option<String>,
    /// The environment the job names with `environment:`, when it names
    /// one plainly (not with an expression).
    #[serde(default)]
    pub environment: Option<String>,
    /// Whether its run is trusted: not a pull request from a fork. Only a
    /// trusted run's jobs reach workflow-only domains.
    #[serde(default)]
    pub trusted: bool,
    /// The machine its `runs-on` asked for, by label (`instance_for`):
    /// `g1t-2core` or `g1t-4core`; absent, the standard one.
    #[serde(default)]
    pub instance: Option<String>,
}

/// A size of machine g1t runs workflow jobs on, asked for by a label in
/// `runs-on`. Each is a Cloudflare Containers instance type; it costs what
/// that instance costs g1t, plus the margin, like any sandbox time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InstanceType {
    /// The `runs-on` label, or `standard` for the default.
    pub label: &'static str,
    /// The Containers instance type.
    pub container: &'static str,
    pub vcpu: f64,
    pub memory_gib: f64,
    pub disk_gb: f64,
    /// What a second of it costs g1t as a multiple of the standard
    /// machine's, with its vCPUs as busy (Cloudflare's list prices:
    /// memory $0.0000025 a GiB-second, disk $0.00000007 a GB-second, vCPU
    /// $0.00002 a second). Used to reserve before a job starts, and to
    /// price a job that did not report its own CPU.
    pub price_scale: f64,
}

/// The default: what `ubuntu-latest` and every other hosted label get.
pub const STANDARD_INSTANCE: InstanceType =
    InstanceType { label: "standard", container: "standard-1", vcpu: 0.5, memory_gib: 4.0, disk_gb: 8.0, price_scale: 1.0 };

/// Every machine a workflow job can ask for, the default first.
pub const INSTANCE_TYPES: [InstanceType; 3] = [
    STANDARD_INSTANCE,
    InstanceType { label: "g1t-2core", container: "standard-3", vcpu: 2.0, memory_gib: 8.0, disk_gb: 16.0, price_scale: 2.8 },
    InstanceType { label: "g1t-4core", container: "standard-4", vcpu: 4.0, memory_gib: 12.0, disk_gb: 20.0, price_scale: 5.1 },
];

/// The machine a job's `runs-on` labels ask for: the largest named, or the
/// standard one. Labels compare without regard to case.
pub fn instance_for(labels: &[String]) -> InstanceType {
    INSTANCE_TYPES
        .iter()
        .rev()
        .find(|instance| instance.label != STANDARD_INSTANCE.label && labels.iter().any(|label| label.trim().eq_ignore_ascii_case(instance.label)))
        .copied()
        .unwrap_or(STANDARD_INSTANCE)
}

/// An instance type by its label, if it is one.
pub fn instance_named(label: &str) -> Option<InstanceType> {
    INSTANCE_TYPES.iter().find(|instance| instance.label.eq_ignore_ascii_case(label.trim())).copied()
}

// ── The cache (actions/cache) ─────────────────────────────────────────────
//
// Entries are kept in R2 by the API (the ACTIONS_CACHE bucket) and listed
// here, by the actions service, which decides what is found, what fits and
// what is evicted. A sandbox reaches these through the API with its job's
// token: `/actions/jobs/{job}/cache` (see apps/api/src/blobs.rs).

/// The largest one cache entry may be, compressed.
pub const CACHE_MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// What one repository's entries may hold together. Saving past it evicts
/// the entries restored longest ago.
pub const CACHE_REPO_QUOTA_BYTES: u64 = 10 * 1024 * 1024 * 1024;
/// An entry not restored for this long is deleted.
pub const CACHE_UNUSED_DAYS: u64 = 7;
/// An entry is deleted this long after it was saved, however often it is
/// restored (the bucket's own lifecycle rule deletes objects at 30 days).
pub const CACHE_MAX_AGE_DAYS: u64 = 28;
/// An upload is sent in parts of this size (the last may be smaller).
pub const CACHE_PART_BYTES: u64 = 32 * 1024 * 1024;
/// What R2 charges g1t to store a GB for a month, in millionths of a
/// dollar ($0.015): what the cache's storage is charged at, plus the margin.
pub const CACHE_MICROS_PER_GB_MONTH: i64 = 15_000;

/// `cache_lookup`: the entry a job restores: its key exactly, else the
/// newest whose key starts with one of `restore`, in order.
/// Returns `Outcome<Option<CacheHit>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheLookupArgs {
    pub job: String,
    pub token: String,
    pub key: String,
    #[serde(default)]
    pub restore: Vec<String>,
    /// The entry's version, a hash of its paths and compression, as the
    /// toolkit's client and g1t's runner both send it: only an entry of the
    /// same version is found. `None` from runners that send none, whose
    /// entries have none.
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CacheHit {
    pub key: String,
    pub object: String,
    pub size: u64,
    /// When it was saved, RFC 3339.
    #[serde(default)]
    pub created_at: String,
    /// A signed token for downloading it through the toolkit's blob
    /// endpoint, when the lookup came with a version.
    #[serde(default)]
    pub blob: Option<String>,
}

/// `cache_reserve`: a job about to save `size` bytes under `key`. Refused
/// when the key is taken (`conflict`: keys are written once) or the entry
/// is too large. Returns `Outcome<CacheReservation>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheReserveArgs {
    pub job: String,
    pub token: String,
    pub key: String,
    /// Its size, when known before it is sent (the toolkit's newer client
    /// says only when it finishes: 0 then).
    pub size: u64,
    /// As in `CacheLookupArgs`.
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CacheReservation {
    pub id: String,
    /// Where the API puts it in R2.
    pub object: String,
    /// The entry's number, which the toolkit's older protocol names it by.
    #[serde(default)]
    pub number: u64,
    /// Its R2 upload, once one is started.
    #[serde(default)]
    pub upload: Option<String>,
    /// A signed token for sending its parts through the toolkit's blob
    /// endpoint, once its upload is started.
    #[serde(default)]
    pub blob: Option<String>,
}

/// `cache_upload`: an entry a job is still uploading, by its number or by
/// key and version. Returns `Outcome<CacheReservation>`, with `upload` and
/// `blob` set once its upload has been started.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheUploadArgs {
    pub job: String,
    pub token: String,
    #[serde(default)]
    pub number: Option<u64>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

/// `cache_commit`: the upload of `id` is complete, at `size` bytes. Returns
/// `Outcome<CacheCommitted>`: the objects of entries it evicted, which the
/// API deletes from R2.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheCommitArgs {
    pub job: String,
    pub token: String,
    pub id: String,
    pub size: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CacheCommitted {
    pub evicted: Vec<String>,
}

/// `cache_abort`: an upload that will not finish; its reservation goes.
/// Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheAbortArgs {
    pub job: String,
    pub token: String,
    pub id: String,
}

// ── Artifacts (actions/upload-artifact) ───────────────────────────────────
//
// Kept in R2 by the API (the ACTIONS_CACHE bucket, under `a/`) and listed
// here, by the actions service, which decides names, sizes and how long
// each is kept. A sandbox reaches them with its job's token
// (`/actions/jobs/{job}/artifacts…`) or, through the toolkit's protocol,
// with its runtime token (`ACTIONS_RUNTIME_TOKEN`); people through the
// REST API and the run's page.

/// The largest one artifact may be.
pub const ARTIFACT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// What one run's artifacts may hold together.
pub const RUN_ARTIFACTS_MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024;
/// How long artifacts are kept unless a repository says otherwise.
pub const ARTIFACT_RETENTION_DEFAULT_DAYS: u32 = 14;
/// The longest a repository may keep them.
pub const ARTIFACT_RETENTION_MAX_DAYS: u32 = 90;
/// A native upload is sent in parts of this size (the last may be smaller).
pub const ARTIFACT_PART_BYTES: u64 = 32 * 1024 * 1024;

/// An artifact, as the API and the site show it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    pub id: u64,
    pub name: String,
    pub size: u64,
    /// `sha256:<hex>`, when the uploader said.
    pub digest: Option<String>,
    /// `zip`, or `tgz` for one an older runner sent.
    pub format: String,
    pub run_id: String,
    pub job_id: String,
    pub repo_id: String,
    /// Whether it has expired or been deleted (its bytes are gone).
    pub expired: bool,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: String,
    /// The run's branch and commit, for the REST shape.
    #[serde(default)]
    pub head_branch: Option<String>,
    #[serde(default)]
    pub head_sha: Option<String>,
}

/// An artifact with where its bytes are, and a signed token for them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactBlob {
    pub artifact: Artifact,
    pub object: String,
    /// For the toolkit's blob endpoint (`/actions/toolkit/blobs/{blob}`).
    pub blob: String,
}

/// A page of artifacts, in GitHub's shape.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ArtifactList {
    pub total_count: u64,
    pub artifacts: Vec<Artifact>,
}

/// `artifact_reserve`: a job about to upload an artifact. Refused when its
/// run has one of that name and `overwrite` is not set (`conflict`), or it
/// is too large. Returns `Outcome<ArtifactReservation>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ArtifactReserveArgs {
    pub job: String,
    /// The job's token, or its runtime token.
    pub token: String,
    pub name: String,
    /// Its size, when known before it is sent (0 otherwise).
    #[serde(default)]
    pub size: u64,
    /// Days to keep it: 0 for the repository's default; at most the
    /// repository's setting.
    #[serde(default)]
    pub retention_days: u32,
    /// When to expire it, RFC 3339, as the toolkit says it (in place of
    /// `retention_days`).
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    /// `zip` (the default) or `tgz`.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactReservation {
    pub id: u64,
    /// Where the API puts it in R2.
    pub object: String,
    /// The days it will be kept, and until when.
    pub retention_days: u32,
    pub expires_at: String,
}

/// `artifact_commit`: its upload is complete, at `size` bytes. The artifact
/// is named by `id`, or by `name` in the job's run (the toolkit's way).
/// Returns `Outcome<Artifact>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ArtifactCommitArgs {
    pub job: String,
    pub token: String,
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    pub size: u64,
    #[serde(default)]
    pub digest: Option<String>,
}

/// `job_artifacts`: a running job listing the artifacts of its own run, or
/// of another run of its repository (`run_id`), narrowed by `name` or
/// `id`: `Outcome<Vec<Artifact>>`. `job_artifact` gives the one named, with
/// a token to download it: `Outcome<ArtifactBlob>`. `job_delete_artifact`
/// deletes one of its own run's: `Outcome<Artifact>`. `artifact_abort`
/// gives up an upload by `id`: `Outcome<bool>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JobArtifactsArgs {
    pub job: String,
    pub token: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<u64>,
}

/// `artifacts`: a repository's artifacts, newest first, or one run's.
/// Anyone who can see the repository. Returns `Outcome<ArtifactList>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ArtifactsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
}

/// `artifact` (`Outcome<Artifact>`) and `artifact_download`
/// (`Outcome<ArtifactBlob>`, with a token good for a few minutes): one
/// artifact by `id`, or by `name` within `run`. Anyone who can see the
/// repository.
#[derive(Debug, Serialize, Deserialize)]
pub struct ArtifactArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// `delete_artifact`: needs the Write role. Returns `Outcome<Artifact>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteArtifactArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: u64,
}

/// `artifact_retention`: anyone who can see the repository. With `days`,
/// sets it, which needs the Maintain role. Returns
/// `Outcome<ArtifactRetention>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ArtifactRetentionArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub days: Option<u32>,
}

/// GitHub's shape: the days artifacts are kept by default, and the most a
/// repository may choose.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRetention {
    pub days: u32,
    pub maximum_allowed_days: u32,
}

// ── The toolkit's protocols ───────────────────────────────────────────────
//
// Actions built on GitHub's toolkit (`@actions/cache`, `@actions/artifact`,
// `@actions/core`'s `getIDToken`) reach g1t with the job's runtime token,
// `ACTIONS_RUNTIME_TOKEN`: a JSON Web Token whose `scp` names the run and
// job, signed with a key derived from the job's own token, so the actions
// service checks it without keeping another secret. Cache and artifact
// operations above take it in place of the job's token.

/// `runtime_auth`: which job a runtime token is, while it runs:
/// `Outcome<RuntimeJob>`. `oidc_claims` takes the same and returns
/// `Outcome<Value>`: the claims of the job's OIDC token, less `iss`, `aud`,
/// `jti` and the times, or `forbidden` when the job's `permissions` do not
/// give it `id-token: write`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeAuthArgs {
    pub job: String,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RuntimeJob {
    pub job: String,
    pub run: String,
    pub repo_id: String,
    pub namespace: String,
    /// `owner/name`.
    pub repository: String,
}

/// What a signed blob token lets its holder do.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlobGrant {
    /// `cache` or `artifact`.
    pub kind: String,
    /// The entry's id: a cache entry's `cache_…`, an artifact's number.
    pub id: String,
    pub object: String,
    /// The R2 upload it sends parts to; `None` for a download.
    pub upload: Option<String>,
    /// For a download: what to call the file, and its type.
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

/// `blob_sign`: a token for uploading an entry the job reserved, to the R2
/// upload the API started for it. Returns `Outcome<String>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BlobSignArgs {
    pub job: String,
    pub token: String,
    /// `cache` or `artifact`.
    pub kind: String,
    pub id: String,
    pub upload: String,
}

/// `blob_open`: what a signed token grants, while it is good and its entry
/// is there: `Outcome<BlobGrant>`. `blob_part` records a part sent with an
/// upload token (`part`, `etag`, `size`): `Outcome<bool>`. `blob_parts`
/// gives the parts recorded, in order: `Outcome<Vec<BlobPart>>`, and
/// `blob_done` forgets them: `Outcome<bool>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BlobArgs {
    pub blob: String,
    #[serde(default)]
    pub part: u32,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BlobPart {
    pub part: u32,
    pub etag: String,
    pub size: u64,
}

#[cfg(test)]
mod instance_tests {
    use super::*;

    fn labels(given: &[&str]) -> Vec<String> {
        given.iter().map(|l| (*l).to_owned()).collect()
    }

    #[test]
    fn runs_on_picks_the_machine() {
        assert_eq!(instance_for(&labels(&["ubuntu-latest"])).container, "standard-1");
        assert_eq!(instance_for(&labels(&[])).label, "standard");
        assert_eq!(instance_for(&labels(&["g1t-4core"])).container, "standard-4");
        assert_eq!(instance_for(&labels(&["ubuntu-latest", "G1T-2Core"])).container, "standard-3");
        // Both named: the larger.
        assert_eq!(instance_for(&labels(&["g1t-2core", "g1t-4core"])).label, "g1t-4core");
        assert_eq!(instance_named("g1t-4core").map(|i| i.vcpu), Some(4.0));
        assert_eq!(instance_named("standard"), Some(STANDARD_INSTANCE));
        assert_eq!(instance_named("g1t-64core"), None);
    }

    #[test]
    fn start_args_from_older_callers_read() {
        let args: StartJobArgs = serde_json::from_value(serde_json::json!({
            "job": "job_1", "token": "t", "repo": { "namespace": "acme", "name": "web" }, "timeoutMinutes": 30
        }))
        .unwrap();
        assert!(args.workflow.is_none() && args.environment.is_none() && !args.trusted && args.instance.is_none());
    }
}

#[cfg(test)]
mod setting_args_tests {
    use super::*;

    #[test]
    fn who_reads_a_row_is_read_as_the_site_and_api_send_it() {
        let args: SetSettingArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "a" },
            "repo": { "namespace": "acme", "name": "web" },
            "kind": "secret",
            "name": "STRIPE_KEY",
            "availableTo": ["deployments"],
            "environments": ["production"],
        }))
        .unwrap();
        assert_eq!(args.available_to, Some(vec!["deployments".to_owned()]));
    }
}
