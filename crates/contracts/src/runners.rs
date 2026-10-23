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
//!   its OS and architecture that is online, idle and takes the machine g1t
//!   would give it as one of its sizes takes it ([`stands_in_for`]), and
//!   runs it in a sandbox of that size ([`OfferedSize`], [`picked_size`]). With none
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
    /// The sizes it takes jobs asking for a hosted label for, as it last
    /// said ([`OfferedSize`]), with the sandbox each gets where that is more
    /// than the size. Null for a runner from before runners said, which
    /// takes those jobs by `cpus` and `memory_mib`.
    #[serde(default)]
    pub sizes: Option<Vec<OfferedSize>>,
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
    /// The sizes it takes jobs asking for a hosted label for
    /// (`Runner::sizes`); empty for none. Older runners leave it out, and
    /// are matched by `cpus` and `memory_mib`.
    #[serde(default)]
    pub sizes: Option<Vec<OfferedSize>>,
    /// Whether it runs a job asking for a hosted label in g1t's runner
    /// image, which has what g1t's machines have (Node, Python, Go, Rust
    /// and the rest), rather than its own. A runner that does not say so
    /// takes none of those jobs ([`stands_in_for`]); runners before 0.3.7
    /// leave it out.
    #[serde(default)]
    pub hosted_image: Option<bool>,
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
    /// The sizes it takes now, as at registration: a change to them counts
    /// from the poll that says it. Older runners leave it out.
    #[serde(default)]
    pub sizes: Option<Vec<OfferedSize>>,
    /// Whether it runs those jobs in g1t's runner image now, as at
    /// registration (`RegisterArgs::hosted_image`). Older runners leave it
    /// out.
    #[serde(default)]
    pub hosted_image: Option<bool>,
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
    /// For a job that asked for one of g1t's machines, taken for one of the
    /// sizes the runner offers: that size, with the CPUs and memory its
    /// sandbox gets ([`OfferedSize::assigned`]). None for any other job,
    /// which keeps the runner's own limits, and from an older g1t.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<OfferedSize>,
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
    /// It runs a job asking for a hosted label in g1t's runner image
    /// (`RegisterArgs::hosted_image`).
    pub hosted_image: Option<bool>,
}

/// Whether a runner may take, in place of `machine` (the machine g1t would
/// give it), a job asking for a hosted label: a runner that says which
/// sizes it takes ([`OfferedSize`]) takes it when the machine is one of
/// them, and one that does not (older runners) when it has at least the
/// machine's CPUs and memory. Either needs Docker when the job has
/// `services:` or `container:`, and a runner that runs jobs directly on its
/// machine takes only a repository known to be private. A runner that says
/// neither what it takes nor what it has takes none: the job runs on g1t's
/// machine instead, where it fits. Nor does one that does not run these
/// jobs in g1t's runner image ([`Capacity::hosted_image`]): in its own
/// image, a job written for g1t's machines finds no Rust, Go or Python and
/// fails (flagon-io#458).
pub fn stands_in_for(
    capacity: Capacity,
    sizes: Option<&[OfferedSize]>,
    isolation: Option<&str>,
    visibility: Option<&str>,
    machine: &crate::actions::InstanceType,
    needs_docker: bool,
) -> bool {
    let isolated = isolation != Some("host") || visibility == Some("private");
    let docker = !needs_docker || capacity.docker == Some(true);
    let image = capacity.hosted_image == Some(true);
    let takes = match sizes {
        Some(sizes) => sizes.iter().any(|offered| offered.size == machine.machine),
        None => match (capacity.cpus, capacity.memory_mib) {
            (Some(cpus), Some(memory_mib)) => f64::from(cpus) >= machine.vcpu && memory_mib as f64 >= machine.memory_gib * 1024.0,
            _ => false,
        },
    };
    takes && docker && isolated && image
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
/// workspace's runner `runner` took it: the size it runs as and the sandbox
/// it got there, when the runner says which sizes it takes (`size`, from
/// [`OfferedSize::assigned`]), and how the runner keeps it (`isolation`).
pub fn on_own_runner_note(runner: &str, size: Option<&OfferedSize>, isolation: Option<&str>) -> String {
    let why = "This job asked for one of g1t's machines, and the workspace prefers its own runners when one that takes it is free (Settings, Runners). Its time there is free.";
    let Some((size, sandbox)) = size.and_then(|offered| Some((size_named(&offered.size)?, offered.sandbox()?))) else {
        return format!(
            "This job asked for one of g1t's machines and runs on the workspace's own runner {runner} instead: the workspace prefers its own runners when one that fits is free (Settings, Runners). Its time there is free."
        );
    };
    let given = if sandbox.memory_mib < size.room().memory_mib {
        format!("{} vCPU, {} of {}", number(size.vcpu), number(sandbox.memory_mib as f64 / 1024.0), gb(size.room().memory_mib))
    } else {
        size.room().words()
    };
    let runs = format!("Runs as {} ({given}) on the workspace's runner {runner}", size.name);
    match isolation {
        Some("host") => format!("{runs}, directly on its machine: host mode sets no limits. {why}"),
        _ if sandbox == size.room() => format!("{runs}, in g1t's runner image, in a sandbox of exactly that size. {why}"),
        _ if sandbox.cpus == size.vcpu && sandbox.memory_mib < size.room().memory_mib => {
            format!("{runs}, in g1t's runner image: its sandbox has less memory than the size, and a job that runs out of it runs again on g1t's machines. {why}")
        }
        _ => format!("{runs}, in g1t's runner image, which gives {} jobs a sandbox of {}. {why}", size.name, sandbox.words()),
    }
}

/// What a job that asked for a hosted label says in "Set up job" when it
/// runs on g1t's machines after all.
pub fn fallback_note(why: Fallback) -> &'static str {
    match why {
        Fallback::NoneFree => {
            "This job runs on g1t's machines: the workspace prefers its own runners, and none that fits this job (its OS and architecture, a runner that takes its size, and Docker if it uses services or a container) was free."
        }
        Fallback::NotTaken => "This job runs on g1t's machines: the workspace prefers its own runners, and none of them took it within 15 seconds.",
    }
}

