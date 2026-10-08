//! Checks: what CI, integrations and g1t's own workflows say about a
//! commit, shown next to it wherever it appears.
//!
//! A commit's checks come in two shapes, as they do on GitHub, so the same
//! integrations work unchanged:
//!
//! - **Statuses**: a state (`pending`, `success`, `failure`, `error`) per
//!   context, such as `ci/build`. Kept in the work service's
//!   `commit_statuses` (see `work::CommitStatus`).
//! - **Check runs**: one run of one check, with a lifecycle (`queued`,
//!   `in_progress`, `completed`), a conclusion, a Markdown report,
//!   annotations on lines of files, and buttons the reporter offers.
//!   Grouped per reporter and commit into a **check suite**. Those reported
//!   through the API are kept by the work service; each job of a g1t
//!   Actions workflow run is read as a check run too, its run as the suite,
//!   from the actions service's own records.
//!
//! Every check run reported through the API also stands as a status of its
//! name (`check_run_id` set on it), so required checks and rulesets'
//! required status checks are met by either shape alike.
//!
//! The work service serves the methods below at `POST /rpc/<method>`.
//! Mirrors `packages/contracts/src/checks.ts`.

use serde::{Deserialize, Serialize};

use crate::actions::{Job, WorkflowRun};
use crate::repos::RepoPath;
use crate::work::CommitStatus;
use crate::{User, Viewer};

/// Where a check run is in its life.
pub const STATUSES: [&str; 3] = ["queued", "in_progress", "completed"];
/// How a completed check run came out.
pub const CONCLUSIONS: [&str; 7] = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"];
/// How serious an annotation is.
pub const ANNOTATION_LEVELS: [&str; 3] = ["notice", "warning", "failure"];
/// A status's states.
pub const STATUS_STATES: [&str; 4] = ["pending", "success", "failure", "error"];

/// The most annotations one request adds, and one check run keeps.
pub const MAX_ANNOTATIONS_PER_REQUEST: usize = 50;
pub const MAX_ANNOTATIONS: u32 = 1000;
/// The most buttons a check run offers, and the longest label, description
/// and identifier of one.
pub const MAX_ACTIONS: usize = 3;
pub const MAX_ACTION_LABEL: usize = 20;
pub const MAX_ACTION_DESCRIPTION: usize = 40;
pub const MAX_ACTION_IDENTIFIER: usize = 20;
/// The longest check run name or status context, title, summary and text.
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_TITLE_CHARS: usize = 255;
pub const MAX_OUTPUT_CHARS: usize = 65_535;
/// The longest status description.
pub const MAX_DESCRIPTION_CHARS: usize = 140;
/// The most commits one `commit_checks` call reads.
pub const MAX_COMMITS: usize = 100;

/// Who reported a check run or suite: an integration, a token's name, or
/// `actions` for g1t Actions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckApp {
    pub slug: String,
    pub name: String,
}

impl CheckApp {
    /// g1t Actions, whose jobs are check runs.
    pub fn actions() -> CheckApp {
        CheckApp { slug: "actions".to_owned(), name: "g1t Actions".to_owned() }
    }

    /// The reporter named `name`: its slug is the name in lowercase, with
    /// a dash for anything but a letter or digit.
    pub fn named(name: &str) -> CheckApp {
        let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
        let mut slug = String::new();
        for c in name.chars() {
            if c.is_ascii_alphanumeric() {
                slug.push(c.to_ascii_lowercase());
            } else if !slug.ends_with('-') {
                slug.push('-');
            }
        }
        let slug = slug.trim_matches('-').to_owned();
        CheckApp { slug: if slug.is_empty() { "api".to_owned() } else { slug }, name }
    }

    /// Who an API caller reports as: `app` when given; a job's G1T_TOKEN
    /// as g1t Actions; otherwise the token's name, or the account's.
    pub fn of(actor: &User, app: Option<&str>) -> CheckApp {
        if let Some(app) = app.map(str::trim).filter(|app| !app.is_empty()) {
            return CheckApp::named(app);
        }
        match actor.token.as_ref().and_then(|token| token.name.as_deref()).map(str::trim) {
            Some(name) if name.starts_with("G1T_TOKEN") => CheckApp::actions(),
            Some(name) if !name.is_empty() => CheckApp::named(name),
            _ => CheckApp::named(&actor.username),
        }
    }
}

/// A line range of a file a check run has something to say about.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckAnnotation {
    /// The file, relative to the repository's root, such as `src/main.rs`.
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    /// `notice`, `warning` or `failure`.
    pub annotation_level: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_details: Option<String>,
}

