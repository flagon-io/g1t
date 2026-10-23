//! Self-hosted runners: a workspace's or a repository's own machines, which
//! run its workflow jobs (and, when it says so, its agents' work) instead
//! of g1t's sandboxes. Time on them costs nothing.
//!
//! The actions service keeps them, beside the jobs they run. A machine runs
//! `g1t-runner` (`crates/runner`), which registers once with a short-lived
//! registration token an admin made, gets a credential of its own, and then
//! only ever calls out: it polls `api.g1t.sh` for work, runs what it is
//! given with the same harness g1t's sandboxes use, and reports back. No
//! port is opened on the machine.
//!
//! - A **registration token** (`g1trt_…`) is made by an owner of the
//!   workspace (or an admin of the repository) and lasts an hour. It can
//!   register any number of runners until then, and nothing else.
//! - A **runner credential** (`g1tr_…`) belongs to one runner. It is stored
//!   only as a hash, rotates every day (the poll that rotates it hands the
//!   new one over), and is revoked when the runner is removed. It can poll
//!   for work, report on what that runner was given, and remove the runner;
//!   nothing else. Any other endpoint refuses it.
//! - A job is given to a runner when every label in its `runs-on` is one
//!   of the runner's labels (ignoring case), and the runner's group lets
//!   the job's repository use it. A job whose `runs-on` names
//!   `self-hosted` (or a `group`) only ever runs on self-hosted runners; it
//!   waits, saying for which labels, until one picks it up, for a day at
//!   most.
//! - A job whose `runs-on` is one of the hosted Linux labels
//!   (`ubuntu-latest`) is offered to the workspace's own runners first,
//!   unless its settings say otherwise (`prefer_own_runners`): a runner of
//!   its OS and architecture that is online, idle and at least as large as
//!   the machine g1t would give it takes it ([`stands_in_for`]). With none
//!   free, it runs on g1t's machine at once; with one free that did not
//!   take it within [`OFFER_TO_OWN_MS`], then ([`falls_back`]).
//!
//! The management methods take an `actor` and an owner (`repo` or
//! `workspace`), as secrets do. The runner's own methods take its id and
//! credential. Mirrors `packages/contracts/src/runners.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::User;
use crate::repos::RepoPath;

/// Every runner has these labels, whatever else it was given.
pub const SELF_HOSTED: &str = "self-hosted";
/// What a registration token starts with.
pub const REGISTRATION_PREFIX: &str = "g1trt_";
/// What a runner's credential starts with.
pub const CREDENTIAL_PREFIX: &str = "g1tr_";
/// How long a registration token lasts, in seconds.
pub const REGISTRATION_TTL_SECONDS: u64 = 60 * 60;
/// How long a job may wait for a self-hosted runner before it fails.
pub const MAX_WAIT_HOURS: u64 = 24;
/// A runner that has not polled for this long is offline.
pub const ONLINE_WITHIN_MS: u64 = 90 * 1000;
/// How long one poll waits for work before answering with none.
pub const MAX_POLL_WAIT_MS: u64 = 20 * 1000;
/// How often a runner's credential is replaced.
pub const ROTATE_AFTER_MS: u64 = 24 * 60 * 60 * 1000;
/// The most labels a runner has, and the longest one.
pub const MAX_LABELS: usize = 30;
pub const MAX_LABEL_LEN: usize = 64;
/// The most runners a workspace has.
pub const MAX_RUNNERS: u32 = 500;
/// The most runners a workspace registers in one minute.
pub const MAX_REGISTRATIONS_PER_MINUTE: u32 = 30;
/// The most registration tokens a workspace makes in one hour.
pub const MAX_TOKENS_PER_HOUR: u32 = 60;

// --- What people see -------------------------------------------------------

/// What a runner is doing now.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerWork {
    /// `workflow` (a workflow job) or `agent` (an agent's run, checks, a
    /// review, the merge queue).
    pub kind: String,
    pub id: String,
    /// The job's name, or what the agent is doing.
    pub name: String,
    /// `owner/name`.
    pub repo: Option<String>,
    /// For a link: the workflow run the job is in, or for `agent` work
    /// the agent run it is (`/<owner>/<name>/agents/runs/<id>`), when
    /// the sandbox that handed it over said which.
    pub run_id: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runner {
    pub id: String,
    pub name: String,
    pub workspace: String,
    /// `owner/name` for a repository's own runner; null for the workspace's.
    pub repo: Option<String>,
    /// Its group's name; null for a repository's runner.
    pub group: Option<String>,
    /// Every label, `self-hosted`, its OS and architecture among them.
    pub labels: Vec<String>,
    /// `linux`, `macos` or `windows`.
    pub os: String,
    /// `x64` or `arm64`.
    pub arch: String,
    /// The `g1t-runner` version it last reported.
    pub version: String,
    /// Runs one job, then removes itself.
    pub ephemeral: bool,
    /// `online`, `busy` or `offline`.
    pub status: String,
    pub work: Option<RunnerWork>,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub created_by: Option<String>,
    /// How it keeps work from its machine, as it last said
    /// ([`ISOLATIONS`]); null for a runner from before runners said.
    #[serde(default)]
    pub isolation: Option<String>,
    /// What a job on it gets, as it last said: CPUs, memory in MiB, and
    /// whether the job can use Docker (`services:`, `container:`). Null
    /// for a runner from before runners said.
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub memory_mib: Option<u64>,
    #[serde(default)]
    pub docker: Option<bool>,
}

