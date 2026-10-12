//! A run's life: made, its jobs waiting on the jobs they need, each job
//! skipped or expanded into its matrix and queued, started in a sandbox
//! when its workspace has room, reporting its steps and logs as it goes,
//! and finished; the run finishes with its last job.

use g1t_actions::events::{RunInfo, runner_context};
use g1t_actions::expr::{self, Scope, Status};
use g1t_actions::matrix;
use g1t_actions::workflow::{self, Workflow};
use g1t_contracts::access::Capability;
use g1t_contracts::actions::{JobCallArgs, RunActionArgs, RunApproval, StartJobArgs, WorkflowRun};
use g1t_contracts::identity::{CreateJobTokenArgs, CreatedAccessToken, RevokeJobTokensArgs};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use g1t_secrets::{random_hex, same, sha256_hex};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::broker::{self, Broker};
use crate::protection::Gate;
use crate::sync::WorkflowRow;
use crate::{Actions, Count, MAX_TIMEOUT_MINUTES, RUNNING_PER_WORKSPACE, SELF_HOSTED_MAX_TIMEOUT_MINUTES, SILENT_MS, SITE, check, fail, optional, repo_path};
use g1t_contracts::runners::{Wanted, waiting_reason};

/// The most log one job keeps, in bytes; past it, the log says so and stops.
const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;
/// The most a single log report may add.
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_ANNOTATIONS: usize = 50;
/// Swaps a running job's token for a new one, only while it still has the
/// one the caller showed (`job_spec` with `rotate`), keeping the hash of
/// the one it started with for `brokered_secrets` (migration 0020).
const TOKEN_ROTATE: &str = "UPDATE jobs SET first_token_hash = COALESCE(first_token_hash, token_hash), token_hash = ?1
     WHERE id = ?2 AND status = 'in_progress' AND token_hash = ?3 RETURNING id";

/// Whether `token` is a running job's: its current one, or with `started`
/// (`brokered_secrets` only) the one it started with before its harness
/// swapped it.
fn token_opens(current: Option<&str>, first: Option<&str>, token: &str, started: bool) -> bool {
    let hash = sha256_hex(token);
    current.is_some_and(|h| same(h, &hash)) || (started && first.is_some_and(|h| same(h, &hash)))
}
/// A batch of a job's log, under the next `seq` of that job's, worked out
/// in the same statement (SQLite runs one write at a time). `?4` is the
/// runner's number for the batch (null from runners that send none): a
/// batch sent again, after an answer the runner did not hear, has the
/// number of one already kept, and is not kept twice (migration 0016).
pub(crate) const LOG_INSERT: &str = "INSERT INTO logs (job_id, seq, step, text, chunk)
     SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4 FROM logs WHERE job_id = ?1
     ON CONFLICT (job_id, chunk) DO NOTHING";
/// The most one step's job summary keeps, in bytes, and how many steps of a
/// job may have one, as on GitHub.
pub(crate) const MAX_SUMMARY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_SUMMARIES: u32 = 20;

/// Whether a step's summary of `adding` bytes is kept: a job keeps up to
/// 20 steps' summaries (`steps` it has, `mine` this step's bytes so far)
/// of up to 1 MiB each.
pub(crate) fn summary_fits(steps: u32, mine: Option<usize>, adding: usize) -> bool {
    if adding == 0 {
        return false;
    }
    match mine {
        Some(used) => used + adding <= MAX_SUMMARY_BYTES,
        None => steps < MAX_SUMMARIES && adding <= MAX_SUMMARY_BYTES,
    }
}

/// The repository whose unfinished runs `event` stops, by id: one deleted,
/// or archived (not unarchived).
pub fn stops_runs(event: &g1t_contracts::events::Event) -> Option<String> {
    let stops = match event.kind.as_str() {
        "repo.deleted" => true,
        "repo.archived" => event.data["archived"].as_bool() != Some(false),
        _ => false,
    };
    if !stops {
        return None;
    }
    event.repo_id.clone().or_else(|| event.data["repoId"].as_str().map(str::to_owned))
}

pub struct NewRun {
    pub repo: Repo,
    pub path: String,
    pub source: String,
    pub workflow: Workflow,
    pub info: RunInfo,
    pub action: Option<String>,
    pub pull: Option<u32>,
    pub title: String,
    pub inputs: Map<String, Value>,
    pub event_key: String,
    pub actor_id: Option<String>,
    pub actor: Option<String>,
    pub trusted: bool,
    /// Why the run waits for someone with the Write role to approve it
    /// before anything starts: a pull request from outside (protection.rs).
    pub approval: Option<String>,
    /// The commit the run is listed, and its statuses and checks reported,
    /// on when it is not the one it builds (`info.sha`): a pull request's
    /// head, when the run builds its test merge commit, as on GitHub.
    pub head_sha: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct RunRow {
    pub id: String,
    pub workflow_id: String,
    pub repo_id: String,
    pub repo: String,
    pub path: String,
    pub name: String,
    pub title: String,
    pub number: u64,
    pub attempt: u64,
    pub event: String,
    pub action: Option<String>,
    pub git_ref: String,
    pub sha: String,
    pub pull: Option<u32>,
    pub status: String,
    pub conclusion: Option<String>,
    pub error: Option<String>,
    pub actor: Option<String>,
    pub actor_id: Option<String>,
    pub source: String,
    pub info: String,
    pub inputs: String,
    pub trusted: u32,
    pub concurrency_group: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// JSON `RunApproval`, for a run that needed approval (migration 0006).
    #[serde(default)]
    pub approval: Option<String>,
    /// Whether its concurrency group cancels what it replaces.
    #[serde(default)]
    pub cancel_in_progress: u32,
    /// Who started the current attempt, once it is re-run (migration 0009).
    #[serde(default)]
    pub triggering_actor: Option<String>,
    /// The current attempt runs with debug logging.
    #[serde(default)]
    pub debug: u32,
}

impl RunRow {
    pub fn approval(&self) -> Option<RunApproval> {
        self.approval.as_deref().and_then(|text| serde_json::from_str(text).ok())
    }

    pub fn info(&self) -> RunInfo {
        let mut info: RunInfo = serde_json::from_str(&self.info).unwrap_or_default();
        info.run_id = self.id.clone();
        info.run_number = self.number;
        info.run_attempt = self.attempt;
        info.workflow_path = self.path.clone();
        if info.workflow.is_empty() {
            info.workflow = self.name.clone();
        }
        info
    }

    pub fn inputs(&self) -> Map<String, Value> {
        serde_json::from_str(&self.inputs).unwrap_or_default()
    }

    pub fn summary(&self) -> WorkflowRun {
        WorkflowRun {
            id: self.id.clone(),
            workflow_id: self.workflow_id.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            title: self.title.clone(),
            number: self.number,
            attempt: self.attempt,
            event: self.event.clone(),
            git_ref: self.git_ref.clone(),
            sha: self.sha.clone(),
            pull: self.pull,
            status: self.status.clone(),
            conclusion: self.conclusion.clone(),
            error: self.error.clone(),
            actor: self.actor.clone(),
            created_at: self.created_at.clone(),
            started_at: self.started_at.clone(),
            finished_at: self.finished_at.clone(),
        }
    }
}

#[derive(Clone, Deserialize)]
pub struct JobRow {
    pub id: String,
    pub run_id: String,
    pub repo_id: String,
    pub namespace: String,
    pub key: String,
    pub ordinal: u32,
    pub name: String,
    pub needs: String,
    pub matrix: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    pub steps: String,
    pub annotations: String,
    pub outputs: String,
    pub reason: Option<String>,
    pub token_hash: Option<String>,
    pub timeout_minutes: u32,
    pub continue_on_error: u32,
    pub max_parallel: Option<u32>,
    /// Set for a job that calls a reusable workflow, and for that
    /// workflow's jobs (see migration 0002).
    pub call: Option<String>,
    pub seen_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// For a job whose `runs-on` names self-hosted runners: what it asks
    /// for, as a JSON array (see `g1t_contracts::runners::Wanted`), when it
    /// started waiting, and the runner that took it (migration 0004).
    #[serde(default)]
    pub labels: Option<String>,
    #[serde(default)]
    pub queued_at: Option<String>,
    #[serde(default)]
    pub runner_id: Option<String>,
    #[serde(default)]
    pub runner_name: Option<String>,
    /// The environment it names, read when its needs were done; a job its
    /// rules hold is `pending` (migration 0006).
    #[serde(default)]
    pub environment: Option<String>,
    /// Its own `concurrency` group, and whether that cancels what it replaces.
    #[serde(default)]
    pub concurrency_group: Option<String>,
    #[serde(default)]
    pub cancel_in_progress: u32,
    /// When it was told to stop, while it runs its cleanup steps
    /// (migration 0009).
    #[serde(default)]
    pub cancel_requested_at: Option<String>,
    /// Whether it was given stand-ins for brokered secrets (migration
    /// 0019), so its log is masked for their values too.
    #[serde(default)]
    pub brokered: u32,
    /// The hash of the token it started with, once its harness swapped that
    /// for another (migration 0020): good for `brokered_secrets` only.
    #[serde(default)]
    pub first_token_hash: Option<String>,
}

/// How long a cancelled job has to run its `if: always()` and `cancelled()`
/// steps and its post steps before it is stopped outright, as on GitHub.
pub const CANCEL_GRACE_MS: u64 = 5 * 60 * 1000;

/// Which jobs a re-run runs again.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rerun<'a> {
    All,
    /// Those that did not succeed.
    Failed,
    /// One job's key.
    Job(&'a str),
}

/// The keys a re-run runs again, in `order`: those `which` names and,
/// transitively, every key that needs one of them. `needs` gives a key's
/// needs; `succeeded` whether every job of a key succeeded.
pub fn rerun_keys(order: &[&str], needs: impl Fn(&str) -> Vec<String>, succeeded: impl Fn(&str) -> bool, which: Rerun) -> Vec<String> {
    let mut again: Vec<String> = Vec::new();
    for key in order {
        let named = match which {
            Rerun::All => true,
            Rerun::Failed => !succeeded(key),
            Rerun::Job(job) => *key == job,
        };
        if named || needs(key).iter().any(|need| again.contains(need)) {
            again.push((*key).to_owned());
        }
    }
    again
}

/// The key under `jobs:` a job belongs to: a called workflow's jobs
/// (`build/test`, or `build[1]/test` for a matrix's second call) run again
/// with the job that calls it (`build`).
pub fn top_key(key: &str) -> &str {
    let first = key.split('/').next().unwrap_or(key);
    first.split('[').next().unwrap_or(first)
}

/// What the keys of the jobs a caller's call makes start with: the
/// caller's key, and for a matrix the combination's index after it
/// (`build[1]`), so each combination's call has jobs of its own. A job id
/// has no `[`, so the two never meet.
fn call_prefix(key: &str, index: Option<usize>) -> String {
    match index {
        Some(index) => format!("{key}[{index}]"),
        None => key.to_owned(),
    }
}

/// Whether a run may call one more reusable workflow, `file`, `depth`
/// levels below the workflow it started from, having called `called`
/// already (one name per call; repeats are one workflow). As on GitHub: ten
/// levels of workflows at most, the top one and nine reusable ones below
/// it, and 50 different reusable workflows in a run.
fn call_allowed(depth: u64, called: &[&str], file: &str) -> std::result::Result<(), String> {
    if depth > MAX_CALL_DEPTH {
        return Err(format!(
            "`{file}` would be the {}th level of workflows: a run connects at most ten, the workflow it started from and nine levels of reusable workflows below it.",
            depth + 1
        ));
    }
    let mut unique: Vec<&str> = called.to_vec();
    unique.push(file);
    unique.sort_unstable();
    unique.dedup();
    if unique.len() > MAX_CALLED_WORKFLOWS {
        return Err(format!("Calling `{file}` would make {} reusable workflows in this run: a run calls at most {MAX_CALLED_WORKFLOWS} different ones.", unique.len()));
    }
    Ok(())
}

/// What a job is shown as: its `name` (else its id), under the job whose
/// call made it (`caller`), read with its matrix when it has an
/// expression, else with the matrix's values after it.
fn shown_name(job: &workflow::Job, caller: Option<&str>, combination: &Map<String, Value>, scope: &Scope) -> String {
    let base = job.name.clone().unwrap_or(job.id.clone());
    let base = match caller {
        Some(caller) => format!("{caller} / {base}"),
        None => base,
    };
    if expr::has_expression(&base) {
        expr::interpolate(&base, scope).unwrap_or(base)
    } else if job.matrix.is_some() {
        matrix::job_name(&base, combination)
    } else {
        base
    }
}

/// Debug logging for a job, as a re-run with it turned on gives GitHub's:
/// `RUNNER_DEBUG=1` and `runner.debug`, and `ACTIONS_STEP_DEBUG` and
/// `ACTIONS_RUNNER_DEBUG` set, which the runner reads as the secrets of
/// those names (`::debug::` lines shown, and how each step's `if` read).
pub fn debug_logging(variables: &mut Map<String, Value>, runner: &mut Value) {
    variables.insert("RUNNER_DEBUG".into(), json!("1"));
    variables.insert("ACTIONS_STEP_DEBUG".into(), json!("true"));
    variables.insert("ACTIONS_RUNNER_DEBUG".into(), json!("true"));
    runner["debug"] = json!("1");
}

impl JobRow {
    pub fn needs(&self) -> Vec<String> {
        serde_json::from_str(&self.needs).unwrap_or_default()
    }

    pub fn call(&self) -> Option<Value> {
        self.call.as_deref().and_then(|call| serde_json::from_str(call).ok())
    }

    /// For a job that calls a reusable workflow: what the keys of the jobs
    /// its call makes start with (`call_prefix`).
    pub fn call_prefix(&self) -> Option<String> {
        let call = self.call().filter(|call| call["role"] == "caller")?;
        Some(call["prefix"].as_str().unwrap_or(&self.key).to_owned())
    }

    /// A job that calls a reusable workflow and has not called it yet: it
    /// waits for room under its matrix's `max-parallel`, or in its
    /// concurrency group.
    pub fn holds_call(&self) -> bool {
        self.status == "waiting" && self.call_prefix().is_some()
    }

    /// For a job of a called workflow: that workflow, the job's own id in
    /// it, and the job.
    pub fn callee(&self) -> Option<(Workflow, workflow::Job, Value)> {
        let call = self.call().filter(|call| call["role"] == "callee")?;
        let called = workflow::parse(call["source"].as_str()?).ok()?;
        let job = called.jobs.iter().find(|job| call["job"].as_str() == Some(job.id.as_str()))?.clone();
        Some((called, job, call))
    }
}

/// A job to decide on: its key, its definition, and what it needs, as
/// (name in `needs`, key of the jobs).
type Unit = (String, workflow::Job, Vec<(String, String)>);

/// How many levels of reusable workflows may sit below the workflow a run
/// started from, as on GitHub (ten levels of workflows in all).
const MAX_CALL_DEPTH: u64 = 9;
/// How many different reusable workflows a run may call, as on GitHub.
const MAX_CALLED_WORKFLOWS: usize = 50;

/// What the jobs of one key came to, for `needs.<key>`.
fn key_result(rows: &[&JobRow]) -> &'static str {
    let failed = |row: &&&JobRow| row.conclusion.as_deref() == Some("failure") && row.continue_on_error == 0;
    if rows.iter().any(|row| failed(&row)) {
        "failure"
    } else if rows.iter().any(|row| row.conclusion.as_deref() == Some("cancelled")) {
        "cancelled"
    } else if rows.iter().all(|row| row.conclusion.as_deref() == Some("skipped")) {
        "skipped"
    } else {
        "success"
    }
}

/// Whether any job before `key` failed: one it needs, or one those need,
/// however far back. A job after a skipped one still sees the failure
/// that skipped it, as GitHub's failure() does. `needs_of`: each key's
/// needs, as keys; `failed`: whether a key's jobs came to a failure.
fn ancestor_failed(needs_of: &std::collections::HashMap<&str, Vec<&str>>, key: &str, failed: impl Fn(&str) -> bool) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<&str> = needs_of.get(key).cloned().unwrap_or_default();
    while let Some(next) = stack.pop() {
        if !seen.insert(next) {
            continue;
        }
        if failed(next) {
            return true;
        }
        stack.extend(needs_of.get(next).into_iter().flatten().copied());
    }
    false
}

/// A job's `environment:`, as deployments read it: its name, the address in
/// `environment.url` once its expressions are filled in from the run, and
/// whether the job deploys to it. A job with `deployment: false` only reads
/// the environment's secrets and variables, and makes no deployment.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct JobEnvironment {
    pub(crate) name: String,
    pub(crate) url: Option<String>,
    pub(crate) deploys: bool,
}

