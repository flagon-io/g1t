//! Runs one GitHub Actions job, as GitHub's runner would: its steps in
//! order, each `run` in a shell and each `uses` as the action it names,
//! with the `${{ }}` contexts, the `GITHUB_*` variables and files, and the
//! workflow commands steps print. It reports every step and the log to
//! g1t as it goes.
//!
//! Configuration comes from the environment: `G1T_API`, and `ACTIONS_JOB`
//! and `ACTIONS_TOKEN`, the job and its own token. Everything else, the
//! job's definition, its contexts and its secrets, is fetched with them.

mod blobs;
mod containers;
mod files;
mod glob;
mod paths;
mod process;
mod report;
mod uses;
mod zip;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use g1t_actions::events::WORKSPACE;
use g1t_actions::expr::{self, Scope, Status};
use serde_json::{Map, Value, json};

use files::StepFiles;
use process::{Commands, Ended};
use report::{Api, Log};

const TEMP: &str = "/home/runner/_temp";

/// Who is running steps: the job itself, or a composite action inside it.
#[derive(Clone, Default)]
pub(crate) struct Frame {
    /// The `steps` context.
    pub(crate) steps: Map<String, Value>,
    /// A composite action's `inputs`, in place of the workflow's.
    pub(crate) inputs: Option<Value>,
    /// A composite action's folder, for `github.action_path`.
    pub(crate) action_path: Option<String>,
    /// Variables a composite action's caller set for its steps.
    pub(crate) env: BTreeMap<String, String>,
}

/// A step run when the job's steps are done: an action's `post`, or
/// saving the cache.
pub(crate) struct Post {
    pub(crate) name: String,
    pub(crate) condition: String,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) run: PostRun,
}

pub(crate) enum PostRun {
    Node { action_dir: PathBuf, script: String },
    CacheSave { key: String, paths: Vec<String> },
    /// A Docker action's `post-entrypoint`.
    Docker(containers::DockerRun),
}

pub(crate) struct Job {
    pub(crate) log: Log,
    pub(crate) spec: Value,
    pub(crate) workspace: PathBuf,
    pub(crate) temp: PathBuf,
    /// This process's own variables, less its credentials, and GitHub's.
    base_env: BTreeMap<String, String>,
    /// Written to `GITHUB_ENV` by earlier steps.
    added_env: BTreeMap<String, String>,
    /// Written to `GITHUB_PATH` by earlier steps, newest first.
    path_prepend: Vec<String>,
    workflow_env: BTreeMap<String, String>,
    job_env: BTreeMap<String, String>,
    /// github, vars, secrets, inputs, matrix, needs, strategy, runner.
    pub(crate) contexts: Map<String, Value>,
    pub(crate) failed: bool,
    pub(crate) posts: Vec<Post>,
    step_names: Vec<String>,
    deadline: Instant,
    debug: bool,
    /// What the last Node process left, for the step that ran it.
    pub(crate) last_node_outputs: BTreeMap<String, String>,
    pub(crate) last_node_state: BTreeMap<String, String>,
    /// The names of the sandbox's own variables, which a container does
    /// not get.
    host_env: BTreeSet<String>,
    /// Whether this job has a Docker Engine of its own (g1t's machines).
    pub(crate) docker_hosted: bool,
    /// The job's network, once its containers have one.
    pub(crate) network: Option<String>,
    /// `services:`, by their names, and their containers' names.
    pub(crate) services: Vec<(String, String)>,
    /// `container:`, once started.
    pub(crate) container: Option<containers::JobContainer>,
    /// The `job` context's `container` and `services`.
    pub(crate) job_context: Map<String, Value>,
    /// Docker actions' images built in this job.
    pub(crate) built_actions: containers::Built,
}

fn text_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(k, v)| (k.clone(), expr::to_text(v))).collect())
        .unwrap_or_default()
}

/// A step's title when it has no name, as GitHub shows it.
fn default_title(step: &Map<String, Value>) -> String {
    if let Some(uses) = step.get("uses").and_then(Value::as_str) {
        return format!("Run {uses}");
    }
    let run = step.get("run").map(expr::to_text).unwrap_or_default();
    let first = run.lines().find(|line| !line.trim().is_empty()).unwrap_or_default().trim();
    format!("Run {first}")
}