/// Which of a workspace's repositories may use its runners.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerGroup {
    pub id: String,
    pub name: String,
    /// The group runners join when none is named: every repository.
    pub default: bool,
    /// Repository names (without the workspace) that may use it; empty is
    /// every repository in the workspace.
    pub repositories: Vec<String>,
    pub runners: u32,
    pub updated_at: String,
}

/// A registration token, shown once.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationToken {
    pub token: String,
    pub expires_at: String,
    pub workspace: String,
    pub repo: Option<String>,
    pub group: Option<String>,
    /// What to pass as `--url`.
    pub url: String,
}

/// Where a workspace's (or a repository's) agents work, and whether pull
/// requests from forks may use its runners.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSettings {
    /// g1t's own work (checks, merge checks and the merge queue) runs on
    /// self-hosted runners with `agent_labels`, instead of g1t's sandboxes.
    /// The names are kept from when that work included agent runs.
    pub agents_on_self_hosted: bool,
    /// The labels a runner needs to take g1t's own work; `self-hosted` is
    /// always one.
    pub agent_labels: Vec<String>,
    /// Jobs of pull requests from forks may run on self-hosted runners.
    /// Off by default: anyone who can open a pull request could run code
    /// on the machine.
    pub fork_pull_requests: bool,
    /// A job asking for one of g1t's hosted Linux labels runs on one of the
    /// workspace's own runners when one that fits it is free, and on g1t's
    /// machines otherwise. On by default. The job gets the run's secrets
    /// on that machine, as on any self-hosted runner.
    pub prefer_own_runners: bool,
    /// For a repository: these are its workspace's, not its own.
    pub inherited: bool,
}

// --- Management ------------------------------------------------------------

/// A workspace's runners (`workspace`), or a repository's own (`repo`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RunnersOwner {
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub workspace: Option<String>,
}

/// `runners`: a workspace's runners (members), or a repository's own
/// (its admins). Returns `Outcome<Vec<Runner>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListRunnersArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: RunnersOwner,
}

/// `create_registration_token`: owners of the workspace, or admins of the
/// repository. Returns `Outcome<RegistrationToken>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateRegistrationTokenArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: RunnersOwner,
    /// The group its runners join, by name or id; the default group if
    /// left out. Not for a repository's runners.
    #[serde(default)]
    pub group: Option<String>,
}

/// `remove_runner`: as `create_registration_token`. A job it is running is
/// cancelled. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveRunnerArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: RunnersOwner,
    pub id: String,
}

/// `runner_groups`: members. Returns `Outcome<Vec<RunnerGroup>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunnerGroupsArgs {
    pub actor: User,
    pub workspace: String,
}

/// `set_runner_group`: create one (no `id`) or change one. Owners.
/// Returns `Outcome<RunnerGroup>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetRunnerGroupArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Repository names; empty for every repository.
    #[serde(default)]
    pub repositories: Option<Vec<String>>,
}

/// `delete_runner_group`: owners. Its runners move to the default group,
/// which cannot be deleted. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteRunnerGroupArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
}

// --- The desktop app's runners ----------------------------------------------

/// The desktop app keeps a runner on a person's computer while it is open
/// (apps/desktop/src-tauri/src/runner). What it says of that runner, as it
/// says it in its tray and settings (its diagnosis.rs, the one catalogue
/// of those words), is kept here per computer, so the workspace's Runners
/// page lists every desktop with the same state, why, and the fix. A
/// desktop not heard from for `DESKTOP_OPEN_WITHIN_MS` has g1t closed, and
/// shows `closed`, which the app sent too.
pub const DESKTOP_OPEN_WITHIN_MS: u64 = 10 * 60 * 1000;
/// The most desktops a workspace keeps reports for.
pub const MAX_DESKTOPS: u32 = 200;

/// A diagnosis, as the app made it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DesktopDiagnosis {
    /// `idle`, `busy`, `no_docker`, `no_wsl`, `sandbox_failed`, `not_allowed`, …
    pub code: String,
    /// `ok`, `working`, `off`, `warning` or `problem`.
    pub tone: String,
    pub title: String,
    #[serde(default)]
    pub cause: Option<String>,
    #[serde(default)]
    pub fix: Option<String>,
    /// A sandboxed desktop's kinds of job, each with how it is: Linux jobs
    /// can run while Windows jobs cannot. Empty for the other backends.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<DesktopCapability>,
    /// The kinds of job say all of this, each for itself: a page showing
    /// them shows no line of the whole runner's as well.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_capabilities: bool,
    /// How its runner's updates stand. From newer apps; older ones leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<DesktopUpdate>,
}

/// How a desktop's runner updates stand, as its app says it. The app
/// looks every hour, and installs a newer runner kind of job by kind of
/// job, as each is idle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DesktopUpdate {
    /// When the app last heard from the runner's releases, RFC 3339.
    #[serde(default)]
    pub checked_at: Option<String>,
    /// A newer version, downloaded and checked, waiting to be installed.
    #[serde(default)]
    pub ready: Option<String>,
    /// What becomes of it, for a desktop with no kinds of job of its own:
    /// `0.3.2 ready, installs after this job`.
    #[serde(default)]
    pub note: Option<String>,
}

/// One kind of job a sandboxed desktop runs, as its app says it. Each
/// starts and stops on its own: `enabled` is false for one the person
/// stopped, which is not failing. The fields after `fix` come from newer
/// apps; older ones leave them out.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DesktopCapability {
    /// `linux`, `windows` or `macos`.
    pub id: String,
    /// `Linux jobs`.
    pub label: String,
    pub tone: String,
    /// `Waiting for jobs`, `Not available`.
    pub title: String,
    #[serde(default)]
    pub cause: Option<String>,
    #[serde(default)]
    pub fix: Option<String>,
    /// `busy`, `idle`, `starting`, `downloading`, `updating`, `waiting`,
    /// `stopped`, `unavailable` or `problem`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// What is wrong, in a few words: `WSL isn't installed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    /// What it is, in a line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// On in the person's settings; false when they stopped it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<DesktopJob>,
    /// Its runner's name on g1t: `build-box-linux`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    /// `nested-container` or `vm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// A newer version waiting for it: `0.3.2 ready, installs after this job`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
}

