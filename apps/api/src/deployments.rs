//! Deployments over REST and MCP: a repository's deployments wherever they
//! run, their statuses, and its environments.
//!
//! Any CI reports a deployment and its statuses here; a g1t Actions job
//! with an `environment:` makes them itself, and g1t.page builds are read
//! in alongside. The deployments service decides who may see and report
//! them (Read to see, Write to report) and keeps them; deployments travel
//! in `snake_case` between services too, so a request's fields reach it
//! as they are, and a deployment's `payload` comes back as it was given.
//!
//! A project's g1t.page settings (whether it deploys at all, and how it
//! builds) are here too, named by workspace and project as the project
//! routes are: the deployments service keeps them in `camelCase`, as the
//! site reads them, so they are shaped here.

use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on deployments.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeploymentsOp {
    ListDeployments,
    GetDeployment,
    CreateDeployment,
    ListDeploymentStatuses,
    CreateDeploymentStatus,
    ListEnvironments,
    GetEnvironment,
    StartDeploymentBuild,
    GetDeploymentSettings,
    UpdateDeploymentSettings,
}

/// The states a deployment's status can have.
const STATES: [&str; 6] = ["queued", "in_progress", "success", "failure", "error", "inactive"];

/// What a project may be built as (`BUILD_AS` in @g1t/contracts).
const BUILD_AS: [&str; 4] = ["auto", "static", "workers", "docker"];

/// The sizes a container app runs at (`APP_INSTANCES` in @g1t/contracts).
const INSTANCE_TYPES: [&str; 6] = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];

impl DeploymentsOp {
    /// Every one: `Op::ALL` lists each as `Op::Deployments(…)`, which a
    /// test checks against this.
    #[cfg(test)]
    pub const ALL: [DeploymentsOp; 10] = [
        DeploymentsOp::ListDeployments,
        DeploymentsOp::GetDeployment,
        DeploymentsOp::CreateDeployment,
        DeploymentsOp::ListDeploymentStatuses,
        DeploymentsOp::CreateDeploymentStatus,
        DeploymentsOp::ListEnvironments,
        DeploymentsOp::GetEnvironment,
        DeploymentsOp::StartDeploymentBuild,
        DeploymentsOp::GetDeploymentSettings,
        DeploymentsOp::UpdateDeploymentSettings,
    ];

