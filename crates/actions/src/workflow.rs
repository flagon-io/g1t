//! Reading a workflow file: its triggers, jobs and steps, and notes on
//! anything in it that runs differently on g1t, so moving a repository
//! from GitHub says plainly what to expect.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::filter::{Filter, Patterns};
use crate::permissions::{self, Permissions};
use crate::syntax;

/// Where workflows live: GitHub's `.github/workflows`, under g1t's own
/// folder, so moving a repository to g1t is renaming `.github` to `.g1t`.
/// g1t reads `.github` only for a mirror of a GitHub repository in CI
/// failover or taken over (services/actions/src/mirrored.rs); otherwise it
/// stays GitHub's.
pub const FOLDER: &str = ".g1t/workflows";

/// The events a workflow can name that g1t starts runs for.
pub const SUPPORTED_EVENTS: &[&str] = &[
    "push",
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "issues",
    "issue_comment",
    "schedule",
    "workflow_dispatch",
    "repository_dispatch",
    "workflow_call",
    "workflow_run",
    "merge_group",
    "create",
    "release",
    "deployment",
    "deployment_status",
];

/// Events GitHub has that g1t knows of but never sends: a workflow on one
/// of them is told so, rather than waiting for a run that never comes.
pub const UNSENT_EVENTS: &[(&str, &str)] = &[(
    "delete",
    "g1t does not start runs when a branch or tag is deleted yet, so the `delete` trigger never starts it. New branches and tags start `create` and `push` workflows.",
)];

/// The `types` each event has when a workflow gives none, as on GitHub.
pub fn default_types(event: &str) -> &'static [&'static str] {
    match event {
        "pull_request" | "pull_request_target" => &["opened", "synchronize", "reopened"],
        "merge_group" => &["checks_requested"],
        _ => &[],
    }
}

/// How much a note matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Runs, slightly differently.
    Info,
    /// Runs, but something in it does nothing or may not work.
    Warning,
    /// Does not run on g1t.
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub severity: Severity,
    /// The job, if the note is about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    pub message: String,
}

/// One event a workflow is started by, with its filters.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Trigger {
    pub event: String,
    /// Activity types; empty means the event's defaults (or all).
    pub types: Vec<String>,
    pub branches: Filter,
    pub tags: Filter,
    pub paths: Filter,
    /// For `schedule`.
    pub crons: Vec<String>,
    /// For `workflow_dispatch` and `workflow_call`: the inputs, as written.
    pub inputs: Map<String, Value>,
    /// For `workflow_run`: the names of the workflows it follows.
    pub workflows: Vec<String>,
}