/// A button on a check run's page. Pressing it sends the reporter a
/// `check_run.requested_action` webhook with its `identifier`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckAction {
    pub label: String,
    pub description: String,
    pub identifier: String,
}

/// What a check run reports: Markdown `summary` and `text` under a `title`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutput {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub text: Option<String>,
    pub annotations_count: u32,
}

/// The suite a check run belongs to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteRef {
    pub id: String,
}

/// For a g1t Actions job: the workflow run it is part of.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRef {
    pub run_id: String,
    /// The workflow's name, such as `CI`.
    pub name: String,
    /// The event that started it, such as `push`.
    pub event: String,
}

/// One run of one check on a commit.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCheckRun {
    /// `cr_…` for one reported through the API; a g1t Actions job's id
    /// (`job_…`) for a job.
    pub id: String,
    pub name: String,
    pub head_sha: String,
    /// `queued`, `in_progress` or `completed`.
    pub status: String,
    /// Once completed: one of [`CONCLUSIONS`].
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// The reporter's own page for it.
    pub details_url: Option<String>,
    /// The reporter's own id for it.
    pub external_id: Option<String>,
    /// Its page on g1t (a path on the site; absolute in API responses).
    pub html_url: String,
    pub output: CheckOutput,
    #[serde(default)]
    pub actions: Vec<CheckAction>,
    pub check_suite: SuiteRef,
    pub app: CheckApp,
    /// For a g1t Actions job: its workflow run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<WorkflowRef>,
    #[serde(default)]
    pub created_at: String,
}

impl CommitCheckRun {
    /// What it is called where it is listed among a commit's checks: a
    /// job as `CI / test (push)`, anything else by its name.
    pub fn display_name(&self) -> String {
        match &self.workflow {
            Some(workflow) => format!("{} / {} ({})", workflow.name, self.name, workflow.event),
            None => self.name.clone(),
        }
    }
}

/// A reporter's check runs on one commit.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCheckSuite {
    /// `cs_…`, or a g1t Actions workflow run's id (`run_…`).
    pub id: String,
    pub head_sha: String,
    pub head_branch: Option<String>,
    /// `queued`, `in_progress` or `completed`, from its latest check runs.
    pub status: String,
    pub conclusion: Option<String>,
    pub app: CheckApp,
    /// For a g1t Actions run: its workflow's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub latest_check_runs_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunList {
    pub total_count: u32,
    pub check_runs: Vec<CommitCheckRun>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSuiteList {
    pub total_count: u32,
    pub check_suites: Vec<CommitCheckSuite>,
}

/// A commit's statuses, one per context, and the state they add up to.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedStatus {
    /// `failure` if any status failed or errored, else `pending` if any is
    /// pending or there are none, else `success`.
    pub state: String,
    pub sha: String,
    pub total_count: u32,
    pub statuses: Vec<CommitStatus>,
}

/// One check as a commit's list shows it: a check run or a status.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    /// `check_run` or `status`.
    pub kind: String,
    /// A check run's id.
    pub id: Option<String>,
    pub name: String,
    /// `success`, `failure`, `pending`, `neutral`, `skipped` or `cancelled`.
    pub state: String,
    /// What it says: a check run's title, or a status's description.
    pub description: Option<String>,
    /// The reporter's page for it.
    pub details_url: Option<String>,
    /// Its page on g1t: a check run's, or a job's run.
    pub url: Option<String>,
    /// Who reported it.
    pub app: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Every check on one commit, and what they add up to.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChecks {
    /// `success`, `failure`, `pending`, or `none` when nothing reported.
    pub state: String,
    pub total: u32,
    pub successful: u32,
    pub failed: u32,
    pub pending: u32,
    /// Neutral, skipped and cancelled: neither passed nor failed.
    pub skipped: u32,
    /// Failing first, then pending, then the rest, each by name.
    pub checks: Vec<CheckItem>,
}

// --- What states mean -----------------------------------------------------

/// A check run's state as one word: `pending` until completed, then its
/// conclusion's kind. Cancelled is counted with neutral and skipped, and
/// timed_out and action_required with failure.
pub fn run_state(status: &str, conclusion: Option<&str>) -> &'static str {
    if status != "completed" {
        return "pending";
    }
    match conclusion.unwrap_or("neutral") {
        "success" => "success",
        "neutral" => "neutral",
        "skipped" => "skipped",
        "cancelled" => "cancelled",
        _ => "failure",
    }
}

/// The status a check run stands as, for required checks: pending until
/// completed; success when it passed, was neutral or skipped; failure
/// otherwise, a cancelled one included.
pub fn status_state_of(status: &str, conclusion: Option<&str>) -> &'static str {
    if status != "completed" {
        return "pending";
    }
    match conclusion.unwrap_or("neutral") {
        "success" | "neutral" | "skipped" => "success",
        _ => "failure",
    }
}

