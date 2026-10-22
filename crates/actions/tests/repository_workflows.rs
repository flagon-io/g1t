//! g1t's own workflows (`.g1t/workflows/*.yml`), read by the same parser
//! and expressions the actions service runs them with: each reads, nothing
//! in it is unsupported, and the deploy workflow's jobs start, wait and
//! stop as docs.g1t.sh/guides/deploy-to-cloudflare/ says.

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
        let job = workflow
            .jobs
            .iter()
            .find(|job| job.id == id)
            .unwrap()
            .clone();
        job.permissions(&workflow, TokenDefault::Restricted)
    };
    // CI and Deploy only read: nothing they do writes with the token.
    // The actions release pushes with its own secret, never the job's token.
    for (name, id) in [
        ("ci.yml", "rust"),
        ("deploy.yml", "core"),
        ("runner-release.yml", "binaries"),
        ("actions-release.yml", "publish"),
    ] {
        let permissions = job(name, id);
        assert!(
            permissions
                .listed()
                .iter()
                .all(|(_, access)| *access <= Access::Read),
            "{name} {id}"
        );
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
    // Cache tidy reads the code and deletes cache entries, nothing else.
    let tidy = job("cache-tidy.yml", "tidy");
    assert_eq!(tidy.get("actions"), Access::Write);
    assert_eq!(tidy.get("contents"), Access::Read);
    assert_eq!(tidy.get("packages"), Access::None);
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
        let unsupported: Vec<_> = workflow
            .notes
            .iter()
            .filter(|n| n.severity != Severity::Info)
            .collect();
        assert!(unsupported.is_empty(), "{name}: {unsupported:?}");
        count += 1;
    }
    assert!(count >= 1);
}

/// The plan job's outputs for a deploy of `stages` (each with its jobs).
fn plan_outputs(
    migrate: bool,
    core: &[(&str, &str, bool)],
    edge: &[(&str, &str, bool)],
    front: &[(&str, &str, bool)],
) -> Value {
    // As scripts/deploy.mjs writes them: a Rust group or a site is built
    // ahead (`prebuilt`), and every stage's builds are one matrix.
    let entries = |stage: &str, jobs: &[(&str, &str, bool)]| -> Vec<Value> {
        jobs.iter()
            .map(|(group, units, rust)| {
                let prebuilt = *rust || *group == "web" || *group == "docs";
                json!({ "group": group, "units": units, "rust": rust, "prebuilt": prebuilt, "stage": stage })
            })
            .collect()
    };
    let matrix = |include: Vec<Value>| {
        let include = if include.is_empty() {
            vec![json!({ "group": "none", "units": "" })]
        } else {
            include
        };
        json!({ "include": include }).to_string()
    };
    let builds: Vec<Value> = [("core", core), ("edge", edge), ("front", front)]
        .iter()
        .flat_map(|(stage, jobs)| entries(stage, jobs))
        .filter(|job| job["prebuilt"] == json!(true))
        .collect();
    json!({
        "migrate": migrate.to_string(),
        "migrate_units": if migrate { "events" } else { "" },
        "has_builds": (!builds.is_empty()).to_string(),
        "builds": matrix(builds),
        "has_core": (!core.is_empty()).to_string(),
        "core": matrix(entries("core", core)),
        "has_edge": (!edge.is_empty()).to_string(),
        "edge": matrix(entries("edge", edge)),
        // What no later unit calls: none here (deploy_stages_skip_what_nothing_later_calls).
        "has_core_rest": "false",
        "core_rest": matrix(Vec::new()),
        "has_edge_rest": "false",
        "edge_rest": matrix(Vec::new()),
        "has_front": (!front.is_empty()).to_string(),
        "front": matrix(entries("front", front)),
    })
}

/// Whether `job` starts, given its needs' results, as the actions service
/// decides it (services/actions/src/plan.rs `decide`, with
/// `expr::job_status`): a need that was skipped is not a failure, and a
/// failure anywhere before the job is.
fn starts(
    workflow: &Workflow,
    job: &str,
    needs: &[(&str, &str)],
    outputs: &Value,
    inputs: Value,
    cancelled: bool,
) -> bool {
    starts_after(workflow, job, needs, outputs, inputs, cancelled, false)
}

/// `starts`, where `failed_before` says a job further back failed (one the
/// needs were skipped for).
fn starts_after(
    workflow: &Workflow,
    job: &str,
    needs: &[(&str, &str)],
    outputs: &Value,
    inputs: Value,
    cancelled: bool,
    failed_before: bool,
) -> bool {
    let job = workflow.jobs.iter().find(|j| j.id == job).unwrap();
    let mut needs_ctx = Map::new();
    let mut results = Vec::new();
    for need in &job.needs {
        let result = needs
            .iter()
            .find(|(name, _)| name == need)
            .map(|(_, r)| *r)
            .unwrap_or("success");
        results.push(result);
        let outputs = if need == "plan" {
            outputs.clone()
        } else {
            json!({})
        };
        needs_ctx.insert(
            need.clone(),
            json!({ "result": result, "outputs": outputs }),
        );
    }
    let status = expr::job_status(results, failed_before, cancelled);
    let mut contexts = Map::new();
    contexts.insert("needs".into(), Value::Object(needs_ctx));
    contexts.insert("inputs".into(), inputs);
    contexts.insert(
        "github".into(),
        json!({ "event_name": "push", "ref": "refs/heads/main" }),
    );
    let scope = Scope {
        contexts: &contexts,
        status,
        hash_files: None,
    };
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
    assert_eq!(
        deploy.job_order(),
        [
            "check",
            "plan",
            "build",
            "migrate",
            "core",
            "core_rest",
            "edge",
            "edge_rest",
            "front",
            "smoke"
        ]
    );
    // The stages share their steps (a YAML alias), and read the token only
    // where they deploy.
    let steps = |id: &str| deploy.jobs.iter().find(|j| j.id == id).unwrap().steps.len();
    for id in ["core_rest", "edge", "edge_rest", "front"] {
        assert_eq!(steps("core"), steps(id), "{id}");
    }
    let source = std::fs::read_to_string(workflows_dir().join("deploy.yml")).unwrap();
    assert!(!source.contains("cancel-in-progress: true"));
}

/// Whether a step's `run` installs the whole lockfile: `npm ci` with no
/// workspace narrowing it, and not the deploy tool's install of some units.
fn installs_everything(run: &str) -> bool {
    run.split('\n').any(|line| {
        let line = line.trim();
        // Installs go through npm-ci.mjs, which runs `npm ci` again when a connection drops.
        (line.starts_with("npm ci") || line.starts_with("node scripts/deploy/npm-ci.mjs"))
            && !line.contains(" -w ")
            && !line.contains("--workspace")
    })
}