impl Job {
    pub(crate) fn base_env_value(&self, name: &str) -> Option<String> {
        self.base_env.get(name).cloned()
    }

    /// What earlier steps added to `PATH`, newest first.
    pub(crate) fn path_prepend_entries(&self) -> &[String] {
        &self.path_prepend
    }

    fn status(&self) -> Status {
        if self.failed { Status::Failure } else { Status::Success }
    }

    /// The contexts an expression in a step can use.
    pub(crate) fn contexts_for(&self, frame: &Frame, env: &BTreeMap<String, String>) -> Map<String, Value> {
        let mut contexts = self.contexts.clone();
        contexts.insert("env".into(), Value::Object(env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()));
        contexts.insert("steps".into(), Value::Object(frame.steps.clone()));
        contexts.insert("job".into(), containers::job_context(if self.failed { "failure" } else { "success" }, &self.job_context));
        if let Some(inputs) = &frame.inputs {
            contexts.insert("inputs".into(), inputs.clone());
        }
        if let Some(path) = &frame.action_path
            && let Some(github) = contexts.get_mut("github")
        {
            github["action_path"] = Value::String(path.clone());
        }
        contexts
    }

    /// Runs `f` with a scope over these contexts.
    pub(crate) fn with_scope<T>(&self, contexts: &Map<String, Value>, f: impl FnOnce(&Scope) -> T) -> T {
        let workspace = self.workspace.clone();
        let hash = move |patterns: &[String]| files::hash_files(&workspace, patterns);
        let scope = Scope {
            contexts,
            status: self.status(),
            hash_files: Some(&hash),
        };
        f(&scope)
    }

    /// The `env` context for a step: the workflow's, the job's, what earlier
    /// steps wrote to `GITHUB_ENV`, and the frame's.
    pub(crate) fn env_context(&self, frame: &Frame) -> BTreeMap<String, String> {
        let mut env = self.added_env.clone();
        env.extend(self.workflow_env.clone());
        env.extend(self.job_env.clone());
        env.extend(frame.env.clone());
        env
    }

    /// What a process for a step is given.
    pub(crate) fn process_env(&self, env: &BTreeMap<String, String>, files: &StepFiles) -> BTreeMap<String, String> {
        let mut out = self.base_env.clone();
        out.extend(env.clone());
        for (name, value) in files.variables() {
            out.insert(name.to_owned(), value);
        }
        if !self.path_prepend.is_empty() {
            let current = out.get("PATH").cloned().unwrap_or_default();
            let separator = paths::PATH_SEPARATOR;
            out.insert("PATH".into(), format!("{}{separator}{current}", self.path_prepend.join(separator)));
        }
        out
    }