/// The environment `environment:` names, as written in `raw` (a job), with
/// `contexts` to fill in expressions: null when it names none, or only
/// through an expression this cannot read before the job runs.
pub(crate) fn environment_of(raw: &Value, contexts: &Map<String, Value>) -> Option<JobEnvironment> {
    let scope = Scope { contexts, status: Status::Success, hash_files: None };
    let plain = |value: &Value| -> Option<String> {
        let text = match value {
            Value::String(text) if text.contains("${{") => expr::interpolate_value(value, &scope).ok().map(|v| expr::to_text(&v))?,
            Value::String(text) => text.clone(),
            _ => return None,
        };
        let text = text.trim().to_owned();
        (!text.is_empty()).then_some(text)
    };
    match raw.get("environment")? {
        name @ Value::String(_) => Some(JobEnvironment { name: plain(name)?, url: None, deploys: workflow::records_deployment(raw) }),
        Value::Object(env) => {
            let name = plain(env.get("name")?)?;
            let url = env
                .get("url")
                .and_then(plain)
                .filter(|url| url.starts_with("https://") || url.starts_with("http://"));
            Some(JobEnvironment { name, url, deploys: workflow::records_deployment(raw) })
        }
        _ => None,
    }
}

/// The contexts a job's `runs-on` and `environment` are read with before it
/// runs: the run's `github`, its inputs, and the job's matrix.
fn start_contexts(run: &RunRow, job: &JobRow, key: &str) -> Map<String, Value> {
    let mut contexts = Map::new();
    contexts.insert("github".into(), run.info().context(key, "", run.action.as_deref()));
    contexts.insert("inputs".into(), Value::Object(run.inputs()));
    contexts.insert("matrix".into(), job.matrix.as_deref().and_then(|m| serde_json::from_str(m).ok()).unwrap_or_else(|| json!({})));
    contexts
}

/// The job as its workflow (or the workflow it calls) defines it.
fn job_spec(run: &RunRow, job: &JobRow) -> Option<workflow::Job> {
    match job.callee() {
        Some((_, spec, _)) => Some(spec),
        None => workflow::parse(&run.source).ok().and_then(|w| w.jobs.into_iter().find(|j| j.id == job.key)),
    }
}

/// The environment a job deploys to, if it deploys: by the name read when
/// its needs were done (which may have needed their outputs), else as
/// its `environment:` reads now.
pub(crate) fn deploys_to(run: &RunRow, job: &JobRow) -> Option<JobEnvironment> {
    let spec = job_spec(run, job)?;
    let read = environment_of(&spec.raw, &start_contexts(run, job, &spec.id));
    let env = match (read, &job.environment) {
        (Some(env), Some(name)) => Some(JobEnvironment { name: name.clone(), ..env }),
        (Some(env), None) => Some(env),
        (None, Some(name)) => Some(JobEnvironment { name: name.clone(), url: None, deploys: workflow::records_deployment(&spec.raw) }),
        (None, None) => None,
    };
    env.filter(|env| env.deploys)
}

/// What the runner is told about a job it starts, from its workflow: the
/// environment it names plainly, and the machine its `runs-on` asks for
/// (`instance_for`; none for the standard one).
#[derive(Default)]
struct StartDetails {
    environment: Option<String>,
    instance: Option<String>,
}

fn start_details(run: &RunRow, job: &JobRow) -> StartDetails {
    let spec = match job.callee() {
        Some((_, spec, _)) => spec,
        None => match workflow::parse(&run.source).ok().and_then(|w| w.jobs.into_iter().find(|j| j.id == job.key)) {
            Some(spec) => spec,
            None => return StartDetails::default(),
        },
    };
    // As read when its needs were done, an expression's included.
    let environment = job.environment.clone();
    // `runs-on` as the job was queued with: its matrix and the run's
    // inputs. A label that needs more than those is the standard machine.
    let contexts = start_contexts(run, job, &spec.id);
    let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
    let labels: Vec<String> = match expr::interpolate_value(&spec.runs_on, &scope).unwrap_or(Value::Null) {
        Value::String(label) => vec![label],
        Value::Array(labels) => labels.iter().map(expr::to_text).collect(),
        Value::Object(given) => match given.get("labels") {
            Some(Value::Array(labels)) => labels.iter().map(expr::to_text).collect(),
            Some(label) => vec![expr::to_text(label)],
            None => Vec::new(),
        },
        _ => Vec::new(),
    };
    let instance = g1t_contracts::actions::instance_for(&labels);
    StartDetails {
        environment,
        instance: (instance != g1t_contracts::actions::STANDARD_INSTANCE).then(|| instance.label.to_owned()),
    }
}

fn now() -> String {
    rfc3339(now_ms())
}

/// How a finished run went for one environment, from the conclusions of
/// the jobs that deploy to it: failed if any failed, an error if any was
/// cancelled, else a success; nothing when none ran (all skipped).
pub(crate) fn deployment_outcome(conclusions: &[Option<String>]) -> Option<&'static str> {
    let ran: Vec<&str> = conclusions.iter().flatten().map(String::as_str).filter(|c| *c != "skipped").collect();
    if ran.is_empty() {
        return None;
    }
    if ran.iter().any(|c| *c == "failure" || *c == "timed_out") {
        return Some("failure");
    }
    if ran.contains(&"cancelled") {
        return Some("error");
    }
    Some("success")
}

impl Actions {
    pub async fn run_row(&self, id: &str) -> Result<Option<RunRow>> {
        self.db.prepare("SELECT * FROM runs WHERE id = ?").bind(&[id.into()])?.first::<RunRow>(None).await
    }

    pub async fn job_rows(&self, run_id: &str) -> Result<Vec<JobRow>> {
        self.db
            .prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid")
            .bind(&[run_id.into()])?
            .all()
            .await?
            .results::<JobRow>()
    }

    pub async fn run_summary(&self, id: &str) -> Result<Outcome<WorkflowRun>> {
        Ok(match self.run_row(id).await? {
            Some(row) => Outcome::Ok(row.summary()),
            None => fail(FailureCode::NotFound, "No such run."),
        })
    }

    /// The contexts every expression outside a job's steps may use.
    fn base_contexts(run: &RunRow, vars: &Map<String, Value>, job: &str) -> Map<String, Value> {
        let mut contexts = Map::new();
        contexts.insert("github".into(), run.info().context(job, "", run.action.as_deref()));
        contexts.insert("inputs".into(), Value::Object(run.inputs()));
        contexts.insert("vars".into(), Value::Object(vars.clone()));
        contexts.insert("needs".into(), json!({}));
        contexts.insert("runner".into(), runner_context());
        contexts
    }

    /// Whether `namespace` is a person's own workspace: usernames and
    /// workspaces share one namespace, so it is when someone has that
    /// username. Kept in the isolate for a few minutes, so a burst of
    /// runs asks identity once.
    async fn personal_namespace(&self, namespace: &str) -> Result<bool> {
        const KEEP_MS: u64 = 5 * 60 * 1000;
        thread_local! {
            static PERSONAL: std::cell::RefCell<std::collections::HashMap<String, (bool, u64)>> = Default::default();
        }
        let now = now_ms();
        let key = namespace.to_ascii_lowercase();
        if let Some(personal) = PERSONAL.with(|kept| kept.borrow().get(&key).filter(|(_, at)| now.saturating_sub(*at) < KEEP_MS).map(|(personal, _)| *personal)) {
            return Ok(personal);
        }
        let found: g1t_contracts::Viewer = g1t_kit::call(
            &self.identity,
            "user_by_username",
            &g1t_contracts::identity::UsernameArgs { username: key.clone() },
        )
        .await?;
        let personal = found.is_some_and(|user| user.username.eq_ignore_ascii_case(namespace));
        PERSONAL.with(|kept| {
            let mut kept = kept.borrow_mut();
            if kept.len() > 1000 {
                kept.clear();
            }
            kept.insert(key, (personal, now));
        });
        Ok(personal)
    }