/// A status's state as one word: `error` is a failure.
pub fn status_item_state(state: &str) -> &'static str {
    match state {
        "success" => "success",
        "pending" => "pending",
        _ => "failure",
    }
}

/// The state a commit's statuses add up to, as GitHub's combined status.
pub fn combined_state(statuses: &[CommitStatus]) -> &'static str {
    if statuses.iter().any(|status| matches!(status.state.as_str(), "failure" | "error")) {
        "failure"
    } else if statuses.is_empty() || statuses.iter().any(|status| status.state == "pending") {
        "pending"
    } else {
        "success"
    }
}

/// Where a suite stands from its latest check runs' `(status, conclusion)`:
/// in progress while any is not completed (queued while none started),
/// then the worst conclusion.
pub fn suite_state(runs: &[(String, Option<String>)]) -> (&'static str, Option<&'static str>) {
    if runs.is_empty() {
        return ("queued", None);
    }
    if runs.iter().any(|(status, _)| status != "completed") {
        let started = runs.iter().any(|(status, _)| status != "queued");
        return (if started { "in_progress" } else { "queued" }, None);
    }
    let has = |wanted: &str| runs.iter().any(|(_, conclusion)| conclusion.as_deref() == Some(wanted));
    let conclusion = if has("action_required") {
        "action_required"
    } else if has("failure") || has("timed_out") {
        "failure"
    } else if has("cancelled") {
        "cancelled"
    } else if has("success") {
        "success"
    } else if runs.iter().all(|(_, conclusion)| conclusion.as_deref() == Some("skipped")) {
        "skipped"
    } else {
        "neutral"
    };
    ("completed", Some(conclusion))
}

// --- g1t Actions jobs as check runs --------------------------------------

/// A job's annotation level as a check run's.
fn annotation_level(level: &str) -> &'static str {
    match level {
        "error" => "failure",
        "warning" => "warning",
        _ => "notice",
    }
}

/// A g1t Actions job as a check run of `repo` (`owner/name`), its workflow
/// run as the suite.
pub fn job_check_run(repo: &str, run: &WorkflowRun, job: &Job) -> CommitCheckRun {
    let status = match job.status.as_str() {
        "in_progress" => "in_progress",
        "completed" => "completed",
        _ => "queued",
    };
    let url = format!("/{repo}/actions/runs/{}?job={}", run.id, job.id);
    CommitCheckRun {
        id: job.id.clone(),
        name: job.name.clone(),
        head_sha: run.sha.clone(),
        status: status.to_owned(),
        conclusion: if status == "completed" { Some(job.conclusion.clone().unwrap_or_else(|| "neutral".to_owned())) } else { None },
        started_at: job.started_at.clone(),
        completed_at: if status == "completed" { job.finished_at.clone() } else { None },
        details_url: Some(url.clone()),
        external_id: None,
        html_url: url,
        output: CheckOutput {
            title: job.reason.clone(),
            summary: None,
            text: None,
            annotations_count: u32::try_from(job.annotations.len()).unwrap_or(u32::MAX),
        },
        actions: Vec::new(),
        check_suite: SuiteRef { id: run.id.clone() },
        app: CheckApp::actions(),
        workflow: Some(WorkflowRef { run_id: run.id.clone(), name: run.name.clone(), event: run.event.clone() }),
        created_at: run.created_at.clone(),
    }
}

/// A job's annotations as a check run's.
pub fn job_annotations(job: &Job) -> Vec<CheckAnnotation> {
    job.annotations
        .iter()
        .map(|note| CheckAnnotation {
            path: note.file.clone().unwrap_or_default(),
            start_line: note.line.unwrap_or(0),
            end_line: note.line.unwrap_or(0),
            start_column: None,
            end_column: None,
            annotation_level: annotation_level(&note.level).to_owned(),
            message: note.message.clone(),
            title: note.title.clone(),
            raw_details: None,
        })
        .collect()
}

