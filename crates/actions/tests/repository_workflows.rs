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
fn every_workflow_asks_for_only_what_its_token_does() {
    use g1t_actions::permissions::{Access, TokenDefault};
    let job = |name: &str, id: &str| {
        let workflow = read(name);
        let job = workflow.jobs.iter().find(|job| job.id == id).unwrap().clone();
        job.permissions(&workflow, TokenDefault::Restricted)
    };
    // CI and Deploy only read: nothing they do writes with the token.
    for (name, id) in [("ci.yml", "rust"), ("deploy.yml", "core"), ("runner-release.yml", "binaries")] {
        let permissions = job(name, id);
        assert!(permissions.listed().iter().all(|(_, access)| *access <= Access::Read), "{name} {id}");
    }
    // The runner base pushes a branch and opens a pull request.
    let base = job("runner-base.yml", "build");
    assert_eq!(base.get("contents"), Access::Write);
    assert_eq!(base.get("pull-requests"), Access::Write);
    assert_eq!(base.get("packages"), Access::None);
    // The runner's image goes to g1t's registry.
    let image = job("runner-release.yml", "image");
    assert_eq!(image.get("packages"), Access::Write);
    assert_eq!(image.get("contents"), Access::Read);
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
/// decides it (services/actions/src/plan.rs `decide`, with
/// `expr::job_status`): a need that was skipped is not a failure, and a
/// failure anywhere before the job is.
fn starts(workflow: &Workflow, job: &str, needs: &[(&str, &str)], outputs: &Value, inputs: Value, cancelled: bool) -> bool {
    starts_after(workflow, job, needs, outputs, inputs, cancelled, false)
}

/// `starts`, where `failed_before` says a job further back failed (one the
/// needs were skipped for).
fn starts_after(workflow: &Workflow, job: &str, needs: &[(&str, &str)], outputs: &Value, inputs: Value, cancelled: bool, failed_before: bool) -> bool {
    let job = workflow.jobs.iter().find(|j| j.id == job).unwrap();
    let mut needs_ctx = Map::new();
    let mut results = Vec::new();
    for need in &job.needs {
        let result = needs.iter().find(|(name, _)| name == need).map(|(_, r)| *r).unwrap_or("success");
        results.push(result);
        let outputs = if need == "plan" { outputs.clone() } else { json!({}) };
        needs_ctx.insert(need.clone(), json!({ "result": result, "outputs": outputs }));
    }
    let status = expr::job_status(results, failed_before, cancelled);
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
    assert_eq!(deploy.job_order(), ["check", "plan", "migrate", "core", "edge", "front", "smoke"]);
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
    // Check and plan run side by side: plan waits for nothing.
    let plan = deploy.jobs.iter().find(|j| j.id == "plan").unwrap();
    assert!(plan.needs.is_empty(), "{:?}", plan.needs);
    for id in ["migrate", "core", "edge", "front", "smoke"] {
        let job = deploy.jobs.iter().find(|j| j.id == id).unwrap();
        assert!(job.needs.iter().any(|n| n == "check") && job.needs.iter().any(|n| n == "plan"), "{id}: {:?}", job.needs);
    }
    // A failed check, though plan succeeded: nothing migrates or deploys,
    // and failure() still sees the check's failure through skipped jobs.
    assert!(!starts(&deploy, "migrate", &[("check", "failure"), ("plan", "success")], &all, push.clone(), false));
    assert!(!starts(&deploy, "core", &[("check", "failure"), ("plan", "success"), ("migrate", "skipped")], &all, push.clone(), false));
    assert!(!starts(&deploy, "front", &[("check", "failure"), ("plan", "success"), ("migrate", "skipped"), ("core", "skipped"), ("edge", "skipped")], &all, push.clone(), false));
    let skipped = [("migrate", "skipped"), ("core", "skipped"), ("edge", "skipped")];
    assert!(!starts_after(&deploy, "front", &skipped, &all, push.clone(), false, true));
    assert!(!starts(&deploy, "smoke", &[("check", "failure"), ("core", "skipped"), ("edge", "skipped"), ("front", "skipped")], &all, push.clone(), false));
    // A failed plan stops everything too.
    assert!(!starts(&deploy, "migrate", &[("plan", "failure")], &all, push.clone(), false));
    assert!(!starts(&deploy, "core", &[("plan", "failure"), ("migrate", "skipped")], &all, push.clone(), false));

    // Smoke follows the last stage that ran, and not a failed one.
    assert!(starts(&deploy, "smoke", &[("core", "success"), ("edge", "success"), ("front", "success")], &all, push.clone(), false));
    assert!(starts(&deploy, "smoke", &[("core", "success"), ("edge", "skipped"), ("front", "success")], &none, push.clone(), false));
    assert!(!starts(&deploy, "smoke", &[("core", "success"), ("edge", "failure"), ("front", "skipped")], &all, push.clone(), false));
    // Nothing deployed: nothing to smoke-test.
    let nothing = plan_outputs(false, &[], &[], &[]);
    assert!(!starts(&deploy, "smoke", &[("core", "skipped"), ("edge", "skipped"), ("front", "skipped")], &nothing, push.clone(), false));

    // A dry run plans and stops.
    let dry = json!({ "dry_run": true, "units": "", "all": false });
    assert!(!starts(&deploy, "migrate", &[], &all, dry.clone(), false));
    assert!(!starts(&deploy, "core", &[("migrate", "skipped")], &all, dry.clone(), false));
    assert!(!starts(&deploy, "smoke", &[("core", "skipped"), ("edge", "skipped"), ("front", "skipped")], &all, dry, false));
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

#[test]
fn deploy_builds_rust_on_the_larger_machine_with_its_target_cached() {
    let deploy = read("deploy.yml");
    for stage in ["core", "edge", "front"] {
        let job = deploy.jobs.iter().find(|j| j.id == stage).unwrap();
        let on = |rust: bool, image: bool| {
            let mut contexts = Map::new();
            contexts.insert("matrix".into(), json!({ "group": "g", "units": "u", "rust": rust, "image": image }));
            let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
            expr::interpolate_value(&job.runs_on, &scope).unwrap()
        };
        assert_eq!(on(true, false), json!("g1t-4core"), "{stage}");
        // The runner's image is built with the job's own Docker Engine.
        assert_eq!(on(false, true), json!("g1t-4core"), "{stage}");
        assert_eq!(on(false, false), json!("ubuntu-latest"), "{stage}");
    }
    let source = std::fs::read_to_string(workflows_dir().join("deploy.yml")).unwrap();
    assert!(source.contains("target/wasm32-unknown-unknown/release"));
    assert!(source.contains("!target/**/incremental"));
    assert!(source.contains("target/x86_64-unknown-linux-musl/release"));
}

/// Whether a step runs, for a job going `status`, with `matrix`.
fn step_runs(step: &workflow::Step, matrix: Value, status: Status) -> bool {
    let mut contexts = Map::new();
    contexts.insert("matrix".into(), matrix);
    let scope = Scope { contexts: &contexts, status, hash_files: None };
    expr::condition(step.condition.as_deref().unwrap_or_default(), &scope).unwrap()
}

#[test]
fn rust_builds_go_through_sccache_before_cargo_and_report_after() {
    let step = |job: &workflow::Job, run: &str| -> (usize, workflow::Step) {
        let at = job.steps.iter().position(|s| s.run.as_deref() == Some(run)).unwrap_or_else(|| panic!("{}: no step runs {run}", job.id));
        (at, job.steps[at].clone())
    };
    let deploy = read("deploy.yml");
    for stage in ["core", "edge", "front"] {
        let job = deploy.jobs.iter().find(|j| j.id == stage).unwrap();
        let (install_at, install) = step(job, "bash scripts/sccache.sh install");
        let (stats_at, stats) = step(job, "bash scripts/sccache.sh stats");
        // Before anything runs Cargo (worker-build's install, the build),
        // and the statistics last.
        let install_step = job.steps.iter().position(|s| s.name.as_deref() == Some("Install")).unwrap();
        assert!(install_at < install_step, "{stage}");
        assert_eq!(stats_at, job.steps.len() - 1, "{stage}");
        for (rust, image, uses) in [(true, false, true), (false, true, true), (false, false, false)] {
            let matrix = json!({ "group": "g", "units": "u", "rust": rust, "image": image });
            assert_eq!(step_runs(&install, matrix.clone(), Status::Success), uses, "{stage} rust={rust} image={image}");
            assert_eq!(step_runs(&stats, matrix.clone(), Status::Success), uses, "{stage}");
            // A failed build still says what was cached.
            assert_eq!(step_runs(&stats, matrix, Status::Failure), uses, "{stage}");
        }
    }
    let ci = read("ci.yml");
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    let (install_at, _) = step(rust, "bash scripts/sccache.sh install");
    let (tests_at, _) = step(rust, "cargo test --workspace --locked --quiet");
    let (stats_at, stats) = step(rust, "bash scripts/sccache.sh stats");
    assert!(install_at < tests_at && tests_at < stats_at);
    assert!(step_runs(&stats, json!({}), Status::Failure));
    // main's runs keep the caches pull requests restore from: only Rust.
    assert!(ci.trigger("push").unwrap().branches.allows("main"));
    assert!(ci.trigger("pull_request").is_some());
    for (id, on_push) in [("rust", true), ("typescript", false), ("build", false)] {
        let job = ci.jobs.iter().find(|j| j.id == id).unwrap();
        for (event, expected) in [("push", on_push), ("pull_request", true)] {
            let mut contexts = Map::new();
            contexts.insert("github".into(), json!({ "event_name": event, "ref": "refs/heads/main" }));
            let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
            assert_eq!(expr::condition(job.condition.as_deref().unwrap_or_default(), &scope).unwrap(), expected, "{id} on {event}");
        }
    }
    // The download is pinned by version and checksum.
    let script = std::fs::read_to_string(workflows_dir().join("../../scripts/sccache.sh")).unwrap();
    assert!(script.contains("VERSION=0.18.0"));
    assert!(script.lines().any(|line| line.strip_prefix("SHA256=").is_some_and(|sum| sum.len() == 64)));
    assert!(script.contains("sha256sum -c"));
    assert!(script.contains("RUSTC_WRAPPER="));
    assert!(script.contains("GITHUB_STEP_SUMMARY"));
}

#[test]
fn the_runner_base_rebuilds_weekly_on_a_machine_with_docker() {
    let base = read("runner-base.yml");
    assert!(base.trigger("schedule").is_some());
    assert!(base.trigger("workflow_dispatch").is_some());
    assert!(base.trigger("push").unwrap().branches.allows("main"));
    let job = base.jobs.iter().find(|j| j.id == "build").unwrap();
    assert_eq!(job.runs_on, json!(["self-hosted", "docker"]));
}