    /// Takes in what a step wrote to its files. Returns its outputs.
    pub(crate) fn absorb(&mut self, files: &StepFiles, commands: &Commands) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
        let mut outputs: BTreeMap<String, String> = commands.outputs.clone();
        match files::key_values(&StepFiles::read(&files.output)) {
            Ok(values) => outputs.extend(values),
            Err(problem) => self.log.line(&format!("##[error]$GITHUB_OUTPUT: {problem}")),
        }
        match files::key_values(&StepFiles::read(&files.env)) {
            Ok(values) => {
                for (name, value) in values {
                    if name.starts_with("GITHUB_") || name == "NODE_OPTIONS" {
                        self.log.line(&format!("##[warning]{name} cannot be set through $GITHUB_ENV."));
                        continue;
                    }
                    self.added_env.insert(name, value);
                }
            }
            Err(problem) => self.log.line(&format!("##[error]$GITHUB_ENV: {problem}")),
        }
        for line in StepFiles::read(&files.path).lines().map(str::trim).filter(|l| !l.is_empty()) {
            self.path_prepend.insert(0, line.to_owned());
        }
        let mut state = commands.state.clone();
        if let Ok(values) = files::key_values(&StepFiles::read(&files.state)) {
            state.extend(values);
        }
        let summary = StepFiles::read(&files.summary);
        if !summary.trim().is_empty() {
            self.log.line("##[group]Step summary");
            for line in summary.lines() {
                self.log.line(line);
            }
            self.log.line("##[endgroup]");
        }
        (outputs, state)
    }

    pub(crate) fn remaining_time(&self) -> Duration {
        self.remaining()
    }

    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// Runs a shell script for a `run` step.
    pub(crate) fn run_script(
        &mut self,
        script: &str,
        shell: Option<&str>,
        working_directory: Option<&str>,
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> (bool, BTreeMap<String, String>, BTreeMap<String, String>) {
        crate::abuse::touch();
        // Mining is never a workflow's job (abuse.rs).
        if let Some(miner) = crate::abuse::miner_in(script) {
            self.log.line(&format!("##[error]g1t does not run cryptocurrency miners ({miner}). This step was not run."));
            return (false, BTreeMap::new(), BTreeMap::new());
        }
        let id = format!("{:x}", rand_id());
        let shell = shell.map(str::trim).filter(|s| !s.is_empty());
        let (program, args, extension): (String, Vec<String>, &str) = match shell {
            // A self-hosted Windows runner, as GitHub's: PowerShell.
            None if cfg!(windows) => (windows_powershell(), powershell_args(), "ps1"),
            // A job container without bash, as GitHub's runner does.
            None if self.container.as_ref().is_some_and(|c| c.shell == "sh") => ("sh".into(), vec!["-e".into(), "{0}".into()], "sh"),
            None => ("bash".into(), vec!["-e".into(), "{0}".into()], "sh"),
            Some("bash") => ("bash".into(), vec!["--noprofile".into(), "--norc".into(), "-eo".into(), "pipefail".into(), "{0}".into()], "sh"),
            Some("sh") => ("sh".into(), vec!["-e".into(), "{0}".into()], "sh"),
            Some("python") => ("python3".into(), vec!["{0}".into()], "py"),
            Some("pwsh") if cfg!(windows) || program_exists("pwsh") => ("pwsh".into(), powershell_args(), "ps1"),
            Some("powershell") if cfg!(windows) => ("powershell".into(), powershell_args(), "ps1"),
            Some("cmd") if cfg!(windows) => (
                "cmd".into(),
                vec!["/D".into(), "/E:ON".into(), "/V:OFF".into(), "/S".into(), "/C".into(), "CALL \"{0}\"".into()],
                "cmd",
            ),
            Some(other @ ("pwsh" | "powershell" | "cmd")) => {
                self.log.line(&format!(
                    "##[error]`shell: {other}` needs Windows or PowerShell, which g1t's Linux runners do not have. A self-hosted Windows runner can run it: `runs-on: [self-hosted, windows]`."
                ));
                return (false, BTreeMap::new(), BTreeMap::new());
            }
            Some(custom) => {
                let mut parts = custom.split_whitespace().map(str::to_owned);
                let program = parts.next().unwrap_or_default();
                let mut args: Vec<String> = parts.collect();
                if !args.iter().any(|a| a.contains("{0}")) {
                    args.push("{0}".into());
                }
                (program, args, "sh")
            }
        };
        let script_path = self.temp.join(format!("{id}.{extension}"));
        if let Err(error) = std::fs::write(&script_path, script) {
            self.log.line(&format!("##[error]Could not write the script: {error}"));
            return (false, BTreeMap::new(), BTreeMap::new());
        }
        let files = match StepFiles::new(&self.temp, &id) {
            Ok(files) => files,
            Err(error) => {
                self.log.line(&format!("##[error]Could not make the step's files: {error}"));
                return (false, BTreeMap::new(), BTreeMap::new());
            }
        };
        let args: Vec<String> = args.iter().map(|a| a.replace("{0}", &paths::shown(&script_path))).collect();
        self.log.line(&format!("shell: {program} {}", args.join(" ")));
        let dir = match working_directory {
            Some(dir) if Path::new(dir).is_absolute() => PathBuf::from(dir),
            Some(dir) => self.workspace.join(dir),
            None => self.workspace.clone(),
        };
        let full = self.process_env(env, &files);
        let in_container = self.container.as_ref().map(|c| c.path.clone()).and_then(|image_path| {
            let inside = self.container_env(env, full.clone(), &image_path);
            self.in_container(&program, &args, &dir, inside)
        });
        let command = match in_container {
            Some(command) => command,
            None => {
                let mut command = Command::new(&program);
                command.args(&args).current_dir(&dir).env_clear().envs(full);
                command
            }
        };
        let mut commands = Commands {
            debug: self.debug,
            ..Commands::default()
        };
        let ended = process::run(command, timeout.min(self.remaining()), &mut self.log, &mut commands);
        let ok = match ended {
            Ok(Ended::Exited(0)) => true,
            Ok(Ended::Exited(code)) => {
                self.log.line(&format!("##[error]Process completed with exit code {code}."));
                false
            }
            Ok(Ended::TimedOut) => {
                self.log.line("##[error]The step ran past its time limit and was stopped.");
                false
            }
            Err(error) => {
                self.log.line(&format!("##[error]{program} could not be started: {error}"));
                false
            }
        };
        let (outputs, state) = self.absorb(&files, &commands);
        (ok, outputs, state)
    }

    /// Runs one step of a frame. Returns whether it succeeded (its
    /// conclusion). `number` is the step the log belongs to.
    pub(crate) fn step(&mut self, frame: &mut Frame, step: &Map<String, Value>, number: u32, report: bool, defaults: &Map<String, Value>) -> bool {
        let env_before = self.env_context(frame);
        let contexts = self.contexts_for(frame, &env_before);
        let title = match step.get("name").map(expr::to_text) {
            Some(name) => self.with_scope(&contexts, |scope| expr::interpolate(&name, scope)).unwrap_or(name),
            None => default_title(step),
        };
        let condition = step.get("if").map(expr::to_text).unwrap_or_default();
        let run_it = match self.with_scope(&contexts, |scope| expr::condition(&condition, scope)) {
            Ok(run_it) => run_it,
            Err(problem) => {
                self.log.line(&format!("##[error]The step's `if` does not read: {problem}"));
                self.failed = true;
                if report {
                    self.log.step_state(number, &title, "completed", Some("failure"));
                }
                return false;
            }
        };
        let id = step.get("id").map(expr::to_text);
        if !run_it {
            if let Some(id) = &id {
                frame.steps.insert(id.clone(), json!({ "outputs": {}, "outcome": "skipped", "conclusion": "skipped" }));
            }
            if report {
                self.log.step_state(number, &title, "completed", Some("skipped"));
            }
            return true;
        }
        if report {
            self.log.step(number);
            self.log.step_state(number, &title, "in_progress", None);
        }

        // The step's own env, read with the contexts before it.
        let mut env = env_before.clone();
        if let Some(Value::Object(step_env)) = step.get("env") {
            for (name, value) in step_env {
                let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
                env.insert(name.clone(), expr::to_text(&value));
            }
        }
        let timeout = step
            .get("timeout-minutes")
            .and_then(|v| self.with_scope(&contexts, |scope| expr::interpolate_value(v, scope)).ok())
            .and_then(|v| v.as_f64().or_else(|| expr::to_text(&v).parse().ok()))
            .map_or(Duration::from_secs(6 * 3600), |minutes| Duration::from_secs_f64(minutes * 60.0));
        let continue_on_error = step
            .get("continue-on-error")
            .and_then(|v| self.with_scope(&contexts, |scope| expr::interpolate_value(v, scope)).ok())
            .is_some_and(|v| expr::truthy(&v));

        let (ok, outputs) = if let Some(run) = step.get("run").map(expr::to_text) {
            let script = match self.with_scope(&contexts, |scope| expr::interpolate(&run, scope)) {
                Ok(script) => script,
                Err(problem) => {
                    self.log.line(&format!("##[error]The script does not read: {problem}"));
                    String::new()
                }
            };
            self.log.line(&format!("##[group]{title}"));
            for line in script.lines() {
                self.log.line(line);
            }
            self.log.line("##[endgroup]");
            let shell = step
                .get("shell")
                .map(expr::to_text)
                .or_else(|| defaults.get("shell").map(expr::to_text));
            if frame.action_path.is_some() && shell.is_none() {
                self.log.line("##[error]A composite action's `run` steps need a `shell`.");
                (false, BTreeMap::new())
            } else {
                let working_directory = step
                    .get("working-directory")
                    .or_else(|| defaults.get("working-directory"))
                    .map(|v| self.with_scope(&contexts, |scope| expr::interpolate(&expr::to_text(v), scope)).unwrap_or_else(|_| expr::to_text(v)));
                let mut env = env;
                if let Some(path) = &frame.action_path {
                    env.insert("GITHUB_ACTION_PATH".into(), path.clone());
                }
                let (ok, outputs, _) = self.run_script(&script, shell.as_deref(), working_directory.as_deref(), &env, timeout);
                (ok, outputs)
            }
        } else if let Some(uses) = step.get("uses").map(expr::to_text) {
            let with: BTreeMap<String, String> = match step.get("with") {
                Some(Value::Object(with)) => with
                    .iter()
                    .map(|(k, v)| {
                        let value = self.with_scope(&contexts, |scope| expr::interpolate_value(v, scope)).unwrap_or(Value::Null);
                        (k.clone(), expr::to_text(&value))
                    })
                    .collect(),
                _ => BTreeMap::new(),
            };
            self.uses(&uses, &with, &env, frame, &title, id.as_deref(), timeout)
        } else {
            self.log.line("##[error]A step needs `run` or `uses`.");
            (false, BTreeMap::new())
        };

        let outcome = if ok { "success" } else { "failure" };
        let conclusion = if ok || continue_on_error { "success" } else { "failure" };
        if !ok && continue_on_error {
            self.log.line("##[warning]The step failed, and `continue-on-error` lets the job go on.");
        }
        if let Some(id) = &id {
            let outputs: Map<String, Value> = outputs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            frame.steps.insert(id.clone(), json!({ "outputs": outputs, "outcome": outcome, "conclusion": conclusion }));
        }
        if conclusion == "failure" {
            self.failed = true;
        }
        if report {
            self.log.step_state(number, &title, "completed", Some(conclusion));
        }
        conclusion == "success"
    }

    fn report_steps(&self) {
        self.log.steps(&self.step_names);
    }
}