// --- Sizes: which of g1t's machines a runner takes jobs for -------------------
//
// A job asking for a hosted label would get one of g1t's machines
// (`actions::INSTANCE_TYPES`); a runner says which of those it takes in its
// place, by machine key (`1-core`, `2-core`, `4-core`), and a job it takes
// for one runs in a sandbox of exactly that size, or of more where the
// runner says so (never less). A runner that was told nothing takes the one
// size [`picked_size`] chooses for it, and keeps that choice.

/// A size a runner takes jobs for, as it says it: one of g1t's machines by
/// its key, and, where the runner gives a job taken for it more than the
/// machine has, the CPUs and memory of that job's sandbox. Never less: an
/// override below the size is raised to it ([`OfferedSize::sandbox`]).
/// In a job's assignment, both are set, to the sandbox the job gets.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OfferedSize {
    /// `2-core`.
    pub size: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpus: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_mib: Option<u64>,
}

/// CPUs and memory: a size's, a sandbox's, or what a machine has.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Room {
    pub cpus: f64,
    pub memory_mib: u64,
}

impl Room {
    /// Whether `other` fits in it.
    pub fn holds(&self, other: Room) -> bool {
        other.cpus <= self.cpus && other.memory_mib <= self.memory_mib
    }

    /// `2 vCPU, 8 GB`.
    pub fn words(&self) -> String {
        format!("{} vCPU, {}", number(self.cpus), gb(self.memory_mib))
    }

    /// `2 vCPU · 8 GB`.
    pub fn spec(&self) -> String {
        format!("{} vCPU · {}", number(self.cpus), gb(self.memory_mib))
    }
}

/// `2`, `1.5`.
fn number(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 { format!("{}", rounded as i64) } else { format!("{rounded}") }
}

/// Memory for people: `8 GB`, `1.5 GB`, `512 MB`.
pub fn gb(mib: u64) -> String {
    if mib < 1024 {
        return format!("{mib} MB");
    }
    format!("{} GB", number(mib as f64 / 1024.0))
}

/// One of g1t's machines as a size a runner takes jobs for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    /// The machine's key (`actions::InstanceType::machine`): `2-core`.
    pub machine: &'static str,
    /// For people: `Standard`.
    pub name: &'static str,
    pub vcpu: f64,
    pub memory_gib: f64,
    /// The least memory its jobs run with ([`SIZE_LEAST_MEMORY`]).
    pub least_memory_gib: f64,
}

impl Size {
    pub fn room(&self) -> Room {
        Room { cpus: self.vcpu, memory_mib: (self.memory_gib * 1024.0) as u64 }
    }

    /// The least a sandbox may give its jobs: all its vCPUs, and its least
    /// memory.
    pub fn least(&self) -> Room {
        Room { cpus: self.vcpu, memory_mib: (self.least_memory_gib * 1024.0) as u64 }
    }

    /// `Standard · 2 vCPU · 8 GB`.
    pub fn title(&self) -> String {
        format!("{} · {}", self.name, self.room().spec())
    }
}

/// What people call each machine as a size, by its key. A machine not
/// named here is called by its key.
const SIZE_NAMES: [(&str, &str); 3] = [("1-core", "Small"), ("2-core", "Standard"), ("4-core", "Large")];

/// The least memory, in GiB, a size's jobs run with where a sandbox has
/// less than the size: about two-thirds of it, by machine key. A sandbox
/// with all of a size's vCPUs and at least this much may take it, and its
/// jobs then run with what it has ([`fitted`]); CPUs are never fewer. A
/// size not named here needs all its memory.
pub const SIZE_LEAST_MEMORY: [(&str, f64); 3] = [("1-core", 4.0), ("2-core", 6.0), ("4-core", 8.0)];

/// The size a runner takes when nobody chose, if it fits: the standard
/// machine, which most jobs get on g1t.
pub const PICKED_FIRST: &str = "2-core";
/// The size it takes instead when that does not fit.
pub const PICKED_ELSE: &str = "1-core";