impl Trigger {
    /// Whether an activity type starts it.
    pub fn wants_type(&self, action: Option<&str>) -> bool {
        let Some(action) = action else { return true };
        if self.types.is_empty() {
            // A g1t agent's pull request has no code until it is marked
            // ready, so that is when its default runs start, as `opened`
            // would on GitHub.
            if action == "ready_for_review" && self.event.starts_with("pull_request") && self.event != "pull_request_review" {
                return true;
            }
            let defaults = default_types(&self.event);
            return defaults.is_empty() || defaults.contains(&action);
        }
        self.types.iter().any(|t| t == action)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub id: Option<String>,
    pub name: Option<String>,
    pub condition: Option<String>,
    pub uses: Option<String>,
    pub run: Option<String>,
    /// Its `g1t` settings, as written: g1t's own, beside GitHub's keys.
    pub g1t: Option<Value>,
    /// The whole step as written, for the sandbox.
    pub raw: Value,
}

impl Step {
    /// How the step is shown when it has no name.
    pub fn title(&self) -> String {
        if let Some(name) = &self.name {
            return name.clone();
        }
        if let Some(uses) = &self.uses {
            return format!("Run {uses}");
        }
        let first = self.run.as_deref().unwrap_or_default().lines().find(|line| !line.trim().is_empty()).unwrap_or_default();
        format!("Run {}", first.trim())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// Its key under `jobs:`.
    pub id: String,
    pub name: Option<String>,
    pub needs: Vec<String>,
    pub condition: Option<String>,
    pub runs_on: Value,
    /// `strategy.matrix`, as written (it may be an expression).
    pub matrix: Option<Value>,
    pub fail_fast: bool,
    pub max_parallel: Option<u32>,
    /// A reusable workflow it calls (`uses:` on a job).
    pub uses: Option<String>,
    /// Its own `permissions`, which replace the workflow's.
    pub permissions: Option<Permissions>,
    /// Its own `concurrency`: at most one job of its group runs at a time.
    pub concurrency: Option<Concurrency>,
    pub steps: Vec<Step>,
    /// Its `g1t` settings, as written: g1t's own, beside GitHub's keys.
    pub g1t: Option<Value>,
    /// The whole job as written, for the sandbox.
    pub raw: Value,
}

impl Job {
    /// What its token may do: its own `permissions`, else its workflow's,
    /// else `default` (the repository's choice).
    pub fn permissions(&self, workflow: &Workflow, default: permissions::TokenDefault) -> Permissions {
        self.permissions
            .clone()
            .or_else(|| workflow.permissions.clone())
            .unwrap_or_else(|| Permissions::default_for(default))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Workflow {
    pub name: Option<String>,
    pub run_name: Option<String>,
    pub triggers: Vec<Trigger>,
    pub env: Map<String, Value>,
    pub concurrency: Option<Concurrency>,
    /// Its top-level `permissions`, for every job that writes none.
    pub permissions: Option<Permissions>,
    pub jobs: Vec<Job>,
    pub notes: Vec<Note>,
    /// Its top-level `g1t` settings, as written: g1t's own, beside
    /// GitHub's keys.
    pub g1t: Option<Value>,
    /// The whole workflow as written.
    pub raw: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Concurrency {
    /// May hold an expression.
    pub group: String,
    pub cancel_in_progress: Value,
}

impl Workflow {
    pub fn trigger(&self, event: &str) -> Option<&Trigger> {
        self.triggers.iter().find(|trigger| trigger.event == event)
    }

    /// The name shown for it: its `name`, or its file's path.
    pub fn display_name(&self, path: &str) -> String {
        self.name.clone().unwrap_or_else(|| path.to_owned())
    }

    /// The job ids in an order where each comes after the jobs it needs.
    pub fn job_order(&self) -> Vec<&str> {
        let mut ordered: Vec<&str> = Vec::new();
        while ordered.len() < self.jobs.len() {
            let before = ordered.len();
            for job in &self.jobs {
                if !ordered.contains(&job.id.as_str()) && job.needs.iter().all(|need| ordered.contains(&need.as_str())) {
                    ordered.push(&job.id);
                }
            }
            if ordered.len() == before {
                break;
            }
        }
        ordered
    }
}

/// YAML to JSON, keeping the order of keys. Keys that are not strings
/// (`on: true` in YAML 1.1, numbers) become their text.
pub fn yaml_to_json(value: &serde_yaml::Value) -> Value {
    match value {
        serde_yaml::Value::Null => Value::Null,
        serde_yaml::Value::Bool(flag) => Value::Bool(*flag),
        serde_yaml::Value::Number(number) => {
            if let Some(n) = number.as_i64() {
                Value::from(n)
            } else if let Some(n) = number.as_u64() {
                Value::from(n)
            } else {
                number.as_f64().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
            }
        }
        serde_yaml::Value::String(text) => Value::String(text.clone()),
        serde_yaml::Value::Sequence(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        serde_yaml::Value::Mapping(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                let key = match key {
                    serde_yaml::Value::String(text) => text.clone(),
                    serde_yaml::Value::Bool(flag) => flag.to_string(),
                    serde_yaml::Value::Number(number) => number.to_string(),
                    _ => continue,
                };
                out.insert(key, yaml_to_json(value));
            }
            Value::Object(out)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_to_json(&tagged.value),
    }
}

fn texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn filter(spec: &Map<String, Value>, only: &str, ignore: &str) -> Filter {
    let list = |key: &str| spec.get(key).map(|value| Patterns::new(&texts(Some(value))));
    Filter { only: list(only), ignore: list(ignore) }
}

fn trigger(event: &str, spec: &Value) -> Trigger {
    let mut trigger = Trigger { event: event.to_owned(), ..Trigger::default() };
    match spec {
        Value::Object(spec) => {
            trigger.types = texts(spec.get("types"));
            trigger.branches = filter(spec, "branches", "branches-ignore");
            trigger.tags = filter(spec, "tags", "tags-ignore");
            trigger.paths = filter(spec, "paths", "paths-ignore");
            if let Some(Value::Object(inputs)) = spec.get("inputs") {
                trigger.inputs = inputs.clone();
            }
            trigger.workflows = texts(spec.get("workflows"));
        }
        Value::Array(entries) if event == "schedule" => {
            trigger.crons = entries.iter().filter_map(|entry| text(entry.get("cron"))).collect();
        }
        _ => {}
    }
    trigger
}

/// Reads a workflow. `Err` is what is wrong with the file, for the person
/// who wrote it; what reads but runs differently is in `notes`.
///
/// It accepts what GitHub accepts and refuses what GitHub refuses: every
/// mapping has only the keys GitHub's schema gives it ([`syntax`]), plus
/// `g1t`, g1t's own settings, on the workflow, a job and a step.
pub fn parse(source: &str) -> Result<Workflow, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(source).map_err(|error| format!("It is not valid YAML: {error}"))?;
    if has_merge_key(&yaml) {
        return Err("It uses a YAML merge key (`<<`), which GitHub does not read, so g1t does not either. Write the keys out, or give a whole value an anchor (`&name`) and repeat it with `*name`.".to_owned());
    }
    let raw = yaml_to_json(&yaml);
    let Value::Object(root) = &raw else {
        return Err("A workflow is a mapping with `on` and `jobs`.".to_owned());
    };
    let mut notes = Vec::new();
    let mut note = |severity, job: Option<&str>, message: String| notes.push(Note { severity, job: job.map(str::to_owned), message });
    check_keys(root, syntax::WORKFLOW, true, "", "the workflow")?;

    // `on`, in any of its three shapes.
    let on = root.get("on").ok_or("`on` is missing: say which events start the workflow.")?;
    let known = |event: &str| syntax::event(event).ok_or_else(|| format!("`on`: GitHub has no `{event}` event, so neither does g1t."));
    let mut triggers = Vec::new();
    match on {
        Value::String(event) => {
            known(event)?;
            triggers.push(trigger(event, &Value::Null));
        }
        Value::Array(events) => {
            for event in events {
                let Value::String(event) = event else { return Err("`on` lists event names.".to_owned()) };
                known(event)?;
                triggers.push(trigger(event, &Value::Null));
            }
        }
        Value::Object(events) => {
            for (event, spec) in events {
                check_event(event, known(event)?, spec, &mut note)?;
                triggers.push(trigger(event, spec));
            }
        }
        _ => return Err("`on` is an event, a list of events, or a mapping of events to their filters.".to_owned()),
    }
    for trigger in &triggers {
        if let Some((_, why)) = UNSENT_EVENTS.iter().find(|(event, _)| *event == trigger.event) {
            note(Severity::Unsupported, None, (*why).to_owned());
        } else if !SUPPORTED_EVENTS.contains(&trigger.event.as_str()) {
            note(
                Severity::Unsupported,
                None,
                format!("g1t does not send GitHub's `{}` event, so that trigger never starts it.", trigger.event),
            );
        }
        if trigger.event == "pull_request_target" {
            note(
                Severity::Info,
                None,
                "`pull_request_target` runs in the base's context: the default branch's copy of this workflow, at the default branch's head, with the repository's secrets. It does not check out the pull request's changes; a step that does runs code anyone could have written, with those secrets.".to_owned(),
            );
        }
        if trigger.event == "workflow_call" && triggers.len() == 1 {
            note(Severity::Info, None, "It is a reusable workflow: it runs when another workflow calls it.".to_owned());
        }
    }

    let env = match root.get("env") {
        Some(Value::Object(env)) => env.clone(),
        _ => Map::new(),
    };
    if let Some(defaults) = root.get("defaults") {
        check_defaults(defaults, "")?;
    }
    if let Some(concurrency) = root.get("concurrency") {
        check_concurrency(concurrency, "", None, &mut note)?;
    }
    let concurrency = concurrency_of(root.get("concurrency"));
    let permissions = match root.get("permissions") {
        None => None,
        Some(value) => {
            if let Value::Object(map) = value {
                check_keys(map, syntax::PERMISSIONS, false, "", "`permissions`")?;
            }
            let (permissions, unknown) = permissions::parse(value)?;
            permission_notes(&unknown, None, &mut note);
            Some(permissions)
        }
    };

    let Some(Value::Object(job_specs)) = root.get("jobs") else {
        return Err("`jobs` is missing: a workflow needs at least one job.".to_owned());
    };
    if job_specs.is_empty() {
        return Err("`jobs` is empty: a workflow needs at least one job.".to_owned());
    }
    let mut jobs = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    for (id, spec) in job_specs {
        if !syntax::valid_id(id) {
            return Err(format!("`{id}` is not a job id GitHub accepts: {ID_RULE}"));
        }
        let lower = id.to_ascii_lowercase();
        if let Some(index) = seen_ids.iter().position(|seen| *seen == lower) {
            let other = job_specs.keys().nth(index).cloned().unwrap_or_default();
            return Err(format!("Job `{id}` is already defined as `{other}`: GitHub compares job ids without case."));
        }
        seen_ids.push(lower);
        let Value::Object(spec) = spec else {
            return Err(format!("Job `{id}` is a mapping."));
        };
        let place = format!("Job `{id}`");
        let uses = text(spec.get("uses"));
        if spec.contains_key("uses") {
            for key in ["runs-on", "steps"] {
                if spec.contains_key(key) {
                    return Err(format!("Job `{id}` calls a reusable workflow with `uses`, so it has no `{key}`: the called workflow's jobs say that."));
                }
            }
            check_keys(spec, syntax::CALLER_JOB, true, &place, "a job that calls a reusable workflow")?;
            if uses.as_deref().is_none_or(|uses| uses.trim().is_empty()) {
                return Err(format!("Job `{id}`: `uses` names the reusable workflow it calls."));
            }
            match spec.get("secrets") {
                None | Some(Value::Object(_)) => {}
                Some(Value::String(inherit)) if inherit == "inherit" => {}
                Some(_) => return Err(format!("Job `{id}`: `secrets` is a mapping of the secrets it passes, or `inherit`.")),
            }
        } else {
            check_keys(spec, syntax::JOB, true, &place, "a job")?;
            if !spec.contains_key("runs-on") {
                return Err(format!("Job `{id}` has no `runs-on`: say which runner it runs on, such as `runs-on: ubuntu-latest`."));
            }
        }
        check_job_parts(id, spec, &mut note)?;
        let steps_raw = match spec.get("steps") {
            Some(Value::Array(steps)) => steps.clone(),
            None if uses.is_some() => Vec::new(),
            None => return Err(format!("Job `{id}` has no `steps`.")),
            Some(_) => return Err(format!("Job `{id}`: `steps` is a list.")),
        };
        let runs_on = spec.get("runs-on").cloned().unwrap_or(Value::Null);
        let labels: Vec<String> =
            texts(Some(&runs_on)).into_iter().chain(runs_on.get("labels").map(|l| texts(Some(l))).unwrap_or_default()).collect();
        // `self-hosted`, or a runner group, sends the job to the workspace's
        // own runners, which may be Linux, macOS or Windows.
        let self_hosted = runs_on.get("group").is_some() || labels.iter().any(|label| label.eq_ignore_ascii_case("self-hosted"));
        let mut steps = Vec::new();
        let mut step_ids: Vec<String> = Vec::new();
        for (index, step) in steps_raw.iter().enumerate() {
            let place = format!("Job `{id}`, step {}", index + 1);
            let Value::Object(fields) = step else {
                return Err(format!("{place}: a step is a mapping."));
            };
            if let Some(key) = syntax::BACKGROUND_STEPS.iter().find(|key| fields.contains_key(**key)) {
                return Err(format!(
                    "{place}: `{key}` is one of GitHub's background steps (`background`, `wait`, `wait-all`, `cancel`, `parallel`), which g1t does not run yet."
                ));
            }
            let step = Step {
                id: text(fields.get("id")),
                name: text(fields.get("name")),
                condition: text(fields.get("if")),
                uses: text(fields.get("uses")),
                run: text(fields.get("run")),
                g1t: fields.get(syntax::EXTENSION).cloned(),
                raw: step.clone(),
            };
            match (&step.uses, &step.run) {
                (Some(_), Some(_)) => return Err(format!("{place}: a step has `uses` or `run`, not both.")),
                (None, None) => return Err(format!("{place}: a step needs `uses` or `run`.")),
                (Some(_), None) => check_keys(fields, syntax::ACTION_STEP, true, &place, "a step that uses an action")?,
                (None, Some(_)) => check_keys(fields, syntax::RUN_STEP, true, &place, "a step that runs a command")?,
            }
            if let Some(step_id) = &step.id {
                if !syntax::valid_id(step_id) {
                    return Err(format!("{place}: `{step_id}` is not a step id GitHub accepts: {ID_RULE}"));
                }
                let lower = step_id.to_ascii_lowercase();
                if step_ids.contains(&lower) {
                    return Err(format!("{place}: another step of job `{id}` has the id `{step_id}` already (GitHub compares step ids without case)."));
                }
                step_ids.push(lower);
            }
            if let Some(uses) = &step.uses
                && let Some((severity, message)) = action_note(uses, fields.get("with").and_then(|with| with.get("cache")).is_some())
            {
                note(severity, Some(id), message);
            }
            if let Some(shell) = text(fields.get("shell"))
                && !self_hosted
                && matches!(shell.as_str(), "pwsh" | "powershell" | "cmd")
            {
                note(Severity::Unsupported, Some(id), format!("Steps with `shell: {shell}` need Windows or PowerShell, which g1t's Linux runners do not have."));
            }
            steps.push(step);
        }
        if self_hosted {
            note(
                Severity::Info,
                Some(id),
                "`self-hosted`: the job runs on one of the workspace's self-hosted runners that has every label in its `runs-on`, and waits until one does.".to_owned(),
            );
        } else {
            for label in &labels {
                let lower = label.to_ascii_lowercase();
                if lower.contains("windows") || lower.contains("macos") {
                    note(
                        Severity::Unsupported,
                        Some(id),
                        format!("`runs-on: {label}`: g1t's own runners are Linux only, so this job fails. To run it on a Windows or macOS machine of your own, add a self-hosted runner and use `runs-on: [self-hosted, ...]`."),
                    );
                }
            }
        }
        if spec.contains_key("services") {
            note(
                Severity::Info,
                Some(id),
                "`services`: each service runs in Docker beside the steps and is reached at `localhost:<port>`. On g1t's machines it is the job's own Docker Engine, the service is also reached by its name, and two services cannot listen on the same port.".to_owned(),
            );
        }
        if spec.contains_key("container") {
            note(
                Severity::Info,
                Some(id),
                "`container`: the steps run inside that image, in Docker (on g1t's machines, the job's own Engine), with the workspace at the same path as on the runner (`/home/runner/work`), not `/__w`.".to_owned(),
            );
        }
        if spec.contains_key("environment") {
            note(Severity::Info, Some(id), "`environment`: the job gets the values its secrets and variables give this environment once the environment's protection rules (required reviewers, a wait timer, which branches may deploy) let it through. Unless it says `deployment: false`, the run records a deployment to it.".to_owned());
        }
        let job_permissions = match spec.get("permissions") {
            None => None,
            Some(value) => {
                if let Value::Object(map) = value {
                    check_keys(map, syntax::PERMISSIONS, false, &place, "`permissions`")?;
                }
                let (permissions, unknown) = permissions::parse(value).map_err(|problem| format!("Job `{id}`: {problem}"))?;
                permission_notes(&unknown, Some(id), &mut note);
                Some(permissions)
            }
        };
        let (matrix, fail_fast, max_parallel) = match spec.get("strategy") {
            Some(Value::Object(strategy)) => (
                strategy.get("matrix").cloned(),
                strategy.get("fail-fast").and_then(Value::as_bool).unwrap_or(true),
                strategy.get("max-parallel").and_then(Value::as_u64).map(|n| n as u32),
            ),
            _ => (None, true, None),
        };
        if let Some(called) = uses.as_deref().filter(|uses| !uses.starts_with("./")) {
            note(
                Severity::Info,
                Some(id),
                format!(
                    "`{called}` is read from that repository on g1t when it is there and this repository may use it (a private one allows it under Settings, Actions, Access), and otherwise from a public repository on GitHub."
                ),
            );
        }
        jobs.push(Job {
            id: id.clone(),
            name: text(spec.get("name")),
            needs: texts(spec.get("needs")),
            condition: text(spec.get("if")),
            runs_on,
            matrix,
            fail_fast,
            max_parallel,
            uses,
            permissions: job_permissions,
            concurrency: concurrency_of(spec.get("concurrency")),
            steps,
            g1t: spec.get(syntax::EXTENSION).cloned(),
            raw: Value::Object(spec.clone()),
        });
    }
    for job in &jobs {
        for need in &job.needs {
            if !jobs.iter().any(|other| &other.id == need) {
                return Err(format!("Job `{}` needs `{need}`, and there is no job called that.", job.id));
            }
        }
    }
    let workflow = Workflow {
        name: text(root.get("name")),
        run_name: text(root.get("run-name")),
        triggers,
        env,
        concurrency,
        permissions,
        jobs,
        notes,
        g1t: root.get(syntax::EXTENSION).cloned(),
        raw,
    };
    if workflow.job_order().len() < workflow.jobs.len() {
        return Err("The jobs' `needs` go round in a circle.".to_owned());
    }
    Ok(workflow)
}

/// Whether a job (as written) records a deployment to its environment:
/// unless it says `deployment: false`, in its `environment` as on GitHub,
/// or in its `g1t` settings.
pub fn records_deployment(job: &Value) -> bool {
    let off = |value: Option<&Value>| match value {
        Some(Value::Bool(flag)) => !flag,
        Some(Value::String(text)) => text.trim() == "false",
        _ => false,
    };
    !off(job.get("environment").and_then(|environment| environment.get("deployment")))
        && !off(job.get(syntax::EXTENSION).and_then(|settings| settings.get("deployment")))
}

/// GitHub's rule for job and step ids, as said when one breaks it.
const ID_RULE: &str = "it starts with a letter or `_`, has only letters, digits, `-` and `_`, is under 100 characters, and does not start with `__`.";

/// Whether a YAML merge key (`<<`) is anywhere in it.
fn has_merge_key(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::Mapping(map) => map.iter().any(|(key, value)| key.as_str() == Some("<<") || has_merge_key(value)),
        serde_yaml::Value::Sequence(items) => items.iter().any(has_merge_key),
        serde_yaml::Value::Tagged(tagged) => has_merge_key(&tagged.value),
        _ => false,
    }
}

/// Keys as a sentence: `a`, `b` or `c`.
fn listed(keys: &[&str]) -> String {
    let quoted: Vec<String> = keys.iter().map(|key| format!("`{key}`")).collect();
    match quoted.split_last() {
        None => String::new(),
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
    }
}

/// `message`, said of `place` ("Job `build`, step 2"), or on its own for
/// the workflow's top level.
fn at(place: &str, message: &str) -> String {
    if place.is_empty() {
        let mut chars = message.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
    } else {
        format!("{place}: {message}")
    }
}

/// Refuses any key of `map` that is not `allowed`, as GitHub does
/// ("Unexpected value"). With `extension`, `g1t` is allowed too, as a
/// mapping of anything. `what` names the mapping in the message.
fn check_keys(map: &Map<String, Value>, allowed: &[&str], extension: bool, place: &str, what: &str) -> Result<(), String> {
    for (key, value) in map {
        if extension && key == syntax::EXTENSION {
            if !value.is_object() {
                return Err(at(place, "`g1t` is a mapping of g1t's own settings."));
            }
            continue;
        }
        if !allowed.contains(&key.as_str()) {
            return Err(at(place, &format!("unexpected `{key}` in {what}; it can have {}.", listed(allowed))));
        }
    }
    Ok(())
}

/// Refuses a mapping without `key`.
fn require(map: &Map<String, Value>, key: &str, place: &str, what: &str) -> Result<(), String> {
    if map.contains_key(key) { Ok(()) } else { Err(at(place, &format!("{what} needs `{key}`."))) }
}

/// One event under `on` and what it is given.
fn check_event(event: &str, kind: syntax::EventSpec, spec: &Value, note: &mut impl FnMut(Severity, Option<&str>, String)) -> Result<(), String> {
    let what = format!("`on.{event}`");
    match (kind, spec) {
        (syntax::EventSpec::Schedule, Value::Array(entries)) => {
            for entry in entries {
                let Value::Object(entry) = entry else { return Err("`on.schedule` is a list of `cron:` entries.".to_owned()) };
                check_keys(entry, syntax::CRON, false, "", "an entry of `on.schedule`")?;
                require(entry, "cron", "", "Each entry of `on.schedule`")?;
                if entry.contains_key("timezone") {
                    note(
                        Severity::Warning,
                        None,
                        "`on.schedule`: g1t reads every `cron` in UTC and does not read `timezone` yet, so the schedule runs at those times in UTC.".to_owned(),
                    );
                }
            }
            Ok(())
        }
        (syntax::EventSpec::Schedule, _) => Err("`on.schedule` is a list of `cron:` entries.".to_owned()),
        (_, Value::Null) => Ok(()),
        (syntax::EventSpec::Bare, _) => Err(format!("{what} takes no settings: write `{event}:` with nothing after it.")),
        (syntax::EventSpec::Filters(keys), Value::Object(map)) => {
            check_keys(map, keys, false, "", &what)?;
            for only in ["branches", "tags", "paths"] {
                let ignore = format!("{only}-ignore");
                if map.contains_key(only) && map.contains_key(&ignore) {
                    return Err(format!(
                        "{what} has both `{only}` and `{ignore}`: GitHub takes one or the other for an event. To leave some out of `{only}`, start a pattern with `!`."
                    ));
                }
            }
            let definitions = |key: &str| -> Result<Vec<(&String, &Value)>, String> {
                match map.get(key) {
                    None | Some(Value::Null) => Ok(Vec::new()),
                    Some(Value::Object(entries)) => Ok(entries.iter().collect()),
                    Some(_) => Err(format!("`on.{event}.{key}` is a mapping of names to their definitions.")),
                }
            };
            if event == "workflow_dispatch" {
                for (name, input) in definitions("inputs")? {
                    match input {
                        Value::Null => {}
                        Value::Object(input) => check_keys(input, syntax::DISPATCH_INPUT, false, "", &format!("input `{name}` of {what}"))?,
                        _ => return Err(format!("Input `{name}` of {what} is a mapping.")),
                    }
                }
            }
            if event == "workflow_call" {
                for (name, input) in definitions("inputs")? {
                    let Value::Object(input) = input else { return Err(format!("Input `{name}` of {what} is a mapping with its `type`.")) };
                    let place = format!("input `{name}` of {what}");
                    check_keys(input, syntax::CALL_INPUT, false, "", &place)?;
                    require(input, "type", "", &format!("Input `{name}` of {what}"))?;
                }
                for (name, output) in definitions("outputs")? {
                    let Value::Object(output) = output else { return Err(format!("Output `{name}` of {what} is a mapping with its `value`.")) };
                    check_keys(output, syntax::CALL_OUTPUT, false, "", &format!("output `{name}` of {what}"))?;
                    require(output, "value", "", &format!("Output `{name}` of {what}"))?;
                }
                for (name, secret) in definitions("secrets")? {
                    match secret {
                        Value::Null => {}
                        Value::Object(secret) => check_keys(secret, syntax::CALL_SECRET, false, "", &format!("secret `{name}` of {what}"))?,
                        _ => return Err(format!("Secret `{name}` of {what} is a mapping, or nothing.")),
                    }
                }
            }
            Ok(())
        }
        (syntax::EventSpec::Filters(_), _) => Err(format!("{what} is a mapping of its filters, or nothing.")),
    }
}

/// `defaults`, at the top level or on a job.
fn check_defaults(value: &Value, place: &str) -> Result<(), String> {
    let Value::Object(defaults) = value else { return Err(at(place, "`defaults` is a mapping with `run`.")) };
    check_keys(defaults, syntax::DEFAULTS, false, place, "`defaults`")?;
    match defaults.get("run") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(run)) => check_keys(run, syntax::DEFAULTS_RUN, false, place, "`defaults.run`"),
        Some(_) => Err(at(place, "`defaults.run` is a mapping with `shell` or `working-directory`.")),
    }
}

/// `concurrency`, at the top level or on a job (`job`).
fn check_concurrency(value: &Value, place: &str, job: Option<&str>, note: &mut impl FnMut(Severity, Option<&str>, String)) -> Result<(), String> {
    let Value::Object(concurrency) = value else { return Ok(()) };
    check_keys(concurrency, syntax::CONCURRENCY, false, place, "`concurrency`")?;
    require(concurrency, "group", place, "`concurrency`")?;
    if let Some(queue) = concurrency.get("queue")
        && text(Some(queue)).as_deref() != Some("single")
    {
        note(
            Severity::Warning,
            job,
            "`concurrency.queue`: g1t keeps one run or job waiting in a group, as `queue: single` does, and does not read `queue` yet.".to_owned(),
        );
    }
    Ok(())
}

/// A job's mappings other than its steps: each has only GitHub's keys.
fn check_job_parts(id: &str, spec: &Map<String, Value>, note: &mut impl FnMut(Severity, Option<&str>, String)) -> Result<(), String> {
    let place = format!("Job `{id}`");
    let credentials = |container: &Map<String, Value>, what: &str| -> Result<(), String> {
        match container.get("credentials") {
            Some(Value::Object(credentials)) => check_keys(credentials, syntax::CREDENTIALS, false, &place, &format!("the `credentials` of {what}")),
            _ => Ok(()),
        }
    };
    if let Some(Value::Object(runs_on)) = spec.get("runs-on") {
        check_keys(runs_on, syntax::RUNS_ON, false, &place, "`runs-on`")?;
    }
    if let Some(Value::Object(strategy)) = spec.get("strategy") {
        check_keys(strategy, syntax::STRATEGY, false, &place, "`strategy`")?;
    }
    if let Some(Value::Object(container)) = spec.get("container") {
        check_keys(container, syntax::CONTAINER, false, &place, "`container`")?;
        credentials(container, "`container`")?;
    }
    if let Some(Value::Object(services)) = spec.get("services") {
        for (name, service) in services {
            if let Value::Object(service) = service {
                let what = format!("service `{name}`");
                check_keys(service, syntax::SERVICE, false, &place, &what)?;
                credentials(service, &what)?;
            }
        }
    }
    if let Some(Value::Object(environment)) = spec.get("environment") {
        check_keys(environment, syntax::ENVIRONMENT, false, &place, "`environment`")?;
        require(environment, "name", &place, "`environment`")?;
    }
    if let Some(concurrency) = spec.get("concurrency") {
        check_concurrency(concurrency, &place, Some(id), note)?;
    }
    if let Some(defaults) = spec.get("defaults") {
        check_defaults(defaults, &place)?;
    }
    if spec.contains_key("snapshot") {
        note(Severity::Unsupported, Some(id), "`snapshot`: g1t does not make custom runner images from a job yet, so the job runs and no image is made.".to_owned());
    }
    if spec.contains_key("cancel-timeout-minutes") {
        note(Severity::Warning, Some(id), "`cancel-timeout-minutes`: g1t does not read it yet, so a cancelled job stops in its usual time.".to_owned());
    }
    Ok(())
}

/// `concurrency`, as a group's name or a mapping with `group` and
/// `cancel-in-progress`.
fn concurrency_of(value: Option<&Value>) -> Option<Concurrency> {
    match value {
        Some(Value::String(group)) => Some(Concurrency { group: group.clone(), cancel_in_progress: Value::Bool(false) }),
        Some(Value::Object(spec)) => text(spec.get("group")).map(|group| Concurrency {
            group,
            cancel_in_progress: spec.get("cancel-in-progress").cloned().unwrap_or(Value::Bool(false)),
        }),
        _ => None,
    }
}

/// What to say about `permissions` names GitHub has that g1t's token has
/// nothing behind.
fn permission_notes(unknown: &[String], job: Option<&str>, note: &mut impl FnMut(Severity, Option<&str>, String)) {
    for name in unknown {
        note(Severity::Warning, job, format!("`permissions.{name}`: g1t's token has nothing behind that permission yet, so it grants nothing."));
    }
}

/// What to say about an action g1t runs differently, if anything.
/// `caches`: the step sets a `cache` input.
fn action_note(uses: &str, caches: bool) -> Option<(Severity, String)> {
    if uses.starts_with("docker://") {
        return Some((Severity::Info, format!("`{uses}` runs in Docker (on g1t's machines, the job's own Engine).")));
    }
    let name = uses.split('@').next().unwrap_or(uses).to_ascii_lowercase();
    match name.as_str() {
        "actions/checkout" => Some((Severity::Info, "`actions/checkout` checks out from g1t.".to_owned())),
        "actions/cache" | "actions/cache/restore" | "actions/cache/save" => Some((
            Severity::Info,
            format!("`{name}`: g1t keeps the cache per repository: up to 2 GiB an entry and 10 GiB a repository, until it goes 7 days unused, and at most 28 days."),
        )),
        "actions/upload-artifact" | "actions/download-artifact" => Some((
            Severity::Info,
            format!("`{name}`: g1t keeps artifacts with the run for 14 days, up to 60 MB each."),
        )),
        _ if caches && name.starts_with("actions/setup-") => Some((
            Severity::Warning,
            format!("`{name}` with `cache:` runs without that cache on g1t. Add an `actions/cache` step for the same effect."),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CI: &str = r#"
name: CI
on:
  push:
    branches: [main]
    paths-ignore: ["docs/**"]
  pull_request:
  workflow_dispatch:
    inputs:
      debug:
        type: boolean
        default: false
  schedule:
    - cron: "0 3 * * *"
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
env:
  CARGO_TERM_COLOR: always
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - name: Test
        run: npm test
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
"#;

    #[test]
    fn a_whole_workflow_reads() {
        let workflow = parse(CI).unwrap();
        assert_eq!(workflow.name.as_deref(), Some("CI"));
        assert_eq!(workflow.triggers.iter().map(|t| t.event.as_str()).collect::<Vec<_>>(), ["push", "pull_request", "workflow_dispatch", "schedule"]);
        let push = workflow.trigger("push").unwrap();
        assert!(push.branches.allows("main"));
        assert!(!push.branches.allows("dev"));
        assert!(!push.paths.allows_paths(&["docs/a.md".into()]));
        assert_eq!(workflow.trigger("schedule").unwrap().crons, ["0 3 * * *"]);
        assert!(workflow.trigger("workflow_dispatch").unwrap().inputs.contains_key("debug"));
        assert_eq!(workflow.concurrency.as_ref().unwrap().group, "ci-${{ github.ref }}");
        assert_eq!(workflow.jobs.len(), 2);
        assert_eq!(workflow.jobs[1].needs, ["test"]);
        assert_eq!(workflow.jobs[0].steps[0].title(), "Run actions/checkout@v7");
        assert_eq!(workflow.jobs[0].steps[2].title(), "Run npm ci");
        assert_eq!(workflow.jobs[0].steps[3].title(), "Test");
        assert_eq!(workflow.job_order(), ["test", "deploy"]);
        assert_eq!(workflow.env["CARGO_TERM_COLOR"], "always");
    }

    #[test]
    fn short_forms_of_on() {
        let one = parse("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert_eq!(one.triggers[0].event, "push");
        let list = parse("on: [push, pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert_eq!(list.triggers.len(), 2);
        let pr = list.trigger("pull_request").unwrap();
        assert!(pr.wants_type(Some("opened")));
        assert!(pr.wants_type(Some("synchronize")));
        assert!(!pr.wants_type(Some("closed")));
        assert!(pr.wants_type(Some("ready_for_review")));
        let typed = parse("on:\n  pull_request:\n    types: [closed]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert!(typed.trigger("pull_request").unwrap().wants_type(Some("closed")));
        assert!(!typed.trigger("pull_request").unwrap().wants_type(Some("opened")));
    }

    #[test]
    fn notes_say_what_runs_differently() {
        let workflow = parse(
            "on: [push, watch]\njobs:\n  win:\n    runs-on: windows-latest\n    services:\n      db: { image: postgres }\n    steps:\n      - uses: actions/cache@v6\n      - uses: actions/setup-node@v7\n        with: { cache: npm }\n      - uses: docker://alpine\n      - run: dir\n        shell: pwsh",
        )
        .unwrap();
        let unsupported: Vec<&str> =
            workflow.notes.iter().filter(|n| n.severity == Severity::Unsupported).map(|n| n.message.as_str()).collect();
        assert!(unsupported.iter().any(|m| m.contains("`watch`")));
        let released = parse("on:\n  release:\n    types: [published]\n  deployment_status:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert!(!released.notes.iter().any(|n| n.severity == Severity::Unsupported));
        assert!(released.trigger("release").unwrap().wants_type(Some("published")));
        assert!(!released.trigger("release").unwrap().wants_type(Some("created")));
        assert!(released.trigger("deployment_status").unwrap().wants_type(Some("created")));
        assert!(unsupported.iter().any(|m| m.contains("windows-latest")));
        assert!(!unsupported.iter().any(|m| m.contains("services")));
        assert!(!unsupported.iter().any(|m| m.contains("docker://alpine")));
        assert!(workflow.notes.iter().any(|n| n.severity == Severity::Info && n.message.contains("own Docker Engine") && n.message.contains("localhost")));
        assert!(workflow.notes.iter().any(|n| n.severity == Severity::Info && n.message.starts_with("`docker://alpine`")));
        assert!(unsupported.iter().any(|m| m.contains("pwsh")));
        assert!(workflow.notes.iter().any(|n| n.severity == Severity::Info && n.message.contains("actions/cache")));
        assert!(workflow.notes.iter().any(|n| n.severity == Severity::Warning && n.message.contains("actions/setup-node")));
        assert!(workflow.notes.iter().any(|n| n.message.contains("2 GiB an entry")));
    }

    #[test]
    fn self_hosted_jobs_may_run_on_any_os() {
        let workflow = parse(
            "on: push
jobs:
  win:
    runs-on: [self-hosted, windows]
    steps:
      - run: dir
        shell: pwsh
  mac:
    runs-on: { group: Macs, labels: [macos] }
    steps: [{ run: 'true' }]",
        )
        .unwrap();
        assert!(!workflow.notes.iter().any(|n| n.severity == Severity::Unsupported), "{:?}", workflow.notes);
        let routed: Vec<&str> = workflow.notes.iter().filter(|n| n.message.starts_with("`self-hosted`")).map(|n| n.message.as_str()).collect();
        assert_eq!(routed.len(), 2);
        assert!(routed.iter().all(|m| m.contains("self-hosted runners") && !m.contains("Linux")));
    }

    #[test]
    fn permissions_are_read_at_both_levels() {
        use crate::permissions::{Access, TokenDefault};
        let workflow = parse(
            "on: push
permissions:
  contents: read
  pull-requests: write
jobs:
  plain:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps: [{ run: 'true' }]
  quiet:
    runs-on: ubuntu-latest
    permissions: {}
    steps: [{ run: 'true' }]",
        )
        .unwrap();
        let plain = workflow.jobs[0].permissions(&workflow, TokenDefault::Restricted);
        assert_eq!(plain.get("pull-requests"), Access::Write);
        assert_eq!(plain.get("contents"), Access::Read);
        // A job's own permissions replace the workflow's whole.
        let release = workflow.jobs[1].permissions(&workflow, TokenDefault::Permissive);
        assert_eq!(release.get("contents"), Access::Write);
        assert_eq!(release.get("pull-requests"), Access::None);
        assert_eq!(workflow.jobs[2].permissions(&workflow, TokenDefault::Permissive).scopes(), ["repo:read"]);
        // Without any, the repository's default.
        let bare = parse("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert_eq!(bare.jobs[0].permissions(&bare, TokenDefault::Restricted).get("contents"), Access::Read);
        assert_eq!(bare.jobs[0].permissions(&bare, TokenDefault::Restricted).get("issues"), Access::None);
        assert_eq!(bare.jobs[0].permissions(&bare, TokenDefault::Permissive).get("issues"), Access::Write);
        // What reads but grants nothing is said.
        let odd = parse("on: push\npermissions: { id-token: write, artifact-metadata: read }\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").unwrap();
        assert!(!odd.notes.iter().any(|n| n.message.contains("id-token")), "OIDC tokens are issued");
        assert!(odd.notes.iter().any(|n| n.severity == Severity::Warning && n.message.contains("`permissions.artifact-metadata`")));
        // A name GitHub's token does not have is refused, as GitHub does;
        // `metadata` is always `read` and cannot be written.
        for name in ["wiki", "metadata"] {
            let problem = parse(&format!("on: push\npermissions: {{ {name}: read }}\njobs:\n  a:\n    runs-on: x\n    steps: [{{ run: 'true' }}]")).unwrap_err();
            assert!(problem.contains(&format!("Unexpected `{name}` in `permissions`")), "{problem}");
        }
        assert!(parse("on: push\npermissions: read\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").unwrap_err().contains("read-all"));
        assert!(
            parse("on: push\njobs:\n  a:\n    runs-on: x\n    permissions: { contents: admin }\n    steps: [{ run: 'true' }]")
                .unwrap_err()
                .contains("Job `a`")
        );
    }

    #[test]
    fn a_job_has_its_own_concurrency() {
        let workflow = parse(
            "on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy-${{ github.ref }}
      cancel-in-progress: true
    steps: [{ run: 'true' }]
  named:
    runs-on: ubuntu-latest
    concurrency: just-one
    steps: [{ run: 'true' }]",
        )
        .unwrap();
        let deploy = workflow.jobs[0].concurrency.as_ref().unwrap();
        assert_eq!(deploy.group, "deploy-${{ github.ref }}");
        assert_eq!(deploy.cancel_in_progress, Value::Bool(true));
        assert_eq!(workflow.jobs[1].concurrency.as_ref().unwrap().group, "just-one");
        assert!(workflow.concurrency.is_none());
    }

    #[test]
    fn events_g1t_never_sends_are_said_and_pull_request_target_is_the_base() {
        let workflow = parse("on: [create, delete, repository_dispatch, pull_request_target]\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").unwrap();
        let unsupported: Vec<&str> = workflow.notes.iter().filter(|n| n.severity == Severity::Unsupported).map(|n| n.message.as_str()).collect();
        assert_eq!(unsupported.len(), 1, "{unsupported:?}");
        assert!(unsupported[0].contains("`delete`"));
        let target = workflow.notes.iter().find(|n| n.message.starts_with("`pull_request_target`")).unwrap();
        assert!(target.message.contains("default branch"));
        assert!(!target.message.contains("on the pull request's head"));
    }

    #[test]
    fn mistakes_are_explained() {
        let problem = |yaml: &str| parse(yaml).unwrap_err();
        assert!(problem("jobs: {}").contains("`on` is missing"));
        assert!(problem("on: push").contains("`jobs` is missing"));
        assert!(problem("on: push\njobs:\n  a:\n    runs-on: x").contains("no `steps`"));
        assert!(problem("on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ name: nothing }]").contains("`uses` or `run`"));
        assert!(problem("on: push\njobs:\n  a:\n    needs: b\n    runs-on: x\n    steps: [{ run: x }]").contains("no job called that"));
        assert!(
            problem("on: push\njobs:\n  a:\n    needs: b\n    runs-on: x\n    steps: [{ run: x }]\n  b:\n    needs: a\n    runs-on: x\n    steps: [{ run: x }]")
                .contains("circle")
        );
        assert!(problem("on: push\njobs: [1]").contains("`jobs`"));
        assert!(problem(": : :").contains("not valid YAML"));
    }

    #[test]
    fn only_githubs_keys_and_g1ts_own() {
        let problem = |yaml: &str| parse(yaml).unwrap_err();
        let job = "\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: 'true' }]";
        assert!(problem(&format!("on: push\nrun_name: x{job}")).starts_with("Unexpected `run_name` in the workflow; it can have `on`, "));
        assert!(problem("on: push\njobs:\n  build:\n    runs-on: x\n    step: []").starts_with("Job `build`: unexpected `step` in a job;"));
        let step = problem("on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: 'true'\n      - uses: actions/checkout@v5\n        shell: bash");
        assert!(step.starts_with("Job `build`, step 2: unexpected `shell` in a step that uses an action;"), "{step}");
        assert!(problem("on: push\njobs:\n  build:\n    steps: [{ run: 'true' }]").contains("no `runs-on`"));
        assert!(problem("on: push\njobs:\n  build:\n    uses: ./.g1t/workflows/b.yml\n    runs-on: x").contains("no `runs-on`"));
        assert!(problem("on: push\njobs:\n  my.job:\n    runs-on: x\n    steps: [{ run: 'true' }]").contains("`my.job` is not a job id"));
        assert!(problem("on: pushh\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").contains("no `pushh` event"));

        // `g1t` is g1t's own, at each level, and kept as written.
        let workflow = parse(
            "on: push
g1t: { note: top }
jobs:
  deploy:
    runs-on: x
    environment: production
    g1t: { deployment: false }
    steps:
      - run: 'true'
        g1t: { anything: [1, 2] }",
        )
        .unwrap();
        assert_eq!(workflow.g1t, Some(serde_json::json!({ "note": "top" })));
        assert_eq!(workflow.jobs[0].g1t, Some(serde_json::json!({ "deployment": false })));
        assert_eq!(workflow.jobs[0].steps[0].g1t, Some(serde_json::json!({ "anything": [1, 2] })));
        assert!(problem(&format!("on: push\ng1t: yes{job}")).contains("`g1t` is a mapping"));
        assert!(!records_deployment(&workflow.jobs[0].raw));
        assert!(!records_deployment(&serde_json::json!({ "environment": { "name": "p", "deployment": false } })));
        assert!(records_deployment(&serde_json::json!({ "environment": { "name": "p", "deployment": true } })));
        assert!(records_deployment(&serde_json::json!({ "environment": "p" })));
    }

    #[test]
    fn aliases_read_and_merge_keys_do_not() {
        let aliased = parse("on: push\njobs:\n  a:\n    runs-on: x\n    steps: &steps\n      - run: 'true'\n  b:\n    runs-on: x\n    steps: *steps").unwrap();
        assert_eq!(aliased.jobs[1].steps.len(), 1);
        let merged = parse("on: push\njobs:\n  a: &job\n    runs-on: x\n    steps: [{ run: 'true' }]\n  b:\n    <<: *job\n    name: B").unwrap_err();
        assert!(merged.contains("merge key"), "{merged}");
    }
}