#[test]
fn npm_downloads_are_cached_whole_and_only_whole_installs_save_them() {
    // Every job's npm cache is the whole lockfile's, under one key. A job
    // that installs part of it only restores: had it saved, its part would
    // stand in for the whole under that key (the first job to finish used
    // to save Wrangler alone, and every later install downloaded the rest).
    let mut saving = Vec::new();
    for entry in std::fs::read_dir(workflows_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        for job in read(&name).jobs {
            let whole = job
                .steps
                .iter()
                .any(|s| s.run.as_deref().is_some_and(installs_everything));
            for step in &job.steps {
                let Some(uses) = step.uses.as_deref() else {
                    continue;
                };
                if !uses.starts_with("actions/cache") || step.raw["with"]["path"] != json!("~/.npm")
                {
                    continue;
                }
                let key = step.raw["with"]["key"].as_str().unwrap_or_default();
                assert_eq!(
                    key, "npm-full-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
                    "{name} {}",
                    job.id
                );
                if let Some(prefix) = step.raw["with"]["restore-keys"].as_str() {
                    assert_eq!(prefix, "npm-full-${{ runner.os }}-", "{name} {}", job.id);
                }
                let saves =
                    uses.starts_with("actions/cache@") || uses.starts_with("actions/cache/save@");
                assert!(
                    !saves || whole,
                    "{name} {}: saves npm's cache but installs only part of the lockfile",
                    job.id
                );
                if saves {
                    saving.push(format!("{name} {}", job.id));
                }
            }
        }
    }
    // main's whole cache is kept by the Caches workflow.
    assert!(saving.contains(&"caches.yml npm".to_owned()), "{saving:?}");
}

/// Every `actions/cache` step of every workflow: (file, job, step).
fn cache_steps() -> Vec<(String, workflow::Job, workflow::Step)> {
    let mut out = Vec::new();
    let mut names: Vec<String> = std::fs::read_dir(workflows_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".yml"))
        .collect();
    names.sort();
    for name in names {
        for job in read(&name).jobs {
            for step in &job.steps {
                if step
                    .uses
                    .as_deref()
                    .is_some_and(|u| u.starts_with("actions/cache"))
                {
                    out.push((name.clone(), job.clone(), step.clone()));
                }
            }
        }
    }
    out
}

/// What a cache step's key starts with before its first expression: the
/// entry it is, whatever its inputs (`cargo-test-`, `apt-tauri-windows-`).
fn family(key: &str) -> String {
    key.split("${{").next().unwrap_or_default().to_owned()
}

fn saves(step: &workflow::Step) -> bool {
    let uses = step.uses.as_deref().unwrap_or_default();
    (uses.starts_with("actions/cache@") || uses.starts_with("actions/cache/save@"))
        && step.raw["with"]["lookup-only"] != json!(true)
}

