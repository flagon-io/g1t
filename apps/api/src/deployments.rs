//! Deployments over REST and MCP: a repository's deployments wherever they
//! run, their statuses, and its environments.
//!
//! Any CI reports a deployment and its statuses here; a g1t Actions job
//! with an `environment:` makes them itself, and g1t.page builds are read
//! in alongside. The deployments service decides who may see and report
//! them (Read to see, Write to report) and keeps them; deployments travel
//! in `snake_case` between services too, so a request's fields reach it
//! as they are, and a deployment's `payload` comes back as it was given.

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
}

/// The states a deployment's status can have.
const STATES: [&str; 6] = ["queued", "in_progress", "success", "failure", "error", "inactive"];

impl DeploymentsOp {
    /// Every one: `Op::ALL` lists each as `Op::Deployments(…)`, which a
    /// test checks against this.
    #[cfg(test)]
    pub const ALL: [DeploymentsOp; 7] = [
        DeploymentsOp::ListDeployments,
        DeploymentsOp::GetDeployment,
        DeploymentsOp::CreateDeployment,
        DeploymentsOp::ListDeploymentStatuses,
        DeploymentsOp::CreateDeploymentStatus,
        DeploymentsOp::ListEnvironments,
        DeploymentsOp::GetEnvironment,
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
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            DeploymentsOp::ListDeployments => "List a repository's deployments wherever they run, newest first: those reported through this API, those g1t Actions made for jobs with an `environment:`, and g1t.page builds (production and previews). Each has its environment, ref and sha, task, description, payload, transient_environment and production_environment, its latest state (queued, in_progress, success, failure, error or inactive), environment_url and log_url, creator, and source (api, actions or g1t_page), with run_id and run_url for g1t Actions and project and number for g1t.page. Filter by environment, ref, sha (or a prefix), task, state, source and creator; page with page and per_page (30 by default, at most 100). total_count counts every match. Needs the Read role; a public repository's are open to anyone.",
            DeploymentsOp::GetDeployment => "Get one deployment by id (dep_… for a reported one, dpl_… for a g1t.page build), with every status it has had, oldest first. Needs the Read role.",
            DeploymentsOp::CreateDeployment => "Report a deployment of a commit to an environment, from any CI or script. ref is the branch, tag or commit deployed; sha is resolved from it unless you give the whole commit id. environment is production unless you say (any name up to 255 characters, such as staging or review/feature-x; names are matched without regard to case, and the first spelling is kept). task is deploy unless you say; payload is any JSON object, returned as given. production_environment is true for an environment named production unless you say; transient_environment marks one that goes away, such as a review app. Its first status is state (queued unless you say), with environment_url and log_url. Each status also shows on the commit as the check `deploy / <environment>`, which a ruleset's required_deployments rule can require. Needs the Write role. Returns the deployment with its statuses.",
            DeploymentsOp::ListDeploymentStatuses => "List a deployment's statuses, newest first: each with its state, description, environment_url, log_url, creator and created_at. A g1t.page build's are read from the build itself. Needs the Read role.",
            DeploymentsOp::CreateDeploymentStatus => "Add a status to a reported deployment: state (queued, in_progress, success, failure, error or inactive), description, environment_url (where it is served) and log_url (where its output can be read). The deployment takes its state, and any address it gives. A success with auto_inactive (true unless you say) makes the environment's older successful deployments inactive. The commit's `deploy / <environment>` check follows: pending while queued or in progress, then success, failure or error. A g1t.page build's statuses come from the build and cannot be added to. Needs the Write role.",
            DeploymentsOp::ListEnvironments => "List the environments a repository's deployments went to, those people use directly first (production by name before others), then the most recently deployed. Each has its name, url (where its current deployment is served), production_environment, transient_environment, deployments_count, latest (its newest deployment, whatever its state), current (its newest successful deployment that is still active) and updated_at. total_count counts deployments across every environment. Needs the Read role.",
            DeploymentsOp::GetEnvironment => "Get one environment by name, matched without regard to case, with its current and latest deployments. A name with slashes is URL-encoded in the path. Needs the Read role.",
        }
    }

    /// Whether it changes anything.
    pub fn writes(self) -> bool {
        matches!(self, DeploymentsOp::CreateDeployment | DeploymentsOp::CreateDeploymentStatus)
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The deployment's id: dep_… for a reported one, dpl_… for a g1t.page build." });
        let state = |what: &str| json!({ "type": "string", "enum": STATES, "description": what });
        let address = |what: &str| json!({ "type": "string", "description": what });
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
            DeploymentsOp::GetEnvironment => (
                json!({
                    "repo": repo,
                    "environment": { "type": "string", "description": "The environment's name, such as production." },
                }),
                &["repo", "environment"],
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
        DeploymentsOp::GetEnvironment => {
            let name = input["environment"].as_str().map(str::trim).filter(|name| !name.is_empty()).ok_or("Name the environment.")?;
            out.insert("name".into(), name.into());
            "get_environment"
        }
    };
    Ok((method, out))
}

pub async fn run(op: DeploymentsOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
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
    g1t_kit::call(&services.deployments, method, &Value::Object(args)).await
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
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in DeploymentsOp::ALL {
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
        }
    }
}