    /// Makes a run and its jobs, and starts what can start. `None` when the
    /// event already started this workflow.
    pub async fn create_run(&self, new: NewRun) -> Result<Option<String>> {
        // Nothing starts on an archived repository. A deleted one is never
        // found to start anything on.
        if new.repo.archived() {
            return Ok(None);
        }
        let workflow_row = self.workflow_row(&new.repo, &new.path, &new.workflow.display_name(&new.path), &new.source).await?;
        let numbered = self
            .db
            .prepare("UPDATE workflows SET run_count = run_count + 1 WHERE id = ? RETURNING run_count AS n")
            .bind(&[workflow_row.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(1, |count| count.n);
        let id = new_id("run", now_ms());
        let mut info = new.info.clone();
        // A personal workspace's repositories are a `User`'s, as on GitHub.
        if self.personal_namespace(&new.repo.namespace).await? {
            crate::payload::owned_by_person(&mut info.event, &new.repo.namespace);
        }
        info.workflow = new.workflow.display_name(&new.path);
        info.workflow_path = new.path.clone();
        info.run_id = id.clone();
        info.run_number = u64::from(numbered);
        let vars = self
            .variables_for(&new.repo.id, &format!("{}/{}", new.repo.namespace, new.repo.name), None, new.trusted)
            .await?;

        // run-name and the concurrency group read github, inputs and vars.
        let mut contexts = Map::new();
        contexts.insert("github".into(), info.context("", "", new.action.as_deref()));
        contexts.insert("inputs".into(), Value::Object(new.inputs.clone()));
        contexts.insert("vars".into(), Value::Object(vars));
        let scope = Scope {
            contexts: &contexts,
            status: Status::Success,
            hash_files: None,
        };
        let title = new
            .workflow
            .run_name
            .as_deref()
            .and_then(|run_name| expr::interpolate(run_name, &scope).ok())
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(new.title.clone());
        let group = new.workflow.concurrency.as_ref().and_then(|c| expr::interpolate(&c.group, &scope).ok());
        let cancel_in_progress = new
            .workflow
            .concurrency
            .as_ref()
            .and_then(|c| expr::interpolate_value(&c.cancel_in_progress, &scope).ok())
            .is_some_and(|value| expr::truthy(&value));

        let approval = new.approval.as_ref().map(|reason| RunApproval { state: "required".into(), reason: reason.clone(), approved_by: None });
        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO runs (id, workflow_id, repo_id, repo, path, name, title, number, event, action, git_ref, sha,
                   pull, status, actor, actor_id, source, info, inputs, trusted, concurrency_group, event_key, created_at,
                   approval, cancel_in_progress)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(&[
                id.as_str().into(),
                workflow_row.id.as_str().into(),
                new.repo.id.as_str().into(),
                format!("{}/{}", new.repo.namespace, new.repo.name).into(),
                new.path.as_str().into(),
                info.workflow.as_str().into(),
                title.as_str().into(),
                numbered.into(),
                info.event_name.as_str().into(),
                optional(new.action.as_deref()),
                info.git_ref.as_str().into(),
                new.head_sha.as_deref().unwrap_or(&info.sha).into(),
                new.pull.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                if approval.is_some() { "action_required" } else { "queued" }.into(),
                optional(new.actor.as_deref()),
                optional(new.actor_id.as_deref()),
                new.source.as_str().into(),
                serde_json::to_string(&info)?.into(),
                serde_json::to_string(&new.inputs)?.into(),
                u32::from(new.trusted).into(),
                optional(group.as_deref()),
                new.event_key.as_str().into(),
                now().into(),
                approval.as_ref().map(serde_json::to_string).transpose()?.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                u32::from(cancel_in_progress).into(),
            ])?
            .first::<Value>(None)
            .await?;
        if inserted.is_none() {
            return Ok(None);
        }
        if let Some(run) = self.run_row(&id).await? {
            self.report_pending(&run).await?;
        }

        // Every job, waiting; each is expanded when the jobs it needs are done.
        let mut statements = Vec::new();
        for job in &new.workflow.jobs {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, needs, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')",
                    )
                    .bind(&[
                        new_id("job", now_ms()).into(),
                        id.as_str().into(),
                        new.repo.id.as_str().into(),
                        new.repo.namespace.as_str().into(),
                        job.id.as_str().into(),
                        job.name.clone().filter(|n| !expr::has_expression(n)).unwrap_or(job.id.clone()).into(),
                        serde_json::to_string(&job.needs)?.into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;

        // A pull request's run from outside waits to be approved; it joins
        // its concurrency group once it is (protection.rs, approve_run).
        if approval.is_some() {
            return Ok(Some(id));
        }
        if let Some(run) = self.run_row(&id).await? {
            self.enter_group(&run).await?;
        }
        Ok(Some(id))
    }

    /// A run about to start: one run at a time per concurrency group, as on
    /// GitHub. A newer run replaces one that waits in the group, and with
    /// `cancel-in-progress` the one that runs; otherwise it waits as
    /// `pending` for the one that runs. Then it moves along.
    pub(crate) async fn enter_group(&self, run: &RunRow) -> Result<()> {
        if let Some(group) = &run.concurrency_group {
            let cancel_in_progress = run.cancel_in_progress != 0;
            let others = self
                .db
                .prepare(
                    "SELECT * FROM runs WHERE repo_id = ? AND concurrency_group = ? AND id != ? AND status NOT IN ('completed', 'action_required') ORDER BY id",
                )
                .bind(&[run.repo_id.as_str().into(), group.as_str().into(), run.id.as_str().into()])?
                .all()
                .await?
                .results::<RunRow>()?;
            for other in &others {
                if cancel_in_progress || other.status == "pending" {
                    // A newer run replaces a waiting one, as on GitHub.
                    self.cancel_run(other, "A newer run in the same concurrency group replaced it.", false).await?;
                }
            }
            if !cancel_in_progress && others.iter().any(|other| other.status != "pending") {
                self.db
                    .prepare("UPDATE runs SET status = 'pending' WHERE id = ?")
                    .bind(&[run.id.as_str().into()])?
                    .run()
                    .await?;
                return Ok(());
            }
        }
        self.advance(&run.id).await
    }

    /// A run that could not start, such as for a workflow file that does not read.
    #[allow(clippy::too_many_arguments)]
    pub async fn record_failed_run(
        &self,
        row: &WorkflowRow,
        git_ref: &str,
        sha: &str,
        event_key: &str,
        actor_id: Option<&str>,
        actor: &str,
        problem: &str,
    ) -> Result<()> {
        let numbered = self
            .db
            .prepare("UPDATE workflows SET run_count = run_count + 1 WHERE id = ? RETURNING run_count AS n")
            .bind(&[row.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(1, |count| count.n);
        let at = now();
        self.db
            .prepare(
                "INSERT OR IGNORE INTO runs (id, workflow_id, repo_id, repo, path, name, title, number, event, git_ref, sha, status,
                   conclusion, error, actor, actor_id, source, info, event_key, created_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'push', ?, ?, 'completed', 'failure', ?, ?, ?, ?, '{}', ?, ?, ?)",
            )
            .bind(&[
                new_id("run", now_ms()).into(),
                row.id.as_str().into(),
                row.repo_id.as_str().into(),
                row.repo.as_str().into(),
                row.path.as_str().into(),
                row.path.as_str().into(),
                "Invalid workflow file".into(),
                numbered.into(),
                git_ref.into(),
                sha.into(),
                problem.into(),
                actor.into(),
                optional(actor_id),
                row.source.as_str().into(),
                event_key.into(),
                at.as_str().into(),
                at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Moves a run along: jobs whose needs are done are decided on, and
    /// jobs that can start are started.
    pub async fn advance(&self, run_id: &str) -> Result<()> {
        // Each pass may finish jobs (skipped ones), which may free others.
        for _ in 0..20 {
            let Some(run) = self.run_row(run_id).await? else { return Ok(()) };
            if matches!(run.status.as_str(), "completed" | "pending" | "action_required") {
                return Ok(());
            }
            let workflow = match workflow::parse(&run.source) {
                Ok(workflow) => workflow,
                Err(problem) => {
                    self.finish_run(&run, Some(&problem)).await?;
                    return Ok(());
                }
            };
            let jobs = self.job_rows(run_id).await?;
            let mut changed = false;
            // What to decide on: the workflow's jobs, and the jobs of the
            // workflows they call, each with its needs as (name, key).
            let mut units: Vec<Unit> = workflow
                .jobs
                .iter()
                .map(|job| (job.id.clone(), job.clone(), job.needs.iter().map(|n| (n.clone(), n.clone())).collect()))
                .collect();
            let mut seen = std::collections::HashSet::new();
            for row in &jobs {
                if !seen.insert(row.key.clone()) {
                    continue;
                }
                if let Some((_, job, call)) = row.callee() {
                    let parent = call["parent"].as_str().unwrap_or_default().to_owned();
                    let needs = job.needs.iter().map(|n| (n.clone(), format!("{parent}/{n}"))).collect();
                    units.push((row.key.clone(), job, needs));
                }
            }
            // Each key's needs, as keys, to look back through for failure().
            let needs_of: std::collections::HashMap<&str, Vec<&str>> =
                units.iter().map(|(key, _, needs)| (key.as_str(), needs.iter().map(|(_, need)| need.as_str()).collect())).collect();
            let key_failed = |key: &str| key_result(&jobs.iter().filter(|row| row.key == key).collect::<Vec<_>>()) == "failure";
            for (key, job, needs) in &units {
                let rows: Vec<&JobRow> = jobs.iter().filter(|row| &row.key == key).collect();
                if rows.is_empty() || !rows.iter().all(|row| row.status == "waiting" && !row.holds_call()) {
                    continue;
                }
                let needed: Vec<(&String, Vec<&JobRow>)> =
                    needs.iter().map(|(name, need)| (name, jobs.iter().filter(|row| &row.key == need).collect())).collect();
                if !needed.iter().all(|(_, rows)| rows.iter().all(|row| row.status == "completed")) {
                    continue;
                }
                let failed_before = ancestor_failed(&needs_of, key, key_failed);
                self.decide(&run, job, rows[0], &needed, failed_before).await?;
                changed = true;
            }
            // A job that called a workflow finishes with that workflow's jobs.
            for row in jobs.iter().filter(|row| row.status == "calling") {
                let prefix = row.call_prefix().unwrap_or(row.key.clone());
                let children: Vec<&JobRow> = jobs
                    .iter()
                    .filter(|child| child.call().is_some_and(|call| call["role"] == "callee" && call["parent"].as_str() == Some(prefix.as_str())))
                    .collect();
                if !children.is_empty() && children.iter().all(|child| child.status == "completed") {
                    self.finish_call(&run, row, &children).await?;
                    changed = true;
                }
            }
            // Calls that wait start while their matrix's `max-parallel` and
            // their concurrency group have room.
            let mut calling: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
            for row in jobs.iter().filter(|row| row.status == "calling") {
                *calling.entry(row.key.as_str()).or_default() += 1;
            }
            for row in jobs.iter().filter(|row| row.holds_call()) {
                let running = calling.get(row.key.as_str()).copied().unwrap_or(0);
                if row.max_parallel.is_some_and(|max| running >= max) || self.group_busy(row).await? {
                    continue;
                }
                if self.start_call(row).await? {
                    calling.insert(row.key.as_str(), running + 1);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        self.start_queued().await?;
        self.finish_if_done(run_id).await
    }

    /// Decides on one job whose needs are done: skip it, fail it, or expand
    /// it into its matrix and queue it. `failed_before`: whether any job
    /// before it failed, however far back (`ancestor_failed`).
    async fn decide(&self, run: &RunRow, job: &workflow::Job, row: &JobRow, needed: &[(&String, Vec<&JobRow>)], failed_before: bool) -> Result<()> {
        let vars = self.variables_for(&run.repo_id, &run.repo, None, run.trusted != 0).await?;
        let mut contexts = Self::base_contexts(run, &vars, &job.id);
        // A called workflow's jobs read the inputs they were called with.
        let call = row.call();
        // Shown under the job whose call made it, by that job's name.
        let caller = call.as_ref().filter(|c| c["role"] == "callee").and_then(|c| {
            c["title"].as_str().map(str::to_owned).or_else(|| c["parent"].as_str().map(|parent| parent.replace('/', " / ")))
        });
        if let Some(call) = call.as_ref().filter(|c| c["role"] == "callee") {
            contexts.insert("inputs".into(), call["inputs"].clone());
        }
        let mut needs = Map::new();
        let mut results = Vec::new();
        for (key, rows) in needed {
            let result = key_result(rows);
            let mut outputs = Map::new();
            for row in rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&row.outputs) {
                    outputs.extend(more);
                }
            }
            results.push(result);
            needs.insert((*key).clone(), json!({ "result": result, "outputs": outputs }));
        }
        // As on GitHub: a need that was skipped makes success() false but
        // not failure(); failure() is a failure anywhere before the job.
        let status = expr::job_status(results, failed_before, run.conclusion.as_deref() == Some("cancelled"));
        contexts.insert("needs".into(), Value::Object(needs));
        let scope = Scope {
            contexts: &contexts,
            status,
            hash_files: None,
        };
        let condition = job.condition.as_deref().unwrap_or_default();
        match expr::condition(condition, &scope) {
            Ok(true) => {}
            Ok(false) => return self.skip_job(row, None).await,
            Err(problem) => return self.fail_job(row, &format!("Its `if` does not read: {problem}")).await,
        }
        // Its matrix, which may come from a needed job's outputs.
        let combinations = match &job.matrix {
            None => vec![Map::new()],
            Some(matrix) => {
                let value = match expr::interpolate_value(matrix, &scope) {
                    Ok(value) => value,
                    Err(problem) => return self.fail_job(row, &format!("Its matrix does not read: {problem}")).await,
                };
                match matrix::expand(&value) {
                    Ok(combinations) if !combinations.is_empty() => combinations,
                    Ok(_) => return self.fail_job(row, "Its matrix makes no jobs.").await,
                    Err(problem) => return self.fail_job(row, &problem).await,
                }
            }
        };
        // A job that calls a reusable workflow calls it once for each.
        if let Some(uses) = &job.uses {
            return self.call_workflow(run, job, row, uses, &contexts, &combinations, caller.as_deref()).await;
        }
        let total = combinations.len();
        let raw = job.raw.as_object().cloned().unwrap_or_default();
        // Whether pull requests from forks may use self-hosted runners here,
        // asked once, and only for a run that is not trusted.
        let mut forks_allowed: Option<bool> = None;
        // Each concurrency group its jobs join, and whether it cancels.
        let mut groups: Vec<(String, bool)> = Vec::new();
        let mut statements = Vec::new();
        for (index, combination) in combinations.iter().enumerate() {
            let mut contexts = contexts.clone();
            contexts.insert("matrix".into(), Value::Object(combination.clone()));
            contexts.insert(
                "strategy".into(),
                json!({ "fail-fast": job.fail_fast, "job-index": index, "job-total": total, "max-parallel": job.max_parallel.unwrap_or(total as u32) }),
            );
            let scope = Scope {
                contexts: &contexts,
                status: Status::Success,
                hash_files: None,
            };
            let name = shown_name(job, caller.as_deref(), combination, &scope);
            let runs_on = expr::interpolate_value(&job.runs_on, &scope).unwrap_or(Value::Null);
            let labels = match &runs_on {
                Value::String(label) => vec![label.clone()],
                Value::Array(labels) => labels.iter().map(expr::to_text).collect(),
                Value::Object(spec) => spec.get("labels").map(|l| match l {
                    Value::Array(labels) => labels.iter().map(expr::to_text).collect(),
                    other => vec![expr::to_text(other)],
                }).unwrap_or_default(),
                _ => Vec::new(),
            };
            // `runs-on: self-hosted` (or a group): the workspace's own
            // machines, which may run any OS. Otherwise g1t's Linux sandboxes.
            let group = match &runs_on {
                Value::Object(spec) => spec.get("group").map(expr::to_text),
                _ => None,
            };
            let wanted = Wanted::of(&labels, group.as_deref());
            let mut reason = if wanted.self_hosted {
                None
            } else {
                labels
                    .iter()
                    .find(|label| {
                        let lower = label.to_ascii_lowercase();
                        lower.contains("windows") || lower.contains("macos")
                    })
                    .map(|label| {
                        let os = if label.to_ascii_lowercase().contains("windows") { "windows" } else { "macos" };
                        format!("`runs-on: {label}`: g1t's own runners are Linux. A self-hosted runner can run it: `runs-on: [self-hosted, {os}]`.")
                    })
            };
            // A pull request from a fork runs code anyone could write: never
            // on the workspace's machines unless it said they may.
            if wanted.self_hosted && run.trusted == 0 {
                let allowed = match forks_allowed {
                    Some(allowed) => allowed,
                    None => {
                        let allowed = self.effective_runner_settings(&row.namespace, Some(&run.repo_id)).await?.fork_pull_requests;
                        forks_allowed = Some(allowed);
                        allowed
                    }
                };
                if !allowed {
                    reason = Some(
                        "Pull requests from forks do not run on self-hosted runners here. An admin can allow it under Settings, Runners.".to_owned(),
                    );
                }
            }
            let max_minutes = if wanted.self_hosted { SELF_HOSTED_MAX_TIMEOUT_MINUTES } else { MAX_TIMEOUT_MINUTES };
            let timeout = raw
                .get("timeout-minutes")
                .and_then(|value| expr::interpolate_value(value, &scope).ok())
                .and_then(|value| value.as_f64().or_else(|| expr::to_text(&value).parse().ok()))
                .map_or(g1t_actions::workflow::DEFAULT_TIMEOUT_MINUTES.min(max_minutes), |minutes| (minutes.ceil() as u32).clamp(1, max_minutes));
            let continue_on_error = raw
                .get("continue-on-error")
                .and_then(|value| expr::interpolate_value(value, &scope).ok())
                .is_some_and(|value| expr::truthy(&value));
            let (mut status, mut conclusion, mut finished) = match &reason {
                Some(_) => ("completed", Some("failure"), Some(now())),
                None => ("queued", None, None),
            };
            // A self-hosted job waits, saying for what, until a runner takes it.
            let (labels_json, queued_at) = if wanted.self_hosted && reason.is_none() {
                reason = Some(waiting_reason(&wanted));
                (Some(serde_json::to_string(&wanted.stored())?), Some(now()))
            } else {
                (None, None)
            };
            // The environment it names, an expression read now, and what
            // that environment's protection rules say: it starts, waits as
            // `pending` (protection.rs), or may not deploy there.
            let environment = environment_of(&job.raw, &contexts).map(|env| env.name);
            if status == "queued"
                && let Some(name) = &environment
            {
                match self.gate(run, name).await? {
                    Gate::Open => {}
                    Gate::Held(why) => {
                        status = "pending";
                        reason = Some(why);
                    }
                    Gate::Refused(why) => {
                        (status, conclusion, finished) = ("completed", Some("failure"), Some(now()));
                        reason = Some(why);
                    }
                }
            }
            // Its own concurrency group.
            let job_group = job
                .concurrency
                .as_ref()
                .and_then(|c| expr::interpolate(&c.group, &scope).ok())
                .map(|group| group.trim().to_owned())
                .filter(|group| !group.is_empty());
            let job_cancel = job
                .concurrency
                .as_ref()
                .and_then(|c| expr::interpolate_value(&c.cancel_in_progress, &scope).ok())
                .is_some_and(|value| expr::truthy(&value));
            if status != "completed"
                && let Some(group) = &job_group
                && !groups.iter().any(|(known, _)| known == group)
            {
                groups.push((group.clone(), job_cancel));
            }
            let values: Vec<worker::wasm_bindgen::JsValue> = vec![
                name.into(),
                serde_json::to_string(combination)?.into(),
                status.into(),
                optional(conclusion),
                optional(reason.as_deref()),
                timeout.into(),
                u32::from(continue_on_error).into(),
                job.max_parallel.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                optional(finished.as_deref()),
                optional(labels_json.as_deref()),
                optional(queued_at.as_deref()),
                optional(environment.as_deref()),
                optional(job_group.as_deref()),
                u32::from(job_cancel).into(),
            ];
            if index == 0 {
                let mut bound = values;
                bound.push(row.id.as_str().into());
                statements.push(
                    self.db
                        .prepare(
                            "UPDATE jobs SET name = ?, matrix = ?, status = ?, conclusion = ?, reason = ?, timeout_minutes = ?,
                               continue_on_error = ?, max_parallel = ?, finished_at = ?, labels = ?, queued_at = ?, environment = ?,
                               concurrency_group = ?, cancel_in_progress = ? WHERE id = ?",
                        )
                        .bind(&bound)?,
                );
            } else {
                let mut bound: Vec<worker::wasm_bindgen::JsValue> = vec![
                    new_id("job", now_ms()).into(),
                    row.run_id.as_str().into(),
                    row.repo_id.as_str().into(),
                    row.namespace.as_str().into(),
                    row.key.as_str().into(),
                    (index as u32).into(),
                    row.needs.as_str().into(),
                    optional(row.call.as_deref()),
                ];
                bound.extend(values);
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO jobs (id, run_id, repo_id, namespace, key, ordinal, needs, call, name, matrix, status, conclusion, reason,
                               timeout_minutes, continue_on_error, max_parallel, finished_at, labels, queued_at, environment,
                               concurrency_group, cancel_in_progress)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(&bound)?,
                );
            }
        }
        self.db.batch(statements).await?;
        self.replace_in_groups(run, &row.key, &groups).await
    }

    /// A job queued in its own concurrency group: with `cancel-in-progress`
    /// it cancels the group's other jobs; otherwise it replaces any that
    /// are queued and not started, and waits for the one running
    /// (`start_queued` starts one of a group at a time). As on GitHub.
    async fn replace_in_groups(&self, run: &RunRow, key: &str, groups: &[(String, bool)]) -> Result<()> {
        if groups.is_empty() {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let mine: Vec<String> = self
            .db
            .prepare("SELECT id FROM jobs WHERE run_id = ? AND key = ?")
            .bind(&[run.id.as_str().into(), key.into()])?
            .all()
            .await?
            .results::<Id>()?
            .into_iter()
            .map(|row| row.id)
            .collect();
        let mut moved: Vec<String> = Vec::new();
        for (group, cancel) in groups {
            let others = self
                .db
                // A call that waits in the group, or calls, is in it too.
                .prepare("SELECT * FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status IN ('waiting', 'queued', 'pending', 'in_progress', 'calling')")
                .bind(&[run.repo_id.as_str().into(), group.as_str().into()])?
                .all()
                .await?
                .results::<JobRow>()?;
            for other in others.iter().filter(|other| !mine.contains(&other.id)) {
                if *cancel || matches!(other.status.as_str(), "queued" | "waiting") {
                    self.stop_job(other, "A newer job in the same concurrency group replaced it.").await?;
                    if !moved.contains(&other.run_id) {
                        moved.push(other.run_id.clone());
                    }
                }
            }
        }
        for other_run in moved.iter().filter(|id| **id != run.id) {
            Box::pin(self.advance(other_run)).await?;
        }
        Ok(())
    }

    /// A job that calls a reusable workflow, in the repository or another
    /// (reach.rs): once for each combination of its matrix, as on GitHub,
    /// each with the inputs and secrets it passes read with that
    /// combination's `matrix`. Each call waits (`holds_call`) until its
    /// matrix's `max-parallel` and its concurrency group have room, when
    /// `start_call` puts the workflow's jobs in the run under it.
    #[allow(clippy::too_many_arguments)]
    async fn call_workflow(
        &self,
        run: &RunRow,
        job: &workflow::Job,
        row: &JobRow,
        uses: &str,
        contexts: &Map<String, Value>,
        combinations: &[Map<String, Value>],
        caller: Option<&str>,
    ) -> Result<()> {
        let depth = row.call().and_then(|c| c["depth"].as_u64()).unwrap_or(0) + 1;
        if depth > MAX_CALL_DEPTH {
            return self.fail_job(row, &call_allowed(depth, &[], uses).unwrap_err()).await;
        }
        let (file, source, origin) = match self.called_workflow(run, row, uses).await? {
            Ok(found) => found,
            Err(why) => return self.fail_job(row, &why).await,
        };
        let jobs = self.job_rows(&run.id).await?;
        // Each call so far, by the workflow it called.
        let called_paths: Vec<String> = jobs
            .iter()
            .filter(|other| other.call_prefix().is_some())
            .filter_map(JobRow::call)
            .filter_map(|call| call["path"].as_str().map(str::to_owned))
            .collect();
        let called_already: Vec<&str> = called_paths.iter().map(String::as_str).collect();
        if let Err(why) = call_allowed(depth, &called_already, &file) {
            return self.fail_job(row, &why).await;
        }
        let called = match workflow::parse(&source) {
            Ok(called) => called,
            Err(problem) => return self.fail_job(row, &format!("`{file}` does not read: {problem}")).await,
        };
        let Some(trigger) = called.trigger("workflow_call") else {
            return self.fail_job(row, &format!("`{file}` cannot be called: it has no `on: workflow_call`.")).await;
        };
        // Secrets: none but the job's token unless `secrets:` passes them,
        // by name or with `inherit`; read when each job starts (job_spec).
        let outer = row.call().filter(|c| c["role"] == "callee").and_then(|c| c.get("secrets").cloned());
        let total = combinations.len();
        let mut groups: Vec<(String, bool)> = Vec::new();
        let mut statements = Vec::new();
        for (index, combination) in combinations.iter().enumerate() {
            let mut contexts = contexts.clone();
            contexts.insert("matrix".into(), Value::Object(combination.clone()));
            contexts.insert(
                "strategy".into(),
                json!({ "fail-fast": job.fail_fast, "job-index": index, "job-total": total, "max-parallel": job.max_parallel.unwrap_or(total as u32) }),
            );
            let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
            let name = shown_name(job, caller, combination, &scope);
            // Inputs: what `with:` passes, as the called workflow types them.
            let given = match job.raw.get("with") {
                Some(with) => match expr::interpolate_value(with, &scope) {
                    Ok(Value::Object(given)) => Ok(given),
                    Ok(_) => Ok(Map::new()),
                    Err(problem) => Err(format!("Its `with` does not read: {problem}")),
                },
                None => Ok(Map::new()),
            };
            let inputs = given.and_then(|given| crate::reach::call_inputs(&file, &trigger.inputs, &given));
            let secrets = crate::reach::secrets_plan(&job.raw, &contexts, outer.clone());
            let problem = match &inputs {
                Err(why) => Some(why.clone()),
                Ok(_) => crate::reach::missing_secrets(&called.raw, &secrets)
                    .first()
                    .map(|name| format!("`{file}` needs the secret `{name}`: pass it under `secrets:`, or use `secrets: inherit`."))
                    .or_else(|| {
                        crate::reach::undeclared_secrets(&called.raw, &secrets)
                            .first()
                            .map(|name| format!("Invalid secret: `{name}` is not defined in `{file}`."))
                    }),
            };
            // Its own concurrency group, which it holds while its workflow runs.
            let group = job
                .concurrency
                .as_ref()
                .and_then(|c| expr::interpolate(&c.group, &scope).ok())
                .map(|group| group.trim().to_owned())
                .filter(|group| !group.is_empty());
            let cancel = job
                .concurrency
                .as_ref()
                .and_then(|c| expr::interpolate_value(&c.cancel_in_progress, &scope).ok())
                .is_some_and(|value| expr::truthy(&value));
            if problem.is_none()
                && let Some(group) = &group
                && !groups.iter().any(|(known, _)| known == group)
            {
                groups.push((group.clone(), cancel));
            }
            let call = json!({
                "role": "caller", "path": file, "source": source, "origin": origin, "depth": depth,
                "prefix": call_prefix(&row.key, job.matrix.is_some().then_some(index)), "title": name,
                "inputs": inputs.unwrap_or_default(), "secrets": secrets, "fail_fast": job.fail_fast,
            });
            let (status, conclusion, finished) = match &problem {
                Some(_) => ("completed", Some("failure"), Some(now())),
                None => ("waiting", None, None),
            };
            let values: Vec<worker::wasm_bindgen::JsValue> = vec![
                name.as_str().into(),
                serde_json::to_string(combination)?.into(),
                status.into(),
                optional(conclusion),
                optional(problem.as_deref()),
                job.max_parallel.map(|max| max.max(1)).map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                optional(finished.as_deref()),
                optional(group.as_deref()),
                u32::from(cancel).into(),
                serde_json::to_string(&call)?.into(),
            ];
            if index == 0 {
                let mut bound = values;
                bound.push(row.id.as_str().into());
                statements.push(
                    self.db
                        .prepare(
                            "UPDATE jobs SET name = ?, matrix = ?, status = ?, conclusion = ?, reason = ?, max_parallel = ?, finished_at = ?,
                               concurrency_group = ?, cancel_in_progress = ?, call = ? WHERE id = ?",
                        )
                        .bind(&bound)?,
                );
            } else {
                let mut bound: Vec<worker::wasm_bindgen::JsValue> = vec![
                    new_id("job", now_ms()).into(),
                    row.run_id.as_str().into(),
                    row.repo_id.as_str().into(),
                    row.namespace.as_str().into(),
                    row.key.as_str().into(),
                    (index as u32).into(),
                    row.needs.as_str().into(),
                ];
                bound.extend(values);
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO jobs (id, run_id, repo_id, namespace, key, ordinal, needs, name, matrix, status, conclusion, reason,
                               max_parallel, finished_at, concurrency_group, cancel_in_progress, call)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(&bound)?,
                );
            }
        }
        self.db.batch(statements).await?;
        self.replace_in_groups(run, &row.key, &groups).await
    }

    /// Whether another job of `row`'s concurrency group runs, or calls a
    /// workflow, so that `row` waits for it.
    async fn group_busy(&self, row: &JobRow) -> Result<bool> {
        let Some(group) = &row.concurrency_group else { return Ok(false) };
        let busy = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status IN ('in_progress', 'calling') AND id != ?")
            .bind(&[row.repo_id.as_str().into(), group.as_str().into(), row.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n);
        Ok(busy > 0)
    }

    /// A call that waited (`holds_call`) is made: the called workflow's
    /// jobs join the run under it, named under its name and keyed under its
    /// prefix. False when it no longer waits.
    async fn start_call(&self, row: &JobRow) -> Result<bool> {
        let Some(call) = row.call() else { return Ok(false) };
        let Some(prefix) = row.call_prefix() else { return Ok(false) };
        let Some(called) = call["source"].as_str().and_then(|source| workflow::parse(source).ok()) else { return Ok(false) };
        let file = call["path"].as_str().unwrap_or_default();
        let started = self
            .db
            .prepare("UPDATE jobs SET status = 'calling', reason = ?, started_at = ? WHERE id = ? AND status = 'waiting' RETURNING id")
            .bind(&[format!("Calls `{file}`.").into(), now().into(), row.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if started.is_none() {
            return Ok(false);
        }
        let mut statements = Vec::new();
        for called_job in &called.jobs {
            let needs: Vec<String> = called_job.needs.iter().map(|n| format!("{prefix}/{n}")).collect();
            let callee = json!({
                "role": "callee", "parent": prefix, "title": row.name, "job": called_job.id, "path": file,
                "source": call["source"], "inputs": call["inputs"], "depth": call["depth"], "origin": call["origin"], "secrets": call["secrets"],
            });
            statements.push(
                self.db
                    .prepare("INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, needs, status, call) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)")
                    .bind(&[
                        new_id("job", now_ms()).into(),
                        row.run_id.as_str().into(),
                        row.repo_id.as_str().into(),
                        row.namespace.as_str().into(),
                        format!("{prefix}/{}", called_job.id).into(),
                        format!("{} / {}", row.name, called_job.name.clone().unwrap_or(called_job.id.clone())).into(),
                        serde_json::to_string(&needs)?.into(),
                        serde_json::to_string(&callee)?.into(),
                    ])?,
            );
        }
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        Ok(true)
    }

    /// The runs with a call waiting in `group`, but `run_id`, moved along
    /// now that a job of the group has finished.
    async fn wake_group(&self, repo_id: &str, group: &str, run_id: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct RunId {
            run_id: String,
        }
        let waiting = self
            .db
            .prepare("SELECT DISTINCT run_id FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status = 'waiting' AND run_id != ?")
            .bind(&[repo_id.into(), group.into(), run_id.into()])?
            .all()
            .await?
            .results::<RunId>()?;
        for other in waiting {
            Box::pin(self.advance(&other.run_id)).await?;
        }
        Ok(())
    }

    /// A job that called a workflow, finished with its jobs: their result,
    /// and the outputs the workflow declares. A failed call of a fail-fast
    /// matrix stops the matrix's other calls.
    async fn finish_call(&self, run: &RunRow, row: &JobRow, children: &[&JobRow]) -> Result<()> {
        let call = row.call().unwrap_or_default();
        let called = call["source"].as_str().and_then(|s| workflow::parse(s).ok());
        let mut jobs_context = Map::new();
        let mut by_key: std::collections::BTreeMap<String, Vec<&JobRow>> = std::collections::BTreeMap::new();
        for child in children {
            by_key.entry(child.key.clone()).or_default().push(child);
        }
        for (key, rows) in &by_key {
            let mut outputs = Map::new();
            for child in rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&child.outputs) {
                    outputs.extend(more);
                }
            }
            let id = key.rsplit('/').next().unwrap_or(key);
            jobs_context.insert(id.to_owned(), json!({ "result": key_result(rows), "outputs": outputs }));
        }
        let inputs = children.first().and_then(|c| c.call()).map(|c| c["inputs"].clone()).unwrap_or(json!({}));
        let mut contexts = Map::new();
        contexts.insert("jobs".into(), Value::Object(jobs_context));
        contexts.insert("inputs".into(), inputs);
        let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
        let mut outputs = Map::new();
        if let Some(Value::Object(declared)) = called.as_ref().map(|w| {
            let on = w.raw.get("on").or_else(|| w.raw.get("true")).cloned().unwrap_or(Value::Null);
            on.get("workflow_call").and_then(|c| c.get("outputs")).cloned().unwrap_or(Value::Null)
        }) {
            for (name, spec) in declared {
                if let Some(value) = spec.get("value") {
                    let value = expr::interpolate_value(value, &scope).unwrap_or(Value::Null);
                    outputs.insert(name, Value::String(expr::to_text(&value)));
                }
            }
        }
        let conclusion = key_result(children);
        let finished = self
            .db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = ?, outputs = ?, finished_at = ? WHERE id = ? AND status = 'calling' RETURNING id")
            .bind(&[conclusion.into(), serde_json::to_string(&outputs)?.into(), now().into(), row.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if finished.is_none() {
            return Ok(());
        }
        if conclusion == "failure" && row.matrix.as_deref().is_some_and(|m| m != "{}") && call["fail_fast"] != json!(false) {
            let siblings = self
                .db
                .prepare("SELECT * FROM jobs WHERE run_id = ? AND key = ? AND status != 'completed'")
                .bind(&[row.run_id.as_str().into(), row.key.as_str().into()])?
                .all()
                .await?
                .results::<JobRow>()?;
            for sibling in siblings {
                self.stop_job(&sibling, "Another job of its matrix failed, and the matrix is fail-fast.").await?;
            }
        }
        if let Some(group) = &row.concurrency_group {
            self.wake_group(&run.repo_id, group, &run.id).await?;
        }
        Ok(())
    }

    /// A file's text at a commit, if it is there.
    pub(crate) async fn read_file(&self, path: &RepoPath, ws: &g1t_contracts::User, sha: &str, file: &str) -> Result<Option<String>> {
        let blob: Outcome<g1t_contracts::repos::BlobView> = g1t_kit::call(
            &self.repos,
            "blob",
            &g1t_contracts::repos::BlobArgs {
                path: path.clone(),
                viewer: Some(ws.clone()),
                git_ref: sha.to_owned(),
                file_path: file.to_owned(),
            },
        )
        .await?;
        Ok(match blob {
            Outcome::Ok(view) => view.text,
            Outcome::Fail(_) => None,
        })
    }

    async fn skip_job(&self, row: &JobRow, reason: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'skipped', reason = ?, finished_at = ? WHERE id = ?")
            .bind(&[optional(reason), now().into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    async fn fail_job(&self, row: &JobRow, reason: &str) -> Result<()> {
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'failure', reason = ?, finished_at = ? WHERE id = ? AND status != 'completed'")
            .bind(&[reason.into(), now().into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Starts queued jobs, oldest first, while their workspace has room.
    pub async fn start_queued(&self) -> Result<()> {
        let queued = self
            .db
            // Self-hosted jobs are taken by their runners (runners.rs).
            .prepare("SELECT * FROM jobs WHERE status = 'queued' AND labels IS NULL ORDER BY rowid LIMIT 50")
            .all()
            .await?
            .results::<JobRow>()?;
        let mut running: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for job in queued {
            let in_workspace = match running.get(&job.namespace) {
                Some(n) => *n,
                None => {
                    let n = self
                        .db
                        // Only g1t's own sandboxes count against the workspace's room.
                        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'in_progress' AND namespace = ? AND runner_id IS NULL")
                        .bind(&[job.namespace.as_str().into()])?
                        .first::<Count>(None)
                        .await?
                        .map_or(0, |count| count.n);
                    running.insert(job.namespace.clone(), n);
                    n
                }
            };
            if in_workspace >= RUNNING_PER_WORKSPACE {
                continue;
            }
            if let Some(max) = job.max_parallel {
                let siblings = self
                    .db
                    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ? AND key = ? AND status = 'in_progress'")
                    .bind(&[job.run_id.as_str().into(), job.key.as_str().into()])?
                    .first::<Count>(None)
                    .await?
                    .map_or(0, |count| count.n);
                if siblings >= max {
                    continue;
                }
            }
            // One job of a concurrency group runs at a time.
            if let Some(group) = &job.concurrency_group {
                let running = self
                    .db
                    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status IN ('in_progress', 'calling') AND id != ?")
                    .bind(&[job.repo_id.as_str().into(), group.as_str().into(), job.id.as_str().into()])?
                    .first::<Count>(None)
                    .await?
                    .map_or(0, |count| count.n);
                if running > 0 {
                    continue;
                }
            }
            let token = random_hex(24);
            let at = now();
            let claimed = self
                .db
                .prepare(
                    "UPDATE jobs SET status = 'in_progress', token_hash = ?, first_token_hash = NULL, started_at = ?, seen_at = ? WHERE id = ? AND status = 'queued' RETURNING id",
                )
                .bind(&[sha256_hex(&token).into(), at.as_str().into(), at.as_str().into(), job.id.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            running.insert(job.namespace.clone(), in_workspace + 1);
            self.db
                .prepare("UPDATE runs SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'")
                .bind(&[at.as_str().into(), job.run_id.as_str().into()])?
                .run()
                .await?;
            let run = self.run_row(&job.run_id).await?;
            let repo: RepoPath = run.as_ref().map(|run| repo_path(&run.repo)).unwrap_or(RepoPath {
                namespace: job.namespace.clone(),
                name: String::new(),
            });
            // Its environment and the machine it asked for, for the runner.
            let details = run.as_ref().map(|run| start_details(run, &job)).unwrap_or_default();
            let trusted = run.as_ref().is_some_and(|run| run.trusted != 0);
            // Only a trusted run's jobs get secrets, brokered ones included.
            let brokered = trusted && self.may_broker(&job.repo_id, &job.namespace).await?;
            let started: Outcome<Value> = g1t_kit::call(
                &self.runner,
                "start_actions_job",
                &StartJobArgs {
                    job: job.id.clone(),
                    token,
                    repo,
                    timeout_minutes: job.timeout_minutes,
                    workflow: run.as_ref().map(|run| run.path.clone()),
                    environment: details.environment,
                    trusted,
                    instance: details.instance,
                    brokered,
                },
            )
            .await
            .unwrap_or_else(|error| fail(FailureCode::Conflict, format!("The runner could not be reached: {error}")));
            if let Outcome::Fail(refused) = started {
                // Billing would not pay for a scheduled run's job: the
                // schedule waits rather than making runs only to refuse them.
                if refused.code == FailureCode::PaymentRequired
                    && let Some(run) = run.as_ref().filter(|run| run.event == "schedule")
                {
                    self.db
                        .prepare("UPDATE workflows SET schedule_refused_until = ? WHERE id = ?")
                        .bind(&[rfc3339(now_ms() + crate::SCHEDULE_REFUSED_MS).into(), run.workflow_id.as_str().into()])?
                        .run()
                        .await?;
                }
                Box::pin(self.finish_job(&job.id, "failure", Some(&refused.message), None)).await?;
            } else {
                self.job_started(&job.id).await?;
            }
        }
        Ok(())
    }

    /// Finishes a job and moves its run along.
    pub async fn finish_job(&self, job_id: &str, conclusion: &str, reason: Option<&str>, outputs: Option<&Map<String, Value>>) -> Result<()> {
        let finished = self
            .db
            .prepare(
                "UPDATE jobs SET status = 'completed', conclusion = ?, reason = COALESCE(?, reason), outputs = COALESCE(?, outputs),
                   finished_at = ?, token_hash = NULL, first_token_hash = NULL WHERE id = ? AND status != 'completed' RETURNING *",
            )
            .bind(&[
                conclusion.into(),
                optional(reason),
                outputs.map(|o| serde_json::to_string(o).unwrap_or_default()).as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                now().into(),
                job_id.into(),
            ])?
            .first::<JobRow>(None)
            .await?;
        let Some(job) = finished else { return Ok(()) };
        self.tell_live(&job.repo_id, &job.run_id, None, None).await;
        // Its G1T_TOKEN stops working with it.
        self.revoke_job_tokens(&job.id).await;
        // A g1t.page build it opened and did not finish fails now, not at
        // the deployments sweep. Only a job that ran can have opened one.
        if job.started_at.is_some() {
            self.end_job_builds(&job.id, conclusion).await;
        }
        // A job that deploys failed: so did its run's deployment, now.
        if conclusion == "failure" && job.continue_on_error == 0 && job.started_at.is_some()
            && let Some(run) = self.run_row(&job.run_id).await?
            && let Some(env) = deploys_to(&run, &job)
        {
            self.report_deployment(&run, &env, "failure", false).await;
        }
        // A self-hosted runner's job: the runner is free again, and its time
        // is recorded, at nothing.
        if job.runner_id.is_some() {
            self.released(&job).await?;
        }
        // Steps still marked as going are not going any more.
        let mut steps: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
        let mut touched = false;
        for step in steps.iter_mut() {
            if step["status"] != "completed" {
                let was_running = step["status"] == "in_progress";
                step["status"] = json!("completed");
                step["conclusion"] = json!(if was_running { conclusion } else { "skipped" });
                touched = true;
            }
        }
        if touched {
            self.db
                .prepare("UPDATE jobs SET steps = ? WHERE id = ?")
                .bind(&[serde_json::to_string(&steps)?.into(), job.id.as_str().into()])?
                .run()
                .await?;
        }
        // fail-fast: one failed combination stops the rest of its matrix.
        if conclusion == "failure" && job.continue_on_error == 0 && job.matrix.as_deref().is_some_and(|m| m != "{}") {
            let run = self.run_row(&job.run_id).await?;
            // As its workflow, or the workflow it is a job of, says.
            let fail_fast = run.as_ref().and_then(|run| job_spec(run, &job)).is_none_or(|j| j.fail_fast);
            if fail_fast {
                let siblings = self
                    .db
                    .prepare("SELECT * FROM jobs WHERE run_id = ? AND key = ? AND status != 'completed'")
                    .bind(&[job.run_id.as_str().into(), job.key.as_str().into()])?
                    .all()
                    .await?
                    .results::<JobRow>()?;
                for sibling in siblings {
                    self.stop_job(&sibling, "Another job of its matrix failed, and the matrix is fail-fast.").await?;
                }
            }
        }
        // A call waiting in its concurrency group, in another run, may start.
        if let Some(group) = &job.concurrency_group {
            self.wake_group(&job.repo_id, group, &job.run_id).await?;
        }
        Box::pin(self.advance(&job.run_id)).await
    }

    /// Cancels a job. One that is running is told to stop (the answer to
    /// its next report), and runs its `if: always()` and `cancelled()`
    /// steps and its post steps before it ends `cancelled`; one that has
    /// not started is cancelled at once.
    async fn stop_job(&self, job: &JobRow, reason: &str) -> Result<()> {
        // A job calling a workflow stops with that workflow's jobs.
        if job.status == "calling"
            && let Some(prefix) = job.call_prefix()
        {
            let under = format!("{prefix}/");
            for child in self.job_rows(&job.run_id).await?.iter().filter(|child| child.key.starts_with(&under) && child.status != "completed") {
                Box::pin(self.stop_job(child, reason)).await?;
            }
        }
        if job.status == "in_progress" && job.started_at.is_some() {
            self.db
                .prepare("UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), reason = ? WHERE id = ? AND status = 'in_progress'")
                .bind(&[now().into(), reason.into(), job.id.as_str().into()])?
                .run()
                .await?;
            return Ok(());
        }
        self.hard_stop(job, reason).await
    }

    /// Cancels a job outright, stopping its sandbox if it has one.
    async fn hard_stop(&self, job: &JobRow, reason: &str) -> Result<()> {
        // A self-hosted runner hears it was cancelled on its next poll.
        if job.status == "in_progress" && job.runner_id.is_none() {
            let _: Result<Value> = g1t_kit::call(&self.runner, "stop_actions_job", &json!({ "job": job.id })).await;
        }
        let stopped = self
            .db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'cancelled', reason = ?, finished_at = ?, token_hash = NULL, first_token_hash = NULL WHERE id = ? AND status != 'completed' RETURNING *")
            .bind(&[reason.into(), now().into(), job.id.as_str().into()])?
            .first::<JobRow>(None)
            .await?;
        if stopped.as_ref().is_some_and(|row| row.started_at.is_some()) {
            self.revoke_job_tokens(&job.id).await;
            self.end_job_builds(&job.id, "cancelled").await;
        }
        if let Some(stopped) = stopped.filter(|row| row.runner_id.is_some()) {
            self.released(&stopped).await?;
        }
        Ok(())
    }

    /// Ends a job's tokens at once. A failure is logged: the token expires
    /// on its own soon after the job's time limit.
    async fn revoke_job_tokens(&self, job_id: &str) {
        let revoked: Result<bool> =
            g1t_kit::call(&self.identity, "revoke_job_tokens", &RevokeJobTokensArgs { job_id: job_id.to_owned() }).await;
        if let Err(error) = revoked {
            worker::console_error!("actions: the tokens of job {job_id} were not revoked: {error}");
        }
    }

    /// Finishes the run when every job has.
    async fn finish_if_done(&self, run_id: &str) -> Result<()> {
        let Some(run) = self.run_row(run_id).await? else { return Ok(()) };
        if matches!(run.status.as_str(), "completed" | "pending" | "action_required") {
            return Ok(());
        }
        let jobs = self.job_rows(run_id).await?;
        if !jobs.iter().all(|job| job.status == "completed") {
            return Ok(());
        }
        self.finish_run(&run, None).await
    }

    async fn finish_run(&self, run: &RunRow, error: Option<&str>) -> Result<()> {
        let jobs = self.job_rows(&run.id).await?;
        let rows: Vec<&JobRow> = jobs.iter().collect();
        let conclusion = if error.is_some() {
            "failure"
        } else if run.conclusion.as_deref() == Some("cancelled") {
            "cancelled"
        } else if rows.is_empty() {
            "skipped"
        } else {
            key_result(&rows)
        };
        let done = self
            .db
            .prepare("UPDATE runs SET status = 'completed', conclusion = ?, error = COALESCE(?, error), finished_at = ? WHERE id = ? AND status != 'completed' RETURNING id")
            .bind(&[conclusion.into(), optional(error), now().into(), run.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if done.is_none() {
            return Ok(());
        }
        self.report_status(run, conclusion).await?;
        self.settle_deployments(run, &jobs, conclusion == "cancelled").await;
        let published: Result<()> = g1t_kit::call(
            &self.events,
            "publish",
            &g1t_contracts::events::Publish {
                events: vec![g1t_contracts::events::NewEvent {
                    kind: "workflow.completed",
                    source: "actions",
                    repo_id: Some(run.repo_id.clone()),
                    actor: run.actor_id.clone(),
                    data: g1t_contracts::events::WorkflowEvent {
                        run_id: run.id.clone(),
                        repo_id: run.repo_id.clone(),
                        workflow: run.name.clone(),
                        path: run.path.clone(),
                        number: run.number,
                        event: run.event.clone(),
                        conclusion: conclusion.to_owned(),
                        git_ref: run.git_ref.clone(),
                        sha: run.sha.clone(),
                        pull: run.pull,
                    },
                }],
            },
        )
        .await;
        if let Err(error) = published {
            worker::console_error!("actions: could not publish workflow.completed: {error}");
        }
        // The next run waiting in its concurrency group.
        if let Some(group) = &run.concurrency_group {
            let next = self
                .db
                .prepare("SELECT * FROM runs WHERE repo_id = ? AND concurrency_group = ? AND status = 'pending' ORDER BY id LIMIT 1")
                .bind(&[run.repo_id.as_str().into(), group.as_str().into()])?
                .first::<RunRow>(None)
                .await?;
            if let Some(next) = next {
                self.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").bind(&[next.id.as_str().into()])?.run().await?;
                Box::pin(self.advance(&next.id)).await?;
            }
        }
        Ok(())
    }

    /// Tells the deployments service that a job ended (`workflow_job_ended`),
    /// so a build it opened with `start_from_workflow` and left open fails
    /// at once. Never fails the job: an answer that does not come is
    /// logged, and the sweep fails the build later.
    async fn end_job_builds(&self, job_id: &str, conclusion: &str) {
        let ended: Result<Value> =
            g1t_kit::call(&self.deployments, "workflow_job_ended", &json!({ "jobId": job_id, "conclusion": conclusion })).await;
        if let Err(error) = ended {
            worker::console_log!("actions: could not tell deployments that job {job_id} ended: {error}");
        }
    }

    /// Tells the deployments service how a run's deployment to `env` stands:
    /// made when its first job naming the environment starts, failed when one
    /// of them fails, and settled (`last`) when the run finishes. Never fails
    /// the run: a deployment that could not be recorded is logged.
    async fn report_deployment(&self, run: &RunRow, env: &JobEnvironment, state: &str, last: bool) {
        let path = repo_path(&run.repo);
        let reported: Result<Value> = g1t_kit::call(
            &self.deployments,
            "actions_deployment",
            &json!({
                "repoId": run.repo_id,
                "repo": { "namespace": path.namespace, "name": path.name },
                "runId": run.id,
                "attempt": run.attempt,
                "runUrl": format!("{SITE}/{}/actions/runs/{}", run.repo, run.id),
                "environment": env.name,
                "url": env.url,
                "ref": run.git_ref,
                "sha": run.sha,
                "state": state,
                "final": last,
                "creator": run.actor,
                "workflow": run.name,
            }),
        )
        .await;
        if let Err(error) = reported {
            worker::console_error!("actions: deployment to {} not recorded for run {}: {error}", env.name, run.id);
        }
    }

    /// A job that deploys has started: its run's deployment to the
    /// environment is under way.
    pub(crate) async fn job_started(&self, job_id: &str) -> Result<()> {
        let Some(job) = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[job_id.into()])?.first::<JobRow>(None).await? else {
            return Ok(());
        };
        let Some(run) = self.run_row(&job.run_id).await? else { return Ok(()) };
        self.tell_live(&run.repo_id, &run.id, Some(&run.sha), run.pull).await;
        if let Some(env) = deploys_to(&run, &job) {
            self.report_deployment(&run, &env, "in_progress", false).await;
        }
        Ok(())
    }

    /// Pages open on the repository hear that a run's job started or
    /// finished, which is no event (`g1t_contracts::live`). Logged and left
    /// when notify cannot be reached: the pages catch up by themselves.
    pub(crate) async fn tell_live(&self, repo_id: &str, run_id: &str, sha: Option<&str>, pull: Option<u32>) {
        let Some(notify) = &self.notify else { return };
        let change = g1t_contracts::live::RepoChange {
            repo_id: repo_id.to_owned(),
            kind: g1t_contracts::live::RUN_UPDATED.to_owned(),
            run: Some(run_id.to_owned()),
            sha: sha.map(str::to_owned),
            number: pull,
            at: now(),
            ..Default::default()
        };
        let args = g1t_contracts::live::RepoChangedArgs { changes: vec![change] };
        let told: Result<Value> = g1t_kit::call(notify, g1t_contracts::live::REPO_CHANGED, &args).await;
        if let Err(error) = told {
            worker::console_error!("actions: live pages not told of run {run_id}: {error}");
        }
    }

    /// The run is over: each environment its jobs deployed to takes the
    /// outcome of those jobs (`deployment_outcome`).
    async fn settle_deployments(&self, run: &RunRow, jobs: &[JobRow], cancelled: bool) {
        let mut seen: Vec<(JobEnvironment, Vec<Option<String>>)> = Vec::new();
        for job in jobs {
            let Some(env) = deploys_to(run, job) else { continue };
            let conclusion = if cancelled && job.conclusion.as_deref() != Some("skipped") && job.started_at.is_some() {
                Some("cancelled".to_owned())
            } else if job.started_at.is_none() {
                Some("skipped".to_owned())
            } else {
                job.conclusion.clone()
            };
            match seen.iter_mut().find(|(known, _)| known.name.eq_ignore_ascii_case(&env.name)) {
                Some((known, conclusions)) => {
                    if known.url.is_none() {
                        known.url = env.url.clone();
                    }
                    conclusions.push(conclusion);
                }
                None => seen.push((env, vec![conclusion])),
            }
        }
        for (env, conclusions) in seen {
            if let Some(state) = deployment_outcome(&conclusions) {
                self.report_deployment(run, &env, state, true).await;
            }
        }
    }

    /// Tells the pull request (or commit) how the run went, as a status.
    async fn report_status(&self, run: &RunRow, conclusion: &str) -> Result<()> {
        let state = match conclusion {
            "success" | "skipped" => "success",
            "cancelled" => "error",
            _ => "failure",
        };
        let _: Result<Value> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &json!({
                "repoId": run.repo_id,
                "sha": run.sha,
                "context": format!("{} / {}", run.name, run.event),
                "state": state,
                "description": format!("{} {}", run.name, match conclusion {
                    "success" => "passed",
                    "skipped" => "was skipped",
                    "cancelled" => "was cancelled",
                    _ => "failed",
                }),
                "targetUrl": format!("{SITE}/{}/actions/runs/{}", run.repo, run.id),
                "source": "actions",
            }),
        )
        .await;
        Ok(())
    }

    /// Tells the pull request a run has started on its head.
    pub async fn report_pending(&self, run: &RunRow) -> Result<()> {
        let _: Result<Value> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &json!({
                "repoId": run.repo_id,
                "sha": run.sha,
                "context": format!("{} / {}", run.name, run.event),
                "state": "pending",
                "description": if run.status == "action_required" {
                    format!("{} is waiting for approval", run.name)
                } else {
                    format!("{} is running", run.name)
                },
                "targetUrl": format!("{SITE}/{}/actions/runs/{}", run.repo, run.id),
                "source": "actions",
            }),
        )
        .await;
        Ok(())
    }

    /// Cancels a run: its waiting and queued jobs at once, and its running
    /// ones gracefully (`stop_job`), or outright when `force`.
    pub async fn cancel_run(&self, run: &RunRow, reason: &str, force: bool) -> Result<()> {
        self.db
            .prepare("UPDATE runs SET conclusion = 'cancelled' WHERE id = ? AND status != 'completed'")
            .bind(&[run.id.as_str().into()])?
            .run()
            .await?;
        for job in self.job_rows(&run.id).await?.iter().filter(|job| job.status != "completed") {
            if force {
                self.hard_stop(job, reason).await?;
            } else {
                self.stop_job(job, reason).await?;
            }
        }
        if run.status == "pending" || run.status == "action_required" {
            self.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").bind(&[run.id.as_str().into()])?.run().await?;
        }
        self.advance(&run.id).await
    }

    /// Cancels every run of the repository that has not finished, for
    /// `repo.deleted` and `repo.archived`.
    pub async fn stop_runs(&self, repo_id: &str) -> Result<()> {
        let runs = self
            .db
            .prepare("SELECT * FROM runs WHERE repo_id = ? AND status != 'completed'")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<RunRow>()?;
        for run in runs {
            self.cancel_run(&run, "The repository was archived or deleted.", true).await?;
        }
        Ok(())
    }

    pub async fn cancel(&self, a: RunActionArgs) -> Result<Outcome<WorkflowRun>> {
        if let Outcome::Fail(refused) = self.may(&a.actor, &a.repo, Capability::Run).await? {
            return Ok(Outcome::Fail(refused));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        if run.status == "completed" {
            return Ok(fail(FailureCode::Conflict, "The run has already finished."));
        }
        // Cancelling a run that is already cancelling stops its jobs
        // outright, without waiting for their cleanup steps.
        let force = a.force || run.conclusion.as_deref() == Some("cancelled");
        let reason = if force {
            format!("{} stopped the run without waiting for its cleanup steps.", a.actor.username)
        } else {
            format!("{} cancelled the run.", a.actor.username)
        };
        self.cancel_run(&run, &reason, force).await?;
        self.run_summary(&run.id).await
    }

    /// Runs again, as a new attempt: every job, with `failed_only` those
    /// that did not succeed, or with `job` that one; each with the jobs that
    /// need them. The attempt that ends is kept, its jobs and their logs and
    /// summaries with it (`job_attempts`, `run_attempts`).
    pub async fn rerun(&self, a: RunActionArgs) -> Result<Outcome<WorkflowRun>> {
        if let Outcome::Fail(refused) = self.may(&a.actor, &a.repo, Capability::Run).await? {
            return Ok(Outcome::Fail(refused));
        }
        // A job alone (`POST …/jobs/{job}/rerun`) names its run.
        let run_id = match (&a.job, a.id.is_empty()) {
            (Some(job), true) => {
                #[derive(Deserialize)]
                struct Of {
                    run_id: String,
                }
                let of = self.db.prepare("SELECT run_id FROM jobs WHERE id = ?").bind(&[job.as_str().into()])?.first::<Of>(None).await?;
                match of {
                    Some(of) => of.run_id,
                    None => return Ok(fail(FailureCode::NotFound, "No such job.")),
                }
            }
            _ => a.id.clone(),
        };
        let run = check!(self.run_in(&a.repo, &run_id).await?);
        if run.status != "completed" {
            return Ok(fail(FailureCode::Conflict, "The run is still going: cancel it first."));
        }
        // Nothing starts again on an archived repository.
        match self.visible_repo(&a.repo, &Some(a.actor.clone())).await? {
            Some(repo) if repo.archived() => {
                return Ok(fail(FailureCode::Forbidden, g1t_contracts::repos::archived_message(&repo.namespace, &repo.name)));
            }
            Some(_) => {}
            None => return Ok(fail(FailureCode::NotFound, "There is no such repository.")),
        }
        if run.error.is_some() {
            return Ok(fail(FailureCode::Conflict, "This run never started: fix the workflow file and push again."));
        }
        let jobs = self.job_rows(&run.id).await?;
        let workflow = workflow::parse(&run.source).ok();
        let target = match &a.job {
            Some(id) => match jobs.iter().find(|job| &job.id == id) {
                Some(job) => Some(top_key(&job.key).to_owned()),
                None => return Ok(fail(FailureCode::NotFound, "That job is not in the run's latest attempt.")),
            },
            None => None,
        };
        let which = match (&target, a.failed_only) {
            (Some(key), _) => Rerun::Job(key),
            (None, true) => Rerun::Failed,
            (None, false) => Rerun::All,
        };
        let order = workflow.as_ref().map(|w| w.job_order()).unwrap_or_default();
        let again = rerun_keys(
            &order,
            |key| jobs.iter().find(|j| j.key == key).map(JobRow::needs).unwrap_or_default(),
            |key| jobs.iter().filter(|j| j.key == key).all(|j| j.conclusion.as_deref() == Some("success")),
            which,
        );
        if again.is_empty() {
            return Ok(fail(FailureCode::Conflict, "Every job succeeded: there is nothing to run again."));
        }
        // The jobs that run again, a called workflow's with the job calling it.
        let rerun_ids: Vec<&str> = jobs.iter().filter(|job| again.iter().any(|key| key == top_key(&job.key))).map(|job| job.id.as_str()).collect();
        let ids = serde_json::to_string(&rerun_ids)?;
        let ended = run.attempt.to_string();
        let ended = ended.as_str();
        let mut statements = vec![
            // The attempt that ends, as it ended.
            self.db
                .prepare(
                    "INSERT OR REPLACE INTO run_attempts (run_id, attempt, repo_id, conclusion, actor, debug, started_at, finished_at)
                     SELECT id, attempt, repo_id, conclusion, COALESCE(triggering_actor, actor), debug, started_at, finished_at FROM runs WHERE id = ?",
                )
                .bind(&[run.id.as_str().into()])?,
            // Earlier attempts that showed a job's logs from where it ran
            // then now find them where they move to.
            self.db
                .prepare("UPDATE job_attempts SET log_id = log_id || '.' || ?1 WHERE run_id = ?2 AND log_id IN (SELECT value FROM json_each(?3))")
                .bind(&[ended.into(), run.id.as_str().into(), ids.as_str().into()])?,
            // Each of its jobs: one that runs again keeps its logs under
            // `{id}.{attempt}`; one left alone is still the live job's.
            self.db
                .prepare(
                    "INSERT OR REPLACE INTO job_attempts (id, run_id, repo_id, attempt, job_id, log_id, key, ordinal, name, needs, status, conclusion,
                       steps, annotations, reason, environment, labels, runner_name, started_at, finished_at)
                     SELECT id || '.' || ?1, run_id, repo_id, ?1, id,
                       CASE WHEN id IN (SELECT value FROM json_each(?3)) THEN id || '.' || ?1 ELSE id END,
                       key, ordinal, name, needs, status, conclusion, steps, annotations, reason, environment, labels, runner_name, started_at, finished_at
                     FROM jobs WHERE run_id = ?2 ORDER BY rowid",
                )
                .bind(&[ended.into(), run.id.as_str().into(), ids.as_str().into()])?,
            self.db
                .prepare("UPDATE logs SET job_id = job_id || '.' || ?1 WHERE job_id IN (SELECT value FROM json_each(?2))")
                .bind(&[ended.into(), ids.as_str().into()])?,
            self.db
                .prepare("UPDATE job_summaries SET job_id = job_id || '.' || ?1 WHERE job_id IN (SELECT value FROM json_each(?2))")
                .bind(&[ended.into(), ids.as_str().into()])?,
        ];
        for key in &again {
            statements.push(self.db.prepare("DELETE FROM jobs WHERE run_id = ? AND key = ? AND ordinal > 0").bind(&[run.id.as_str().into(), key.as_str().into()])?);
            // The jobs of a workflow it called (each matrix combination's
            // under `key[i]/`) are made again when it calls it again.
            statements.push(
                self.db
                    .prepare("DELETE FROM jobs WHERE run_id = ? AND (key LIKE ? OR key LIKE ?)")
                    .bind(&[run.id.as_str().into(), format!("{key}/%").into(), format!("{key}[%").into()])?,
            );
            statements.push(
                self.db
                    .prepare(
                        "UPDATE jobs SET status = 'waiting', conclusion = NULL, steps = '[]', annotations = '[]', outputs = '{}', reason = NULL,
                           matrix = NULL, call = NULL, token_hash = NULL, first_token_hash = NULL, seen_at = NULL, started_at = NULL, finished_at = NULL,
                           labels = NULL, queued_at = NULL, runner_id = NULL, runner_name = NULL, environment = NULL,
                           concurrency_group = NULL, cancel_in_progress = 0, cancel_requested_at = NULL WHERE run_id = ? AND key = ?",
                    )
                    .bind(&[run.id.as_str().into(), key.as_str().into()])?,
            );
        }
        statements.push(
            self.db
                .prepare(
                    "UPDATE runs SET status = 'queued', conclusion = NULL, attempt = attempt + 1, started_at = NULL, finished_at = NULL,
                       triggering_actor = ?, debug = ? WHERE id = ?",
                )
                .bind(&[a.actor.username.as_str().into(), u32::from(a.debug).into(), run.id.as_str().into()])?,
        );
        self.db.batch(statements).await?;
        if let Some(run) = self.run_row(&run.id).await? {
            self.report_pending(&run).await?;
        }
        self.advance(&run.id).await?;
        // A page left open on the attempt that ended, which asks for nothing
        // while its run is over, hears that it is going again: re-run from
        // the API, the MCP tool, a pull request or another tab, as well as
        // from that page, it offers Cancel run and not the re-runs.
        self.tell_live(&run.repo_id, &run.id, Some(&run.sha), run.pull).await;
        self.run_summary(&run.id).await
    }

    pub async fn run_in(&self, repo: &RepoPath, id: &str) -> Result<Outcome<RunRow>> {
        let row = self
            .db
            .prepare("SELECT * FROM runs WHERE id = ? AND lower(repo) = lower(?)")
            .bind(&[id.into(), format!("{}/{}", repo.namespace, repo.name).into()])?
            .first::<RunRow>(None)
            .await?;
        Ok(row.map_or_else(|| fail(FailureCode::NotFound, "No such run."), Outcome::Ok))
    }

    // --- The sandbox's side -----------------------------------------------------

    pub(crate) async fn job_for_token(&self, a: &JobCallArgs) -> Result<Outcome<JobRow>> {
        self.job_for(a, false).await
    }

    /// As [`Self::job_for_token`], and also with the token the job started
    /// with after its harness swapped it (`job_spec` with `rotate`): for
    /// `brokered_secrets` alone, which the runner Worker asks with the
    /// token it was given at the start, and which no API route passes on.
    pub(crate) async fn job_for_started_token(&self, a: &JobCallArgs) -> Result<Outcome<JobRow>> {
        self.job_for(a, true).await
    }

    async fn job_for(&self, a: &JobCallArgs, started: bool) -> Result<Outcome<JobRow>> {
        let job = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[a.job.as_str().into()])?.first::<JobRow>(None).await?;
        Ok(match job {
            Some(job) if job.status == "in_progress" && token_opens(job.token_hash.as_deref(), job.first_token_hash.as_deref(), &a.token, started) => Outcome::Ok(job),
            _ => fail(FailureCode::Unauthenticated, "That job is not running, or the token is not its."),
        })
    }

    /// `job_auth`: which run and repository a running job's token is for,
    /// so the API can keep its artifacts and cache.
    pub async fn job_auth(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        Ok(Outcome::Ok(json!({ "run": job.run_id, "repoId": job.repo_id })))
    }

    /// `job_spec`: everything the sandbox needs to run the job.
    pub async fn job_spec(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        // Asked to, the token the harness asked with is spent here: it gets
        // a new one with the spec, for everything after, so a copy of the
        // first left on the runner's computer (a Windows job's script, a
        // container's environment) cannot fetch the secrets again. The new
        // token is made now, as the runtime token is signed with its hash,
        // and swapped in last, so a spec that could not be made leaves the
        // old one working.
        let next = a.rotate.then(|| random_hex(24));
        let token_hash = match &next {
            Some(next) => sha256_hex(next),
            None => job.token_hash.clone().unwrap_or_default(),
        };
        let Some(run) = self.run_row(&job.run_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such run."));
        };
        let Ok(caller) = workflow::parse(&run.source) else {
            return Ok(fail(FailureCode::Invalid, "The workflow no longer reads."));
        };
        // A called workflow's job runs as that workflow defines it.
        let callee = job.callee();
        let (workflow, spec, call_inputs) = match callee {
            Some((called, spec, call)) => (called, spec, Some(call["inputs"].clone())),
            None => match caller.jobs.iter().find(|j| j.id == job.key) {
                Some(spec) => (caller.clone(), spec.clone(), None),
                None => return Ok(fail(FailureCode::NotFound, "The job is not in the workflow.")),
            },
        };
        let spec = &spec;
        let repo = repo_path(&run.repo);
        let trusted = run.trusted != 0;
        // The job's `environment:`, by name, as read when its needs were done
        // (an expression included), once the environment's protection rules
        // let it start: entries with a value for it give that value instead
        // of their default, as GitHub's environment secrets do.
        let environment: Option<String> = job.environment.clone();
        // What its token may do: its `permissions:` (a called workflow's
        // jobs no more than the job that calls it), else the repository's
        // default; read-only for a pull request from outside.
        // The repository's default, its workspace's taken in, and whether
        // its jobs may open and approve pull requests.
        let (default, pull_requests) = self.token_policy(&run.repo_id).await?;
        let mut permissions = spec.permissions(&workflow, default);
        if let Some(parent) = &job.call().filter(|c| c["role"] == "callee").and_then(|c| c["parent"].as_str().map(str::to_owned)) {
            let top = top_key(parent);
            if let Some(caller_job) = caller.jobs.iter().find(|j| j.id == top) {
                permissions = permissions.capped_by(&caller_job.permissions(&caller, default));
            }
        }
        if !trusted {
            permissions = permissions.read_only();
        }
        // G1T_TOKEN, and GITHUB_TOKEN as its alias: a token of the
        // workspace's that reaches this repository only, with the scopes
        // its permissions give, until the job ends.
        let token = match self.workspace_actor(&repo.namespace).await? {
            Some(workspace) => {
                let created: CreatedAccessToken = g1t_kit::call(
                    &self.identity,
                    "create_job_token",
                    &CreateJobTokenArgs {
                        workspace,
                        repo: repo.clone(),
                        run_id: run.id.clone(),
                        job_id: job.id.clone(),
                        name: format!("G1T_TOKEN for {} run {}", run.repo, run.number),
                        ttl_seconds: u64::from(job.timeout_minutes) * 60 + 600,
                        scopes: permissions.scopes().into_iter().map(str::to_owned).collect(),
                        pull_requests: pull_requests && trusted,
                    },
                )
                .await?;
                created.token
            }
            None => String::new(),
        };
        // A run that is not trusted (a pull request from outside the
        // workspace) gets no secrets and an empty token.
        let passed = job.call().filter(|c| c["role"] == "callee").and_then(|c| c.get("secrets").cloned());
        // Brokered secrets among them (broker.rs), whatever keys they reach
        // the job under.
        let mut brokers: Vec<Broker> = Vec::new();
        let mut secrets = match (trusted, passed) {
            (false, _) => Map::new(),
            (true, None) => {
                let resolved = self.secrets_for(&run.repo_id, &run.repo, environment.as_deref(), true).await?;
                brokers.extend(resolved.brokers());
                resolved.values
            }
            // A called workflow's job: what its callers passed it (reach.rs),
            // and its own environment's secrets over them.
            (true, Some(plan)) => {
                let base = self.secrets_for(&run.repo_id, &run.repo, None, true).await?;
                brokers.extend(base.brokers());
                let base = base.values;
                let vars = self.variables_for(&run.repo_id, &run.repo, None, true).await?;
                let github = run.info().context(&job.key, "", run.action.as_deref());
                let mut passed = crate::reach::resolve_secrets(&plan, &base, &github, &vars);
                if let Some(name) = environment.as_deref() {
                    let own = self.secrets_for(&run.repo_id, &run.repo, Some(name), true).await?;
                    brokers.extend(own.brokers());
                    for (key, value) in own.values {
                        if base.get(&key) != Some(&value) {
                            passed.insert(key, value);
                        }
                    }
                }
                passed
            }
        };
        // A brokered secret's value never reaches the sandbox: the job gets
        // a stand-in, which the runner Worker fills in on its requests to
        // the secret's hosts. A self-hosted runner's requests never pass
        // the Worker: a harness there that brokers is given each stand-in's
        // hosts, and passes its job's requests to them through g1t
        // (broker.rs); any other keeps a stand-in that does nothing, and
        // the log says so.
        let stand_ins = broker::substitute(&mut secrets, &brokers, broker::stand_in);
        let relayed = job.runner_id.is_some() && a.broker && !stand_ins.is_empty();
        if !stand_ins.is_empty() {
            self.keep_stand_ins(&job.id, job.timeout_minutes, &stand_ins).await?;
            if job.runner_id.is_some() {
                let mut made: Vec<&broker::StandIn> = stand_ins.iter().collect();
                made.sort_unstable_by(|a, b| a.broker.name.cmp(&b.broker.name));
                let notes: String = made
                    .iter()
                    .map(|made| {
                        let note = if relayed { broker::brokered_note(&made.broker.name, &made.broker.hosts) } else { broker::self_hosted_note(&made.broker.name) };
                        note + "\n"
                    })
                    .collect();
                self.note_log(&job.id, 0, &notes).await?;
            }
        }
        secrets.insert("G1T_TOKEN".into(), Value::String(token.clone()));
        secrets.insert("GITHUB_TOKEN".into(), Value::String(token.clone()));
        // Each secret as it is, a line at a time, base64 and JSON-escaped.
        let mut masks: Vec<String> = g1t_actions::mask::all_variants(secrets.values().filter_map(|v| v.as_str()));
        let vars = self.variables_for(&run.repo_id, &run.repo, environment.as_deref(), trusted).await?;
        // The toolkit's runtime token (runtime.rs), for as long as the job
        // may run; the API puts it and the toolkit's addresses in the
        // job's variables.
        let runtime_token = crate::runtime::runtime_token(
            &job.id,
            &job.run_id,
            &token_hash,
            now_ms() / 1000,
            u64::from(job.timeout_minutes) * 60 + 600,
        );
        masks.push(runtime_token.clone());
        let retention_days = self.retention_setting(&run.repo_id).await?;

        let jobs = self.job_rows(&run.id).await?;
        let mut needs = Map::new();
        // In a called workflow, its jobs' keys sit under the job that called it.
        let parent = job.call().filter(|c| c["role"] == "callee").and_then(|c| c["parent"].as_str().map(str::to_owned));
        for need in &spec.needs {
            let key = match &parent {
                Some(parent) => format!("{parent}/{need}"),
                None => need.clone(),
            };
            let rows: Vec<&JobRow> = jobs.iter().filter(|row| row.key == key).collect();
            let mut outputs = Map::new();
            for row in &rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&row.outputs) {
                    outputs.extend(more);
                }
            }
            needs.insert(need.clone(), json!({ "result": key_result(&rows), "outputs": outputs }));
        }
        let siblings = jobs.iter().filter(|row| row.key == job.key).count();
        let matrix: Value = job.matrix.as_deref().and_then(|m| serde_json::from_str(m).ok()).unwrap_or(json!({}));
        let info = run.info();
        let mut github = info.context(&job.key, &token, run.action.as_deref());
        github["token"] = json!(token);
        github["retention_days"] = json!(retention_days);
        // On a self-hosted runner, `runner` and `RUNNER_*` describe that
        // machine rather than g1t's sandbox.
        let mut variables = info.variables(&job.key);
        variables.insert("GITHUB_RETENTION_DAYS".into(), json!(retention_days.to_string()));
        let mut runner = match &job.runner_id {
            Some(id) => self.runner_context_for(id, &mut variables).await?,
            None => runner_context(),
        };
        // A re-run with debug logging: what GitHub sets for one.
        if run.debug != 0 {
            debug_logging(&mut variables, &mut runner);
        }

        // Where to check out: the repository, which holds a pull request's
        // test merge commit; a pull request's fork when the run builds its
        // head instead (`run.sha` is the head, `info.sha` what is built).
        let clone_url = match run.pull {
            Some(number) if run.event.starts_with("pull_request") && run.event != "pull_request_target" && info.sha == run.sha => {
                let located: Outcome<g1t_contracts::work::PullDetail> = g1t_kit::call(
                    &self.work,
                    "get_pull",
                    &g1t_contracts::work::ViewArgs {
                        repo: repo.clone(),
                        number,
                        viewer: self.workspace_actor(&repo.namespace).await?,
                        after_seq: 0,
                    },
                )
                .await?;
                match located {
                    Outcome::Ok(detail) => match detail.pull.fork {
                        Some(fork) => format!("{SITE}/{}/{}.git", fork.namespace, fork.name),
                        None => format!("{SITE}/{}.git", run.repo),
                    },
                    Outcome::Fail(_) => format!("{SITE}/{}.git", run.repo),
                }
            }
            _ => format!("{SITE}/{}.git", run.repo),
        };

        // Only one fetch with a token gets its spec: of two at once, the
        // second finds the hash already changed and is refused.
        if next.is_some() {
            let swapped = self
                .db
                .prepare(TOKEN_ROTATE)
                .bind(&[token_hash.as_str().into(), job.id.as_str().into(), job.token_hash.as_deref().unwrap_or_default().into()])?
                .first::<Value>(None)
                .await?;
            if swapped.is_none() {
                return Ok(fail(FailureCode::Unauthenticated, "That job is not running, or the token is not its."));
            }
        }

        let mut spec = json!({
            "job": job.id,
            "run": run.id,
            "key": job.key,
            "name": job.name,
            "spec": spec.raw,
            "workflow": {
                "env": workflow.env,
                "defaults": workflow.raw.get("defaults").cloned().unwrap_or(Value::Null),
            },
            "github": github,
            "variables": variables,
            "event": info.event,
            "contexts": {
                "vars": vars,
                "secrets": secrets,
                "inputs": call_inputs.unwrap_or_else(|| Value::Object(run.inputs())),
                "matrix": matrix,
                "needs": needs,
                "strategy": {
                    "fail-fast": spec.fail_fast,
                    "job-index": job.ordinal,
                    "job-total": siblings,
                    "max-parallel": spec.max_parallel.unwrap_or(siblings as u32),
                },
                "runner": runner,
            },
            "checkout": {
                "repository": run.repo,
                "url": clone_url,
                "sha": info.sha,
                "ref": run.git_ref,
                "token": token,
            },
            "timeoutMinutes": job.timeout_minutes,
            "masks": masks,
            // As the job's log lists them at its start.
            "permissions": permissions.listed().into_iter().map(|(name, access)| (name.to_owned(), json!(access.as_str()))).collect::<Map<String, Value>>(),
            // Whether the job may ask for an OIDC token decides whether it
            // is told where to.
            "runtime": {
                "token": runtime_token,
                "idToken": self.oidc_allowed(&run, &job),
            },
        });
        if let Some(next) = next {
            spec["nextToken"] = json!(next);
        }
        if relayed {
            spec["brokered"] = broker::spec_entries(&stand_ins);
        }
        Ok(Outcome::Ok(spec))
    }

    /// `job_report`: the sandbox telling how the job is going.
    pub async fn job_report(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        let report = &a.report;
        let at = now();
        match report["kind"].as_str().unwrap_or_default() {
            "steps" => {
                // The list can grow as the job goes (post steps), so steps
                // already reported keep where they stand.
                let known: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
                let steps: Vec<Value> = report["steps"]
                    .as_array()
                    .map(|names| {
                        names
                            .iter()
                            .enumerate()
                            .map(|(i, name)| match known.get(i) {
                                Some(step) if step["status"] != "queued" => step.clone(),
                                _ => json!({ "number": i + 1, "name": expr::to_text(name), "status": "queued", "conclusion": null, "startedAt": null, "finishedAt": null }),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.db
                    .prepare("UPDATE jobs SET steps = ?, seen_at = ? WHERE id = ?")
                    .bind(&[serde_json::to_string(&steps)?.into(), at.as_str().into(), job.id.as_str().into()])?
                    .run()
                    .await?;
            }
            "step" => {
                let number = report["number"].as_u64().unwrap_or(0) as usize;
                let mut steps: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
                if let Some(step) = number.checked_sub(1).and_then(|i| steps.get_mut(i)) {
                    let status = report["status"].as_str().unwrap_or("in_progress");
                    step["status"] = json!(status);
                    if status == "in_progress" {
                        step["startedAt"] = json!(at);
                    }
                    if status == "completed" {
                        step["finishedAt"] = json!(at);
                        step["conclusion"] = report["conclusion"].clone();
                    }
                    if let Some(name) = report["name"].as_str() {
                        step["name"] = json!(name);
                    }
                }
                self.db
                    .prepare("UPDATE jobs SET steps = ?, seen_at = ? WHERE id = ?")
                    .bind(&[serde_json::to_string(&steps)?.into(), at.as_str().into(), job.id.as_str().into()])?
                    .run()
                    .await?;
            }
            // A line from g1t itself, not the job: the runner Worker's note
            // that a brokered secret went to a host it is not for. Put
            // under the step that is running.
            "note" => {
                let text = report["text"].as_str().unwrap_or_default().chars().take(1000).collect::<String>();
                let steps: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
                let step = steps.iter().rev().find(|step| step["status"] == "in_progress").and_then(|step| step["number"].as_u64()).unwrap_or(0);
                if !text.trim().is_empty() {
                    self.note_log(&job.id, step as u32, &text).await?;
                }
            }
            "log" => {
                let mut text = report["text"].as_str().unwrap_or_default().to_owned();
                // A brokered secret's value never enters the sandbox, but an
                // answer that echoed it whole could carry it in; it is
                // masked here, where the value is known.
                if job.brokered != 0 {
                    let values: Vec<String> = self.stand_ins_of(&job.id).await?.into_iter().map(|secret| secret.value).collect();
                    if !values.is_empty() {
                        text = g1t_actions::mask::apply(&text, &g1t_actions::mask::all_variants(values.iter().map(String::as_str)));
                    }
                }
                if text.len() > MAX_CHUNK_BYTES {
                    let mut cut = MAX_CHUNK_BYTES;
                    while !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text.truncate(cut);
                }
                #[derive(Deserialize)]
                struct Size {
                    n: Option<f64>,
                }
                let size = self
                    .db
                    .prepare("SELECT SUM(LENGTH(text)) AS n FROM logs WHERE job_id = ?")
                    .bind(&[job.id.as_str().into()])?
                    .first::<Size>(None)
                    .await?;
                let used = size.and_then(|s| s.n).unwrap_or(0.0) as usize;
                if used < MAX_LOG_BYTES {
                    if used + text.len() >= MAX_LOG_BYTES {
                        text.push_str("\n… The log reached its limit of 4 MB; the rest is not kept.\n");
                    }
                    // The next `seq` is taken in the insert itself, so two
                    // batches at once (a report sent again while the first
                    // was still being written) never reach for the same one
                    // and lose a chunk to the primary key.
                    self.db
                        .prepare(LOG_INSERT)
                        .bind(&[
                            job.id.as_str().into(),
                            (report["step"].as_u64().unwrap_or(0) as u32).into(),
                            text.into(),
                            report["chunk"].as_u64().map_or(worker::wasm_bindgen::JsValue::NULL, |n| (n as f64).into()),
                        ])?
                        .run()
                        .await?;
                }
                self.db.prepare("UPDATE jobs SET seen_at = ? WHERE id = ?").bind(&[at.into(), job.id.as_str().into()])?.run().await?;
            }
            "summary" => {
                // `$GITHUB_STEP_SUMMARY`, masked by the runner: added to the
                // step's summary, up to 1 MiB a step and 20 steps a job.
                let step = report["step"].as_u64().unwrap_or(0) as u32;
                let markdown = report["markdown"].as_str().unwrap_or_default();
                #[derive(Deserialize)]
                struct Held {
                    steps: u32,
                    mine: Option<f64>,
                }
                let held = self
                    .db
                    .prepare("SELECT COUNT(*) AS steps, MAX(CASE WHEN step = ? THEN LENGTH(markdown) END) AS mine FROM job_summaries WHERE job_id = ?")
                    .bind(&[step.into(), job.id.as_str().into()])?
                    .first::<Held>(None)
                    .await?;
                let (steps, mine) = held.map_or((0, None), |held| (held.steps, held.mine.map(|n| n as usize)));
                if summary_fits(steps, mine, markdown.len()) {
                    self.db
                        .prepare(
                            "INSERT INTO job_summaries (job_id, step, markdown) VALUES (?, ?, ?)
                               ON CONFLICT (job_id, step) DO UPDATE SET markdown = job_summaries.markdown || excluded.markdown",
                        )
                        .bind(&[job.id.as_str().into(), step.into(), markdown.into()])?
                        .run()
                        .await?;
                }
                self.db.prepare("UPDATE jobs SET seen_at = ? WHERE id = ?").bind(&[at.into(), job.id.as_str().into()])?.run().await?;
            }
            "annotation" => {
                let mut annotations: Vec<Value> = serde_json::from_str(&job.annotations).unwrap_or_default();
                if annotations.len() < MAX_ANNOTATIONS {
                    annotations.push(json!({
                        "level": report["level"].as_str().unwrap_or("notice"),
                        "message": report["message"].as_str().unwrap_or_default().chars().take(4000).collect::<String>(),
                        "title": report["title"],
                        "file": report["file"],
                        "line": report["line"],
                    }));
                    self.db
                        .prepare("UPDATE jobs SET annotations = ?, seen_at = ? WHERE id = ?")
                        .bind(&[serde_json::to_string(&annotations)?.into(), at.as_str().into(), job.id.as_str().into()])?
                        .run()
                        .await?;
                }
            }
            // Nothing to tell; the answer says whether to stop.
            "ping" => {
                self.db.prepare("UPDATE jobs SET seen_at = ? WHERE id = ?").bind(&[at.into(), job.id.as_str().into()])?.run().await?;
            }
            "done" => {
                // A job told to stop ends cancelled, however its cleanup went.
                let conclusion = if job.cancel_requested_at.is_some() {
                    "cancelled"
                } else {
                    report["conclusion"]
                        .as_str()
                        .filter(|c| matches!(*c, "success" | "failure" | "cancelled"))
                        .unwrap_or("failure")
                };
                let outputs = report["outputs"].as_object().cloned();
                Box::pin(self.finish_job(&job.id, conclusion, report["reason"].as_str(), outputs.as_ref())).await?;
            }
            other => return Ok(fail(FailureCode::Invalid, format!("There is no report called `{other}`."))),
        }
        // `cancelled`: the run was cancelled, and the runner should stop
        // the step it is on and run only its cleanup steps.
        Ok(Outcome::Ok(json!({ "ok": true, "cancelled": job.cancel_requested_at.is_some() })))
    }

    // --- Every minute ---------------------------------------------------------------

    pub async fn on_minute(&self, now_ms: u64) -> Result<()> {
        let minute = now_ms / 60_000 * 60_000;
        // Repositories a workspace's managed workflows changed in, beyond
        // those synced at once (managed.rs): their schedules wait for it.
        if let Err(error) = self.catch_up_syncs().await {
            worker::console_error!("actions: catching up syncs failed: {error}");
        }
        // Staff (or billing's usage watcher) paused scheduled runs across
        // g1t: this minute's schedules are skipped, not queued for later.
        // Kept 30 seconds in the isolate (g1t_kit::pause).
        if g1t_kit::pause::paused(&self.billing, g1t_contracts::billing::PauseLevel::Schedules).await {
            worker::console_log!("actions: schedules are paused across g1t; skipped this minute's");
        } else if let Err(error) = self.run_schedules(minute).await {
            worker::console_error!("actions: schedules failed: {error}");
        }
        // Jobs whose sandbox went quiet or ran past their time.
        let running = self.db.prepare("SELECT * FROM jobs WHERE status = 'in_progress'").all().await?.results::<JobRow>()?;
        for job in running {
            // Times in g1t's format compare as text.
            let before = |ms: u64| rfc3339(now_ms.saturating_sub(ms));
            let silent = job.seen_at.as_deref().is_some_and(|seen| seen < before(SILENT_MS).as_str());
            let limit = (u64::from(job.timeout_minutes) * 60 + 120) * 1000;
            let over = job.started_at.as_deref().is_some_and(|started| started < before(limit).as_str());
            let cancel_overdue = job.cancel_requested_at.as_deref().is_some_and(|at| at < before(CANCEL_GRACE_MS).as_str());
            if cancel_overdue {
                // Cancelled, and still going after its grace period.
                self.hard_stop(&job, "It was cancelled, and did not finish its cleanup steps within 5 minutes.").await?;
                self.advance(&job.run_id).await?;
            } else if over {
                let reason = format!("It ran longer than its time limit of {} minutes.", job.timeout_minutes);
                // A self-hosted runner is told to stop on its next poll.
                if job.runner_id.is_none() {
                    let _: Result<Value> = g1t_kit::call(&self.runner, "stop_actions_job", &json!({ "job": job.id })).await;
                }
                self.finish_job(&job.id, "failure", Some(&reason), None).await?;
            } else if silent {
                let reason = match &job.runner_name {
                    Some(name) => format!("The self-hosted runner {name} stopped answering."),
                    None => "The runner stopped answering.".to_owned(),
                };
                self.finish_job(&job.id, "failure", Some(&reason), None).await?;
            }
        }
        // Calls of reusable workflows waiting in a concurrency group, in
        // case the job they waited for was cancelled in another run.
        #[derive(Deserialize)]
        struct RunId {
            run_id: String,
        }
        let held = self
            .db
            .prepare("SELECT DISTINCT run_id FROM jobs WHERE status = 'waiting' AND concurrency_group IS NOT NULL LIMIT 20")
            .all()
            .await?
            .results::<RunId>()?;
        for run in held {
            self.advance(&run.run_id).await?;
        }
        if let Err(error) = self.sweep_runners(now_ms).await {
            worker::console_error!("actions: the runners' sweep failed: {error}");
        }
        // Jobs held at an environment whose wait timer has run out.
        if let Err(error) = self.release_gates().await {
            worker::console_error!("actions: environments' gates failed: {error}");
        }
        // Once an hour: the cache's expired entries, and its storage.
        if (now_ms / 60_000) % 60 == 7
            && let Err(error) = self.sweep_cache(now_ms).await
        {
            worker::console_error!("actions: the cache's sweep failed: {error}");
        }
        // And the archives of GitHub's actions no job uses any more.
        if (now_ms / 60_000) % 60 == 47
            && let Err(error) = self.sweep_action_archives(now_ms).await
        {
            worker::console_error!("actions: the action archives' sweep failed: {error}");
        }
        // And artifacts past their time, and the toolkit's abandoned parts.
        if (now_ms / 60_000) % 60 == 37 {
            if let Err(error) = self.sweep_artifacts(now_ms).await {
                worker::console_error!("actions: the artifacts' sweep failed: {error}");
            }
            if let Err(error) = self.sweep_blob_parts(now_ms).await {
                worker::console_error!("actions: the blob parts' sweep failed: {error}");
            }
        }
        // And logs of jobs that finished longer ago than LOG_RETENTION_DAYS.
        if (now_ms / 60_000) % 60 == 17
            && let Err(error) = self.sweep_logs(now_ms).await
        {
            worker::console_error!("actions: the logs' sweep failed: {error}");
        }
        self.start_queued().await
    }
}


#[cfg(test)]
mod log_chunks {
    use rusqlite::{Connection, params};

    use super::LOG_INSERT;

    /// The logs table as the migrations leave it.
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        for name in ["0001_init.sql", "0016_log_chunks.sql"] {
            let path = format!("{}/migrations/{name}", env!("CARGO_MANIFEST_DIR"));
            db.execute_batch(&std::fs::read_to_string(path).unwrap()).unwrap();
        }
        db
    }

    fn log(db: &Connection, job: &str) -> Vec<(i64, i64, String)> {
        let mut rows = db.prepare("SELECT seq, step, text FROM logs WHERE job_id = ? ORDER BY seq").unwrap();
        rows.query_map([job], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn a_batch_sent_again_is_kept_once() {
        let db = database();
        let insert = |job: &str, step: i64, text: &str, chunk: Option<i64>| db.execute(LOG_INSERT, params![job, step, text, chunk]).unwrap();
        assert_eq!(insert("job_1", 0, "one\n", Some(1)), 1);
        // The runner did not hear the answer and sent the batch again.
        assert_eq!(insert("job_1", 0, "one\n", Some(1)), 0);
        assert_eq!(insert("job_1", 1, "two\n", Some(2)), 1);
        // Another job numbers its batches from 1 too.
        assert_eq!(insert("job_2", 0, "other\n", Some(1)), 1);
        // A runner that numbers nothing has every batch kept, as before.
        assert_eq!(insert("job_3", 0, "a\n", None), 1);
        assert_eq!(insert("job_3", 0, "a\n", None), 1);
        assert_eq!(log(&db, "job_1"), [(1, 0, "one\n".into()), (2, 1, "two\n".into())]);
        assert_eq!(log(&db, "job_2"), [(1, 0, "other\n".into())]);
        assert_eq!(log(&db, "job_3").len(), 2);
        // A job run again moves its log aside (`{id}.{attempt}`), and the
        // new attempt's runner numbers from 1 again.
        db.execute("UPDATE logs SET job_id = job_id || '.1' WHERE job_id = 'job_1'", []).unwrap();
        assert_eq!(insert("job_1", 0, "again\n", Some(1)), 1);
        assert_eq!(log(&db, "job_1"), [(1, 0, "again\n".into())]);
        assert_eq!(log(&db, "job_1.1").len(), 2);
    }
}

#[cfg(test)]
mod token_rotation {
    use g1t_secrets::sha256_hex;
    use rusqlite::{Connection, OptionalExtension, params};

    use super::{TOKEN_ROTATE, token_opens};

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        for name in ["0001_init.sql", "0020_job_token_rotation.sql"] {
            let path = format!("{}/migrations/{name}", env!("CARGO_MANIFEST_DIR"));
            db.execute_batch(&std::fs::read_to_string(path).unwrap()).unwrap();
        }
        db.execute(
            "INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, status, token_hash) VALUES ('job_1', 'run_1', 'repo_1', 'acme', 'build', 'build', 'in_progress', ?1)",
            [sha256_hex("first")],
        )
        .unwrap();
        db
    }

    fn rotate(db: &Connection, next: &str, shown: &str) -> bool {
        db.query_row(TOKEN_ROTATE, params![sha256_hex(next), "job_1", sha256_hex(shown)], |row| row.get::<_, String>(0))
            .optional()
            .unwrap()
            .is_some()
    }

    /// The job's current token's hash, and the one it started with.
    fn hashes(db: &Connection) -> (Option<String>, Option<String>) {
        db.query_row("SELECT token_hash, first_token_hash FROM jobs WHERE id = 'job_1'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
    }

    #[test]
    fn a_job_token_fetches_its_spec_once() {
        let db = database();
        assert!(rotate(&db, "second", "first"));
        assert_eq!(hashes(&db), (Some(sha256_hex("second")), Some(sha256_hex("first"))));
        // The first token, shown again (a copy left on the computer, or a
        // second fetch racing the first), swaps nothing and is refused.
        assert!(!rotate(&db, "third", "first"));
        assert_eq!(hashes(&db).0, Some(sha256_hex("second")));
        // A job that ended has no token to swap.
        db.execute("UPDATE jobs SET status = 'completed', token_hash = NULL, first_token_hash = NULL", []).unwrap();
        assert!(!rotate(&db, "fourth", "second"));
        assert_eq!(hashes(&db), (None, None));
    }

    #[test]
    fn the_worker_finds_brokered_secrets_with_the_token_the_job_started_with() {
        let db = database();
        let opens = |db: &Connection, token: &str, started: bool| {
            let (current, first) = hashes(db);
            token_opens(current.as_deref(), first.as_deref(), token, started)
        };
        // Before any swap, the job's one token opens everything.
        assert!(opens(&db, "first", false) && opens(&db, "first", true));
        assert!(rotate(&db, "second", "first"));
        // The harness's new token opens everything.
        assert!(opens(&db, "second", false) && opens(&db, "second", true));
        // The token it started with, which the runner Worker holds, still
        // finds the job's brokered secrets, and opens nothing else.
        assert!(opens(&db, "first", true));
        assert!(!opens(&db, "first", false));
        assert!(!opens(&db, "other", true));
        // Another swap keeps the token it started with, not the one between.
        assert!(rotate(&db, "third", "second"));
        assert!(opens(&db, "first", true));
        assert!(!opens(&db, "second", true));
    }

    #[test]
    fn the_runtime_token_is_signed_for_the_token_that_replaces_the_first() {
        let now = 1_800_000_000;
        let token = crate::runtime::runtime_token("job_1", "run_1", &sha256_hex("second"), now, 600);
        assert!(crate::runtime::runtime_valid(&token, "job_1", &sha256_hex("second"), now));
        assert!(!crate::runtime::runtime_valid(&token, "job_1", &sha256_hex("first"), now));
    }
}

#[cfg(test)]
mod stopping {
    use super::stops_runs;
    use g1t_contracts::events::Event;
    use serde_json::{Value, json};

    fn event(kind: &str, data: Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "repos".into(),
            time: "2026-10-05T00:00:00Z".into(),
            repo_id: Some("rep_1".into()),
            actor: None,
            data,
        }
    }

    #[test]
    fn deleting_or_archiving_stops_runs() {
        assert_eq!(stops_runs(&event("repo.deleted", json!({ "repoId": "rep_1" }))).as_deref(), Some("rep_1"));
        assert_eq!(stops_runs(&event("repo.archived", json!({ "archived": true }))).as_deref(), Some("rep_1"));
        assert_eq!(stops_runs(&event("repo.unarchived", json!({ "archived": false }))), None);
        assert_eq!(stops_runs(&event("repo.restored", json!({}))), None);
        assert_eq!(stops_runs(&event("git.push", json!({}))), None);
    }
}

#[cfg(test)]
mod status_of_needs {
    use std::collections::HashMap;

    use super::ancestor_failed;

    /// check -> plan -> (migrate) -> core -> edge, as deploy.yml has them,
    /// and a job that needs only the last.
    fn graph() -> HashMap<&'static str, Vec<&'static str>> {
        HashMap::from([
            ("check", vec![]),
            ("plan", vec!["check"]),
            ("migrate", vec!["plan"]),
            ("core", vec!["plan", "migrate"]),
            ("edge", vec!["plan", "migrate", "core"]),
            ("notify", vec!["edge"]),
        ])
    }

    #[test]
    fn a_failure_is_seen_however_far_back() {
        let needs = graph();
        let failed = |which: &'static str| move |key: &str| key == which;
        // check failed; plan, and everything after, was skipped for it.
        assert!(ancestor_failed(&needs, "notify", failed("check")));
        assert!(ancestor_failed(&needs, "core", failed("check")));
        assert!(ancestor_failed(&needs, "edge", failed("core")));
        // Nothing before a job failed: a skipped migrate is not a failure.
        assert!(!ancestor_failed(&needs, "edge", |_| false));
        assert!(!ancestor_failed(&needs, "core", failed("edge")));
        assert!(!ancestor_failed(&needs, "check", failed("check")));
    }

    #[test]
    fn cycles_and_unknown_keys_end() {
        let needs = HashMap::from([("a", vec!["b"]), ("b", vec!["a"])]);
        assert!(!ancestor_failed(&needs, "a", |_| false));
        assert!(!ancestor_failed(&needs, "missing", |_| true));
    }
}

#[cfg(test)]
mod deployments {
    use serde_json::{Map, Value, json};

    use super::{JobEnvironment, deployment_outcome, environment_of};

    #[test]
    fn a_jobs_environment_is_read_for_deployments() {
        let contexts: Map<String, Value> = serde_json::from_value(json!({
            "github": { "ref_name": "main", "repository": "acme/web" },
            "inputs": { "target": "staging" },
            "matrix": {},
        }))
        .unwrap();
        let read = |raw: Value| environment_of(&raw, &contexts);
        assert_eq!(read(json!({})), None);
        assert_eq!(
            read(json!({ "environment": "production" })),
            Some(JobEnvironment { name: "production".into(), url: None, deploys: true })
        );
        assert_eq!(
            read(json!({ "environment": { "name": "production", "url": "https://g1t.sh" } })),
            Some(JobEnvironment { name: "production".into(), url: Some("https://g1t.sh".into()), deploys: true })
        );
        // Expressions are filled in from the run.
        assert_eq!(
            read(json!({ "environment": { "name": "${{ inputs.target }}", "url": "https://${{ github.ref_name }}.example.com" } })),
            Some(JobEnvironment { name: "staging".into(), url: Some("https://main.example.com".into()), deploys: true })
        );
        // Secrets only: no deployment.
        assert!(!read(json!({ "environment": { "name": "production", "deployment": false } })).unwrap().deploys);
        // The same, said in the job's g1t settings.
        assert!(!read(json!({ "environment": "production", "g1t": { "deployment": false } })).unwrap().deploys);
        assert!(!read(json!({ "environment": { "name": "production" }, "g1t": { "deployment": false } })).unwrap().deploys);
        // Only http(s) addresses.
        assert_eq!(read(json!({ "environment": { "name": "production", "url": "javascript:alert(1)" } })).unwrap().url, None);
    }

    #[test]
    fn a_runs_outcome_for_an_environment() {
        let of = |list: &[&str]| deployment_outcome(&list.iter().map(|c| Some((*c).to_owned())).collect::<Vec<_>>());
        assert_eq!(of(&["success", "skipped"]), Some("success"));
        assert_eq!(of(&["success", "failure"]), Some("failure"));
        assert_eq!(of(&["success", "cancelled"]), Some("error"));
        assert_eq!(of(&["skipped"]), None);
        assert_eq!(deployment_outcome(&[None]), None);
    }
}

#[cfg(test)]
mod reruns {
    use serde_json::{Map, Value, json};

    use super::{MAX_SUMMARIES, MAX_SUMMARY_BYTES, Rerun, Scope, Status, call_allowed, call_prefix, debug_logging, rerun_keys, shown_name, summary_fits, top_key};

    /// build ← test ← deploy, and lint on its own.
    fn keys(which: Rerun, failed: &[&str]) -> Vec<String> {
        let order = ["build", "lint", "test", "deploy"];
        let needs = |key: &str| -> Vec<String> {
            match key {
                "test" => vec!["build".into()],
                "deploy" => vec!["test".into()],
                _ => Vec::new(),
            }
        };
        rerun_keys(&order, needs, |key| !failed.contains(&key), which)
    }

    #[test]
    fn a_rerun_takes_the_jobs_it_names_and_those_that_need_them() {
        assert_eq!(keys(Rerun::All, &[]), ["build", "lint", "test", "deploy"]);
        assert_eq!(keys(Rerun::Failed, &["test"]), ["test", "deploy"]);
        assert_eq!(keys(Rerun::Failed, &["lint"]), ["lint"]);
        assert!(keys(Rerun::Failed, &[]).is_empty());
        // One job, whatever it came to, and what depends on it.
        assert_eq!(keys(Rerun::Job("build"), &[]), ["build", "test", "deploy"]);
        assert_eq!(keys(Rerun::Job("lint"), &["test"]), ["lint"]);
        assert_eq!(keys(Rerun::Job("deploy"), &[]), ["deploy"]);
        assert!(keys(Rerun::Job("missing"), &[]).is_empty());
    }

    #[test]
    fn a_called_workflows_jobs_run_again_with_the_job_that_calls_it() {
        assert_eq!(top_key("build/test"), "build");
        assert_eq!(top_key("build/inner/test"), "build");
        assert_eq!(top_key("lint"), "lint");
        // A matrix's calls each have their own jobs, under `key[i]/`.
        assert_eq!(top_key("build[1]/test"), "build");
        assert_eq!(top_key("build/inner[0]/test"), "build");
        assert_eq!(call_prefix("build", Some(1)), "build[1]");
        assert_eq!(call_prefix("build/inner", None), "build/inner");
    }

    #[test]
    fn a_run_connects_ten_levels_of_workflows_and_fifty_reusable_ones() {
        assert!(call_allowed(1, &[], "a.yml").is_ok());
        assert!(call_allowed(9, &[], "a.yml").is_ok());
        let deep = call_allowed(10, &[], "a.yml").unwrap_err();
        assert!(deep.contains("at most ten") && deep.contains("nine levels"), "{deep}");
        let names: Vec<String> = (0..50).map(|n| format!("w{n}.yml")).collect();
        let fifty: Vec<&str> = names.iter().map(String::as_str).collect();
        // A workflow called again, as by each combination of a matrix, is one.
        assert!(call_allowed(1, &fifty, "w3.yml").is_ok());
        assert!(call_allowed(1, &fifty, "another.yml").unwrap_err().contains("at most 50 different"));
    }

    #[test]
    fn a_matrixs_calls_are_named_by_the_caller_and_its_values() {
        let workflow = super::workflow::parse(
            "on: push\njobs:\n  build:\n    name: Build\n    strategy:\n      matrix: { os: [linux], node: [20] }\n    uses: ./.g1t/workflows/b.yml\n  plain:\n    uses: ./.g1t/workflows/b.yml\n  test:\n    name: Test ${{ matrix.os }}\n    strategy:\n      matrix: { os: [linux] }\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]",
        )
        .unwrap();
        let job = |id: &str| workflow.jobs.iter().find(|job| job.id == id).unwrap();
        let combination: Map<String, Value> = serde_json::from_value(json!({ "os": "linux", "node": 20 })).unwrap();
        let mut contexts = Map::new();
        contexts.insert("matrix".into(), Value::Object(combination.clone()));
        let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
        assert_eq!(shown_name(job("build"), None, &combination, &scope), "Build (linux, 20)");
        assert_eq!(shown_name(job("plain"), None, &Map::new(), &scope), "plain");
        // A called workflow's job, under the call that made it.
        assert_eq!(shown_name(job("plain"), Some("Build (linux, 20)"), &Map::new(), &scope), "Build (linux, 20) / plain");
        assert_eq!(shown_name(job("test"), Some("Build"), &combination, &scope), "Build / Test linux");
    }

    #[test]
    fn a_job_keeps_twenty_steps_summaries_of_a_mebibyte_each() {
        assert!(summary_fits(0, None, 10));
        assert!(!summary_fits(0, None, 0), "nothing to keep");
        assert!(!summary_fits(MAX_SUMMARIES, None, 10), "a twenty-first step's summary is dropped");
        assert!(summary_fits(MAX_SUMMARIES, Some(10), 10), "a step that has one may add to it");
        assert!(summary_fits(1, Some(MAX_SUMMARY_BYTES - 10), 10));
        assert!(!summary_fits(1, Some(MAX_SUMMARY_BYTES - 10), 11));
        assert!(!summary_fits(0, None, MAX_SUMMARY_BYTES + 1));
    }

    #[test]
    fn a_debug_rerun_sets_what_github_sets() {
        let mut variables = Map::new();
        let mut runner = json!({ "name": "g1t", "debug": "" });
        debug_logging(&mut variables, &mut runner);
        assert_eq!(variables["RUNNER_DEBUG"], "1");
        assert_eq!(variables["ACTIONS_STEP_DEBUG"], "true");
        assert_eq!(variables["ACTIONS_RUNNER_DEBUG"], "true");
        assert_eq!(runner["debug"], Value::String("1".into()));
        assert_eq!(runner["name"], "g1t");
    }
}