    pub fn name(self) -> &'static str {
        match self {
            DeploymentsOp::ListDeployments => "list_deployments",
            DeploymentsOp::GetDeployment => "get_deployment",
            DeploymentsOp::CreateDeployment => "create_deployment",
            DeploymentsOp::ListDeploymentStatuses => "list_deployment_statuses",
            DeploymentsOp::CreateDeploymentStatus => "create_deployment_status",
            DeploymentsOp::ListEnvironments => "list_environments",
            DeploymentsOp::GetEnvironment => "get_environment",
            DeploymentsOp::StartDeploymentBuild => "start_deployment_build",
            DeploymentsOp::GetDeploymentSettings => "get_deployment_settings",
            DeploymentsOp::UpdateDeploymentSettings => "update_deployment_settings",
        }
    }

    /// For the API reference: "List deployments".
    pub fn title(self) -> &'static str {
        match self {
            DeploymentsOp::ListDeployments => "List deployments",
            DeploymentsOp::GetDeployment => "Get a deployment",
            DeploymentsOp::CreateDeployment => "Create a deployment",
            DeploymentsOp::ListDeploymentStatuses => "List deployment statuses",
            DeploymentsOp::CreateDeploymentStatus => "Create a deployment status",
            DeploymentsOp::ListEnvironments => "List environments",
            DeploymentsOp::GetEnvironment => "Get an environment",
            DeploymentsOp::StartDeploymentBuild => "Start a g1t.page build from a workflow",
            DeploymentsOp::GetDeploymentSettings => "Get a project's deployment settings",
            DeploymentsOp::UpdateDeploymentSettings => "Update a project's deployment settings",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            DeploymentsOp::ListDeployments => "List a repository's deployments wherever they run, newest first: those reported through this API, those g1t Actions made for jobs with an `environment:`, and g1t.page builds (production and previews). Each has its environment, ref and sha, task, description, payload, transient_environment and production_environment, its latest state (queued, in_progress, success, failure, error or inactive), environment_url and log_url, creator, and source (api, actions or g1t_page), with run_id and run_url for g1t Actions and project and number for g1t.page. Filter by environment, ref, sha (or a prefix), task, state, source and creator; page with page and per_page (30 by default, at most 100). total_count counts every match. Needs the Read role; a public repository's are open to anyone.",
            DeploymentsOp::GetDeployment => "Get one deployment by id (dep_… for a reported one, dpl_… for a g1t.page build), with every status it has had, oldest first. Needs the Read role.",
            DeploymentsOp::CreateDeployment => "Report a deployment of a commit to an environment, from any CI or script. ref is the branch, tag or commit deployed; sha is resolved from it unless you give the whole commit id. environment is production unless you say (any name up to 255 characters, such as staging or review/feature-x; names are matched without regard to case, and the first spelling is kept). task is deploy unless you say; payload is any JSON object, returned as given. production_environment is true for an environment named production unless you say; transient_environment marks one that goes away, such as a review app. Its first status is state (queued unless you say), with environment_url and log_url. Each status also shows on the commit as the check `deploy / <environment>`, which a ruleset's required_deployments rule can require. Needs the Write role. Returns the deployment with its statuses.",
            DeploymentsOp::ListDeploymentStatuses => "List a deployment's statuses, newest first: each with its state, description, environment_url, log_url, creator and created_at. A g1t.page build's are read from the build itself. Needs the Read role.",
            DeploymentsOp::CreateDeploymentStatus => "Add a status to a reported deployment: state (queued, in_progress, success, failure, error or inactive), description, environment_url (where it is served) and log_url (where its output can be read). The deployment takes its state, and any address it gives. A success with auto_inactive (true unless you say) makes the environment's older successful deployments inactive. The commit's `deploy / <environment>` check follows: pending while queued or in progress, then success, failure or error. A g1t.page build's statuses come from the build and cannot be added to. Needs the Write role.",
            DeploymentsOp::ListEnvironments => "List the environments a repository's deployments went to, those people use directly first (production by name before others), then the most recently deployed, and after them those with protection rules but no deployment yet. Each has its name, url (where its current deployment is served), production_environment, transient_environment, deployments_count, latest (its newest deployment, whatever its state), current (its newest successful deployment that is still active) and updated_at, and, when it has rules, protection_rules (required_reviewers, wait_timer, branch_policy), deployment_branch_policy, branch_policies and can_admins_bypass. total_count counts deployments across every environment. Needs the Read role.",
            DeploymentsOp::GetEnvironment => "Get one environment by name, matched without regard to case, with its current and latest deployments and its protection rules (see update_environment). An environment with rules but no deployment yet is found too. A name with slashes is URL-encoded in the path. Needs the Read role.",
            DeploymentsOp::StartDeploymentBuild => "From a running g1t Actions job, open a g1t.page build of one of the repository's projects, which the job then builds in its own checkout with `g1t-runner deploy` (the g1t/deploy action does both). Only the job's own token (G1T_TOKEN) may call it, with `deployments: write` (or `pages: write`) in its `permissions:`. project is the project's slug; it may be left out when the repository has one project with Deployments on. The run decides what is built: a run on the project's production branch (a push, a dispatch or a schedule there) builds production, a pull request's run builds that pull request's preview, and a run on another branch builds that branch's preview; a tag's run is refused. sha is the commit built, the run's unless you say. A pull request from a fork or from someone without the Write role, and a run that had to be approved, get no build secrets. The workspace's plan must include Deployments and its spend limit must not be reached; the build's time is the job's Actions time and is not charged again. Returns deploy_id and token (DEPLOY_ID and DEPLOY_TOKEN for `g1t-runner deploy`, the token good for this build alone until it finishes), kind (production or preview), project, branch, number, commit, url (the app's address), trusted, the project's root_dir, build_command and output_dir, build_as (auto, static, workers or docker) and dockerfile (its Dockerfile's path, or null to find `Dockerfile` or `Containerfile`), and build_env and build_secrets (the project's variables and secrets for builds of that kind). The commit's `g1t / deploy` check is pending until the build reports.",
            DeploymentsOp::GetDeploymentSettings => "A project's g1t.page deployment settings, as its Settings → Deployments page shows them: whether Deployments are on (`enabled`; off for every project until someone turns them on), whether the default branch deploys to production on every push (`production`) and every pull request gets a preview (`previews`), production's address (`production_url`, and `primary_domain` once a custom domain serves it), how it builds (`build_as`: auto, static, workers or docker; `build_command`, `output_dir`, `dockerfile` and `instance_type` for a container; `via_workflow` to build through the deploy workflow g1t manages), how many days an unvisited preview stays up (`idle_days`), and what its last finished build found it to be (`detected`: workers, static, html or container, with `framework`), null before one has. A repository's own project has its name. Needs the Read role on the project's repository.",
            DeploymentsOp::UpdateDeploymentSettings => "Change a project's g1t.page deployment settings; only what you give changes. `enabled: true` turns Deployments on, as Turn on deployments under Settings → Deployments does: production starts building from the default branch at once, and every pull request gets a preview. That needs the g1t plan on the workspace (refused with payment_required otherwise; an owner starts it under Billing), and is refused for a project set to be a library, a tool or other until update_project makes it an app. `enabled: false` takes production and every preview down now and stops building; turning `production` or `previews` off takes those apps down. build_command, output_dir and dockerfile take null or \"\" to go back to what is found by itself; idle_days is 1 to 90; build_as is auto, static, workers or docker; instance_type is a container size (lite, basic, standard-1 to standard-4). Needs the Admin role on the project's repository. Returns the settings as get_deployment_settings does.",
        }
    }

    /// Whether it changes anything.
    pub fn writes(self) -> bool {
        matches!(
            self,
            DeploymentsOp::CreateDeployment
                | DeploymentsOp::CreateDeploymentStatus
                | DeploymentsOp::StartDeploymentBuild
                | DeploymentsOp::UpdateDeploymentSettings
        )
    }

    /// Whether it is about one repository, named by `repo`: a project's
    /// settings are named by its workspace and slug instead.
    pub fn needs_repo(self) -> bool {
        !matches!(self, DeploymentsOp::GetDeploymentSettings | DeploymentsOp::UpdateDeploymentSettings)
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The deployment's id: dep_… for a reported one, dpl_… for a g1t.page build." });
        let state = |what: &str| json!({ "type": "string", "enum": STATES, "description": what });
        let address = |what: &str| json!({ "type": "string", "description": what });
        let workspace = json!({ "type": "string", "description": "The workspace's slug, e.g. \"flagon-io\"." });
        let project = json!({ "type": "string", "description": "The project's slug, as in g1t.sh/{workspace}/{project}; a repository's own project has its name." });
        let (properties, required): (Value, &[&str]) = match self {
            DeploymentsOp::ListDeployments => (
                json!({
                    "repo": repo,
                    "environment": { "type": "string", "description": "Only this environment's, matched without regard to case." },
                    "ref": { "type": "string", "description": "Only deployments of this branch, tag or commit as it was given." },
                    "sha": { "type": "string", "description": "Only deployments of this commit, or of commits starting with it." },
                    "task": { "type": "string", "description": "Only this task's, such as deploy." },
                    "state": state("Only deployments whose latest status has this state."),
                    "source": { "type": "string", "enum": ["api", "actions", "g1t_page"], "description": "Only those reported through the API, made by g1t Actions, or built on g1t.page." },
                    "creator": { "type": "string", "description": "Only those this username (or g1t) made." },
                    "page": { "type": "integer", "description": "Which page, from 1." },
                    "per_page": { "type": "integer", "description": "How many a page holds, 1 to 100; 30 by default." },
                }),
                &["repo"],
            ),
            DeploymentsOp::GetDeployment | DeploymentsOp::ListDeploymentStatuses => (json!({ "repo": repo, "id": id }), &["repo", "id"]),
            DeploymentsOp::CreateDeployment => (
                json!({
                    "repo": repo,
                    "ref": { "type": "string", "description": "The branch, tag or commit deployed, such as main or v1.4.0." },
                    "sha": { "type": "string", "description": "The commit deployed; resolved from ref when left out." },
                    "environment": { "type": "string", "description": "Where it went, such as production, staging or review/feature-x; production unless you say." },
                    "task": { "type": "string", "description": "What kind of deployment, such as deploy or deploy:migrations; deploy unless you say." },
                    "description": { "type": "string", "description": "A short note, at most 1,000 characters." },
                    "payload": { "type": "object", "description": "Anything else to keep with it, as a JSON object (a JSON string of one is read too), at most 64 KB. Returned as given." },
                    "production_environment": { "type": "boolean", "description": "Whether people use this environment directly. True for production unless you say." },
                    "transient_environment": { "type": "boolean", "description": "Whether the environment goes away, such as a review app. False unless you say." },
                    "state": state("Its first status: queued unless you say. Report in_progress, then success or failure, as it goes."),
                    "environment_url": address("Where it is served, an http(s) address."),
                    "log_url": address("Where its output can be read, an http(s) address."),
                }),
                &["repo", "ref"],
            ),
            DeploymentsOp::CreateDeploymentStatus => (
                json!({
                    "repo": repo,
                    "id": id,
                    "state": state("Where it is now."),
                    "description": { "type": "string", "description": "A short note, at most 1,000 characters." },
                    "environment_url": address("Where it is served, an http(s) address."),
                    "log_url": address("Where its output can be read, an http(s) address."),
                    "auto_inactive": { "type": "boolean", "description": "On a success, make the environment's older successful deployments inactive. True unless you say." },
                }),
                &["repo", "id", "state"],
            ),
            DeploymentsOp::ListEnvironments => (json!({ "repo": repo }), &["repo"]),
            DeploymentsOp::StartDeploymentBuild => (
                json!({
                    "repo": repo,
                    "project": { "type": "string", "description": "The project's slug; may be left out when the repository has one project with Deployments on." },
                    "sha": { "type": "string", "description": "The commit built, in hex; the run's commit unless you say." },
                }),
                &["repo"],
            ),
            DeploymentsOp::GetEnvironment => (
                json!({
                    "repo": repo,
                    "environment": { "type": "string", "description": "The environment's name, such as production." },
                }),
                &["repo", "environment"],
            ),
            DeploymentsOp::GetDeploymentSettings => (json!({ "workspace": workspace, "project": project }), &["workspace", "project"]),
            DeploymentsOp::UpdateDeploymentSettings => (
                json!({
                    "workspace": workspace,
                    "project": project,
                    "enabled": { "type": "boolean", "description": "Turn Deployments on (production builds at once; needs the g1t plan) or off (every app comes down)." },
                    "production": { "type": "boolean", "description": "Deploy the default branch to production on every push." },
                    "previews": { "type": "boolean", "description": "A preview for every branch with an open pull request." },
                    "build_as": { "type": "string", "enum": BUILD_AS, "description": "What it is built as; auto finds it from its files." },
                    "build_command": { "type": ["string", "null"], "description": "Runs instead of the project's own build script; null or \"\" for its own." },
                    "output_dir": { "type": ["string", "null"], "description": "What a static site serves; null or \"\" to find it by itself." },
                    "dockerfile": { "type": ["string", "null"], "description": "For a container: its Dockerfile's path inside the project; null or \"\" for Dockerfile or Containerfile." },
                    "instance_type": { "type": "string", "enum": INSTANCE_TYPES, "description": "For a container: the size it runs at." },
                    "idle_days": { "type": "integer", "minimum": 1, "maximum": 90, "description": "A preview no one visits for this many days comes down." },
                    "via_workflow": { "type": "boolean", "description": "Build through the deploy workflow g1t manages for the project, listed under Actions." },
                }),
                &["workspace", "project"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

/// The fields of `input` named in `keys` that were given, as they were.
fn given(input: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| input.get(*key).filter(|value| !value.is_null()).map(|value| ((*key).to_owned(), value.clone())))
        .collect()
}

/// A query parameter's number, given as a number or as text.
fn number(input: &Value, key: &str) -> Option<u64> {
    match &input[key] {
        Value::Number(number) => number.as_u64(),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

/// A flag given as a boolean or as text.
fn flag(input: &Value, key: &str) -> Option<bool> {
    match &input[key] {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// The arguments the deployments service takes for `op`, from the
/// operation's input; `Err` says what is missing or wrong.
pub(crate) fn args(op: DeploymentsOp, input: &Value) -> std::result::Result<(&'static str, Map<String, Value>), String> {
    let mut out = Map::new();
    let repo = repo_path(input).ok_or("Give the repository as \"owner/name\".")?;
    out.insert("repo".into(), json!({ "namespace": repo.namespace, "name": repo.name }));
    let id = || input["id"].as_str().map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).ok_or("Give the deployment's id.");
    if let Some(state) = input["state"].as_str()
        && !STATES.contains(&state)
    {
        return Err(format!("{state} is not a state: use queued, in_progress, success, failure, error or inactive."));
    }
    let method = match op {
        DeploymentsOp::ListDeployments => {
            out.extend(given(input, &["environment", "ref", "sha", "task", "state", "source", "creator"]));
            if let Some(page) = number(input, "page") {
                out.insert("page".into(), page.into());
            }
            if let Some(per_page) = number(input, "per_page") {
                out.insert("per_page".into(), per_page.into());
            }
            "list_deployments"
        }
        DeploymentsOp::GetDeployment => {
            out.insert("id".into(), id()?.into());
            "get_deployment"
        }
        DeploymentsOp::ListDeploymentStatuses => {
            out.insert("id".into(), id()?.into());
            "list_deployment_statuses"
        }
        DeploymentsOp::CreateDeployment => {
            if input["ref"].as_str().is_none_or(|text| text.trim().is_empty()) && input["sha"].as_str().is_none() {
                return Err("Give the ref deployed: a branch, a tag or a commit.".to_owned());
            }
            out.extend(given(
                input,
                &["ref", "sha", "environment", "task", "description", "payload", "state", "environment_url", "log_url"],
            ));
            for key in ["production_environment", "transient_environment"] {
                if let Some(value) = flag(input, key) {
                    out.insert(key.into(), value.into());
                }
            }
            "create_deployment"
        }
        DeploymentsOp::CreateDeploymentStatus => {
            out.insert("id".into(), id()?.into());
            if input["state"].as_str().is_none() {
                return Err("Give the status's state: queued, in_progress, success, failure, error or inactive.".to_owned());
            }
            out.extend(given(input, &["state", "description", "environment_url", "log_url"]));
            if let Some(value) = flag(input, "auto_inactive") {
                out.insert("auto_inactive".into(), value.into());
            }
            "create_deployment_status"
        }
        DeploymentsOp::ListEnvironments => "list_environments",
        // The deployments service checks the job's token itself: the
        // caller (the job's workspace, with `token.job`) is the actor.
        DeploymentsOp::StartDeploymentBuild => {
            for key in ["project", "sha"] {
                if let Some(value) = input[key].as_str().map(str::trim).filter(|value| !value.is_empty()) {
                    out.insert(key.into(), value.into());
                }
            }
            "start_from_workflow"
        }
        DeploymentsOp::GetEnvironment => {
            let name = input["environment"].as_str().map(str::trim).filter(|name| !name.is_empty()).ok_or("Name the environment.")?;
            out.insert("name".into(), name.into());
            "get_environment"
        }
        // Named by workspace and project: see `settings_args`.
        DeploymentsOp::GetDeploymentSettings | DeploymentsOp::UpdateDeploymentSettings => {
            return Err("Name the workspace and the project.".to_owned());
        }
    };
    Ok((method, out))
}

/// The project a settings operation names, as the deployments service
/// takes it.
fn project_ref(input: &Value) -> std::result::Result<Value, String> {
    let slug = |key: &str| input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_lowercase);
    let workspace = slug("workspace").ok_or("Give the workspace's slug.")?;
    let project = slug("project").ok_or("Give the project's slug.")?;
    Ok(json!({ "workspace": workspace, "slug": project }))
}

/// The change an update asks for, in the deployments service's spelling:
/// only what it gives. `Err` says what is wrong.
pub(crate) fn settings_changes(input: &Value) -> std::result::Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for (key, field) in [("enabled", "enabled"), ("production", "production"), ("previews", "previews"), ("via_workflow", "viaWorkflow")] {
        match input.get(key) {
            None | Some(Value::Null) => {}
            Some(_) => {
                let value = flag(input, key).ok_or(format!("{key} must be true or false."))?;
                out.insert(field.into(), value.into());
            }
        }
    }
    // Text that "" or null puts back to what is found by itself.
    for (key, field) in [("build_command", "buildCommand"), ("output_dir", "outputDir"), ("dockerfile", "dockerfile")] {
        match input.get(key) {
            None => {}
            Some(Value::Null) => {
                out.insert(field.into(), Value::Null);
            }
            Some(Value::String(text)) if text.trim().chars().count() > 500 => {
                return Err(format!("{key} is at most 500 characters."));
            }
            Some(Value::String(text)) if text.trim().is_empty() => {
                out.insert(field.into(), Value::Null);
            }
            Some(Value::String(text)) => {
                out.insert(field.into(), text.trim().into());
            }
            Some(_) => return Err(format!("{key} must be a string or null.")),
        }
    }
    let word = |key: &str, allowed: &[&str]| -> std::result::Result<Option<String>, String> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if allowed.contains(&text.trim()) => Ok(Some(text.trim().to_owned())),
            Some(_) => Err(format!("{key} must be one of {}.", allowed.join(", "))),
        }
    };
    if let Some(build_as) = word("build_as", &BUILD_AS)? {
        out.insert("buildAs".into(), build_as.into());
    }
    if let Some(instance_type) = word("instance_type", &INSTANCE_TYPES)? {
        out.insert("instanceType".into(), instance_type.into());
    }
    match input.get("idle_days") {
        None | Some(Value::Null) => {}
        Some(_) => match number(input, "idle_days") {
            Some(days @ 1..=90) => {
                out.insert("idleDays".into(), days.into());
            }
            _ => return Err("idle_days must be a whole number from 1 to 90.".to_owned()),
        },
    }
    Ok(out)
}

/// A project's deployment settings as the deployments service answers
/// (`camelCase`), as the API shows them.
pub(crate) fn settings_json(settings: &Value, project: &Value) -> Value {
    json!({
        "workspace": project["workspace"],
        "project": project["slug"],
        "enabled": settings["enabled"].as_bool().unwrap_or(false),
        "production": settings["production"].as_bool().unwrap_or(true),
        "previews": settings["previews"].as_bool().unwrap_or(true),
        "production_url": settings["productionUrl"],
        "primary_domain": settings["primaryDomain"],
        "build_as": settings["buildAs"].as_str().unwrap_or("auto"),
        "build_command": settings["buildCommand"],
        "output_dir": settings["outputDir"],
        "dockerfile": settings["dockerfile"],
        "instance_type": settings["instanceType"].as_str().unwrap_or(INSTANCE_TYPES[0]),
        "idle_days": settings["idleDays"],
        "via_workflow": settings["viaWorkflow"].as_bool().unwrap_or(false),
        "detected": settings["detected"],
        "framework": settings["framework"],
    })
}

/// Reads or changes a project's deployment settings.
async fn run_settings(op: DeploymentsOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let project = match project_ref(input) {
        Ok(project) => project,
        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
    };
    let answered: Outcome<Value> = if op == DeploymentsOp::GetDeploymentSettings {
        g1t_kit::call(&services.deployments, "settings", &json!({ "project": project, "viewer": viewer })).await?
    } else {
        let Some(actor) = viewer else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Changing deployment settings needs a g1t access token."));
        };
        let changes = match settings_changes(input) {
            Ok(changes) => changes,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        g1t_kit::call(&services.deployments, "update_settings", &json!({ "actor": actor, "project": project, "changes": changes })).await?
    };
    Ok(match answered {
        Outcome::Ok(settings) => Outcome::Ok(settings_json(&settings, &project)),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    })
}

/// For create_repo with `deploy`: turns Deployments on for the new
/// repository's own project (named as the repository is), as the site's
/// new-repository card does, as the person who made it. Never fails the
/// creation: what it answers is `deployments` (the settings) or
/// `deploy_error` (why they are not on: no g1t plan, a role too low).
pub(crate) async fn turn_on_for_new_repo(services: &Services, actor: &Value, namespace: &str, name: &str) -> (Value, Value) {
    let project = json!({ "workspace": namespace.to_lowercase(), "slug": name.to_lowercase() });
    let asked = json!({ "actor": actor, "project": project, "changes": { "enabled": true } });
    let answered: Result<Outcome<Value>> = g1t_kit::call(&services.deployments, "update_settings", &asked).await;
    match answered {
        Ok(Outcome::Ok(settings)) => (settings_json(&settings, &project), Value::Null),
        Ok(Outcome::Fail(failure)) => (Value::Null, failure.message.into()),
        Err(error) => {
            worker::console_error!("created {namespace}/{name} without deployments: {error}");
            (
                Value::Null,
                "Deployments could not be turned on. Try again with update_deployment_settings, or from the project's Settings → Deployments.".into(),
            )
        }
    }
}

pub async fn run(op: DeploymentsOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    if !op.needs_repo() {
        return run_settings(op, services, viewer, input).await;
    }
    let (method, mut args) = match args(op, input) {
        Ok(found) => found,
        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
    };
    if op.writes() {
        let Some(actor) = viewer else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Reporting a deployment needs a g1t access token."));
        };
        args.insert("actor".into(), serde_json::to_value(actor)?);
    } else {
        args.insert("viewer".into(), serde_json::to_value(viewer)?);
    }
    let answered: Outcome<Value> = g1t_kit::call(&services.deployments, method, &Value::Object(args)).await?;
    // Environments carry their protection rules, kept by the actions service.
    match op {
        DeploymentsOp::ListEnvironments => crate::protection::with_protection(services, viewer, input, answered, None).await,
        DeploymentsOp::GetEnvironment => {
            let name = input["environment"].as_str().unwrap_or_default().trim().to_owned();
            crate::protection::with_protection(services, viewer, input, answered, Some(&name)).await
        }
        _ => Ok(answered),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_becomes_the_services_arguments() {
        let (method, args) = super::args(
            DeploymentsOp::CreateDeployment,
            &json!({ "repo": "acme/web", "ref": "main", "environment": "staging", "payload": { "buildId": 7 }, "production_environment": "false", "ignored": 1 }),
        )
        .unwrap();
        assert_eq!(method, "create_deployment");
        assert_eq!(args["repo"], json!({ "namespace": "acme", "name": "web" }));
        assert_eq!(args["payload"], json!({ "buildId": 7 }), "a payload passes through as given");
        assert_eq!(args["production_environment"], json!(false));
        assert!(!args.contains_key("ignored"));
        let (method, args) = super::args(DeploymentsOp::ListDeployments, &json!({ "repo": "acme/web", "page": "2", "state": "failure" })).unwrap();
        assert_eq!(method, "list_deployments");
        assert_eq!(args["page"], json!(2));
        assert!(super::args(DeploymentsOp::ListDeployments, &json!({ "repo": "acme/web", "state": "done" })).is_err());
        assert!(super::args(DeploymentsOp::CreateDeployment, &json!({ "repo": "acme/web" })).is_err());
        assert!(super::args(DeploymentsOp::CreateDeploymentStatus, &json!({ "repo": "acme/web", "id": "dep_1" })).is_err());
        let (method, args) = super::args(DeploymentsOp::GetEnvironment, &json!({ "repo": "acme/web", "environment": "review/x" })).unwrap();
        assert_eq!((method, args["name"].clone()), ("get_environment", json!("review/x")));
        let (method, args) = super::args(DeploymentsOp::StartDeploymentBuild, &json!({ "repo": "acme/web", "project": " web ", "sha": "" })).unwrap();
        assert_eq!(method, "start_from_workflow");
        assert_eq!(args["project"], json!("web"));
        assert!(!args.contains_key("sha"), "an empty sha is the run's");
        assert!(DeploymentsOp::StartDeploymentBuild.writes());
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in DeploymentsOp::ALL {
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            let required = op.input()["required"].as_array().unwrap().clone();
            if op.needs_repo() {
                assert!(required.contains(&json!("repo")), "{}", op.name());
            } else {
                assert_eq!(required, vec![json!("workspace"), json!("project")], "{}", op.name());
            }
        }
        assert!(DeploymentsOp::UpdateDeploymentSettings.writes());
        assert!(!DeploymentsOp::GetDeploymentSettings.writes());
    }

    #[test]
    fn a_settings_change_is_only_what_is_given_in_the_service_s_spelling() {
        let sent = settings_changes(&json!({
            "workspace": "flagon-io", "project": "web", "enabled": true, "previews": "false",
            "build_command": " npm run build ", "output_dir": "", "dockerfile": null,
            "build_as": "static", "instance_type": "basic", "idle_days": "14", "ignored": 1,
        }))
        .unwrap();
        assert_eq!(
            Value::Object(sent),
            json!({
                "enabled": true, "previews": false, "buildCommand": "npm run build", "outputDir": null,
                "dockerfile": null, "buildAs": "static", "instanceType": "basic", "idleDays": 14,
            })
        );
        assert!(settings_changes(&json!({})).unwrap().is_empty());
        assert_eq!(Value::Object(settings_changes(&json!({ "enabled": false })).unwrap()), json!({ "enabled": false }));
        for bad in [
            json!({ "enabled": "yes" }),
            json!({ "build_as": "container" }),
            json!({ "instance_type": "huge" }),
            json!({ "idle_days": 0 }),
            json!({ "idle_days": 91 }),
            json!({ "build_command": 3 }),
            json!({ "output_dir": "x".repeat(501) }),
        ] {
            assert!(settings_changes(&bad).is_err(), "{bad}");
        }
        assert!(project_ref(&json!({ "workspace": "acme" })).is_err());
        assert_eq!(project_ref(&json!({ "workspace": " Acme ", "project": "Web" })).unwrap(), json!({ "workspace": "acme", "slug": "web" }));
    }

    #[test]
    fn settings_are_snake_case() {
        let shown = settings_json(
            &json!({
                "enabled": true, "previews": true, "production": true, "buildCommand": null, "outputDir": "dist",
                "idleDays": 7, "viaWorkflow": false, "productionUrl": "https://web-acme.g1t.page", "primaryDomain": null,
                "detected": "static", "framework": "astro", "buildAs": "auto", "dockerfile": null, "instanceType": "lite",
                "containers": { "available": true, "sleepMinutes": 5, "prices": [] },
            }),
            &json!({ "workspace": "acme", "slug": "web" }),
        );
        assert!(g1t_kit::wire::camel_case_keys(&shown).is_empty(), "{:?}", g1t_kit::wire::camel_case_keys(&shown));
        assert_eq!(shown["production_url"], "https://web-acme.g1t.page");
        assert_eq!(shown["output_dir"], "dist");
        assert_eq!((shown["workspace"].clone(), shown["project"].clone()), (json!("acme"), json!("web")));
        assert!(shown.get("containers").is_none());
    }
}