/// What a desktop's kind of job is running.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DesktopJob {
    /// `workflow` or `agent`.
    pub kind: String,
    pub name: String,
    /// `acme/web`.
    pub repo: String,
}

/// The most kinds of job a desktop reports.
pub const MAX_DESKTOP_CAPABILITIES: usize = 4;

/// One person's computer, as its desktop app last said.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRunner {
    pub workspace: String,
    /// The computer's name, which its runner has too.
    pub machine: String,
    /// Whose computer: their username.
    pub person: String,
    /// `sandboxed`, `docker` or `host`.
    pub backend: String,
    pub version: Option<String>,
    pub diagnosis: DesktopDiagnosis,
    /// What to show while g1t is closed on it.
    pub closed: DesktopDiagnosis,
    /// Heard from within `DESKTOP_OPEN_WITHIN_MS`: g1t is open there.
    pub open: bool,
    pub reported_at: String,
}

/// `report_desktop`: the person's own desktop app, through the site, for a
/// workspace they own. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReportDesktopArgs {
    pub actor: User,
    pub workspace: String,
    pub machine: String,
    pub backend: String,
    #[serde(default)]
    pub version: Option<String>,
    pub diagnosis: DesktopDiagnosis,
    pub closed: DesktopDiagnosis,
}

/// `desktop_runners`: owners of the workspace. Returns `Outcome<Vec<DesktopRunner>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DesktopRunnersArgs {
    pub actor: User,
    pub workspace: String,
}

/// `runner_settings`: members of the workspace, or admins of the
/// repository. Returns `Outcome<RunnerSettings>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunnerSettingsArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: RunnersOwner,
}

/// `set_runner_settings`: owners, or admins of the repository. Left out is
/// unchanged; `inherit` drops a repository's own settings. Returns
/// `Outcome<RunnerSettings>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetRunnerSettingsArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: RunnersOwner,
    #[serde(default)]
    pub agents_on_self_hosted: Option<bool>,
    #[serde(default)]
    pub agent_labels: Option<Vec<String>>,
    #[serde(default)]
    pub fork_pull_requests: Option<bool>,
    #[serde(default)]
    pub prefer_own_runners: Option<bool>,
    #[serde(default)]
    pub inherit: bool,
}

/// `stuck_jobs`: Mission control's Needs you. Returns `Vec<StuckJob>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StuckJobsArgs {
    pub viewer: crate::Viewer,
}

/// `runner_activity`: what runs for a workspace now, on g1t's cloud and
/// handed to its own runners, for the Runners page. Owners, as the
/// workspace's runners are. Snake case both ways. Returns
/// `Outcome<RunnerActivity>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunnerActivityArgs {
    pub actor: User,
    pub workspace: String,
}

/// A workflow job running in one of g1t's sandboxes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CloudJob {
    pub id: String,
    pub name: String,
    /// The workflow run it is in.
    pub run_id: String,
    /// `owner/name`.
    pub repo: String,
    pub started_at: Option<String>,
}

/// Agent work handed to one of the workspace's own runners, waiting for
/// one or taken.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HandedOverTask {
    pub id: String,
    /// The agent run it is, when the sandbox said; older tasks have none.
    pub run_id: Option<String>,
    /// `agent`, `checks`, `review`, `queue`…
    pub kind: String,
    pub title: String,
    /// `owner/name`.
    pub repo: String,
    /// `queued` or `in_progress`.
    pub status: String,
    pub runner_name: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RunnerActivity {
    /// Workflow jobs in g1t's sandboxes now, newest first, at most
    /// `ACTIVITY_LIMIT`.
    pub cloud_jobs: Vec<CloudJob>,
    /// Workflow jobs queued for g1t's sandboxes.
    pub cloud_jobs_queued: u32,
    /// g1t's own work (checks, merge checks, the merge queue) on, or waiting
    /// for, the workspace's own runners.
    pub handed_over: Vec<HandedOverTask>,
    /// Workflow jobs waiting for one of the workspace's own runners.
    pub self_hosted_jobs_queued: u32,
}

/// The most jobs and tasks `runner_activity` lists of each.
pub const ACTIVITY_LIMIT: u32 = 100;

/// A job that has waited ten minutes or more for a self-hosted runner,
/// with none that matches online.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckJob {
    pub id: String,
    pub name: String,
    pub run_id: String,
    /// `owner/name`.
    pub repo: String,
    /// What it asks for, for people: `self-hosted, linux, gpu`.
    pub labels: String,
    pub queued_at: String,
}

// --- The runner's side (snake_case on the wire, as the API passes it) ------