/// A workflow run as a check suite.
pub fn run_check_suite(run: &WorkflowRun, jobs: &[Job]) -> CommitCheckSuite {
    let states: Vec<(String, Option<String>)> = jobs
        .iter()
        .map(|job| {
            let status = match job.status.as_str() {
                "in_progress" | "completed" => job.status.clone(),
                _ => "queued".to_owned(),
            };
            (status, job.conclusion.clone())
        })
        .collect();
    let (status, conclusion) = if jobs.is_empty() {
        let completed = run.status == "completed";
        (if completed { "completed" } else { "queued" }, run.conclusion.as_deref().filter(|_| completed).map(|c| match c {
            "success" => "success",
            "skipped" => "skipped",
            "cancelled" => "cancelled",
            _ => "failure",
        }))
    } else {
        suite_state(&states)
    };
    CommitCheckSuite {
        id: run.id.clone(),
        head_sha: run.sha.clone(),
        head_branch: run.git_ref.strip_prefix("refs/heads/").map(str::to_owned),
        status: status.to_owned(),
        conclusion: conclusion.map(str::to_owned),
        app: CheckApp::actions(),
        name: Some(run.name.clone()),
        latest_check_runs_count: u32::try_from(jobs.len()).unwrap_or(u32::MAX),
        created_at: run.created_at.clone(),
        updated_at: run.finished_at.clone().or_else(|| run.started_at.clone()).unwrap_or_else(|| run.created_at.clone()),
    }
}

/// Of a commit's workflow runs, newest first, the latest of each workflow
/// for each event: an earlier attempt is superseded by the one after it.
pub fn latest_runs<T>(runs: &[(WorkflowRun, T)]) -> Vec<&(WorkflowRun, T)> {
    let mut seen: Vec<(&str, &str, &str)> = Vec::new();
    let mut out = Vec::new();
    for entry in runs {
        let key = (entry.0.sha.as_str(), entry.0.path.as_str(), entry.0.event.as_str());
        if !seen.contains(&key) {
            seen.push(key);
            out.push(entry);
        }
    }
    out
}

// --- A commit's checks, added up -----------------------------------------

/// Every check on one commit, as its list shows them: each check run, and
/// each status that is not one of them standing in as a status (its
/// `check_run_id`) nor a workflow's whose jobs are listed (its context
/// `Workflow / event` among `job_contexts`).
pub fn summarize(check_runs: &[CommitCheckRun], statuses: &[CommitStatus], job_contexts: &[String]) -> CommitChecks {
    let mut checks: Vec<CheckItem> = Vec::new();
    for run in check_runs {
        checks.push(CheckItem {
            kind: "check_run".to_owned(),
            id: Some(run.id.clone()),
            name: run.display_name(),
            state: run_state(&run.status, run.conclusion.as_deref()).to_owned(),
            description: run.output.title.clone().or_else(|| run.output.summary.as_deref().map(first_line)),
            details_url: run.details_url.clone(),
            url: Some(run.html_url.clone()),
            app: Some(run.app.name.clone()),
            started_at: run.started_at.clone(),
            completed_at: run.completed_at.clone(),
        });
    }
    for status in statuses {
        if status.check_run_id.is_some() || job_contexts.contains(&status.context) {
            continue;
        }
        checks.push(CheckItem {
            kind: "status".to_owned(),
            id: None,
            name: status.context.clone(),
            state: status_item_state(&status.state).to_owned(),
            description: status.description.clone(),
            details_url: status.target_url.clone(),
            url: None,
            app: status.source.clone(),
            started_at: None,
            completed_at: Some(status.updated_at.clone()),
        });
    }
    let rank = |state: &str| match state {
        "failure" => 0,
        "pending" => 1,
        "success" => 2,
        _ => 3,
    };
    checks.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let count = |wanted: &[&str]| u32::try_from(checks.iter().filter(|check| wanted.contains(&check.state.as_str())).count()).unwrap_or(u32::MAX);
    let failed = count(&["failure"]);
    let pending = count(&["pending"]);
    let state = if checks.is_empty() {
        "none"
    } else if failed > 0 {
        "failure"
    } else if pending > 0 {
        "pending"
    } else {
        "success"
    };
    CommitChecks {
        state: state.to_owned(),
        total: u32::try_from(checks.len()).unwrap_or(u32::MAX),
        successful: count(&["success"]),
        failed,
        pending,
        skipped: count(&["neutral", "skipped", "cancelled"]),
        checks,
    }
}

fn first_line(text: &str) -> String {
    text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim().chars().take(MAX_TITLE_CHARS).collect()
}

// --- Validating what a reporter sends ------------------------------------

/// Whether `text` is a full commit id: 40 hex digits (or 64, for SHA-256).
pub fn is_full_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// What a reporter sends to create or change a check run. On a change,
/// fields left out stay as they are.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub details_url: Option<String>,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub output: Option<OutputInput>,
    /// Replaces its buttons when given.
    #[serde(default)]
    pub actions: Option<Vec<CheckAction>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    /// Added to those it has, at most [`MAX_ANNOTATIONS_PER_REQUEST`].
    #[serde(default)]
    pub annotations: Vec<CheckAnnotation>,
}