/// Every size, smallest first: each of g1t's machines once.
pub fn sizes() -> Vec<Size> {
    let mut out: Vec<Size> = Vec::new();
    for instance in crate::actions::INSTANCE_TYPES {
        if out.iter().any(|size| size.machine == instance.machine) {
            continue;
        }
        let name = SIZE_NAMES.iter().find(|(key, _)| *key == instance.machine).map_or(instance.machine, |(_, name)| *name);
        let least = SIZE_LEAST_MEMORY.iter().find(|(key, _)| *key == instance.machine).map_or(instance.memory_gib, |(_, gib)| gib.min(instance.memory_gib));
        out.push(Size { machine: instance.machine, name, vcpu: instance.vcpu, memory_gib: instance.memory_gib, least_memory_gib: least });
    }
    out.sort_by(|a, b| a.vcpu.total_cmp(&b.vcpu).then(a.memory_gib.total_cmp(&b.memory_gib)));
    out
}

/// A size by its machine's key, if it is one.
pub fn size_named(key: &str) -> Option<Size> {
    let key = key.trim();
    sizes().into_iter().find(|size| size.machine.eq_ignore_ascii_case(key))
}

impl OfferedSize {
    /// A size at its own spec.
    pub fn of(size: &str) -> OfferedSize {
        OfferedSize { size: size.to_owned(), cpus: None, memory_mib: None }
    }

    /// The sandbox a job taken for it gets: the size's own CPUs and memory,
    /// or what the runner said: more of either, or less memory down to the
    /// size's least ([`Size::least`]), never fewer CPUs. None for a size
    /// that is not one of g1t's machines.
    pub fn sandbox(&self) -> Option<Room> {
        let size = size_named(&self.size)?;
        let spec = size.room();
        Some(Room {
            cpus: self.cpus.filter(|c| c.is_finite()).map_or(spec.cpus, |c| c.max(spec.cpus)),
            memory_mib: self.memory_mib.map_or(spec.memory_mib, |m| m.max(size.least().memory_mib)),
        })
    }

    /// Whether its jobs get less memory than the size: its sandbox has less
    /// than the size and at least its least.
    pub fn short_of_memory(&self) -> bool {
        match (size_named(&self.size), self.sandbox()) {
            (Some(size), Some(sandbox)) => sandbox.memory_mib < size.room().memory_mib,
            _ => false,
        }
    }

    /// What a job taken for it is handed: the size, with its sandbox's CPUs
    /// and memory both set.
    pub fn assigned(&self) -> Option<OfferedSize> {
        let size = size_named(&self.size)?;
        let sandbox = self.sandbox()?;
        Some(OfferedSize { size: size.machine.to_owned(), cpus: Some(sandbox.cpus), memory_mib: Some(sandbox.memory_mib) })
    }

    /// Whether it can be offered: one of g1t's machines, with no fewer CPUs
    /// than it and no less memory than its least where it says how much. A
    /// runner and the desktop app refuse an override below that this way;
    /// g1t raises one that reaches it anyway ([`kept_sizes`]).
    pub fn check(&self) -> std::result::Result<(), String> {
        let Some(size) = size_named(&self.size) else {
            let known: Vec<&str> = sizes().iter().map(|s| s.machine).collect();
            return Err(format!("`{}` is not a size: the sizes are {}.", self.size, known.join(", ")));
        };
        let spec = size.room();
        if let Some(cpus) = self.cpus
            && !(cpus.is_finite() && cpus >= spec.cpus)
        {
            return Err(format!("{} jobs get at least {} vCPU, its own size, not {}.", size.name, number(spec.cpus), number(cpus)));
        }
        if let Some(memory) = self.memory_mib
            && memory < size.least().memory_mib
        {
            return Err(format!("{} jobs get at least {}, the least it runs with, not {}.", size.name, gb(size.least().memory_mib), gb(memory)));
        }
        Ok(())
    }

    /// For people: `Standard`, or `Standard → 4 vCPU · 16 GB` when its
    /// jobs get more than the size.
    pub fn said(&self) -> String {
        let Some(size) = size_named(&self.size) else { return self.size.clone() };
        match self.sandbox() {
            Some(sandbox) if sandbox != size.room() => format!("{} → {}", size.name, sandbox.spec()),
            _ => size.name.to_owned(),
        }
    }
}

/// What a runner says it takes, as g1t keeps it: sizes that are g1t's
/// machines, each once, smallest first, with fewer CPUs than the size, or
/// less memory than its least, raised to that. Others are dropped.
pub fn kept_sizes(given: &[OfferedSize]) -> Vec<OfferedSize> {
    let mut out: Vec<OfferedSize> = Vec::new();
    for size in sizes() {
        let Some(offered) = given.iter().find(|o| o.size.trim().eq_ignore_ascii_case(size.machine)) else { continue };
        let sandbox = offered.sandbox().unwrap_or_else(|| size.room());
        let spec = size.room();
        out.push(OfferedSize {
            size: size.machine.to_owned(),
            cpus: (sandbox.cpus > spec.cpus).then_some(sandbox.cpus.min(4096.0)),
            memory_mib: (sandbox.memory_mib != spec.memory_mib).then_some(sandbox.memory_mib.min(64 * 1024 * 1024)),
        });
    }
    out
}