/// `runner_register`: a machine registering with a registration token.
/// Returns `Outcome<Registered>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RegisterArgs {
    pub token: String,
    pub name: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub ephemeral: bool,
    /// A group by name, for a workspace's token; the token's group, else
    /// the default, if left out.
    #[serde(default)]
    pub group: Option<String>,
    /// Replace a runner of the same name instead of refusing.
    #[serde(default)]
    pub replace: bool,
    /// How the runner keeps work from its machine: `nested-container` (a
    /// container per job, inside the runner's own sandboxed container),
    /// `vm` (a throwaway VM per job, native to the machine's OS),
    /// `container` (a container per job, on a Docker Engine it shares with
    /// its machine) or `host` (directly on the machine). A `host` runner is
    /// given no public repository's work ([`isolation_allows`]); older
    /// runners leave it out.
    #[serde(default)]
    pub isolation: Option<String>,
    /// Which computer it is: a fingerprint the runner derives from its
    /// operating system's machine id, never the id itself. A runner of the
    /// same name registered from the same computer is taken over without
    /// `replace`, so a computer whose sandbox was made again registers
    /// again by itself. Older runners, and those in a container that can't
    /// tell, leave it out.
    #[serde(default)]
    pub machine: Option<String>,
    /// What a job on it gets (`Runner::cpus`). A runner that does not say
    /// takes no job asking for a hosted label ([`stands_in_for`]); older
    /// runners leave them out.
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub memory_mib: Option<u64>,
    #[serde(default)]
    pub docker: Option<bool>,
}

/// The isolation levels a runner may say it has (`RegisterArgs::isolation`).
pub const ISOLATIONS: &[&str] = &["nested-container", "vm", "container", "host"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Registered {
    pub runner: Runner,
    /// Shown once; the runner keeps it in its configuration.
    pub credential: String,
}

/// Every call a registered runner makes carries its id and credential.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RunnerAuth {
    pub runner: String,
    pub credential: String,
}

/// `runner_poll`: waits up to `wait_ms` for work. Doubles as the runner's
/// heartbeat. Returns `Outcome<Poll>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PollArgs {
    #[serde(flatten)]
    pub auth: RunnerAuth,
    #[serde(default)]
    pub version: String,
    /// What it is running now; it is given nothing more while busy.
    #[serde(default)]
    pub running: Vec<String>,
    #[serde(default)]
    pub wait_ms: u64,
    /// How the runner keeps work from its machine now, as at registration
    /// (`RegisterArgs::isolation`); kept up to date from each poll. Older
    /// runners leave it out.
    #[serde(default)]
    pub isolation: Option<String>,
    /// What a job on it gets now, as at registration; kept up to date from
    /// each poll. Older runners leave them out.
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub memory_mib: Option<u64>,
    #[serde(default)]
    pub docker: Option<bool>,
}

/// Work for a runner.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Assignment {
    /// `workflow` or `agent`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub repo: String,
    pub timeout_minutes: u32,
    /// The image to run it in: the job's `container:`, when it names one.
    pub image: Option<String>,
    /// A workflow job's own token, for `ACTIONS_JOB`/`ACTIONS_TOKEN`.
    pub token: Option<String>,
    /// An agent task's environment, as g1t's sandbox would have been
    /// started with: `MODE`, the run's short-lived credentials, the model
    /// proxy's address.
    pub env: Option<Map<String, Value>>,
    /// The repository's visibility, `public` or `private`, when g1t knows
    /// it: a runner that runs work directly on its machine refuses a
    /// public repository's. Older g1t leaves it out.
    #[serde(default)]
    pub visibility: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Poll {
    pub assignment: Option<Assignment>,
    /// Work it holds that it should stop: cancelled, timed out, removed.
    #[serde(default)]
    pub cancel: Vec<String>,
    /// A new credential: it replaces the old, which stops working once this
    /// one is used.
    pub credential: Option<String>,
    /// The runner was removed: stop and forget the credential.
    #[serde(default)]
    pub removed: bool,
}

/// `runner_finished`: a runner telling what became of work it was given.
/// For a workflow job the harness has normally reported already; this
/// covers one that crashed or was killed. Returns `Outcome<bool>` (whether
/// it changed anything).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FinishedArgs {
    #[serde(flatten)]
    pub auth: RunnerAuth,
    pub id: String,
    pub exit_code: i32,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `runner_remove_self`: `g1t-runner remove`. Returns `Outcome<bool>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RemoveSelfArgs {
    #[serde(flatten)]
    pub auth: RunnerAuth,
}

// --- Between services (camelCase, as every service speaks) ----------------

/// `runner_route`: whether a kind of g1t's own work in a repository runs on
/// self-hosted runners, and on which labels. Asked by the runner service
/// before it starts a sandbox. Returns `Option<Vec<String>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteArgs {
    pub workspace: String,
    pub repo: RepoPath,
}

/// `enqueue_task`: agent work for a self-hosted runner, from the runner
/// service's sandbox (`sandbox` is its Durable Object's id), which is told
/// with `task_ended` how it went. Returns `Outcome<String>` (the task's id).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueTaskArgs {
    pub sandbox: String,
    pub workspace: String,
    pub repo: RepoPath,
    /// The run kind: `agent`, `checks`, `review`, `queue`…
    pub kind: String,
    pub title: String,
    pub labels: Vec<String>,
    pub env: Map<String, Value>,
    pub timeout_minutes: u32,
    /// The agent run the work belongs to, when the sandbox opened one: what
    /// people's pages link a runner's agent work to.
    #[serde(default, alias = "run_id")]
    pub run_id: Option<String>,
}

/// `cancel_task`: the sandbox's work stopped from g1t's side (a person, a
/// time cap). Returns `Outcome<bool>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTaskArgs {
    pub sandbox: String,
    #[serde(default)]
    pub reason: Option<String>,
}

// --- Labels ----------------------------------------------------------------