fn too_long(text: Option<&str>, max: usize) -> bool {
    text.is_some_and(|text| text.chars().count() > max)
}

fn valid_url(url: Option<&str>) -> bool {
    url.is_none_or(|url| url.is_empty() || url.starts_with("https://") || url.starts_with("http://"))
}

/// Why `input` cannot be used, if it cannot. `creating` asks for a name and
/// a head commit.
pub fn validate_run(input: &CheckRunInput, creating: bool) -> Result<(), String> {
    if creating {
        if input.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
            return Err("`name` is required.".to_owned());
        }
        if input.head_sha.as_deref().is_none_or(|sha| sha.trim().is_empty()) {
            return Err("`head_sha` is required: the commit the check is about.".to_owned());
        }
    }
    if input.name.as_deref().is_some_and(|name| name.trim().is_empty() || name.trim().chars().count() > MAX_NAME_CHARS) {
        return Err(format!("`name` is 1 to {MAX_NAME_CHARS} characters."));
    }
    if let Some(status) = input.status.as_deref()
        && !STATUSES.contains(&status)
    {
        return Err("`status` is queued, in_progress or completed.".to_owned());
    }
    if let Some(conclusion) = input.conclusion.as_deref()
        && !CONCLUSIONS.contains(&conclusion)
    {
        return Err(format!("`conclusion` is one of {}.", CONCLUSIONS.join(", ")));
    }
    if input.status.as_deref() == Some("completed") && input.conclusion.is_none() && creating {
        return Err("A completed check run needs a `conclusion`.".to_owned());
    }
    if input.conclusion.is_some() && input.status.as_deref().is_some_and(|status| status != "completed") {
        return Err("A check run with a `conclusion` is completed: leave `status` out or set it to completed.".to_owned());
    }
    if !valid_url(input.details_url.as_deref()) {
        return Err("`details_url` is an http or https address.".to_owned());
    }
    if too_long(input.external_id.as_deref(), MAX_TITLE_CHARS) {
        return Err(format!("`external_id` is at most {MAX_TITLE_CHARS} characters."));
    }
    if let Some(output) = &input.output {
        if too_long(output.title.as_deref(), MAX_TITLE_CHARS) {
            return Err(format!("`output.title` is at most {MAX_TITLE_CHARS} characters."));
        }
        if too_long(output.summary.as_deref(), MAX_OUTPUT_CHARS) || too_long(output.text.as_deref(), MAX_OUTPUT_CHARS) {
            return Err(format!("`output.summary` and `output.text` are at most {MAX_OUTPUT_CHARS} characters each."));
        }
        if output.annotations.len() > MAX_ANNOTATIONS_PER_REQUEST {
            return Err(format!("At most {MAX_ANNOTATIONS_PER_REQUEST} annotations at a time: send more with further updates."));
        }
        for annotation in &output.annotations {
            validate_annotation(annotation)?;
        }
    }
    if let Some(actions) = &input.actions {
        if actions.len() > MAX_ACTIONS {
            return Err(format!("At most {MAX_ACTIONS} actions."));
        }
        for action in actions {
            if action.label.trim().is_empty() || action.label.chars().count() > MAX_ACTION_LABEL {
                return Err(format!("An action's `label` is 1 to {MAX_ACTION_LABEL} characters."));
            }
            if action.description.chars().count() > MAX_ACTION_DESCRIPTION {
                return Err(format!("An action's `description` is at most {MAX_ACTION_DESCRIPTION} characters."));
            }
            if action.identifier.trim().is_empty() || action.identifier.chars().count() > MAX_ACTION_IDENTIFIER {
                return Err(format!("An action's `identifier` is 1 to {MAX_ACTION_IDENTIFIER} characters."));
            }
        }
    }
    Ok(())
}

fn validate_annotation(annotation: &CheckAnnotation) -> Result<(), String> {
    if annotation.path.trim().is_empty() {
        return Err("Each annotation needs a `path`.".to_owned());
    }
    if annotation.start_line == 0 || annotation.end_line < annotation.start_line {
        return Err("An annotation's `start_line` is from 1, and its `end_line` no less.".to_owned());
    }
    if !ANNOTATION_LEVELS.contains(&annotation.annotation_level.as_str()) {
        return Err("An annotation's `annotation_level` is notice, warning or failure.".to_owned());
    }
    if annotation.message.trim().is_empty() || annotation.message.chars().count() > MAX_OUTPUT_CHARS {
        return Err("Each annotation needs a `message`.".to_owned());
    }
    if annotation.start_column.is_some() && annotation.start_line != annotation.end_line {
        return Err("Columns are for an annotation on one line: start_line and end_line the same.".to_owned());
    }
    Ok(())
}