/// What a runner takes, for people: `Small, Standard → 4 vCPU · 16 GB`;
/// `no sizes` when it takes none.
pub fn sizes_said(offered: &[OfferedSize]) -> String {
    if offered.is_empty() {
        return "no sizes".to_owned();
    }
    offered.iter().map(OfferedSize::said).collect::<Vec<_>>().join(", ")
}

/// The machine a runner's jobs run on: what it has, and, for a runner in a
/// sandbox of a set size on it (the desktop app's), that sandbox's share,
/// which no job can have more of.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Machine {
    pub cpus: u32,
    pub memory_mib: u64,
    pub share: Option<Room>,
}

impl Machine {
    pub fn room(&self) -> Room {
        Room { cpus: f64::from(self.cpus), memory_mib: self.memory_mib }
    }

    /// Half of it: what a size taken without asking may use, so the
    /// person's own work keeps the rest.
    pub fn half(&self) -> Room {
        Room { cpus: f64::from(self.cpus) / 2.0, memory_mib: self.memory_mib / 2 }
    }

    /// Whether a job of `room` fits without asking: in half the machine,
    /// and in the sandbox's share.
    pub fn fits(&self, room: Room) -> bool {
        self.half().holds(room) && self.share.is_none_or(|share| share.holds(room))
    }

    /// `8 CPUs and 16 GB`.
    pub fn words(&self) -> String {
        format!("{} CPU{} and {}", self.cpus, if self.cpus == 1 { "" } else { "s" }, gb(self.memory_mib))
    }
}

/// The one size a runner takes when nobody chose: Standard if it fits in
/// half the machine (and the sandbox's share), else Small if that does,
/// else Standard and then Small at their least memory, else none. Never
/// Large: most jobs then run at 2 vCPU on people's machines, as on g1t's.
/// The runner keeps what this chose, and the person changes it from there.
pub fn picked_size(machine: Machine) -> Option<Size> {
    let picks: Vec<Size> = [PICKED_FIRST, PICKED_ELSE].iter().filter_map(|key| size_named(key)).collect();
    let whole = picks.iter().find(|size| machine.fits(size.room()));
    whole.or_else(|| picks.iter().find(|size| machine.fits(size.least()))).copied()
}

/// Why [`picked_size`] chose what it did, in a sentence for the settings:
/// `Standard fits in half this machine's 8 CPUs and 16 GB.`
pub fn pick_reason(machine: Machine) -> String {
    let share = machine.share.map(|share| format!(" and in the sandbox's {}", share.words())).unwrap_or_default();
    match picked_size(machine) {
        Some(size) if machine.fits(size.room()) => format!("{} fits in half this machine's {}{share}.", size.name, machine.words()),
        Some(size) => format!(
            "{} fits in half this machine's {}{share} with {} of its {}.",
            size.name,
            machine.words(),
            gb(size.least().memory_mib),
            gb(size.room().memory_mib)
        ),
        None => {
            let small = size_named(PICKED_ELSE).map(|s| format!(": Small needs at least {}", s.least().words())).unwrap_or_default();
            format!("No size fits in half this machine's {}{share}{small}. Offer one anyway to take jobs of it.", machine.words())
        }
    }
}

/// What a size's jobs get on `machine`: what the runner gives it, with its
/// memory lowered to what the sandbox's share (else the machine) has where
/// that is less, down to the size's least and never below it. With room
/// for all of it, a size gets all of it; CPUs are never lowered. One that
/// doesn't fit even at its least is left as it is, and warns
/// ([`size_warning`]).
pub fn fitted(offered: &OfferedSize, machine: Machine) -> OfferedSize {
    let (Some(size), Some(sandbox)) = (size_named(&offered.size), offered.sandbox()) else { return offered.clone() };
    let has = machine.share.map_or(machine.memory_mib, |share| share.memory_mib);
    if sandbox.memory_mib <= has || has < size.least().memory_mib {
        return offered.clone();
    }
    OfferedSize { memory_mib: Some(has), ..offered.clone() }
}

/// What a size whose jobs get less memory than it says, for the settings:
/// `Runs with 8 GB instead of 12 GB: jobs that need all of it may run out
/// of memory.` None when its jobs get all of it.
pub fn memory_warning(offered: &OfferedSize) -> Option<String> {
    let size = size_named(&offered.size)?;
    let sandbox = offered.sandbox()?;
    offered.short_of_memory().then(|| {
        format!(
            "Runs with {} instead of {}: jobs that need all of it may run out of memory, and run again on g1t's machines.",
            gb(sandbox.memory_mib),
            gb(size.room().memory_mib)
        )
    })
}