/// A label as it is kept: trimmed and lowercase. `None` when it is not
/// one: empty, too long, or with characters other than letters, digits,
/// `-`, `_`, `.`, `:` and `/`.
pub fn clean_label(label: &str) -> Option<String> {
    let label = label.trim().to_ascii_lowercase();
    let ok = !label.is_empty()
        && label.len() <= MAX_LABEL_LEN
        && label.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/'));
    ok.then_some(label)
}

/// A runner's labels: what it was given, cleaned, with `self-hosted`, its
/// OS and its architecture, each once, in that order first.
pub fn runner_labels(given: &[String], os: &str, arch: &str) -> Result<Vec<String>, String> {
    let mut labels: Vec<String> = Vec::new();
    for label in [SELF_HOSTED, os, arch].iter().map(|s| s.to_string()).chain(given.iter().cloned()) {
        let Some(clean) = clean_label(&label) else {
            return Err(format!("`{label}` is not a label: use letters, digits, `-`, `_`, `.`, `:` and `/`, up to {MAX_LABEL_LEN} characters."));
        };
        if !labels.contains(&clean) {
            labels.push(clean);
        }
    }
    if labels.len() > MAX_LABELS {
        return Err(format!("A runner has at most {MAX_LABELS} labels."));
    }
    Ok(labels)
}

/// The OS a runner reports, as its label: `linux`, `macos` or `windows`.
pub fn os_label(os: &str) -> Option<&'static str> {
    match os.trim().to_ascii_lowercase().as_str() {
        "linux" => Some("linux"),
        "macos" | "darwin" | "osx" | "mac" => Some("macos"),
        "windows" | "win" => Some("windows"),
        _ => None,
    }
}

/// The architecture a runner reports, as its label: `x64` or `arm64`.
pub fn arch_label(arch: &str) -> Option<&'static str> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x64" | "x86_64" | "amd64" => Some("x64"),
        "arm64" | "aarch64" => Some("arm64"),
        _ => None,
    }
}

/// What a job's `runs-on` asks for, read for self-hosted runners: its
/// labels, cleaned, and the group it names. `self_hosted` when it names
/// `self-hosted` or a group, which only self-hosted runners can satisfy.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Wanted {
    pub labels: Vec<String>,
    pub group: Option<String>,
    pub self_hosted: bool,
}

impl Wanted {
    pub fn of(labels: &[String], group: Option<&str>) -> Wanted {
        let mut out: Vec<String> = Vec::new();
        for label in labels {
            let clean = label.trim().to_ascii_lowercase();
            if !clean.is_empty() && !out.contains(&clean) {
                out.push(clean);
            }
        }
        let group = group.map(|g| g.trim().to_owned()).filter(|g| !g.is_empty());
        let self_hosted = group.is_some() || out.iter().any(|l| l == SELF_HOSTED);
        Wanted { labels: out, group, self_hosted }
    }

    /// The job's labels as stored on it: its labels, then `group:<name>`.
    pub fn stored(&self) -> Vec<String> {
        let mut out = self.labels.clone();
        if let Some(group) = &self.group {
            out.push(format!("group:{}", group.to_ascii_lowercase()));
        }
        out
    }

    /// Back from what [`Wanted::stored`] kept.
    pub fn from_stored(stored: &[String]) -> Wanted {
        let group = stored.iter().find_map(|l| l.strip_prefix("group:").map(str::to_owned));
        let labels: Vec<String> = stored.iter().filter(|l| !l.starts_with("group:")).cloned().collect();
        Wanted::of(&labels, group.as_deref())
    }

    /// Whether a runner with `labels`, in the group called `group`, can
    /// take it: every label it asks for, and its group if it names one.
    pub fn matches(&self, labels: &[String], group: Option<&str>) -> bool {
        let has = |wanted: &String| labels.iter().any(|l| l.eq_ignore_ascii_case(wanted));
        let group_ok = match (&self.group, group) {
            (None, _) => true,
            (Some(wanted), Some(group)) => wanted.eq_ignore_ascii_case(group),
            (Some(_), None) => false,
        };
        group_ok && self.labels.iter().all(has)
    }

    /// For people: `self-hosted, linux, gpu` (in group `build`).
    pub fn describe(&self) -> String {
        let labels = self.labels.join(", ");
        match &self.group {
            Some(group) if labels.is_empty() => format!("in group {group}"),
            Some(group) => format!("{labels} in group {group}"),
            None => labels,
        }
    }
}

/// What a public repository's job says while the only runners that could
/// take it run jobs directly on their machines (`host` isolation), which
/// are never given a public repository's work.
pub const WAITING_FOR_SANDBOX: &str =
    "Waiting for a sandboxed runner: this repository is public, and host-mode runners don't run public repositories' jobs.";

/// Whether a runner of `isolation` may be given a repository's work, by
/// its visibility (`public` or `private`; unknown lets it through, and the
/// runner decides). A host-mode runner takes no public repository's work.
pub fn isolation_allows(isolation: Option<&str>, visibility: Option<&str>) -> bool {
    !(isolation == Some("host") && visibility == Some("public"))
}

/// What a job waiting for a runner says.
pub fn waiting_reason(wanted: &Wanted) -> String {
    format!("Waiting for a self-hosted runner with labels {}.", wanted.describe())
}

// --- Hosted labels on the workspace's own runners ----------------------------

/// How long a job asking for a hosted label is offered to the workspace's
/// own runners before it runs on g1t's machines. A free runner is in a
/// poll already and looks every few seconds, so it takes the job well
/// within this.
pub const OFFER_TO_OWN_MS: u64 = 15 * 1000;

/// What a job offered to the workspace's own runners says while it waits.
pub const OFFERED_TO_OWN: &str =
    "Offered to the workspace's own runners first: it runs on g1t's machines if none that fits takes it within 15 seconds.";