/// PowerShell on Windows: `pwsh` (PowerShell 7) if it is installed, as on
/// GitHub's Windows runners, else Windows PowerShell.
fn windows_powershell() -> String {
    if program_exists("pwsh") { "pwsh".into() } else { "powershell".into() }
}

/// How GitHub runs a PowerShell step: the script, stopping at the first error.
fn powershell_args() -> Vec<String> {
    vec!["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), ". '{0}'".into()]
}

/// Whether `program` is on `PATH`.
fn program_exists(program: &str) -> bool {
    Command::new(program)
        .arg(if program == "cmd" { "/C" } else { "-Version" })
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// An id for files, unique enough within one job.
fn rand_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    nanos ^ (NEXT.fetch_add(1, Ordering::Relaxed) << 48)
}

fn interpolated_map(job: &Job, value: Option<&Value>, contexts: &Map<String, Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = value {
        for (name, value) in map {
            let value = job.with_scope(contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
            out.insert(name.clone(), expr::to_text(&value));
        }
    }
    out
}

fn setup(mut spec: Value, api: Api) -> Result<Job> {
    let masks: Vec<String> = spec["masks"].as_array().map(|m| m.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let log = Log::new(api, masks);
    // On a self-hosted runner's own machine, GitHub's layout lives in a
    // folder of the runner's (paths.rs).
    for part in ["variables", "github"] {
        paths::relocate(&mut spec[part]);
    }
    paths::relocate(&mut spec["contexts"]["runner"]);
    let workspace = paths::under_home(WORKSPACE);
    let temp = paths::under_home(TEMP);
    std::fs::create_dir_all(&workspace).context("could not make the workspace")?;
    std::fs::create_dir_all(&temp).context("could not make the temporary folder")?;
    std::fs::write(temp.join("event.json"), serde_json::to_string_pretty(&spec["event"])?)?;

    let host_env: BTreeSet<String> = std::env::vars().map(|(name, _)| name).collect();
    // Docker of the job's own, on g1t's machines (crate::docker).
    let docker_hosted = cfg!(target_os = "linux")
        && std::env::var("G1T_DOCKER").as_deref() == Ok("on")
        && spec["variables"]["RUNNER_ENVIRONMENT"].as_str() != Some("self-hosted");
    // This process's environment, less what only it should see.
    let mut base_env: BTreeMap<String, String> =
        std::env::vars().filter(|(name, _)| !matches!(name.as_str(), "ACTIONS_TOKEN" | "ACTIONS_JOB" | "MODE") && !name.starts_with("G1T_")).collect();
    base_env.insert("HOME".into(), std::env::var("HOME").unwrap_or_else(|_| "/home/node".into()));
    base_env.extend(text_map(spec.get("variables")));
    base_env.insert("GITHUB_EVENT_PATH".into(), paths::shown(&temp.join("event.json")));

    let mut contexts: Map<String, Value> = spec["contexts"].as_object().cloned().unwrap_or_default();
    contexts.insert("github".into(), spec["github"].clone());
    let debug = contexts
        .get("secrets")
        .and_then(|s| s.get("ACTIONS_STEP_DEBUG"))
        .or_else(|| contexts.get("vars").and_then(|v| v.get("ACTIONS_STEP_DEBUG")))
        .is_some_and(|v| expr::to_text(v) == "true");

    // `timeoutMinutes` is how the API spelled it before its bodies were
    // `snake_case`.
    let timeout = spec["timeout_minutes"]
        .as_u64()
        .or_else(|| spec["timeoutMinutes"].as_u64())
        .unwrap_or(60);
    let mut job = Job {
        log,
        spec,
        workspace,
        temp,
        base_env,
        added_env: BTreeMap::new(),
        path_prepend: Vec::new(),
        workflow_env: BTreeMap::new(),
        job_env: BTreeMap::new(),
        contexts,
        failed: false,
        posts: Vec::new(),
        step_names: Vec::new(),
        deadline: Instant::now() + Duration::from_secs(timeout * 60),
        debug,
        last_node_outputs: BTreeMap::new(),
        last_node_state: BTreeMap::new(),
        host_env,
        docker_hosted,
        network: None,
        services: Vec::new(),
        container: None,
        job_context: Map::new(),
        built_actions: containers::Built::new(),
    };

    // The workflow's env reads github, secrets, inputs and vars; the job's
    // also its matrix, needs and strategy.
    let mut contexts = job.contexts.clone();
    contexts.insert("env".into(), json!({}));
    job.workflow_env = interpolated_map(&job, job.spec["workflow"].get("env"), &contexts);
    contexts.insert("env".into(), Value::Object(job.workflow_env.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
    job.job_env = interpolated_map(&job, job.spec["spec"].get("env"), &contexts);
    Ok(job)
}

/// The job's `defaults.run`, its own over the workflow's.
fn run_defaults(spec: &Value) -> Map<String, Value> {
    let mut defaults = spec["workflow"]["defaults"]["run"].as_object().cloned().unwrap_or_default();
    if let Some(own) = spec["spec"]["defaults"]["run"].as_object() {
        defaults.extend(own.clone());
    }
    defaults
}

fn run_job(job: &mut Job) {
    let steps: Vec<Map<String, Value>> = job.spec["spec"]["steps"]
        .as_array()
        .map(|steps| steps.iter().filter_map(|s| s.as_object().cloned()).collect())
        .unwrap_or_default();
    let defaults = run_defaults(&job.spec);

    // Step names as they read before anything has run.
    let frame = Frame::default();
    let env = job.env_context(&frame);
    let contexts = job.contexts_for(&frame, &env);
    job.step_names = steps
        .iter()
        .map(|step| match step.get("name").map(expr::to_text) {
            Some(name) => job.with_scope(&contexts, |scope| expr::interpolate(&name, scope)).unwrap_or(name),
            None => default_title(step),
        })
        .collect();
    job.report_steps();

    job.log.step(0);
    job.log.line(&format!("Job: {}", job.spec["name"].as_str().unwrap_or_default()));
    let variables = &job.spec["variables"];
    if variables["RUNNER_ENVIRONMENT"] == "self-hosted" {
        let text = |name: &str| variables[name].as_str().unwrap_or_default().to_owned();
        job.log.line(&format!("Runner: {}, self-hosted, {} {}", text("RUNNER_NAME"), text("RUNNER_OS"), text("RUNNER_ARCH")));
    } else {
        job.log.line("Runner: g1t, Linux X64 (Debian bookworm, Node 24, Python 3, Go, Rust)");
    }
    if let Some(Value::Object(matrix)) = job.contexts.get("matrix")
        && !matrix.is_empty()
    {
        job.log.line(&format!("Matrix: {}", serde_json::to_string(matrix).unwrap_or_default()));
    }
    if job.docker_hosted {
        let registry = job.contexts["github"]["server_url"].as_str().and_then(crate::docker::engine::registry_host);
        let token = job.contexts.get("secrets").and_then(|s| s.get("G1T_TOKEN")).map(expr::to_text).filter(|t| !t.is_empty());
        let options = crate::docker::engine::Options { registry: registry.zip(token) };
        if let Err(problem) = crate::docker::engine::enable(options) {
            job.log.line(&format!("##[warning]Docker is not available in this job: {problem}"));
            job.docker_hosted = false;
        }
    }
    let containers_started = job.start_containers();
    job.log.flush();

    let mut frame = Frame::default();
    if !containers_started {
        job.failed = true;
        for (index, name) in job.step_names.clone().iter().enumerate() {
            job.log.step_state(index as u32 + 1, name, "completed", Some("skipped"));
        }
    }
    for (index, step) in steps.iter().enumerate().filter(|_| containers_started) {
        job.step(&mut frame, step, index as u32 + 1, true, &defaults);
        job.log_docker_notes();
        if job.remaining().is_zero() {
            job.log.line("##[error]The job ran past its time limit.");
            job.failed = true;
            break;
        }
    }

    // Post steps, last registered first.
    let posts: Vec<Post> = std::mem::take(&mut job.posts);
    for post in posts.into_iter().rev() {
        let number = job.step_names.len() as u32 + 1;
        job.step_names.push(post.name.clone());
        job.report_steps();
        let contexts = job.contexts_for(&frame, &job.env_context(&frame));
        let run_it = job.with_scope(&contexts, |scope| expr::condition(&post.condition, scope)).unwrap_or(true);
        if !run_it {
            job.log.step_state(number, &post.name, "completed", Some("skipped"));
            continue;
        }
        job.log.step(number);
        job.log.step_state(number, &post.name, "in_progress", None);
        let ok = match &post.run {
            PostRun::Node { action_dir, script } => job.run_node(action_dir, script, &post.env),
            PostRun::CacheSave { key, paths } => job.cache_save(key, paths),
            PostRun::Docker(run) => job.run_docker(run).0,
        };
        job.log.step_state(number, &post.name, "completed", Some(if ok { "success" } else { "failure" }));
        if !ok {
            job.failed = true;
        }
    }

    // GitHub's "Stop containers": services' logs, and everything removed.
    if job.has_containers() {
        let number = job.step_names.len() as u32 + 1;
        job.step_names.push("Stop containers".into());
        job.report_steps();
        job.log.step(number);
        job.log.step_state(number, "Stop containers", "in_progress", None);
        job.stop_containers();
        job.log.step_state(number, "Stop containers", "completed", Some("success"));
    }

    // The job's outputs, read now that every step has run.
    let env = job.env_context(&frame);
    let contexts = job.contexts_for(&frame, &env);
    let mut outputs = Map::new();
    if let Some(Value::Object(declared)) = job.spec["spec"].get("outputs") {
        for (name, value) in declared {
            let value = job.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
            outputs.insert(name.clone(), Value::String(expr::to_text(&value)));
        }
    }
    let conclusion = if job.failed { "failure" } else { "success" };
    job.log.done(conclusion, &outputs, None);
}

pub(crate) fn main() -> i32 {
    let api = match (crate::env("G1T_API"), crate::env("ACTIONS_JOB"), crate::env("ACTIONS_TOKEN")) {
        (Ok(base), Ok(job), Ok(token)) => Api { base, job, token },
        _ => {
            eprintln!("g1t-runner: G1T_API, ACTIONS_JOB and ACTIONS_TOKEN are needed");
            return 2;
        }
    };
    let spec = match api.spec() {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("g1t-runner: could not fetch the job: {error:#}");
            api.report(json!({ "kind": "done", "conclusion": "failure", "reason": format!("The runner could not fetch the job: {error}") }));
            return 1;
        }
    };
    let reporter = Api {
        base: api.base.clone(),
        job: api.job.clone(),
        token: api.token.clone(),
    };
    let mut job = match setup(spec, reporter) {
        Ok(job) => job,
        Err(error) => {
            api.report(json!({ "kind": "done", "conclusion": "failure", "reason": format!("The runner could not set up: {error:#}") }));
            return 1;
        }
    };
    run_job(&mut job);
    if job.failed { 1 } else { 0 }
}