/// What offering a size whose jobs get `sandbox` costs a machine, when it
/// may hurt: more than the sandbox's share or the machine has (jobs may run
/// slower, or run out of memory), or more than half of it (the person's own
/// work may slow down while one runs). None when it fits in half. Offering
/// it is the person's call: this warns, and refuses nothing.
pub fn size_warning(machine: Machine, sandbox: Room) -> Option<String> {
    if let Some(share) = machine.share
        && !share.holds(sandbox)
    {
        return Some(format!(
            "More than the sandbox's {}: a job gets at most that, so it may run slower or run out of memory.",
            share.words()
        ));
    }
    if !machine.room().holds(sandbox) {
        return Some(format!("More than this machine's {}: a job may run slower or run out of memory.", machine.words()));
    }
    if !machine.half().holds(sandbox) {
        return Some(format!("More than half this machine's {}: your own work may slow down while a job runs.", machine.words()));
    }
    None
}

// --- The sandbox's share: what the desktop app's Linux sandbox may use -------
//
// The desktop app's sandbox gets a share of the computer (the launcher's
// `Resources`), and a job in it never has more than that share, whatever
// its size gives it. Saving sizes grows the share to hold the largest of
// them ([`share_for`]); it never shrinks one, so a share someone set stays
// at least what they set, and one too large for the computer warns
// ([`share_warning`]) rather than being refused.

/// What the runner itself needs in the sandbox beside a job: its own
/// process and the job's Docker Engine.
pub const RUNNER_ROOM_MIB: u64 = 1024;

/// The share that holds every size in `offered`: at least the largest
/// sandbox's CPUs (whole ones, which is how a share is set) and its memory
/// plus [`RUNNER_ROOM_MIB`], each no less than `share` has now. `limit` is
/// what the sandbox can have at most (the VM it runs in, else the
/// computer): CPUs are never grown past it, since a container can't be
/// given more than there are; memory is, and [`share_warning`] says so.
pub fn share_for(share: Room, offered: &[OfferedSize], limit: Room) -> Room {
    let needed = offered.iter().filter_map(OfferedSize::sandbox).fold(Room::default(), |most, sandbox| Room {
        cpus: most.cpus.max(sandbox.cpus),
        memory_mib: most.memory_mib.max(sandbox.memory_mib),
    });
    let cpus = needed.cpus.ceil().min(limit.cpus.max(1.0));
    let memory_mib = if needed.memory_mib == 0 { 0 } else { needed.memory_mib + RUNNER_ROOM_MIB };
    Room { cpus: share.cpus.max(cpus), memory_mib: share.memory_mib.max(memory_mib) }
}