/// The runner labels a job's hosted `runs-on` stands for, when the job may
/// run on the workspace's own runners instead: every label one of g1t's
/// Linux labels (`ubuntu-latest`, `ubuntu-24.04-arm`, or an older or newer
/// `ubuntu-*`), all of one architecture. `linux` and `x64`, or `arm64` for
/// an `-arm` label. None for any other `runs-on`: Windows and macOS labels,
/// which only a self-hosted runner runs, and labels of the person's own.
pub fn hosted_wanted(labels: &[String]) -> Option<Wanted> {
    let mut arch: Option<&'static str> = None;
    for label in labels {
        let label = label.trim().to_ascii_lowercase();
        let this = match crate::actions::github_label(&label) {
            Some(github) if github.os == "linux" => github.arch,
            Some(_) => return None,
            None if label.starts_with("ubuntu-") => {
                if label.ends_with("-arm") {
                    "arm64"
                } else {
                    "x64"
                }
            }
            None => return None,
        };
        if arch.is_some_and(|known| known != this) {
            return None;
        }
        arch = Some(this);
    }
    arch.map(|arch| Wanted::of(&["linux".to_owned(), arch.to_owned()], None))
}

/// Whether a job asking for a hosted label is offered to the workspace's
/// own runners: its settings prefer them, and the run is trusted, or is
/// a pull request from a fork where those may use self-hosted runners.
pub fn offered_to_own(prefer_own_runners: bool, trusted: bool, fork_pull_requests: bool) -> bool {
    prefer_own_runners && (trusted || fork_pull_requests)
}

/// What a runner says a job on it gets.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Capacity {
    pub cpus: Option<u32>,
    pub memory_mib: Option<u64>,
    pub docker: Option<bool>,
}

/// Whether a runner may take, in place of `machine` (the machine g1t would
/// give it), a job asking for a hosted label: at least the machine's CPUs
/// and memory, Docker when the job has `services:` or `container:`, and,
/// for a runner that runs jobs directly on its machine, only a repository
/// known to be private. A runner that does not say what it has takes none:
/// the job runs on g1t's machine instead, where it fits.
pub fn stands_in_for(
    capacity: Capacity,
    isolation: Option<&str>,
    visibility: Option<&str>,
    machine: &crate::actions::InstanceType,
    needs_docker: bool,
) -> bool {
    let (Some(cpus), Some(memory_mib)) = (capacity.cpus, capacity.memory_mib) else {
        return false;
    };
    let isolated = isolation != Some("host") || visibility == Some("private");
    f64::from(cpus) >= machine.vcpu
        && memory_mib as f64 >= machine.memory_gib * 1024.0
        && (!needs_docker || capacity.docker == Some(true))
        && isolated
}

/// Why a job offered to the workspace's own runners runs on g1t's machines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    /// No runner of the workspace that fits it is online and idle, or its
    /// runners already have all the jobs its plan lets them run at once.
    NoneFree,
    /// One was, and it did not take the job within [`OFFER_TO_OWN_MS`].
    NotTaken,
}

/// Whether a job offered to the workspace's own runners since `queued_at`
/// (RFC 3339) runs on g1t's machines at `now`, and why: at once when no
/// runner that fits it is free, else once it has waited
/// [`OFFER_TO_OWN_MS`]. One whose time cannot be read has waited enough.
pub fn falls_back(runner_free: bool, queued_at: Option<&str>, now: u64) -> Option<Fallback> {
    if !runner_free {
        return Some(Fallback::NoneFree);
    }
    let waited = queued_at.and_then(crate::time::parse_rfc3339).is_none_or(|at| now.saturating_sub(at) >= OFFER_TO_OWN_MS);
    waited.then_some(Fallback::NotTaken)
}

/// What a job that asked for a hosted label says in "Set up job" when the
/// workspace's runner `runner` took it.
pub fn on_own_runner_note(runner: &str) -> String {
    format!(
        "This job asked for one of g1t's machines and runs on the workspace's own runner {runner} instead: the workspace prefers its own runners when one that fits is free (Settings, Runners). Its time there is free."
    )
}

/// What a job that asked for a hosted label says in "Set up job" when it
/// runs on g1t's machines after all.
pub fn fallback_note(why: Fallback) -> &'static str {
    match why {
        Fallback::NoneFree => {
            "This job runs on g1t's machines: the workspace prefers its own runners, and none that fits this job (its OS and architecture, at least this machine's CPUs and memory, and Docker if it uses services or a container) was free."
        }
        Fallback::NotTaken => "This job runs on g1t's machines: the workspace prefers its own runners, and none of them took it within 15 seconds.",
    }
}

// --- Staff only (sudo.g1t.sh) ---

/// `admin_runners`: a workspace's self-hosted runners, its own and its
/// repositories', for staff. Returns `Vec<AdminRunner>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRunnersArgs {
    pub workspace: String,
}

/// A self-hosted runner as staff see it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminRunner {
    pub id: String,
    pub name: String,
    /// `workspace/repo` for a repository's own runner.
    pub repo: Option<String>,
    pub os: String,
    pub version: String,
    /// Running something now.
    pub busy: bool,
    /// RFC 3339.
    pub last_seen_at: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    pub created_by: Option<String>,
}