/// Why a status cannot be set, if it cannot.
pub fn validate_status(state: &str, context: &str, description: Option<&str>, target_url: Option<&str>) -> Result<(), String> {
    if !STATUS_STATES.contains(&state) {
        return Err("`state` is pending, success, failure or error.".to_owned());
    }
    if context.trim().is_empty() || context.chars().count() > MAX_NAME_CHARS {
        return Err(format!("`context` is 1 to {MAX_NAME_CHARS} characters."));
    }
    if too_long(description, MAX_DESCRIPTION_CHARS) {
        return Err(format!("`description` is at most {MAX_DESCRIPTION_CHARS} characters."));
    }
    if !valid_url(target_url) {
        return Err("`target_url` is an http or https address.".to_owned());
    }
    Ok(())
}

// --- Methods ---------------------------------------------------------------

/// `create_commit_status`: sets a status on a commit, as `actor` (the
/// Write role). Publishes `status.created`. Returns `Outcome<CommitStatus>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStatusArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub sha: String,
    pub state: String,
    /// `default` when left out.
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_url: Option<String>,
}

/// `commit_statuses` (a list of `CommitStatus`, newest first) and
/// `combined_status` (`CombinedStatus`): a commit's statuses, by a branch,
/// tag or commit.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(rename = "ref")]
    pub git_ref: String,
}

/// `create_check_run`: as `actor` (the Write role), reporting as `app`
/// (see [`CheckApp::of`]). Publishes `check_run.created`, and
/// `check_run.completed` when it is created completed. Returns
/// `Outcome<CommitCheckRun>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCheckRunArgs {
    pub actor: User,
    pub repo: RepoPath,
    #[serde(default)]
    pub app: Option<String>,
    pub run: CheckRunInput,
}

/// `update_check_run`: changes a check run reported through the API.
/// Returns `Outcome<CommitCheckRun>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckRunArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub run: CheckRunInput,
}

/// `get_check_run` (`Outcome<CommitCheckRun>`), `check_run_annotations`
/// (`Outcome<Vec<CheckAnnotation>>`) and `get_check_suite`
/// (`Outcome<CommitCheckSuite>`), by id.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIdArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub id: String,
}

/// `ref_check_runs`: a commit's check runs, by a branch, tag or commit,
/// filtered. Returns `Outcome<CheckRunList>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCheckRunsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(rename = "ref")]
    pub git_ref: String,
    #[serde(default)]
    pub check_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// An app's slug, such as `actions`.
    #[serde(default)]
    pub app: Option<String>,
    /// `latest` (the default): the latest run of each name; `all`: every one.
    #[serde(default)]
    pub filter: Option<String>,
}

/// `ref_check_suites`: a commit's check suites. Returns
/// `Outcome<CheckSuiteList>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefCheckSuitesArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(rename = "ref")]
    pub git_ref: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub check_name: Option<String>,
}

/// `rerequest_check_run` and `rerequest_check_suite`: asks the reporter to
/// run it again (`check_run.rerequested`, `check_suite.rerequested`); a
/// g1t Actions job or run is run again. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerequestArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
}

/// `request_check_action`: someone pressed one of a check run's buttons.
/// Publishes `check_run.requested_action`. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestActionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub identifier: String,
}

/// `commit_checks`: every check on each of `shas` (at most
/// [`MAX_COMMITS`]), for showing them next to commits. Commits nothing
/// reported on are left out. Returns
/// `Outcome<BTreeMap<String, CommitChecks>>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChecksArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub shas: Vec<String>,
}

/// The actions service's `check_runs`: workflow runs with their jobs, by
/// commits, by a run's id, or by one of its jobs' ids, newest first. For
/// the work service only; it decides who may see them. Returns
/// `Vec<RunDetail>` (without notes).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsChecksArgs {
    pub repo_id: String,
    #[serde(default)]
    pub shas: Vec<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
}

/// What `check_run.*` events carry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunEvent {
    pub repo_id: String,
    pub check_run: CommitCheckRun,
    /// For `check_run.requested_action`: the button's identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_action: Option<String>,
}

/// What `check_suite.*` events carry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSuiteEvent {
    pub repo_id: String,
    pub check_suite: CommitCheckSuite,
}

