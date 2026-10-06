//! g1t's own workflows (`.g1t/workflows/*.yml`), read by the same parser
//! and expressions the actions service runs them with: each reads, nothing
//! in it is unsupported, and the deploy workflow's jobs start, wait and
//! stop as docs/DEPLOYING.md says.

use std::path::PathBuf;

use g1t_actions::expr::{self, Scope, Status};
use g1t_actions::matrix;
use g1t_actions::workflow::{self, Severity, Workflow};
use serde_json::{Map, Value, json};

fn workflows_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.g1t/workflows")
}

fn read(name: &str) -> Workflow {
    let source = std::fs::read_to_string(workflows_dir().join(name)).unwrap();
    workflow::parse(&source).unwrap_or_else(|problem| panic!("{name}: {problem}"))
}

#[test]
fn every_workflow_reads_and_runs_on_g1t() {
    let mut count = 0;
    for entry in std::fs::read_dir(workflows_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let workflow = read(&name);
        let unsupported: Vec<_> = workflow.notes.iter().filter(|n| n.severity != Severity::Info).collect();
        assert!(unsupported.is_empty(), "{name}: {unsupported:?}");
        count += 1;
    }
    assert!(count >= 1);
}

/// The plan job's outputs for a deploy of `stages` (each with its jobs).
fn plan_outputs(migrate: bool, core: &[(&str, &str, bool)], edge: &[(&str, &str, bool)], front: &[(&str, &str, bool)]) -> Value {
    let matrix = |jobs: &[(&str, &str, bool)]| {
        let include: Vec<Value> = if jobs.is_empty() {
            vec![json!({ "group": "none", "units": "" })]
        } else {
            jobs.iter().map(|(group, units, rust)| json!({ "group": group, "units": units, "rust": rust })).collect()
        };
        json!({ "include": include }).to_string()
    };
    json!({
        "migrate": migrate.to_string(),
        "migrate_units": if migrate { "events" } else { "" },
        "has_core": (!core.is_empty()).to_string(),
        "core": matrix(core),
        "has_edge": (!edge.is_empty()).to_string(),
        "edge": matrix(edge),
        "has_front": (!front.is_empty()).to_string(),
        "front": matrix(front),
    })
}

/// Whether `job` starts, given its needs' results, as the actions service
/// decides it (services/actions/src/plan.rs `decide`): any need that did
/// not succeed makes the status a failure.
fn starts(workflow: &Workflow, job: &str, needs: &[(&str, &str)], outputs: &Value, inputs: Value, cancelled: bool) -> bool {
    let job = workflow.jobs.iter().find(|j| j.id == job).unwrap();
    let mut needs_ctx = Map::new();
    let mut status = if cancelled { Status::Cancelled } else { Status::Success };
    for need in &job.needs {
        let result = needs.iter().find(|(name, _)| name == need).map(|(_, r)| *r).unwrap_or("success");
        if result != "success" && matches!(status, Status::Success) {
            status = Status::Failure;
        }
        let outputs = if need == "plan" { outputs.clone() } else { json!({}) };
        needs_ctx.insert(need.clone(), json!({ "result": result, "outputs": outputs }));
    }
    let mut contexts = Map::new();
    contexts.insert("needs".into(), Value::Object(needs_ctx));
    contexts.insert("inputs".into(), inputs);
    contexts.insert("github".into(), json!({ "event_name": "push", "ref": "refs/heads/main" }));
    let scope = Scope { contexts: &contexts, status, hash_files: None };
    expr::condition(job.condition.as_deref().unwrap_or_default(), &scope).unwrap()
}

#[test]
fn deploy_runs_on_main_and_by_hand_one_at_a_time() {
    let deploy = read("deploy.yml");
    let push = deploy.trigger("push").unwrap();
    assert!(push.branches.allows("main"));
    assert!(!push.branches.allows("feature"));
    let dispatch = deploy.trigger("workflow_dispatch").unwrap();
    for input in ["units", "all", "dry_run"] {
        assert!(dispatch.inputs.contains_key(input), "{input}");
    }
    let concurrency = deploy.concurrency.as_ref().unwrap();
    assert_eq!(concurrency.group, "deploy-production");
    assert_eq!(concurrency.cancel_in_progress, json!(false));
    assert_eq!(deploy.job_order(), ["check", "plan", "migrate", "core", "edge", "front"]);
    // The stages share their steps (a YAML alias), and read the token only
    // where they deploy.
    let steps = |id: &str| deploy.jobs.iter().find(|j| j.id == id).unwrap().steps.len();
    assert_eq!(steps("core"), steps("edge"));
    assert_eq!(steps("core"), steps("front"));
    let source = std::fs::read_to_string(workflows_dir().join("deploy.yml")).unwrap();
    assert!(!source.contains("cancel-in-progress: true"));
}