/// `admin_remove_runners`: staff remove one of a workspace's runners
/// (`id`), or every one (`id` null), and end the registration tokens it
/// has out. What they were running fails; their credentials stop at once.
/// Returns `Outcome<u32>`, how many were removed.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRemoveRunnersArgs {
    pub workspace: String,
    #[serde(default)]
    pub id: Option<String>,
    pub staff: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_host_mode_runner_takes_no_public_repositorys_work() {
        assert!(!isolation_allows(Some("host"), Some("public")));
        assert!(isolation_allows(Some("host"), Some("private")));
        assert!(isolation_allows(Some("host"), None));
        assert!(isolation_allows(Some("container"), Some("public")));
        assert!(isolation_allows(None, Some("public")), "an older runner decides itself");
        let poll: PollArgs = serde_json::from_value(serde_json::json!({ "runner": "rnr_1", "credential": "c" })).unwrap();
        assert_eq!(poll.isolation, None, "an older runner's poll");
    }

    #[test]
    fn a_runner_always_has_self_hosted_its_os_and_its_arch() {
        let labels = runner_labels(&strings(&["GPU", "gpu", " cuda-12 "]), "linux", "x64").unwrap();
        assert_eq!(labels, strings(&["self-hosted", "linux", "x64", "gpu", "cuda-12"]));
        assert!(runner_labels(&strings(&["has space"]), "linux", "x64").is_err());
        assert!(runner_labels(&strings(&[""]), "linux", "x64").is_err());
    }

    #[test]
    fn os_and_arch_are_read_as_people_write_them() {
        assert_eq!(os_label("Darwin"), Some("macos"));
        assert_eq!(os_label("Windows"), Some("windows"));
        assert_eq!(os_label("plan9"), None);
        assert_eq!(arch_label("x86_64"), Some("x64"));
        assert_eq!(arch_label("aarch64"), Some("arm64"));
        assert_eq!(arch_label("mips"), None);
    }

    #[test]
    fn a_job_names_self_hosted_or_a_group_to_need_one() {
        assert!(Wanted::of(&strings(&["Self-Hosted", "linux"]), None).self_hosted);
        assert!(Wanted::of(&strings(&[]), Some("build")).self_hosted);
        assert!(!Wanted::of(&strings(&["ubuntu-latest"]), None).self_hosted);
    }

    #[test]
    fn every_label_the_job_names_must_be_the_runners() {
        let runner = strings(&["self-hosted", "linux", "x64", "gpu"]);
        assert!(Wanted::of(&strings(&["self-hosted"]), None).matches(&runner, Some("default")));
        assert!(Wanted::of(&strings(&["self-hosted", "LINUX", "gpu"]), None).matches(&runner, None));
        assert!(!Wanted::of(&strings(&["self-hosted", "linux", "arm64"]), None).matches(&runner, None));
        assert!(!Wanted::of(&strings(&["self-hosted", "windows"]), None).matches(&runner, None));
    }

    #[test]
    fn a_group_is_matched_by_name() {
        let runner = strings(&["self-hosted", "linux", "x64"]);
        let wanted = Wanted::of(&strings(&["linux"]), Some("Build"));
        assert!(wanted.matches(&runner, Some("build")));
        assert!(!wanted.matches(&runner, Some("default")));
        assert!(!wanted.matches(&runner, None));
        assert_eq!(Wanted::from_stored(&wanted.stored()), wanted.clone().tap_lower());
    }

    impl Wanted {
        fn tap_lower(mut self) -> Wanted {
            self.group = self.group.map(|g| g.to_ascii_lowercase());
            self
        }
    }

    #[test]
    fn a_hosted_linux_label_stands_for_linux_and_its_architecture() {
        let linux = |arch: &str| Some(Wanted::of(&strings(&["linux", arch]), None));
        assert_eq!(hosted_wanted(&strings(&["ubuntu-latest"])), linux("x64"));
        assert_eq!(hosted_wanted(&strings(&[" Ubuntu-24.04 "])), linux("x64"));
        assert_eq!(hosted_wanted(&strings(&["ubuntu-slim"])), linux("x64"));
        assert_eq!(hosted_wanted(&strings(&["ubuntu-24.04-arm"])), linux("arm64"));
        // Older and newer images than the table has.
        assert_eq!(hosted_wanted(&strings(&["ubuntu-20.04"])), linux("x64"));
        assert_eq!(hosted_wanted(&strings(&["ubuntu-28.04-arm"])), linux("arm64"));
        assert_eq!(hosted_wanted(&strings(&["ubuntu-latest", "ubuntu-24.04"])), linux("x64"));
        // Windows and macOS stay as they are, and so do labels of one's own.
        assert_eq!(hosted_wanted(&strings(&["windows-latest"])), None);
        assert_eq!(hosted_wanted(&strings(&["macos-15"])), None);
        assert_eq!(hosted_wanted(&strings(&["ubuntu-latest", "gpu"])), None);
        assert_eq!(hosted_wanted(&strings(&["ubuntu-latest", "ubuntu-24.04-arm"])), None, "two architectures");
        assert_eq!(hosted_wanted(&strings(&[])), None);
        let runner = strings(&["self-hosted", "linux", "x64", "desktop"]);
        assert!(hosted_wanted(&strings(&["ubuntu-latest"])).unwrap().matches(&runner, Some("default")));
        assert!(!hosted_wanted(&strings(&["ubuntu-24.04-arm"])).unwrap().matches(&runner, None));
        assert!(!hosted_wanted(&strings(&["ubuntu-latest"])).unwrap().self_hosted);
    }

    #[test]
    fn a_fork_pull_request_is_offered_only_where_forks_may_use_runners() {
        assert!(offered_to_own(true, true, false));
        assert!(!offered_to_own(true, false, false));
        assert!(offered_to_own(true, false, true));
        assert!(!offered_to_own(false, true, true));
    }

    #[test]
    fn a_runner_stands_in_only_for_a_machine_it_is_as_large_as() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let large = crate::actions::instance_named("g1t-4core").unwrap();
        let laptop = Capacity { cpus: Some(8), memory_mib: Some(16 * 1024), docker: Some(true) };
        assert!(stands_in_for(laptop, Some("nested-container"), Some("public"), &standard, false));
        assert!(stands_in_for(laptop, Some("nested-container"), Some("public"), &large, true));
        // Exactly the machine's size is enough; a CPU or a MiB less is not.
        let exact = Capacity { cpus: Some(2), memory_mib: Some(8 * 1024), docker: None };
        assert!(stands_in_for(exact, Some("container"), None, &standard, false));
        assert!(!stands_in_for(Capacity { cpus: Some(1), ..exact }, Some("container"), None, &standard, false));
        assert!(!stands_in_for(Capacity { memory_mib: Some(8 * 1024 - 1), ..exact }, Some("container"), None, &standard, false));
        assert!(!stands_in_for(exact, Some("container"), None, &large, false));
        // A runner that does not say what it has takes none.
        assert!(!stands_in_for(Capacity { cpus: None, ..laptop }, None, None, &standard, false));
        assert!(!stands_in_for(Capacity { memory_mib: None, ..laptop }, None, None, &standard, false));
        assert!(!stands_in_for(Capacity::default(), None, None, &standard, false));
    }

    #[test]
    fn services_and_containers_need_a_runner_with_docker() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let without = Capacity { cpus: Some(4), memory_mib: Some(16 * 1024), docker: Some(false) };
        assert!(stands_in_for(without, None, None, &standard, false));
        assert!(!stands_in_for(without, None, None, &standard, true));
        assert!(!stands_in_for(Capacity { docker: None, ..without }, None, None, &standard, true));
        assert!(stands_in_for(Capacity { docker: Some(true), ..without }, None, None, &standard, true));
    }

    #[test]
    fn a_host_mode_runner_stands_in_only_for_a_private_repository() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let big = Capacity { cpus: Some(16), memory_mib: Some(64 * 1024), docker: Some(true) };
        assert!(stands_in_for(big, Some("host"), Some("private"), &standard, false));
        assert!(!stands_in_for(big, Some("host"), Some("public"), &standard, false));
        // Unknown: g1t's machine runs it, rather than the runner deciding.
        assert!(!stands_in_for(big, Some("host"), None, &standard, false));
        assert!(stands_in_for(big, Some("vm"), None, &standard, false));
    }

    #[test]
    fn a_job_falls_back_at_once_with_no_runner_free_and_after_fifteen_seconds_untaken() {
        let queued = crate::time::rfc3339(1_000_000);
        let at = |ms: u64| 1_000_000 + ms;
        assert_eq!(falls_back(false, Some(&queued), at(0)), Some(Fallback::NoneFree));
        assert_eq!(falls_back(true, Some(&queued), at(0)), None);
        assert_eq!(falls_back(true, Some(&queued), at(OFFER_TO_OWN_MS - 1)), None);
        assert_eq!(falls_back(true, Some(&queued), at(OFFER_TO_OWN_MS)), Some(Fallback::NotTaken));
        assert_eq!(falls_back(true, None, at(0)), Some(Fallback::NotTaken));
        assert_eq!(falls_back(true, Some("not a time"), at(0)), Some(Fallback::NotTaken));
        // What the log says names the runner, or why none ran it.
        assert!(on_own_runner_note("box-linux").contains("own runner box-linux"));
        assert!(fallback_note(Fallback::NoneFree).contains("none that fits"));
        assert!(fallback_note(Fallback::NotTaken).contains("15 seconds"));
        assert!(OFFERED_TO_OWN.contains("15 seconds") && OFFER_TO_OWN_MS == 15_000);
    }

    #[test]
    fn waiting_says_for_what() {
        let wanted = Wanted::of(&strings(&["self-hosted", "linux", "gpu"]), None);
        assert_eq!(waiting_reason(&wanted), "Waiting for a self-hosted runner with labels self-hosted, linux, gpu.");
    }

    #[test]
    fn the_runners_wire_is_snake_case() {
        let poll: PollArgs = serde_json::from_value(serde_json::json!({
            "runner": "rnr_1", "credential": "g1tr_x", "version": "0.1.0", "running": ["job_1"], "wait_ms": 1000
        }))
        .unwrap();
        assert_eq!(poll.auth.runner, "rnr_1");
        assert_eq!(poll.wait_ms, 1000);
        let assignment = serde_json::to_value(Assignment {
            kind: "workflow".into(),
            id: "job_1".into(),
            name: "build".into(),
            repo: "acme/web".into(),
            timeout_minutes: 60,
            image: None,
            token: Some("t".into()),
            env: None,
            visibility: Some("private".into()),
        })
        .unwrap();
        assert_eq!(assignment["timeout_minutes"], 60);
        assert_eq!(assignment["visibility"], "private");
        // An older runner's registration, without an isolation level.
        let register: RegisterArgs = serde_json::from_value(serde_json::json!({ "token": "g1trt_x", "name": "a", "os": "linux", "arch": "x64" })).unwrap();
        assert_eq!(register.isolation, None);
        assert_eq!((register.cpus, register.memory_mib, register.docker), (None, None, None), "an older runner says nothing of its size");
        let poll: PollArgs = serde_json::from_value(serde_json::json!({
            "runner": "rnr_1", "credential": "c", "cpus": 8, "memory_mib": 16384, "docker": true
        }))
        .unwrap();
        assert_eq!((poll.cpus, poll.memory_mib, poll.docker), (Some(8), Some(16384), Some(true)));
    }
}