fn paths(step: &workflow::Step) -> Vec<String> {
    let text = step.raw["with"]["path"].as_str().unwrap_or_default();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

#[test]
fn each_cache_has_one_set_of_paths_wherever_it_is_used() {
    // An entry's version is the hash of its paths: a step that names the
    // same key with other paths finds nothing, silently. So every step of
    // an entry, in every workflow, names the same paths.
    let mut seen: std::collections::BTreeMap<String, (Vec<String>, String)> = Default::default();
    for (file, job, step) in cache_steps() {
        let key = step.raw["with"]["key"].as_str().unwrap_or_default();
        let family = family(key);
        assert!(!family.is_empty(), "{file} {}: a key starts with its name", job.id);
        let here = format!("{file} {}", job.id);
        match seen.get(&family) {
            Some((first, at)) => assert_eq!(
                &paths(&step),
                first,
                "{here} names other paths for {family} than {at}"
            ),
            None => {
                seen.insert(family, (paths(&step), here));
            }
        }
    }
    for family in [
        "npm-full-",
        "cargo-crates-",
        "cargo-test-",
        "cargo-workers-",
        "runner-musl-",
        "runner-release-",
        "desktop-check-nodebug-",
        "desktop-release-linux-",
        "desktop-release-windows-",
        "apt-tauri-",
        "apt-tauri-windows-",
        "xwin-",
        "zig-0.13.0-zigbuild-",
        "cli-release-",
    ] {
        assert!(seen.contains_key(family), "{family}: {:?}", seen.keys());
    }
}

#[test]
fn main_saves_every_cache_that_pull_requests_and_releases_restore() {
    // A run restores from its own ref, its pull request's base and main;
    // a release tag's run never reads another tag's entries. So every
    // entry any step restores is saved by a workflow that runs on pushes
    // to main, and the release workflows only restore.
    let on_main = ["ci.yml", "caches.yml", "deploy.yml"];
    for file in on_main {
        let push = read(file).trigger("push").cloned().unwrap();
        assert!(push.branches.allows("main"), "{file}");
    }
    let releases = [
        "cli-release.yml",
        "desktop-release.yml",
        "mobile-build.yml",
        "mobile-release.yml",
        "runner-release.yml",
    ];
    let steps = cache_steps();
    let saved_on_main: std::collections::BTreeSet<String> = steps
        .iter()
        .filter(|(file, _, step)| on_main.contains(&file.as_str()) && saves(step))
        .map(|(_, _, step)| family(step.raw["with"]["key"].as_str().unwrap_or_default()))
        .collect();
    for (file, job, step) in &steps {
        let family = family(step.raw["with"]["key"].as_str().unwrap_or_default());
        // The conformance run restores what its own first job saved.
        if family == "conformance-" {
            continue;
        }
        assert!(
            saved_on_main.contains(&family),
            "{file} {}: nothing on main saves {family}",
            job.id
        );
        if releases.contains(&file.as_str()) {
            assert!(!saves(step), "{file} {}: a release saves {family}, which only its own tag would read", job.id);
        }
    }
}

#[test]
fn rust_caches_are_keyed_by_the_toolchain_and_the_dependencies() {
    // Not by Cargo.lock as a whole: 25 of its 31 changes in a week were a
    // release's version bump, and each saved every Rust cache again.
    for (file, job, step) in cache_steps() {
        let key = step.raw["with"]["key"].as_str().unwrap_or_default();
        assert!(
            !key.contains("Cargo.lock") && !key.contains("base.json"),
            "{file} {}: {key}",
            job.id
        );
        let target = paths(&step).iter().any(|p| p.contains("target"));
        if target {
            // The toolchain that built it: this machine's rustc, or for
            // the CLI's release, the cargo-zigbuild image it builds in.
            let toolchain = if paths(&step).iter().any(|p| p.starts_with("target/zig")) {
                "steps.keys.outputs.zigbuild"
            } else {
                "steps.keys.outputs.rust"
            };
            assert!(key.contains(toolchain), "{file} {}: {key}", job.id);
            // A restore key never reaches another toolchain's entries.
            for prefix in step.raw["with"]["restore-keys"]
                .as_str()
                .unwrap_or_default()
                .lines()
                .filter(|l| !l.trim().is_empty())
            {
                assert!(prefix.contains(toolchain), "{file} {}: {prefix}", job.id);
            }
        }
        if key.contains("steps.keys.outputs.") {
            let at = job.steps.iter().position(|s| s == &step).unwrap();
            let keys = job
                .steps
                .iter()
                .position(|s| s.id.as_deref() == Some("keys"))
                .unwrap_or_else(|| panic!("{file} {}: no keys step", job.id));
            assert!(keys < at, "{file} {}", job.id);
            assert_eq!(
                job.steps[keys].run.as_deref(),
                Some("node scripts/deploy/ci-cache.mjs keys")
            );
        }
    }
}

#[test]
fn a_cargo_target_restored_from_an_older_entry_is_pruned_before_it_is_saved() {
    // Otherwise the old versions of what changed ride along forever: CI's
    // test build grew from 671 MB to 1,687 MB in a day.
    for (file, id, cache) in [
        ("ci.yml", "rust", "test-build"),
        ("ci.yml", "desktop", "desktop-build"),
        ("caches.yml", "runner", "runner-build"),
    ] {
        let workflow = read(file);
        let job = workflow.jobs.iter().find(|j| j.id == id).unwrap();
        let at = job
            .steps
            .iter()
            .position(|s| s.id.as_deref() == Some(cache))
            .unwrap();
        let prune = job
            .steps
            .iter()
            .position(|s| {
                s.run
                    .as_deref()
                    .is_some_and(|r| r.starts_with("node scripts/deploy/ci-cache.mjs prune "))
            })
            .unwrap_or_else(|| panic!("{file} {id}: no prune"));
        assert!(at < prune, "{file} {id}");
        let condition = job.steps[prune].condition.as_deref().map(str::trim).unwrap_or_default();
        // The cache step saves in its post step, after the prune; or it only
        // restores, and a save step of the same entry after the prune saves
        // when it runs.
        if saves(&job.steps[at]) {
            // A job a pull request may pass without running (ci-affected.mjs
            // --job) asks that too: skipped, the cache step says no hit.
            let hit = format!("steps.{cache}.outputs.cache-hit != 'true' }}}}");
            assert!(
                [
                    format!("${{{{ {hit}"),
                    format!("${{{{ steps.affected.outputs.run == 'true' && {hit}"),
                ]
                .contains(&condition.to_string()),
                "{file} {id}: {condition}"
            );
        } else {
            let key = &job.steps[at].raw["with"]["key"];
            let save = job
                .steps
                .iter()
                .position(|s| saves(s) && &s.raw["with"]["key"] == key)
                .unwrap_or_else(|| panic!("{file} {id}: nothing saves {key}"));
            assert!(prune < save, "{file} {id}");
            assert_eq!(paths(&job.steps[save]), paths(&job.steps[at]), "{file} {id}");
            assert!(
                condition.starts_with(&format!("${{{{ steps.{cache}.outputs.cache-hit != 'true' ")),
                "{file} {id}: {condition}"
            );
            assert_eq!(job.steps[save].condition.as_deref().map(str::trim), Some(condition), "{file} {id}");
        }
    }
    // The CLI's build is made in the builder image, whose Cargo the host
    // cannot ask what it built: so it is never started from an older entry,
    // and has nothing old to prune.
    let caches = read("caches.yml");
    let cli = caches.jobs.iter().find(|j| j.id == "cli").unwrap();
    let build = cli
        .steps
        .iter()
        .find(|s| s.raw["with"]["key"].as_str().is_some_and(|k| k.starts_with("cli-release-")))
        .unwrap();
    assert!(saves(build));
    assert!(build.raw["with"].get("restore-keys").is_none());
    let ci = read("ci.yml");
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    assert_eq!(
        rust.raw["env"]["CARGO_PROFILE_DEV_DEBUG"],
        json!("line-tables-only")
    );
}

#[test]
fn the_caches_workflow_builds_only_what_is_missing() {
    let caches = read("caches.yml");
    let push = caches.trigger("push").unwrap();
    assert!(push.branches.allows("main"));
    assert!(!push.branches.allows("feature"));
    // Never cut off halfway: a build half done saves nothing.
    assert_eq!(
        caches.concurrency.as_ref().unwrap().cancel_in_progress,
        json!(false)
    );
    let look = caches.jobs.iter().find(|j| j.id == "look").unwrap();
    // Looked up, not downloaded.
    for step in &look.steps {
        if step.uses.as_deref().is_some_and(|u| u.starts_with("actions/cache")) {
            assert_eq!(step.uses.as_deref(), Some("actions/cache/restore@v4"));
            assert_eq!(step.raw["with"]["lookup-only"], json!(true), "{:?}", step.id);
        }
    }
    for job in &caches.jobs {
        if job.id != "look" {
            assert_eq!(job.needs, ["look"], "{}", job.id);
            assert!(
                job.condition
                    .as_deref()
                    .is_some_and(|c| c.contains("needs.look.outputs.")),
                "{}",
                job.id
            );
        }
    }
}

#[test]
fn deploy_stages_follow_one_another() {
    let deploy = read("deploy.yml");
    let all = plan_outputs(
        true,
        &[("rust", "events,repos", true), ("ts", "projects", false)],
        &[("rust", "api", true)],
        &[("web", "web", false)],
    );
    let push = json!({});

    // Everything succeeds: each stage runs after the last.
    assert!(starts(&deploy, "migrate", &[], &all, push.clone(), false));
    assert!(starts(
        &deploy,
        "core",
        &[("migrate", "success")],
        &all,
        push.clone(),
        false
    ));
    assert!(starts(
        &deploy,
        "edge",
        &[("migrate", "success"), ("core", "success")],
        &all,
        push.clone(),
        false
    ));
    assert!(starts(
        &deploy,
        "front",
        &[
            ("migrate", "success"),
            ("core", "success"),
            ("edge", "success")
        ],
        &all,
        push.clone(),
        false
    ));

    // No migrations: the migrate job is skipped, and core still runs.
    let none = plan_outputs(
        false,
        &[("ts", "projects", false)],
        &[],
        &[("web", "web", false)],
    );
    assert!(!starts(&deploy, "migrate", &[], &none, push.clone(), false));
    assert!(starts(
        &deploy,
        "core",
        &[("migrate", "skipped")],
        &none,
        push.clone(),
        false
    ));
    // An empty stage is skipped, and the next one still runs.
    assert!(!starts(
        &deploy,
        "edge",
        &[("migrate", "skipped"), ("core", "success")],
        &none,
        push.clone(),
        false
    ));
    assert!(starts(
        &deploy,
        "front",
        &[
            ("migrate", "skipped"),
            ("core", "success"),
            ("edge", "skipped")
        ],
        &none,
        push.clone(),
        false
    ));

    // A failure stops every later stage.
    assert!(!starts(
        &deploy,
        "core",
        &[("migrate", "failure")],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "edge",
        &[("migrate", "success"), ("core", "failure")],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "front",
        &[
            ("migrate", "success"),
            ("core", "success"),
            ("edge", "failure")
        ],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "front",
        &[
            ("migrate", "success"),
            ("core", "failure"),
            ("edge", "skipped")
        ],
        &all,
        push.clone(),
        false
    ));
    // A cancelled run starts nothing more.
    assert!(!starts(
        &deploy,
        "edge",
        &[("migrate", "success"), ("core", "success")],
        &all,
        push.clone(),
        true
    ));
    // Check and plan run side by side: plan waits for nothing.
    let plan = deploy.jobs.iter().find(|j| j.id == "plan").unwrap();
    assert!(plan.needs.is_empty(), "{:?}", plan.needs);
    for id in ["migrate", "core", "core_rest", "edge", "edge_rest", "front", "smoke"] {
        let job = deploy.jobs.iter().find(|j| j.id == id).unwrap();
        assert!(
            job.needs.iter().any(|n| n == "check") && job.needs.iter().any(|n| n == "plan"),
            "{id}: {:?}",
            job.needs
        );
    }
    // A failed check, though plan succeeded: nothing migrates or deploys,
    // and failure() still sees the check's failure through skipped jobs.
    assert!(!starts(
        &deploy,
        "migrate",
        &[("check", "failure"), ("plan", "success")],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "core",
        &[
            ("check", "failure"),
            ("plan", "success"),
            ("migrate", "skipped")
        ],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "front",
        &[
            ("check", "failure"),
            ("plan", "success"),
            ("migrate", "skipped"),
            ("core", "skipped"),
            ("edge", "skipped")
        ],
        &all,
        push.clone(),
        false
    ));
    let skipped = [
        ("migrate", "skipped"),
        ("core", "skipped"),
        ("edge", "skipped"),
    ];
    assert!(!starts_after(
        &deploy,
        "front",
        &skipped,
        &all,
        push.clone(),
        false,
        true
    ));
    assert!(!starts(
        &deploy,
        "smoke",
        &[
            ("check", "failure"),
            ("core", "skipped"),
            ("edge", "skipped"),
            ("front", "skipped")
        ],
        &all,
        push.clone(),
        false
    ));
    // A failed plan stops everything too.
    assert!(!starts(
        &deploy,
        "migrate",
        &[("plan", "failure")],
        &all,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "core",
        &[("plan", "failure"), ("migrate", "skipped")],
        &all,
        push.clone(),
        false
    ));

    // Smoke follows the last stage that ran, and not a failed one.
    assert!(starts(
        &deploy,
        "smoke",
        &[
            ("core", "success"),
            ("edge", "success"),
            ("front", "success")
        ],
        &all,
        push.clone(),
        false
    ));
    assert!(starts(
        &deploy,
        "smoke",
        &[
            ("core", "success"),
            ("edge", "skipped"),
            ("front", "success")
        ],
        &none,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "smoke",
        &[
            ("core", "success"),
            ("edge", "failure"),
            ("front", "skipped")
        ],
        &all,
        push.clone(),
        false
    ));
    // Nothing deployed: nothing to smoke-test.
    let nothing = plan_outputs(false, &[], &[], &[]);
    assert!(!starts(
        &deploy,
        "smoke",
        &[
            ("core", "skipped"),
            ("edge", "skipped"),
            ("front", "skipped")
        ],
        &nothing,
        push.clone(),
        false
    ));

    // Every stage builds at once, as soon as the plan is known: the build
    // waits for nothing else, and every stage waits for it.
    let build = deploy.jobs.iter().find(|j| j.id == "build").unwrap();
    assert_eq!(build.needs, ["plan"]);
    assert!(starts(&deploy, "build", &[], &all, push.clone(), false));
    for id in ["core", "edge", "front"] {
        let job = deploy.jobs.iter().find(|j| j.id == id).unwrap();
        assert!(job.needs.iter().any(|n| n == "build"), "{id}: {:?}", job.needs);
    }
    // A failed build deploys nothing.
    assert!(!starts(
        &deploy,
        "core",
        &[("build", "failure"), ("migrate", "success")],
        &all,
        push.clone(),
        false
    ));
    // TypeScript Workers alone: nothing to build, and core still runs.
    let bundled = plan_outputs(false, &[("ts", "projects", false)], &[], &[]);
    assert!(!starts(&deploy, "build", &[], &bundled, push.clone(), false));
    assert!(starts(
        &deploy,
        "core",
        &[("build", "skipped"), ("migrate", "skipped")],
        &bundled,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "build",
        &[],
        &all,
        json!({ "dry_run": true, "units": "", "all": false }),
        false
    ));

    // A dry run plans and stops.
    let dry = json!({ "dry_run": true, "units": "", "all": false });
    assert!(!starts(&deploy, "migrate", &[], &all, dry.clone(), false));
    assert!(!starts(
        &deploy,
        "core",
        &[("migrate", "skipped")],
        &all,
        dry.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "smoke",
        &[
            ("core", "skipped"),
            ("edge", "skipped"),
            ("front", "skipped")
        ],
        &all,
        dry,
        false
    ));
}

#[test]
fn deploy_stages_skip_what_nothing_later_calls() {
    // The plan puts a job no later unit calls in `<stage>_rest`
    // (scripts/deploy/plan.mjs workflowOutputs): the runner's image when
    // the API is not deploying, the API (the site does not bind it).
    let deploy = read("deploy.yml");
    let mut outputs = plan_outputs(
        false,
        &[("ts", "projects", false)],
        &[("ts", "status", false)],
        &[("web", "web", false)],
    );
    let rest = |stage: &str, group: &str, units: &str| {
        json!({ "include": [{ "group": group, "units": units, "rust": false, "prebuilt": false, "stage": stage }] }).to_string()
    };
    outputs["has_core_rest"] = json!("true");
    outputs["core_rest"] = json!(rest("core", "runner-image", "runner"));
    outputs["has_edge_rest"] = json!("true");
    outputs["edge_rest"] = json!(rest("edge", "rust", "api"));
    let push = json!({});
    let needs = |id: &str| deploy.jobs.iter().find(|j| j.id == id).unwrap().needs.clone();

    // Beside core: it waits for what core waits for, and nothing but smoke
    // waits for it.
    assert_eq!(needs("core_rest"), needs("core"));
    assert!(starts(&deploy, "core_rest", &[("migrate", "skipped")], &outputs, push.clone(), false));
    for id in ["edge", "edge_rest", "front"] {
        assert!(!needs(id).iter().any(|n| n == "core_rest"), "{id}");
    }
    // Beside front: after core, not before front.
    assert_eq!(needs("edge_rest"), needs("edge"));
    assert!(needs("front").iter().any(|n| n == "edge"));
    assert!(!needs("front").iter().any(|n| n == "edge_rest"));
    assert!(starts(
        &deploy,
        "edge_rest",
        &[("migrate", "skipped"), ("core", "success")],
        &outputs,
        push.clone(),
        false
    ));
    // A failed core stops both; a failed runner's image stops neither edge
    // nor front, only smoke.
    assert!(!starts(
        &deploy,
        "edge_rest",
        &[("migrate", "skipped"), ("core", "failure")],
        &outputs,
        push.clone(),
        false
    ));
    assert!(starts(
        &deploy,
        "front",
        &[
            ("migrate", "skipped"),
            ("core", "success"),
            ("edge", "success")
        ],
        &outputs,
        push.clone(),
        false
    ));
    assert!(!starts(
        &deploy,
        "smoke",
        &[
            ("core", "success"),
            ("core_rest", "failure"),
            ("edge", "success"),
            ("edge_rest", "success"),
            ("front", "success")
        ],
        &outputs,
        push.clone(),
        false
    ));
    // Smoke waits for every deploy job, the rest included.
    for id in ["core", "core_rest", "edge", "edge_rest", "front"] {
        assert!(needs("smoke").iter().any(|n| n == id), "{id}");
    }
    // Only the rest deploying: smoke still runs after it.
    let mut alone = plan_outputs(false, &[], &[], &[]);
    alone["has_core_rest"] = json!("true");
    alone["core_rest"] = json!(rest("core", "runner-image", "runner"));
    assert!(starts(
        &deploy,
        "smoke",
        &[
            ("core", "skipped"),
            ("core_rest", "success"),
            ("edge", "skipped"),
            ("edge_rest", "skipped"),
            ("front", "skipped")
        ],
        &alone,
        push.clone(),
        false
    ));
    assert!(!starts(&deploy, "core", &[], &alone, push.clone(), false));
    // A dry run deploys none of it.
    let dry = json!({ "dry_run": true, "units": "", "all": false });
    assert!(!starts(&deploy, "core_rest", &[], &outputs, dry.clone(), false));
    assert!(!starts(&deploy, "edge_rest", &[], &outputs, dry, false));
}

#[test]
fn deploy_stage_matrices_come_from_the_plan() {
    let deploy = read("deploy.yml");
    let outputs = plan_outputs(
        false,
        &[
            ("rust-1", "events,work", true),
            ("rust-2", "repos", true),
            ("ts", "projects,og", false),
        ],
        &[],
        &[],
    );
    let core = deploy.jobs.iter().find(|j| j.id == "core").unwrap();
    assert!(!core.fail_fast);
    assert_eq!(core.max_parallel, Some(12));
    let mut contexts = Map::new();
    contexts.insert(
        "needs".into(),
        json!({ "plan": { "result": "success", "outputs": outputs } }),
    );
    let scope = Scope {
        contexts: &contexts,
        status: Status::Success,
        hash_files: None,
    };
    let value = expr::interpolate_value(core.matrix.as_ref().unwrap(), &scope).unwrap();
    let jobs = matrix::expand(&value).unwrap();
    let groups: Vec<(&str, &str, bool)> = jobs
        .iter()
        .map(|c| {
            (
                c["group"].as_str().unwrap(),
                c["units"].as_str().unwrap(),
                c["rust"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        groups,
        [
            ("rust-1", "events,work", true),
            ("rust-2", "repos", true),
            ("ts", "projects,og", false)
        ]
    );

    // The builds: every stage's Rust groups and sites in one matrix, each
    // naming its stage, since two stages may each have a group `rust`.
    let outputs = plan_outputs(
        false,
        &[("rust", "events", true), ("ts", "projects", false)],
        &[("rust", "api", true)],
        &[("web", "web", false)],
    );
    let build = deploy.jobs.iter().find(|j| j.id == "build").unwrap();
    let mut contexts = Map::new();
    contexts.insert(
        "needs".into(),
        json!({ "plan": { "result": "success", "outputs": outputs } }),
    );
    let scope = Scope {
        contexts: &contexts,
        status: Status::Success,
        hash_files: None,
    };
    let value = expr::interpolate_value(build.matrix.as_ref().unwrap(), &scope).unwrap();
    let builds: Vec<(String, String)> = matrix::expand(&value)
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["stage"].as_str().unwrap().to_owned(),
                c["group"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        builds,
        [
            ("core".to_owned(), "rust".to_owned()),
            ("edge".to_owned(), "rust".to_owned()),
            ("front".to_owned(), "web".to_owned())
        ]
    );
    // A build's artifact is the one its stage's job fetches.
    let artifact = |job: &workflow::Job, action: &str| {
        job.steps
            .iter()
            .find(|s| s.uses.as_deref().is_some_and(|u| u.starts_with(action)))
            .map(|s| s.raw["with"]["name"].as_str().unwrap().to_owned())
            .unwrap_or_else(|| panic!("{}: no {action}", job.id))
    };
    let name = "build-${{ matrix.stage }}-${{ matrix.group }}";
    assert_eq!(artifact(build, "actions/upload-artifact@"), name);
    for stage in ["core", "core_rest", "edge", "edge_rest", "front"] {
        let job = deploy.jobs.iter().find(|j| j.id == stage).unwrap();
        assert_eq!(artifact(job, "actions/download-artifact@"), name, "{stage}");
    }
    // The build reads no secret and makes no deployment.
    assert!(build.raw.get("environment").is_none());
    let source = std::fs::read_to_string(workflows_dir().join("deploy.yml")).unwrap();
    assert!(!source.split("\n  build:").nth(1).unwrap().split("\n  migrate:").next().unwrap().contains("secrets."));
}

#[test]
fn deploy_builds_on_ubuntu_latest_with_its_target_cached() {
    let deploy = read("deploy.yml");
    for stage in ["core", "core_rest", "edge", "edge_rest", "front"] {
        let job = deploy.jobs.iter().find(|j| j.id == stage).unwrap();
        let on = |rust: bool, image: bool| {
            let mut contexts = Map::new();
            contexts.insert(
                "matrix".into(),
                json!({ "group": "g", "units": "u", "rust": rust, "image": image }),
            );
            let scope = Scope {
                contexts: &contexts,
                status: Status::Success,
                hash_files: None,
            };
            expr::interpolate_value(&job.runs_on, &scope).unwrap()
        };
        // Every job on ubuntu-latest, as on GitHub: 4 vCPU in this public
        // repository, the size GitHub gives a public one
        // (g1t_contracts::actions::instance_for), Rust builds and the
        // runner's image included.
        assert_eq!(on(true, false), json!("ubuntu-latest"), "{stage}");
        assert_eq!(on(false, true), json!("ubuntu-latest"), "{stage}");
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
    let scope = Scope {
        contexts: &contexts,
        status,
        hash_files: None,
    };
    expr::condition(step.condition.as_deref().unwrap_or_default(), &scope).unwrap()
}

/// Whether a step runs, for a job going `status`, with `contexts` (an
/// object of them, such as `steps`).
fn runs_with(step: &workflow::Step, contexts: &Value, status: Status) -> bool {
    let contexts = contexts.as_object().unwrap().clone();
    let scope = Scope {
        contexts: &contexts,
        status,
        hash_files: None,
    };
    expr::condition(step.condition.as_deref().unwrap_or_default(), &scope).unwrap()
}

#[test]
fn rust_builds_go_through_sccache_before_cargo_and_report_after() {
    let step = |job: &workflow::Job, run: &str| -> (usize, workflow::Step) {
        let at = job
            .steps
            .iter()
            .position(|s| s.run.as_deref() == Some(run))
            .unwrap_or_else(|| panic!("{}: no step runs {run}", job.id));
        (at, job.steps[at].clone())
    };
    let deploy = read("deploy.yml");
    // The Workers' Rust is built by the build job; a stage's job builds
    // only the runner's binary, for its image.
    for (id, through) in [
        ("build", [true, false, false]),
        ("core", [false, true, false]),
        ("core_rest", [false, true, false]),
        ("edge", [false, true, false]),
        ("edge_rest", [false, true, false]),
        ("front", [false, true, false]),
    ] {
        let stage = id;
        let job = deploy.jobs.iter().find(|j| j.id == id).unwrap();
        let (install_at, install) = step(job, "bash scripts/sccache.sh install");
        let (stats_at, stats) = step(job, "bash scripts/sccache.sh stats");
        // Before anything runs Cargo (worker-build's install, the build),
        // and the statistics last.
        let install_step = job
            .steps
            .iter()
            .position(|s| s.name.as_deref() == Some("Install"))
            .unwrap();
        assert!(install_at < install_step, "{stage}");
        assert_eq!(stats_at, job.steps.len() - 1, "{stage}");
        for (rust, image, uses) in [
            (true, false, through[0]),
            (false, true, through[1]),
            (false, false, through[2]),
        ] {
            let matrix = json!({ "group": "g", "units": "u", "rust": rust, "image": image });
            assert_eq!(
                step_runs(&install, matrix.clone(), Status::Success),
                uses,
                "{stage} rust={rust} image={image}"
            );
            assert_eq!(
                step_runs(&stats, matrix.clone(), Status::Success),
                uses,
                "{stage}"
            );
            // A failed build still says what was cached.
            assert_eq!(step_runs(&stats, matrix, Status::Failure), uses, "{stage}");
        }
    }
    let ci = read("ci.yml");
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    let (install_at, _) = step(rust, "bash scripts/sccache.sh install");
    let (tests_at, _) = step(rust, "cargo test ${{ steps.affected.outputs.crates }} --locked --quiet");
    let (stats_at, stats) = step(rust, "bash scripts/sccache.sh stats");
    assert!(install_at < tests_at && tests_at < stats_at);
    let testing = json!({ "steps": { "affected": { "outputs": { "crates": "-p g1t-kit", "whole": "true" } } } });
    assert!(runs_with(&stats, &testing, Status::Failure));
    // main's runs keep the caches pull requests restore from: Rust's test
    // builds and tsc's build info; the site's build keeps nothing.
    assert!(ci.trigger("push").unwrap().branches.allows("main"));
    assert!(ci.trigger("pull_request").is_some());
    assert!(ci.trigger("merge_group").is_some());
    for (id, on_push) in [("rust", true), ("typescript", true), ("build", false)] {
        let job = ci.jobs.iter().find(|j| j.id == id).unwrap();
        for (event, expected) in [
            ("push", on_push),
            ("pull_request", true),
            ("merge_group", true),
        ] {
            let mut contexts = Map::new();
            contexts.insert(
                "github".into(),
                json!({ "event_name": event, "ref": "refs/heads/main" }),
            );
            let scope = Scope {
                contexts: &contexts,
                status: Status::Success,
                hash_files: None,
            };
            assert_eq!(
                expr::condition(job.condition.as_deref().unwrap_or_default(), &scope).unwrap(),
                expected,
                "{id} on {event}"
            );
        }
    }
    // The download is pinned by version and checksum.
    let script = std::fs::read_to_string(workflows_dir().join("../../scripts/sccache.sh")).unwrap();
    assert!(script.contains("VERSION=0.18.0"));
    assert!(script.lines().any(|line| {
        line.strip_prefix("SHA256=")
            .is_some_and(|sum| sum.len() == 64)
    }));
    assert!(script.contains("sha256sum -c"));
    assert!(script.contains("RUSTC_WRAPPER="));
    assert!(script.contains("GITHUB_STEP_SUMMARY"));
    // A tag's run reads main's entries and saves none, which only its own
    // tag could read; the mode reaches the steps after it too.
    assert!(script.contains("if [ \"${GITHUB_REF_TYPE:-}\" = tag ]; then\n  export SCCACHE_GHA_RW_MODE=READ_ONLY"));
    assert!(script.contains("echo \"SCCACHE_GHA_RW_MODE=$SCCACHE_GHA_RW_MODE\""));
    let tagged = read("runner-release.yml");
    assert!(tagged.trigger("push").unwrap().tags.allows("runner-v0.4.0"));
}

#[test]
fn g1ts_own_actions_are_published_when_they_change() {
    let release = read("actions-release.yml");
    let push = release.trigger("push").unwrap();
    assert!(push.branches.allows("main"));
    assert!(!push.branches.allows("feature"));
    assert!(release.trigger("workflow_dispatch").is_some());
    let source = std::fs::read_to_string(workflows_dir().join("actions-release.yml")).unwrap();
    assert!(source.contains("actions/**"));
    assert!(source.contains("secrets.ACTIONS_PUBLISH_TOKEN"));
    // Every action is a composite one with its README, and the copies of
    // the script that finds g1t-runner are the same file.
    let actions = workflows_dir().join("../../actions");
    let mut finders = Vec::new();
    for entry in std::fs::read_dir(&actions).unwrap() {
        let dir = entry.unwrap().path();
        let manifest = std::fs::read_to_string(dir.join("action.yml"))
            .unwrap_or_else(|_| panic!("{} has no action.yml", dir.display()));
        let manifest: serde_yaml::Value = serde_yaml::from_str(&manifest).unwrap();
        assert_eq!(
            manifest["runs"]["using"].as_str(),
            Some("composite"),
            "{}",
            dir.display()
        );
        assert!(dir.join("README.md").exists(), "{}", dir.display());
        finders.push(std::fs::read_to_string(dir.join("runner.sh")).unwrap());
    }
    assert!(finders.len() >= 2);
    assert!(
        finders.windows(2).all(|pair| pair[0] == pair[1]),
        "actions/*/runner.sh differ"
    );
    let deploy: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(actions.join("deploy/action.yml")).unwrap())
            .unwrap();
    assert_eq!(
        deploy["inputs"]["token"]["default"].as_str(),
        Some("${{ github.token }}")
    );
    for output in ["url", "deployment-id"] {
        assert!(deploy["outputs"][output]["value"].is_string(), "{output}");
    }
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

#[test]
fn the_conformance_workflow_is_the_same_on_github_and_on_g1t() {
    let root = workflows_dir()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let ours = std::fs::read_to_string(root.join(".g1t/workflows/conformance.yml")).unwrap();
    let theirs = std::fs::read_to_string(root.join(".github/workflows/conformance.yml")).unwrap();
    assert_eq!(
        ours, theirs,
        "copy .g1t/workflows/conformance.yml over .github/workflows/conformance.yml"
    );
    // It runs only by hand, and reads nothing it could change.
    let workflow = read("conformance.yml");
    assert_eq!(
        workflow
            .triggers
            .iter()
            .map(|t| t.event.as_str())
            .collect::<Vec<_>>(),
        ["workflow_dispatch"]
    );
    assert!(!ours.contains("secrets."));
}

/// No workflow of g1t's asks for a secret no one can set. Secret names
/// starting with G1T_ or GITHUB_ are g1t's own and refused when saved, so a
/// workflow reading one gets nothing: the Actions release asked for
/// G1T_ACTIONS_PUBLISH_TOKEN, which could never exist. G1T_TOKEN, the job's
/// own token, is the one g1t gives every job.
#[test]
fn workflows_read_only_secrets_that_can_be_set() {
    for entry in std::fs::read_dir(workflows_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|ext| ext != "yml") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        for (at, _) in source.match_indices("secrets.") {
            let name: String = source[at + "secrets.".len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            let reserved = name.starts_with("G1T_") || name.starts_with("GITHUB_");
            assert!(
                !reserved || name == "G1T_TOKEN" || name == "GITHUB_TOKEN",
                "{} reads secrets.{name}, a name g1t keeps for its own",
                path.display()
            );
        }
    }
}

#[test]
fn every_install_runs_again_when_a_connection_drops() {
    // npm does not retry a body that breaks off midway; npm-ci.mjs does.
    for entry in std::fs::read_dir(workflows_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        for job in read(&name).jobs {
            for step in &job.steps {
                let Some(run) = step.run.as_deref() else {
                    continue;
                };
                for line in run.lines() {
                    assert!(
                        !line.trim().starts_with("npm ci"),
                        "{name} {}: `{}` should be `node scripts/deploy/npm-ci.mjs …`",
                        job.id,
                        line.trim()
                    );
                }
            }
        }
    }
}

/// The workspace's crates, by package name: Cargo.toml's members, with
/// `crates/*` read from the folder.
fn workspace_crates() -> Vec<String> {
    let root = workflows_dir().join("../..");
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    let members = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("members"))
        .unwrap();
    let mut dirs = Vec::new();
    for member in members.split('"').skip(1).step_by(2) {
        match member.strip_suffix("/*") {
            Some(parent) => {
                for entry in std::fs::read_dir(root.join(parent)).unwrap() {
                    let path = entry.unwrap().path();
                    if path.join("Cargo.toml").exists() {
                        dirs.push(path);
                    }
                }
            }
            None => dirs.push(root.join(member)),
        }
    }
    let mut names: Vec<String> = dirs
        .iter()
        .map(|dir| {
            let manifest = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
            let line = manifest
                .lines()
                .find(|line| line.trim_start().starts_with("name"))
                .unwrap_or_else(|| panic!("{} has no name", dir.display()));
            line.split('"').nth(1).unwrap().to_owned()
        })
        .collect();
    names.sort();
    names
}

/// The TypeScript job's type checks, of the workspaces ci-affected.mjs names.
const TYPE_CHECKS: &str =
    "node scripts/deploy/ci-workspaces.mjs typecheck ${{ steps.affected.outputs.typecheck }}";

/// What `ci-affected.mjs --npm` writes for a run on `event`: every
/// workspace and check when `reached`, none otherwise; a push the merge
/// queue `tested` only type checks.
fn npm_outputs(event: &str, tested: bool, reached: bool) -> Value {
    let all = "@g1t/contracts @g1t/web";
    let run = reached && !tested;
    json!({
        "github": { "event_name": event },
        "steps": { "affected": { "outputs": {
            "tested": tested.to_string(),
            "typecheck": if reached { all } else { "" },
            "test": if run { all } else { "" },
            "install": reached.to_string(),
            "install-args": "",
            "whole": reached.to_string(),
            "deploy": run.to_string(),
            "conformance": run.to_string(),
            "ops": run.to_string(),
            "manifest": run.to_string(),
            "plugins": run.to_string(),
        } } },
    })
}

#[test]
fn ci_checks_only_the_npm_workspaces_a_pull_request_reaches() {
    let ci = read("ci.yml");
    let typescript = ci.jobs.iter().find(|j| j.id == "typescript").unwrap();
    // The test merge commit and its parents, to compare it with the base.
    assert_eq!(typescript.steps[0].raw["with"]["fetch-depth"], json!(2));
    let affected = &typescript.steps[1];
    assert_eq!(affected.id.as_deref(), Some("affected"));
    assert!(affected.condition.is_none());
    // A pull request that reaches no workspace and no check installs and
    // runs nothing but ci-affected's own tests, and passes.
    for step in &typescript.steps[2..] {
        let name = step.name.clone().unwrap_or_default();
        let always = step.run.as_deref() == Some("node --test scripts/deploy/ci-affected.test.mjs");
        assert_eq!(
            runs_with(step, &npm_outputs("pull_request", false, false), Status::Success),
            always,
            "{name}"
        );
        // One that reaches them runs every step but the save, main's alone.
        assert_eq!(
            runs_with(step, &npm_outputs("pull_request", false, true), Status::Success),
            !(saves(step) && step.raw["with"]["key"].as_str().is_some_and(|k| k.starts_with("tsc-"))),
            "{name}"
        );
    }
    // The workspaces' scripts run through ci-workspaces.mjs, and only a
    // whole check saves tsc's build info.
    for run in [
        TYPE_CHECKS,
        "node scripts/deploy/ci-workspaces.mjs test ${{ steps.affected.outputs.test }}",
        "node scripts/deploy/npm-ci.mjs --prefer-offline --no-audit --no-fund ${{ steps.affected.outputs.install-args }}",
    ] {
        assert!(typescript.steps.iter().any(|s| s.run.as_deref() == Some(run)), "{run}");
    }
    let save = typescript
        .steps
        .iter()
        .find(|s| s.uses.as_deref().is_some_and(|u| u.starts_with("actions/cache/save@")))
        .unwrap();
    let mut part = npm_outputs("push", false, true);
    part["steps"]["affected"]["outputs"]["whole"] = json!("false");
    assert!(!runs_with(save, &part, Status::Success));
    assert!(runs_with(save, &npm_outputs("push", false, true), Status::Success));
}

#[test]
fn ci_keeps_only_tsc_build_info_between_type_checks() {
    // tsc hashes every file it reads against its build info, so an entry
    // from another commit never hides an error; a generated type kept from
    // another commit could, so each run writes those again.
    let ci = read("ci.yml");
    let typescript = ci.jobs.iter().find(|j| j.id == "typescript").unwrap();
    let at = typescript
        .steps
        .iter()
        .position(|s| s.raw["with"]["key"].as_str().is_some_and(|k| k.starts_with("tsc-")))
        .unwrap();
    let kept = paths(&typescript.steps[at]);
    assert!(!kept.is_empty() && kept.iter().all(|p| p.ends_with("/*.tsbuildinfo")), "{kept:?}");
    let check = typescript
        .steps
        .iter()
        .position(|s| s.run.as_deref() == Some(TYPE_CHECKS))
        .unwrap();
    assert!(at < check);
}

#[test]
fn ci_tests_every_crate_once_across_its_rust_parts() {
    let ci = read("ci.yml");
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    assert!(!rust.fail_fast);
    let parts = rust.raw["strategy"]["matrix"]["include"].as_array().unwrap();
    assert!(parts.len() >= 2, "{parts:?}");
    let mut tested: Vec<String> = Vec::new();
    for part in parts {
        let crates = part["crates"].as_str().unwrap();
        let mut words = crates.split_whitespace();
        while let Some(flag) = words.next() {
            assert_eq!(flag, "-p", "{crates}");
            tested.push(words.next().unwrap().to_owned());
        }
    }
    tested.sort();
    let mut once = tested.clone();
    once.dedup();
    assert_eq!(tested, once, "a crate is in more than one part");
    assert_eq!(tested, workspace_crates(), "the parts and the workspace's crates differ");
    // Each part keeps a test build of its own, and builds and prunes the same crates.
    let key = rust
        .steps
        .iter()
        .find(|s| s.id.as_deref() == Some("test-build"))
        .unwrap()
        .raw["with"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(key.contains("${{ matrix.part }}"), "{key}");
    // It tests the crates of the part a pull request reaches, and prunes
    // and saves only a build of all of them.
    for run in ["cargo test ${{ steps.affected.outputs.crates }} --locked --quiet", "node scripts/deploy/ci-cache.mjs prune target/debug -- test ${{ matrix.crates }} --locked --no-run"] {
        assert!(rust.steps.iter().any(|s| s.run.as_deref() == Some(run)), "{run}");
    }
}

#[test]
fn ci_tests_only_the_crates_a_pull_request_reaches() {
    let ci = read("ci.yml");
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    // The check names stay those the rules may require.
    assert_eq!(rust.raw["name"], json!("Rust (${{ matrix.part }})"));
    // The test merge commit and its parents, to compare it with the base.
    let checkout = &rust.steps[0];
    assert!(checkout.uses.as_deref().is_some_and(|u| u.starts_with("actions/checkout@")));
    assert_eq!(checkout.raw["with"]["fetch-depth"], json!(2));
    let affected = &rust.steps[1];
    assert_eq!(affected.id.as_deref(), Some("affected"));
    assert_eq!(
        affected.run.as_deref(),
        Some("node scripts/deploy/ci-affected.mjs ${{ matrix.crates }}")
    );
    assert!(affected.condition.is_none());
    let outputs = |crates: &str, whole: bool| {
        json!({ "steps": {
            "affected": { "outputs": { "crates": crates, "whole": whole.to_string() } },
            "test-build": { "outputs": { "cache-hit": "false" } },
        } })
    };
    let (all, some, none) = (outputs("-p g1t-kit -p g1t", true), outputs("-p g1t", false), outputs("", false));
    for step in &rust.steps[2..] {
        let name = step.name.clone().unwrap_or_default();
        // A part with nothing to test does nothing more, and passes.
        assert!(!runs_with(step, &none, Status::Success), "{name}");
        assert!(!runs_with(step, &none, Status::Failure), "{name}");
        // Built only for a push the merge queue tested (below).
        if name == "Tests, compiled only" {
            continue;
        }
        assert!(runs_with(step, &all, Status::Success), "{name}");
        // Only a build of every crate of the part is pruned and saved.
        let keeps = name == "Only this build's files are saved" || saves(step) && step.id.as_deref() != Some("test-build") && step.raw["with"]["key"].as_str().is_some_and(|k| k.starts_with("cargo-test-"));
        assert_eq!(runs_with(step, &some, Status::Success), !keeps, "{name}");
    }
    // The script is the build's: a change to it, as to this workflow,
    // tests every crate (scripts/deploy/ci-affected.mjs EVERYTHING).
    let script = std::fs::read_to_string(workflows_dir().join("../../scripts/deploy/ci-affected.mjs")).unwrap();
    for path in ["\"Cargo.lock\"", "\".g1t/workflows/ci.yml\"", "\"scripts/sccache.sh\"", "\"scripts/deploy/ci-affected.mjs\""] {
        assert!(script.contains(path), "{path}");
    }
    // Anything but a pull request or a merge queue state tests every crate.
    assert!(script.contains("if (event === \"pull_request\") {"));
    assert!(script.contains("if (event === \"merge_group\") {"));
    assert!(script.contains("return { why: `a ${event ?? \"local\"} run tests every crate` };"));
}

#[test]
fn a_push_the_merge_queue_tested_keeps_mains_caches_and_runs_no_tests_again() {
    let ci = read("ci.yml");
    // Its token may read runs: ci-affected.mjs asks whether the push's
    // commit passed a merge_group run of CI.
    assert_eq!(ci.raw["permissions"]["actions"], json!("read"));
    let rust = ci.jobs.iter().find(|j| j.id == "rust").unwrap();
    let affected = rust
        .steps
        .iter()
        .find(|s| s.id.as_deref() == Some("affected"))
        .unwrap();
    assert_eq!(
        affected.raw["env"]["GITHUB_TOKEN"],
        json!("${{ github.token }}")
    );
    let outputs = |tested: bool| {
        json!({ "steps": {
            "affected": { "outputs": { "crates": "-p g1t-kit -p g1t", "whole": "true", "tested": tested.to_string() } },
            "test-build": { "outputs": { "cache-hit": "false" } },
        } })
    };
    let named = |name: &str| {
        rust.steps
            .iter()
            .find(|s| s.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("no step {name}"))
    };
    let (tests, compiled) = (named("Tests"), named("Tests, compiled only"));
    assert_eq!(
        tests.run.as_deref(),
        Some("cargo test ${{ steps.affected.outputs.crates }} --locked --quiet")
    );
    assert_eq!(
        compiled.run.as_deref(),
        Some("cargo test ${{ steps.affected.outputs.crates }} --locked --quiet --no-run")
    );
    for (tested, test, compile) in [(false, true, false), (true, false, true)] {
        assert_eq!(
            runs_with(tests, &outputs(tested), Status::Success),
            test,
            "tested={tested}"
        );
        assert_eq!(
            runs_with(compiled, &outputs(tested), Status::Success),
            compile,
            "tested={tested}"
        );
        // Either way the whole build is pruned and saved for pull requests.
        assert!(runs_with(
            named("Only this build's files are saved"),
            &outputs(tested),
            Status::Success
        ));
        assert!(runs_with(
            named("Save the test build"),
            &outputs(tested),
            Status::Success
        ));
    }
    // A queue state's branch is gone once it lands: it saves no test build.
    let mut queued = outputs(false).as_object().unwrap().clone();
    queued.insert("github".into(), json!({ "event_name": "merge_group" }));
    assert!(!runs_with(
        named("Save the test build"),
        &Value::Object(queued),
        Status::Success
    ));
    // TypeScript type checks every workspace, saving tsc's build info, and
    // runs no tests: ci-affected.mjs --npm says which (npmPlan).
    let typescript = ci.jobs.iter().find(|j| j.id == "typescript").unwrap();
    let queue = typescript
        .steps
        .iter()
        .position(|s| s.id.as_deref() == Some("affected"))
        .unwrap();
    assert_eq!(
        typescript.steps[queue].run.as_deref(),
        Some("node scripts/deploy/ci-affected.mjs --npm")
    );
    assert_eq!(
        typescript.steps[queue].raw["env"]["GITHUB_TOKEN"],
        json!("${{ github.token }}")
    );
    let check = typescript
        .steps
        .iter()
        .position(|s| s.run.as_deref() == Some(TYPE_CHECKS))
        .unwrap();
    assert!(queue < check);
    for step in &typescript.steps[check..] {
        let name = step.name.clone().unwrap_or_default();
        assert!(runs_with(step, &npm_outputs("push", false, true), Status::Success), "{name}");
        let kept = step.run.as_deref() == Some(TYPE_CHECKS) || saves(step);
        assert_eq!(
            runs_with(step, &npm_outputs("push", true, true), Status::Success),
            kept,
            "{name}"
        );
    }
    // The desktop job asks too, and passes without running (ci-affected.mjs).
    let desktop = ci.jobs.iter().find(|j| j.id == "desktop").unwrap();
    let asks = desktop
        .steps
        .iter()
        .find(|s| s.id.as_deref() == Some("affected"))
        .unwrap();
    assert_eq!(
        asks.run.as_deref(),
        Some("node scripts/deploy/ci-affected.mjs --job desktop")
    );
    assert_eq!(
        asks.raw["env"]["GITHUB_TOKEN"],
        json!("${{ github.token }}")
    );
}