#[test]
fn deploy_stages_follow_one_another() {
    let deploy = read("deploy.yml");
    let all = plan_outputs(true, &[("rust", "events,repos", true), ("ts", "projects", false)], &[("rust", "api", true)], &[("web", "web", false)]);
    let push = json!({});

    // Everything succeeds: each stage runs after the last.
    assert!(starts(&deploy, "migrate", &[], &all, push.clone(), false));
    assert!(starts(&deploy, "core", &[("migrate", "success")], &all, push.clone(), false));
    assert!(starts(&deploy, "edge", &[("migrate", "success"), ("core", "success")], &all, push.clone(), false));
    assert!(starts(&deploy, "front", &[("migrate", "success"), ("core", "success"), ("edge", "success")], &all, push.clone(), false));

    // No migrations: the migrate job is skipped, and core still runs.
    let none = plan_outputs(false, &[("ts", "projects", false)], &[], &[("web", "web", false)]);
    assert!(!starts(&deploy, "migrate", &[], &none, push.clone(), false));
    assert!(starts(&deploy, "core", &[("migrate", "skipped")], &none, push.clone(), false));
    // An empty stage is skipped, and the next one still runs.
    assert!(!starts(&deploy, "edge", &[("migrate", "skipped"), ("core", "success")], &none, push.clone(), false));
    assert!(starts(&deploy, "front", &[("migrate", "skipped"), ("core", "success"), ("edge", "skipped")], &none, push.clone(), false));

    // A failure stops every later stage.
    assert!(!starts(&deploy, "core", &[("migrate", "failure")], &all, push.clone(), false));
    assert!(!starts(&deploy, "edge", &[("migrate", "success"), ("core", "failure")], &all, push.clone(), false));
    assert!(!starts(&deploy, "front", &[("migrate", "success"), ("core", "success"), ("edge", "failure")], &all, push.clone(), false));
    assert!(!starts(&deploy, "front", &[("migrate", "success"), ("core", "failure"), ("edge", "skipped")], &all, push.clone(), false));
    // A cancelled run starts nothing more.
    assert!(!starts(&deploy, "edge", &[("migrate", "success"), ("core", "success")], &all, push.clone(), true));

    // A dry run plans and stops.
    let dry = json!({ "dry_run": true, "units": "", "all": false });
    assert!(!starts(&deploy, "migrate", &[], &all, dry.clone(), false));
    assert!(!starts(&deploy, "core", &[("migrate", "skipped")], &all, dry, false));
}

#[test]
fn deploy_stage_matrices_come_from_the_plan() {
    let deploy = read("deploy.yml");
    let outputs = plan_outputs(false, &[("rust-1", "events,work", true), ("rust-2", "repos", true), ("ts", "projects,og", false)], &[], &[]);
    let core = deploy.jobs.iter().find(|j| j.id == "core").unwrap();
    assert!(!core.fail_fast);
    assert_eq!(core.max_parallel, Some(4));
    let mut contexts = Map::new();
    contexts.insert("needs".into(), json!({ "plan": { "result": "success", "outputs": outputs } }));
    let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
    let value = expr::interpolate_value(core.matrix.as_ref().unwrap(), &scope).unwrap();
    let jobs = matrix::expand(&value).unwrap();
    let groups: Vec<(&str, &str, bool)> = jobs
        .iter()
        .map(|c| (c["group"].as_str().unwrap(), c["units"].as_str().unwrap(), c["rust"].as_bool().unwrap()))
        .collect();
    assert_eq!(groups, [("rust-1", "events,work", true), ("rust-2", "repos", true), ("ts", "projects,og", false)]);
}
