//! Reading a workflow file: its triggers, jobs and steps, and notes on
//! anything in it that runs differently on g1t, so moving a repository
//! from GitHub says plainly what to expect.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::filter::{Filter, Patterns};

/// Where workflows live.
pub const FOLDER: &str = ".github/workflows";

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
    "merge_group",
    "create",
    "delete",
];

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
}

impl Trigger {
    /// Whether an activity type starts it.
    pub fn wants_type(&self, action: Option<&str>) -> bool {
        let Some(action) = action else { return true };
        if self.types.is_empty() {
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
    pub steps: Vec<Step>,
    /// The whole job as written, for the sandbox.
    pub raw: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Workflow {
    pub name: Option<String>,
    pub run_name: Option<String>,
    pub triggers: Vec<Trigger>,
    pub env: Map<String, Value>,
    pub concurrency: Option<Concurrency>,
    pub jobs: Vec<Job>,
    pub notes: Vec<Note>,
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
pub fn parse(source: &str) -> Result<Workflow, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(source).map_err(|error| format!("It is not valid YAML: {error}"))?;
    let raw = yaml_to_json(&yaml);
    let Value::Object(root) = &raw else {
        return Err("A workflow is a mapping with `on` and `jobs`.".to_owned());
    };
    let mut notes = Vec::new();
    let mut note = |severity, job: Option<&str>, message: String| notes.push(Note { severity, job: job.map(str::to_owned), message });

    // `on`, in any of its three shapes. YAML 1.1 readers turn `on` into
    // `true`; this reader keeps it, and accepts both.
    let on = root.get("on").or_else(|| root.get("true")).ok_or("`on` is missing: say which events start the workflow.")?;
    let mut triggers = Vec::new();
    match on {
        Value::String(event) => triggers.push(trigger(event, &Value::Null)),
        Value::Array(events) => {
            for event in events {
                let Value::String(event) = event else { return Err("`on` lists event names.".to_owned()) };
                triggers.push(trigger(event, &Value::Null));
            }
        }
        Value::Object(events) => {
            for (event, spec) in events {
                triggers.push(trigger(event, spec));
            }
        }
        _ => return Err("`on` is an event, a list of events, or a mapping of events to their filters.".to_owned()),
    }
    for trigger in &triggers {
        if !SUPPORTED_EVENTS.contains(&trigger.event.as_str()) {
            note(
                Severity::Unsupported,
                None,
                format!("g1t has no `{}` event, so that trigger never starts it.", trigger.event),
            );
        }
        if trigger.event == "pull_request_target" {
            note(
                Severity::Info,
                None,
                "`pull_request_target` runs like `pull_request`, on the pull request's head, with the repository's secrets.".to_owned(),
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
    let concurrency = match root.get("concurrency") {
        Some(Value::String(group)) => Some(Concurrency { group: group.clone(), cancel_in_progress: Value::Bool(false) }),
        Some(Value::Object(spec)) => text(spec.get("group")).map(|group| Concurrency {
            group,
            cancel_in_progress: spec.get("cancel-in-progress").cloned().unwrap_or(Value::Bool(false)),
        }),
        _ => None,
    };

    let Some(Value::Object(job_specs)) = root.get("jobs") else {
        return Err("`jobs` is missing: a workflow needs at least one job.".to_owned());
    };
    if job_specs.is_empty() {
        return Err("`jobs` is empty: a workflow needs at least one job.".to_owned());
    }
    let mut jobs = Vec::new();
    for (id, spec) in job_specs {
        let Value::Object(spec) = spec else {
            return Err(format!("Job `{id}` is a mapping."));
        };
        let uses = text(spec.get("uses"));
        let steps_raw = match spec.get("steps") {
            Some(Value::Array(steps)) => steps.clone(),
            None if uses.is_some() => Vec::new(),
            None => return Err(format!("Job `{id}` has no `steps`.")),
            Some(_) => return Err(format!("Job `{id}`: `steps` is a list.")),
        };
        let mut steps = Vec::new();
        for (index, step) in steps_raw.iter().enumerate() {
            let Value::Object(fields) = step else {
                return Err(format!("Job `{id}`, step {}: a step is a mapping.", index + 1));
            };
            let step = Step {
                id: text(fields.get("id")),
                name: text(fields.get("name")),
                condition: text(fields.get("if")),
                uses: text(fields.get("uses")),
                run: text(fields.get("run")),
                raw: step.clone(),
            };
            match (&step.uses, &step.run) {
                (Some(_), Some(_)) => return Err(format!("Job `{id}`, step {}: a step has `uses` or `run`, not both.", index + 1)),
                (None, None) => return Err(format!("Job `{id}`, step {}: a step needs `uses` or `run`.", index + 1)),
                _ => {}
            }
            if let Some(uses) = &step.uses
                && let Some((severity, message)) = action_note(uses)
            {
                note(severity, Some(id), message);
            }
            if let Some(shell) = text(fields.get("shell"))
                && matches!(shell.as_str(), "pwsh" | "powershell" | "cmd")
            {
                note(Severity::Unsupported, Some(id), format!("Steps with `shell: {shell}` need Windows or PowerShell, which g1t's Linux runners do not have."));
            }
            steps.push(step);
        }
        let runs_on = spec.get("runs-on").cloned().unwrap_or(Value::Null);
        for label in texts(Some(&runs_on)).iter().chain(runs_on.get("labels").map(|l| texts(Some(l))).unwrap_or_default().iter()) {
            let lower = label.to_ascii_lowercase();
            if lower.contains("windows") || lower.contains("macos") {
                note(
                    Severity::Unsupported,
                    Some(id),
                    format!("`runs-on: {label}`: g1t runs jobs on Linux only, so this job fails."),
                );
            } else if lower == "self-hosted" {
                note(Severity::Info, Some(id), "`self-hosted`: g1t runs it on its own Linux runner.".to_owned());
            }
        }
        if spec.contains_key("services") {
            note(Severity::Unsupported, Some(id), "`services` containers (such as a database) are not started on g1t yet.".to_owned());
        }
        if spec.contains_key("container") {
            note(Severity::Warning, Some(id), "`container`: steps run on g1t's runner image instead of that container.".to_owned());
        }
        if spec.contains_key("environment") {
            note(Severity::Info, Some(id), "`environment`: protection rules are not enforced on g1t yet; the job runs with the repository's secrets.".to_owned());
        }
        let (matrix, fail_fast, max_parallel) = match spec.get("strategy") {
            Some(Value::Object(strategy)) => (
                strategy.get("matrix").cloned(),
                strategy.get("fail-fast").and_then(Value::as_bool).unwrap_or(true),
                strategy.get("max-parallel").and_then(Value::as_u64).map(|n| n as u32),
            ),
            _ => (None, true, None),
        };
        if uses.is_some() {
            note(Severity::Unsupported, Some(id), "Reusable workflows (`uses:` on a job) are not called on g1t yet, so this job fails.".to_owned());
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
            steps,
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
        jobs,
        notes,
        raw,
    };
    if workflow.job_order().len() < workflow.jobs.len() {
        return Err("The jobs' `needs` go round in a circle.".to_owned());
    }
    Ok(workflow)
}

/// What to say about an action g1t runs differently, if anything.
fn action_note(uses: &str) -> Option<(Severity, String)> {
    if uses.starts_with("docker://") {
        return Some((Severity::Unsupported, format!("`{uses}`: Docker actions do not run on g1t yet.")));
    }
    let name = uses.split('@').next().unwrap_or(uses).to_ascii_lowercase();
    match name.as_str() {
        "actions/checkout" => Some((Severity::Info, "`actions/checkout` checks out from g1t.".to_owned())),
        "actions/cache" | "actions/cache/restore" | "actions/cache/save" => Some((
            Severity::Warning,
            format!("`{name}`: g1t has no cache yet, so it always misses and the job does the work again."),
        )),
        "actions/upload-artifact" | "actions/download-artifact" => Some((
            Severity::Warning,
            format!("`{name}`: artifacts are kept for the run on g1t, and passed between its jobs."),
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
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
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
        assert_eq!(workflow.jobs[0].steps[0].title(), "Run actions/checkout@v4");
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
        let typed = parse("on:\n  pull_request:\n    types: [closed]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]").unwrap();
        assert!(typed.trigger("pull_request").unwrap().wants_type(Some("closed")));
        assert!(!typed.trigger("pull_request").unwrap().wants_type(Some("opened")));
    }

    #[test]
    fn notes_say_what_runs_differently() {
        let workflow = parse(
            "on: [push, release]\njobs:\n  win:\n    runs-on: windows-latest\n    services:\n      db: { image: postgres }\n    steps:\n      - uses: actions/cache@v4\n      - uses: docker://alpine\n      - run: dir\n        shell: pwsh",
        )
        .unwrap();
        let unsupported: Vec<&str> =
            workflow.notes.iter().filter(|n| n.severity == Severity::Unsupported).map(|n| n.message.as_str()).collect();
        assert!(unsupported.iter().any(|m| m.contains("`release`")));
        assert!(unsupported.iter().any(|m| m.contains("windows-latest")));
        assert!(unsupported.iter().any(|m| m.contains("services")));
        assert!(unsupported.iter().any(|m| m.contains("docker://alpine")));
        assert!(unsupported.iter().any(|m| m.contains("pwsh")));
        assert!(workflow.notes.iter().any(|n| n.severity == Severity::Warning && n.message.contains("actions/cache")));
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
}