/// What `status.created` carries.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub repo_id: String,
    pub sha: String,
    pub context: String,
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::Annotation;

    fn status(context: &str, state: &str) -> CommitStatus {
        CommitStatus {
            context: context.into(),
            state: state.into(),
            description: None,
            target_url: None,
            updated_at: "2026-10-07T00:00:00Z".into(),
            source: None,
            check_run_id: None,
        }
    }

    fn run(name: &str, status: &str, conclusion: Option<&str>) -> CommitCheckRun {
        CommitCheckRun {
            id: format!("cr_{name}"),
            name: name.into(),
            head_sha: "a".repeat(40),
            status: status.into(),
            conclusion: conclusion.map(Into::into),
            html_url: format!("/acme/web/checks/cr_{name}"),
            app: CheckApp::named("Codecov"),
            ..CommitCheckRun::default()
        }
    }

    #[test]
    fn states_read_as_github_reads_them() {
        assert_eq!(run_state("queued", None), "pending");
        assert_eq!(run_state("completed", Some("timed_out")), "failure");
        assert_eq!(run_state("completed", Some("cancelled")), "cancelled");
        assert_eq!(status_state_of("in_progress", None), "pending");
        assert_eq!(status_state_of("completed", Some("skipped")), "success");
        assert_eq!(status_state_of("completed", Some("cancelled")), "failure");
        assert_eq!(status_state_of("completed", Some("action_required")), "failure");
        assert_eq!(combined_state(&[]), "pending");
        assert_eq!(combined_state(&[status("a", "success"), status("b", "pending")]), "pending");
        assert_eq!(combined_state(&[status("a", "error"), status("b", "pending")]), "failure");
        assert_eq!(combined_state(&[status("a", "success")]), "success");
    }

    #[test]
    fn a_suite_is_its_worst_run() {
        let s = |status: &str, conclusion: Option<&str>| (status.to_owned(), conclusion.map(str::to_owned));
        assert_eq!(suite_state(&[s("queued", None), s("queued", None)]), ("queued", None));
        assert_eq!(suite_state(&[s("completed", Some("success")), s("in_progress", None)]), ("in_progress", None));
        assert_eq!(suite_state(&[s("completed", Some("success")), s("completed", Some("timed_out"))]), ("completed", Some("failure")));
        assert_eq!(suite_state(&[s("completed", Some("skipped")), s("completed", Some("skipped"))]), ("completed", Some("skipped")));
        assert_eq!(suite_state(&[s("completed", Some("skipped")), s("completed", Some("success"))]), ("completed", Some("success")));
        assert_eq!(suite_state(&[s("completed", Some("neutral"))]), ("completed", Some("neutral")));
    }

    #[test]
    fn a_commits_checks_add_up_without_counting_one_twice() {
        let runs = [run("lint", "completed", Some("failure")), run("coverage", "in_progress", None)];
        let mut projected = status("lint", "failure");
        projected.check_run_id = Some("cr_lint".into());
        let statuses = [projected, status("CI / push", "success"), status("deploy", "success")];
        let summary = summarize(&runs, &statuses, &["CI / push".to_owned()]);
        assert_eq!(summary.total, 3, "{summary:?}");
        assert_eq!(summary.state, "failure");
        assert_eq!((summary.failed, summary.pending, summary.successful), (1, 1, 1));
        let names: Vec<&str> = summary.checks.iter().map(|check| check.name.as_str()).collect();
        assert_eq!(names, ["lint", "coverage", "deploy"]);
        assert_eq!(summarize(&[], &[], &[]).state, "none");
        let passing = summarize(&[run("a", "completed", Some("success")), run("b", "completed", Some("skipped"))], &[], &[]);
        assert_eq!((passing.state.as_str(), passing.successful, passing.skipped), ("success", 1, 1));
    }

    #[test]
    fn a_job_is_a_check_run_of_its_workflow_run() {
        let workflow_run = WorkflowRun {
            id: "run_1".into(),
            workflow_id: "wf".into(),
            path: ".g1t/workflows/ci.yml".into(),
            name: "CI".into(),
            title: "t".into(),
            number: 3,
            attempt: 1,
            event: "push".into(),
            git_ref: "refs/heads/main".into(),
            sha: "b".repeat(40),
            pull: None,
            status: "in_progress".into(),
            conclusion: None,
            error: None,
            actor: None,
            created_at: "2026-10-07T00:00:00Z".into(),
            started_at: None,
            finished_at: None,
        };
        let job = Job {
            id: "job_1".into(),
            run_id: "run_1".into(),
            key: "test".into(),
            name: "Test".into(),
            needs: vec![],
            status: "completed".into(),
            conclusion: Some("success".into()),
            steps: vec![],
            annotations: vec![Annotation { level: "error".into(), message: "boom".into(), title: None, file: Some("src/a.rs".into()), line: Some(4) }],
            reason: None,
            started_at: Some("2026-10-07T00:00:01Z".into()),
            finished_at: Some("2026-10-07T00:00:26Z".into()),
            environment: None,
            self_hosted: false,
            runner: None,
        };
        let check = job_check_run("acme/web", &workflow_run, &job);
        assert_eq!(check.display_name(), "CI / Test (push)");
        assert_eq!(check.check_suite.id, "run_1");
        assert_eq!(check.html_url, "/acme/web/actions/runs/run_1?job=job_1");
        assert_eq!(check.output.annotations_count, 1);
        assert_eq!(job_annotations(&job)[0].annotation_level, "failure");
        let waiting = Job { status: "waiting".into(), conclusion: None, ..job.clone() };
        let suite = run_check_suite(&workflow_run, &[job, waiting]);
        assert_eq!((suite.status.as_str(), suite.head_branch.as_deref()), ("in_progress", Some("main")));
        assert_eq!(suite.name.as_deref(), Some("CI"));
    }

    #[test]
    fn only_the_latest_run_of_each_workflow_and_event_counts() {
        let base = WorkflowRun {
            id: "run_2".into(),
            workflow_id: "wf".into(),
            path: "ci.yml".into(),
            name: "CI".into(),
            title: String::new(),
            number: 2,
            attempt: 1,
            event: "push".into(),
            git_ref: String::new(),
            sha: "c".into(),
            pull: None,
            status: "completed".into(),
            conclusion: None,
            error: None,
            actor: None,
            created_at: String::new(),
            started_at: None,
            finished_at: None,
        };
        let older = WorkflowRun { id: "run_1".into(), ..base.clone() };
        let pull = WorkflowRun { id: "run_0".into(), event: "pull_request".into(), ..base.clone() };
        let runs = [(base, ()), (older, ()), (pull, ())];
        let ids: Vec<&str> = latest_runs(&runs).iter().map(|(run, _)| run.id.as_str()).collect();
        assert_eq!(ids, ["run_2", "run_0"]);
    }

    #[test]
    fn reporters_are_named_from_the_token() {
        let mut user = User { id: "u".into(), username: "ada".into(), ..User::default() };
        assert_eq!(CheckApp::of(&user, None).slug, "ada");
        assert_eq!(CheckApp::of(&user, Some(" Vercel Preview ")), CheckApp { slug: "vercel-preview".into(), name: "Vercel Preview".into() });
        user.token = Some(Box::new(crate::scopes::TokenAccess { name: Some("G1T_TOKEN for acme/web run 4".into()), ..Default::default() }));
        assert_eq!(CheckApp::of(&user, None), CheckApp::actions());
        user.token = Some(Box::new(crate::scopes::TokenAccess { name: Some("Buildkite".into()), ..Default::default() }));
        assert_eq!(CheckApp::of(&user, None).slug, "buildkite");
    }

    #[test]
    fn what_a_reporter_sends_is_checked() {
        let ok = CheckRunInput { name: Some("lint".into()), head_sha: Some("a".repeat(40)), ..Default::default() };
        assert!(validate_run(&ok, true).is_ok());
        assert!(validate_run(&CheckRunInput::default(), true).is_err());
        assert!(validate_run(&CheckRunInput::default(), false).is_ok());
        let completed = CheckRunInput { status: Some("completed".into()), ..ok.clone() };
        assert!(validate_run(&completed, true).unwrap_err().contains("conclusion"));
        let odd = CheckRunInput { conclusion: Some("passed".into()), ..ok.clone() };
        assert!(validate_run(&odd, true).is_err());
        let annotated = CheckRunInput {
            output: Some(OutputInput {
                title: Some("1 problem".into()),
                annotations: vec![CheckAnnotation { path: "a.rs".into(), start_line: 3, end_line: 2, annotation_level: "warning".into(), message: "x".into(), ..Default::default() }],
                ..Default::default()
            }),
            ..ok.clone()
        };
        assert!(validate_run(&annotated, true).unwrap_err().contains("end_line"));
        let buttons = CheckRunInput {
            actions: Some(vec![CheckAction { label: "Fix this".into(), description: "Let us fix it".into(), identifier: "fix".into() }; 4]),
            ..ok
        };
        assert!(validate_run(&buttons, true).is_err());
        assert!(validate_status("success", "ci/build", Some("Passed"), Some("https://ci.example.com/1")).is_ok());
        assert!(validate_status("passed", "ci", None, None).is_err());
        assert!(validate_status("success", "ci", None, Some("javascript:alert(1)")).is_err());
        assert!(is_full_sha(&"a".repeat(40)) && !is_full_sha("main"));
    }
}
