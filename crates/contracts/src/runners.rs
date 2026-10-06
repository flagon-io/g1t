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
    /// The workflow run the job is in, for a link.
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
    /// Agent runs, checks, reviews and the merge queue run on self-hosted
    /// runners with `agent_labels`, instead of g1t's sandboxes.
    pub agents_on_self_hosted: bool,
    /// The labels a runner needs to take agent work; `self-hosted` is
    /// always one.
    pub agent_labels: Vec<String>,
    /// Jobs of pull requests from forks may run on self-hosted runners.
    /// Off by default: anyone who can open a pull request could run code
    /// on the machine.
    pub fork_pull_requests: bool,
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
    pub inherit: bool,
}

/// `stuck_jobs`: Mission control's Needs you. Returns `Vec<StuckJob>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StuckJobsArgs {
    pub viewer: crate::Viewer,
}

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
}

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

/// What a job waiting for a runner says.
pub fn waiting_reason(wanted: &Wanted) -> String {
    format!("Waiting for a self-hosted runner with labels {}.", wanted.describe())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
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
        })
        .unwrap();
        assert_eq!(assignment["timeout_minutes"], 60);
    }
}