/// What a share costs the computer, when it may hurt: more than `limit` (the
/// VM it runs in, as far as the launcher can tell), or more than half the
/// computer, so the person's own work may slow down. None when it fits in
/// half. A warning, never a refusal.
pub fn share_warning(machine: Machine, share: Room, limit: Option<Room>) -> Option<String> {
    if let Some(limit) = limit
        && !limit.holds(share)
    {
        return Some(format!(
            "More than the Linux VM's {}: the sandbox gets at most that, so a job may run slower or run out of memory.",
            limit.words()
        ));
    }
    if !machine.room().holds(share) {
        return Some(format!("More than this computer's {}: a job may run slower or run out of memory.", machine.words()));
    }
    if !machine.half().holds(share) {
        return Some(format!("More than half this computer's {}: your own work may slow down while a job runs.", machine.words()));
    }
    None
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
        let laptop = Capacity { cpus: Some(8), memory_mib: Some(16 * 1024), docker: Some(true), hosted_image: Some(true) };
        assert!(stands_in_for(laptop, None, Some("nested-container"), Some("public"), &standard, false));
        assert!(stands_in_for(laptop, None, Some("nested-container"), Some("public"), &large, true));
        // Exactly the machine's size is enough; a CPU or a MiB less is not.
        let exact = Capacity { cpus: Some(2), memory_mib: Some(8 * 1024), docker: None, hosted_image: Some(true) };
        assert!(stands_in_for(exact, None, Some("container"), None, &standard, false));
        assert!(!stands_in_for(Capacity { cpus: Some(1), ..exact }, None, Some("container"), None, &standard, false));
        assert!(!stands_in_for(Capacity { memory_mib: Some(8 * 1024 - 1), ..exact }, None, Some("container"), None, &standard, false));
        assert!(!stands_in_for(exact, None, Some("container"), None, &large, false));
        // A runner that does not say what it has takes none.
        assert!(!stands_in_for(Capacity { cpus: None, ..laptop }, None, None, None, &standard, false));
        assert!(!stands_in_for(Capacity { memory_mib: None, ..laptop }, None, None, None, &standard, false));
        assert!(!stands_in_for(Capacity::default(), None, None, None, &standard, false));
    }

    #[test]
    fn services_and_containers_need_a_runner_with_docker() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let without = Capacity { cpus: Some(4), memory_mib: Some(16 * 1024), docker: Some(false), hosted_image: Some(true) };
        assert!(stands_in_for(without, None, None, None, &standard, false));
        assert!(!stands_in_for(without, None, None, None, &standard, true));
        assert!(!stands_in_for(Capacity { docker: None, ..without }, None, None, None, &standard, true));
        assert!(stands_in_for(Capacity { docker: Some(true), ..without }, None, None, None, &standard, true));
    }

    #[test]
    fn a_host_mode_runner_stands_in_only_for_a_private_repository() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let big = Capacity { cpus: Some(16), memory_mib: Some(64 * 1024), docker: Some(true), hosted_image: Some(true) };
        assert!(stands_in_for(big, None, Some("host"), Some("private"), &standard, false));
        assert!(!stands_in_for(big, None, Some("host"), Some("public"), &standard, false));
        // Unknown: g1t's machine runs it, rather than the runner deciding.
        assert!(!stands_in_for(big, None, Some("host"), None, &standard, false));
        assert!(stands_in_for(big, None, Some("vm"), None, &standard, false));
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
        assert!(on_own_runner_note("box-linux", None, None).contains("own runner box-linux"));
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
            size: None,
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
        assert_eq!(poll.sizes, None, "an older runner says nothing of its sizes");
        let poll: PollArgs = serde_json::from_value(serde_json::json!({
            "runner": "rnr_1", "credential": "c", "sizes": [{ "size": "1-core" }, { "size": "2-core", "cpus": 4, "memory_mib": 16384 }]
        }))
        .unwrap();
        assert_eq!(poll.sizes, Some(vec![OfferedSize::of("1-core"), OfferedSize { size: "2-core".into(), cpus: Some(4.0), memory_mib: Some(16384) }]));
        let assignment: Value = serde_json::to_value(OfferedSize::of("2-core").assigned()).unwrap();
        assert_eq!(assignment, serde_json::json!({ "size": "2-core", "cpus": 2.0, "memory_mib": 8192 }));
    }

    fn machine(cpus: u32, gib: u64) -> Machine {
        Machine { cpus, memory_mib: gib * 1024, share: None }
    }

    #[test]
    fn the_sizes_are_g1ts_machines_by_name() {
        let titles: Vec<String> = sizes().iter().map(Size::title).collect();
        assert_eq!(titles, ["Small · 1 vCPU · 6 GB", "Standard · 2 vCPU · 8 GB", "Large · 4 vCPU · 12 GB"]);
        assert_eq!(size_named(" 2-CORE ").map(|s| s.name), Some("Standard"));
        assert_eq!(size_named("8-core"), None);
        assert_eq!(gb(1536), "1.5 GB");
        assert_eq!(gb(512), "512 MB");
    }

    #[test]
    fn a_runner_told_nothing_takes_standard_or_else_small_in_half_its_machine() {
        // Standard (2 vCPU, 8 GB) fits in half of 8 CPUs and 16 GiB.
        assert_eq!(picked_size(machine(8, 16)).map(|s| s.machine), Some("2-core"));
        assert!(pick_reason(machine(8, 16)).starts_with("Standard fits in half this machine's 8 CPUs and 16 GB"));
        // Half of 4 CPUs and 8 GiB is 4 GB: not Small's 6 GB, but its least.
        assert_eq!(picked_size(machine(4, 8)).map(|s| s.machine), Some("1-core"));
        assert!(pick_reason(machine(4, 8)).contains("with 4 GB of its 6 GB"));
        assert_eq!(picked_size(machine(2, 4)), None);
        assert!(pick_reason(machine(2, 4)).contains("Small needs at least 1 vCPU, 4 GB"));
        // A size that fits whole comes before one at its least.
        assert_eq!(picked_size(machine(4, 13)).map(|s| s.machine), Some("1-core"), "Small whole, before Standard at 6 GB");
        assert_eq!(picked_size(machine(4, 12)).map(|s| s.machine), Some("1-core"));
        // Small where Standard does not fit; never Large, however big.
        assert_eq!(picked_size(machine(2, 12)).map(|s| s.machine), Some("1-core"));
        assert_eq!(picked_size(machine(64, 256)).map(|s| s.machine), Some("2-core"));
        // A sandbox of a set size holds the job too: half the computer is not enough.
        let desktop = Machine { share: Some(Room { cpus: 4.0, memory_mib: 6 * 1024 }), ..machine(16, 32) };
        assert_eq!(picked_size(desktop).map(|s| s.machine), Some("1-core"));
        assert!(pick_reason(desktop).contains("in the sandbox's 4 vCPU, 6 GB"));
    }

    #[test]
    fn a_size_offered_beyond_half_the_machine_warns_and_is_not_refused() {
        let large = size_named("4-core").unwrap().room();
        let standard = size_named("2-core").unwrap().room();
        assert_eq!(size_warning(machine(8, 16), standard), None);
        assert!(size_warning(machine(8, 16), large).unwrap().contains("More than half this machine's 8 CPUs and 16 GB"));
        assert!(size_warning(machine(2, 4), standard).unwrap().contains("More than this machine's 2 CPUs and 4 GB"));
        let desktop = Machine { share: Some(Room { cpus: 4.0, memory_mib: 8 * 1024 }), ..machine(16, 64) };
        assert!(size_warning(desktop, large).unwrap().contains("More than the sandbox's 4 vCPU, 8 GB"));
        // Offered anyway, it is matched: the warning refuses nothing.
        let offered = [OfferedSize::of("4-core")];
        let large_machine = crate::actions::instance_named("g1t-4core").unwrap();
        assert!(stands_in_for(Capacity { hosted_image: Some(true), ..Capacity::default() }, Some(&offered), Some("nested-container"), None, &large_machine, false));
    }

    #[test]
    fn a_size_runs_with_less_memory_down_to_its_least_and_never_fewer_cpus() {
        let least: Vec<(&str, u64)> = sizes().iter().map(|s| (s.name, s.least().memory_mib / 1024)).collect();
        assert_eq!(least, [("Small", 4), ("Standard", 6), ("Large", 8)]);
        let large = OfferedSize::of("4-core");
        let share = |gib: u64| Machine { share: Some(Room { cpus: 8.0, memory_mib: gib * 1024 }), ..machine(32, 64) };
        // With all of it, all of it.
        assert_eq!(fitted(&large, share(16)), large);
        assert_eq!(memory_warning(&fitted(&large, share(16))), None);
        // At its least or above: what the sandbox has, and a warning.
        let at_least = fitted(&large, share(8));
        assert_eq!(at_least.sandbox(), Some(Room { cpus: 4.0, memory_mib: 8 * 1024 }));
        assert_eq!(at_least.check(), Ok(()));
        assert!(memory_warning(&at_least).unwrap().starts_with("Runs with 8 GB instead of 12 GB"));
        assert_eq!(fitted(&large, share(10)).memory_mib, Some(10 * 1024));
        // Below it: left at its size, which warns that it is more than the sandbox's.
        assert_eq!(fitted(&large, share(7)), large);
        assert!(size_warning(share(7), large.sandbox().unwrap()).unwrap().contains("More than the sandbox's"));
        // CPUs are never fewer, and a runner can't offer less memory than the least.
        assert!(OfferedSize { size: "4-core".into(), cpus: Some(2.0), memory_mib: None }.check().is_err());
        assert!(OfferedSize { size: "4-core".into(), cpus: None, memory_mib: Some(7 * 1024) }.check().unwrap_err().contains("at least 8 GB"));
        assert_eq!(at_least.assigned().unwrap().memory_mib, Some(8 * 1024), "the job is handed what it gets");
    }

    #[test]
    fn saving_sizes_grows_the_share_to_hold_the_largest_and_never_shrinks_it() {
        let computer = Room { cpus: 32.0, memory_mib: 64 * 1024 };
        let share = Room { cpus: 8.0, memory_mib: 8 * 1024 };
        // Large (4 vCPU, 12 GB) needs 4 CPUs and 13 GiB with the runner's own room.
        let large = [OfferedSize::of("2-core"), OfferedSize::of("4-core")];
        assert_eq!(share_for(share, &large, computer), Room { cpus: 8.0, memory_mib: 13 * 1024 });
        // Its jobs given more: that is what the share holds.
        let more = [OfferedSize { size: "4-core".into(), cpus: Some(12.5), memory_mib: Some(24 * 1024) }];
        assert_eq!(share_for(share, &more, computer), Room { cpus: 13.0, memory_mib: 25 * 1024 });
        // A share that holds them already, or no sizes, stays as it is.
        let roomy = Room { cpus: 16.0, memory_mib: 32 * 1024 };
        assert_eq!(share_for(roomy, &large, computer), roomy);
        assert_eq!(share_for(share, &[], computer), share);
        // Never past the VM's CPUs, which a container can't be given.
        let vm = Room { cpus: 4.0, memory_mib: 8 * 1024 };
        assert_eq!(share_for(Room { cpus: 2.0, memory_mib: 4096 }, &more, vm), Room { cpus: 4.0, memory_mib: 25 * 1024 });
    }

    #[test]
    fn a_share_beyond_half_the_computer_or_its_vm_warns_and_is_not_refused() {
        let computer = machine(32, 64);
        assert_eq!(share_warning(computer, Room { cpus: 16.0, memory_mib: 16 * 1024 }, None), None);
        assert!(share_warning(computer, Room { cpus: 17.0, memory_mib: 16 * 1024 }, None).unwrap().contains("More than half this computer's 32 CPUs and 64 GB"));
        assert!(share_warning(machine(4, 8), Room { cpus: 4.0, memory_mib: 9 * 1024 }, None).unwrap().contains("More than this computer's"));
        let vm = Room { cpus: 16.0, memory_mib: 32 * 1024 };
        assert_eq!(share_warning(computer, Room { cpus: 8.0, memory_mib: 13 * 1024 }, Some(vm)), None);
        assert!(share_warning(computer, Room { cpus: 8.0, memory_mib: 40 * 1024 }, Some(vm)).unwrap().contains("More than the Linux VM's 16 vCPU, 32 GB"));
    }

    #[test]
    fn a_job_never_gets_less_than_its_size() {
        let more = OfferedSize { size: "2-core".into(), cpus: Some(4.0), memory_mib: Some(16 * 1024) };
        assert_eq!(more.check(), Ok(()));
        assert_eq!(more.sandbox(), Some(Room { cpus: 4.0, memory_mib: 16 * 1024 }));
        assert_eq!(more.said(), "Standard → 4 vCPU · 16 GB");
        // Below the size: the runner and the app refuse it, and g1t raises it.
        let less = OfferedSize { size: "2-core".into(), cpus: Some(1.0), memory_mib: Some(4096) };
        assert!(less.check().unwrap_err().contains("at least 2 vCPU"));
        assert!(OfferedSize { cpus: None, ..less.clone() }.check().unwrap_err().contains("at least 6 GB"));
        assert_eq!(less.sandbox(), Some(Room { cpus: 2.0, memory_mib: 6144 }), "raised to its least");
        assert_eq!(kept_sizes(std::slice::from_ref(&less)), vec![OfferedSize { size: "2-core".into(), cpus: None, memory_mib: Some(6144) }]);
        assert!(OfferedSize::of("16-core").check().unwrap_err().contains("not a size"));
        // Kept once each, smallest first, unknown ones dropped.
        let given = [more.clone(), OfferedSize::of("1-core"), OfferedSize::of("2-core"), OfferedSize::of("gpu")];
        assert_eq!(kept_sizes(&given), vec![OfferedSize::of("1-core"), more.clone()]);
        assert_eq!(sizes_said(&kept_sizes(&given)), "Small, Standard → 4 vCPU · 16 GB");
        assert_eq!(sizes_said(&[]), "no sizes");
    }

    #[test]
    fn a_runner_that_says_its_sizes_takes_only_those() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let slim = crate::actions::instance_named("ubuntu-slim").unwrap();
        let small_box = Capacity { cpus: Some(1), memory_mib: Some(1024), docker: Some(true), hosted_image: Some(true) };
        let offered = [OfferedSize::of("2-core")];
        // Its sizes, not its resources, decide.
        assert!(stands_in_for(small_box, Some(&offered), None, None, &standard, false));
        assert!(!stands_in_for(small_box, Some(&offered), None, None, &slim, false));
        assert!(!stands_in_for(small_box, Some(&[]), None, None, &standard, false), "it takes none");
        // Docker and host mode still count.
        assert!(!stands_in_for(Capacity { docker: Some(false), ..small_box }, Some(&offered), None, None, &standard, true));
        assert!(!stands_in_for(small_box, Some(&offered), Some("host"), Some("public"), &standard, false));
    }

    #[test]
    fn only_a_runner_that_runs_them_in_g1ts_runner_image_takes_jobs_asking_for_g1ts_machines() {
        let standard = crate::actions::STANDARD_INSTANCE;
        let offered = [OfferedSize::of("2-core")];
        let sandbox = Capacity { cpus: Some(8), memory_mib: Some(16 * 1024), docker: Some(true), hosted_image: Some(true) };
        assert!(stands_in_for(sandbox, Some(&offered), Some("nested-container"), None, &standard, false));
        // In its own image such a job finds no cargo: before 0.3.7 one ran there and failed at once.
        let older = Capacity { hosted_image: None, ..sandbox };
        assert!(!stands_in_for(older, Some(&offered), Some("nested-container"), None, &standard, false), "an older runner");
        assert!(!stands_in_for(older, None, Some("nested-container"), None, &standard, false), "by its resources too");
        let without = Capacity { hosted_image: Some(false), ..sandbox };
        assert!(!stands_in_for(without, Some(&offered), Some("nested-container"), None, &standard, false), "one with no such image");
        let register: RegisterArgs = serde_json::from_value(serde_json::json!({ "token": "t", "name": "a", "os": "linux", "arch": "x64", "hosted_image": true })).unwrap();
        assert_eq!(register.hosted_image, Some(true));
        let poll: PollArgs = serde_json::from_value(serde_json::json!({ "runner": "rnr_1", "credential": "c" })).unwrap();
        assert_eq!(poll.hosted_image, None, "an older runner says nothing of it");
    }

    #[test]
    fn set_up_job_says_the_size_and_the_sandbox() {
        let standard = OfferedSize::of("2-core").assigned();
        let exact = on_own_runner_note("box-linux", standard.as_ref(), Some("nested-container"));
        assert!(exact.starts_with("Runs as Standard (2 vCPU, 8 GB) on the workspace's runner box-linux, in g1t's runner image, in a sandbox of exactly that size."), "{exact}");
        let more = OfferedSize { size: "2-core".into(), cpus: Some(4.0), memory_mib: Some(16 * 1024) }.assigned();
        let given = on_own_runner_note("box-linux", more.as_ref(), Some("nested-container"));
        assert!(given.contains("which gives Standard jobs a sandbox of 4 vCPU, 16 GB"), "{given}");
        assert!(on_own_runner_note("box", standard.as_ref(), Some("host")).contains("host mode sets no limits"));
        let short = OfferedSize { size: "4-core".into(), cpus: None, memory_mib: Some(8 * 1024) }.assigned();
        let short = on_own_runner_note("box-linux", short.as_ref(), Some("nested-container"));
        assert!(short.starts_with("Runs as Large (4 vCPU, 8 of 12 GB) on the workspace's runner box-linux"), "{short}");
    }
}
