//! Checks over REST and MCP: statuses on commits, and check runs and
//! check suites, in GitHub's shapes so that existing integrations and
//! actions report to g1t unchanged.
//!
//! The work service keeps them and decides who may read and report them
//! (`g1t_contracts::checks`). A g1t Actions job is a check run here too,
//! and its workflow run the suite.

use g1t_contracts::checks::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChecksOp {
    CreateCommitStatus,
    ListCommitStatuses,
    GetCombinedStatus,
    CreateCheckRun,
    UpdateCheckRun,
    GetCheckRun,
    ListCheckRunAnnotations,
    RerequestCheckRun,
    ListCheckRunsForRef,
    ListCheckSuitesForRef,
    GetCheckSuite,
    RerequestCheckSuite,
}

impl ChecksOp {
    /// Every one: `Op::ALL` lists each as `Op::Checks(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [ChecksOp; 12] = [
        ChecksOp::CreateCommitStatus,
        ChecksOp::ListCommitStatuses,
        ChecksOp::GetCombinedStatus,
        ChecksOp::CreateCheckRun,
        ChecksOp::UpdateCheckRun,
        ChecksOp::GetCheckRun,
        ChecksOp::ListCheckRunAnnotations,
        ChecksOp::RerequestCheckRun,
        ChecksOp::ListCheckRunsForRef,
        ChecksOp::ListCheckSuitesForRef,
        ChecksOp::GetCheckSuite,
        ChecksOp::RerequestCheckSuite,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ChecksOp::CreateCommitStatus => "create_commit_status",
            ChecksOp::ListCommitStatuses => "list_commit_statuses",
            ChecksOp::GetCombinedStatus => "get_combined_status",
            ChecksOp::CreateCheckRun => "create_check_run",
            ChecksOp::UpdateCheckRun => "update_check_run",
            ChecksOp::GetCheckRun => "get_check_run",
            ChecksOp::ListCheckRunAnnotations => "list_check_run_annotations",
            ChecksOp::RerequestCheckRun => "rerequest_check_run",
            ChecksOp::ListCheckRunsForRef => "list_check_runs_for_ref",
            ChecksOp::ListCheckSuitesForRef => "list_check_suites_for_ref",
            ChecksOp::GetCheckSuite => "get_check_suite",
            ChecksOp::RerequestCheckSuite => "rerequest_check_suite",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            ChecksOp::CreateCommitStatus => "Create a commit status",
            ChecksOp::ListCommitStatuses => "List a commit's statuses",
            ChecksOp::GetCombinedStatus => "Get a commit's combined status",
            ChecksOp::CreateCheckRun => "Create a check run",
            ChecksOp::UpdateCheckRun => "Update a check run",
            ChecksOp::GetCheckRun => "Get a check run",
            ChecksOp::ListCheckRunAnnotations => "List a check run's annotations",
            ChecksOp::RerequestCheckRun => "Rerequest a check run",
            ChecksOp::ListCheckRunsForRef => "List a commit's check runs",
            ChecksOp::ListCheckSuitesForRef => "List a commit's check suites",
            ChecksOp::GetCheckSuite => "Get a check suite",
            ChecksOp::RerequestCheckSuite => "Rerequest a check suite",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ChecksOp::CreateCommitStatus => "Set a status on a commit: state (pending, success, failure or error), context (what reports it, such as ci/build; default by default), description (at most 140 characters) and target_url (where to see more). A context has one status per commit: setting it again replaces it. A status is a check: a required check or a ruleset's required status check of its context is met by it. Needs the Write role; publishes status.created.",
            ChecksOp::ListCommitStatuses => "List the statuses on a commit, named by its SHA, a branch or a tag: one per context, newest first. Check runs are listed by list_check_runs_for_ref instead.",
            ChecksOp::GetCombinedStatus => "A commit's statuses, one per context, and the state they add up to: failure if any failed or errored, pending if any is pending or there are none, success otherwise. Named by its SHA, a branch or a tag.",
            ChecksOp::CreateCheckRun => "Report a check run on a commit: name and head_sha are required; status (queued, in_progress or completed; queued by default), conclusion (success, failure, neutral, cancelled, skipped, timed_out or action_required; it makes the run completed), started_at and completed_at (RFC 3339; filled in when left out), details_url (your page for it), external_id (your id for it), output (title, summary and text in Markdown, and up to 50 annotations: path, start_line, end_line, start_column, end_column, annotation_level notice, warning or failure, message, title, raw_details) and actions (up to 3 buttons: label, description, identifier). app names who reports it, by default your token's name. Runs are grouped per reporter and commit into a check suite. A check run is a check: a required check of its name is met by it, a cancelled one failing. Needs the Write role; publishes check_run.created, and check_run.completed when it is created completed.",
            ChecksOp::UpdateCheckRun => "Change a check run reported through the API, by id (cr_…). Fields left out stay as they are; output annotations are added to the ones it has (at most 1000 in all); actions, when given, replace its buttons. Giving a conclusion completes it. Publishes check_run.completed when it completes. A g1t Actions job's check run is its workflow's and cannot be changed.",
            ChecksOp::GetCheckRun => "Get a check run by id: cr_… for one reported through the API, or a g1t Actions job's id (job_…), whose workflow run is its suite and whose workflow says its name, run and event in workflow.",
            ChecksOp::ListCheckRunAnnotations => "List a check run's annotations in the order they were reported: path, start_line, end_line, start_column, end_column, annotation_level (notice, warning or failure), message, title and raw_details.",
            ChecksOp::RerequestCheckRun => "Ask for a check run to run again. For one reported through the API, its reporter is sent check_run.rerequested; for a g1t Actions job, its workflow run runs again (which also needs workflows:write). Needs the Write role.",
            ChecksOp::ListCheckRunsForRef => "List a commit's check runs, named by its SHA, a branch or a tag: those reported through the API and each job of its g1t Actions workflow runs. filter latest (the default) gives each name's latest run and each workflow's latest run per event; all gives every one. Narrow with check_name, status and app (a reporter's slug; actions for g1t Actions).",
            ChecksOp::ListCheckSuitesForRef => "List a commit's check suites, named by its SHA, a branch or a tag: one per reporter that reported check runs on it through the API, and one per g1t Actions workflow run, with its status and conclusion worked out from its latest check runs. Narrow with app and check_name.",
            ChecksOp::GetCheckSuite => "Get a check suite by id: cs_… for a reporter's, or a g1t Actions workflow run's id (run_…).",
            ChecksOp::RerequestCheckSuite => "Ask for a check suite to run again: its reporter is sent check_suite.rerequested, or a g1t Actions workflow run runs again (which also needs workflows:write). Needs the Write role.",
        }
    }

    /// Whether it only reads, which anyone who can see the repository may.
    pub fn reads(self) -> bool {
        !matches!(
            self,
            ChecksOp::CreateCommitStatus
                | ChecksOp::CreateCheckRun
                | ChecksOp::UpdateCheckRun
                | ChecksOp::RerequestCheckRun
                | ChecksOp::RerequestCheckSuite
        )
    }

    pub fn input(self) -> Value {
        let repo = || json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let git_ref = || json!({ "type": "string", "description": "The commit: its SHA, a branch or a tag." });
        let run_id = || json!({ "type": "string", "description": "The check run's id: cr_…, or a g1t Actions job's job_…" });
        let suite_id = || json!({ "type": "string", "description": "The check suite's id: cs_…, or a g1t Actions run's run_…" });
        let run_fields = |mut properties: Value, creating: bool| {
            properties["name"] = json!({ "type": "string", "description": "The check's name, at most 100 characters, such as lint or coverage." });
            if creating {
                properties["head_sha"] = json!({ "type": "string", "description": "The commit's full SHA (or a branch or tag, read as the commit it points to now)." });
                properties["app"] = json!({ "type": "string", "description": "Who reports it, shown with it and grouping its check suite: by default your token's name." });
            }
            properties["status"] = json!({ "type": "string", "enum": STATUSES, "description": "Where it is: queued, in_progress or completed." });
            properties["conclusion"] = json!({ "type": "string", "enum": CONCLUSIONS, "description": "How it came out; giving one completes it." });
            properties["started_at"] = json!({ "type": "string", "description": "When it started, RFC 3339." });
            properties["completed_at"] = json!({ "type": "string", "description": "When it completed, RFC 3339." });
            properties["details_url"] = json!({ "type": "string", "description": "Your page for it, http or https." });
            properties["external_id"] = json!({ "type": "string", "description": "Your id for it." });
            properties["output"] = json!({
                "type": "object",
                "description": "Its report: a title, a Markdown summary and text, and annotations on lines of files (at most 50 a request).",
                "properties": {
                    "title": { "type": "string" },
                    "summary": { "type": "string" },
                    "text": { "type": "string" },
                    "annotations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string" },
                                "start_line": { "type": "integer" },
                                "end_line": { "type": "integer" },
                                "start_column": { "type": "integer" },
                                "end_column": { "type": "integer" },
                                "annotation_level": { "type": "string", "enum": ANNOTATION_LEVELS },
                                "message": { "type": "string" },
                                "title": { "type": "string" },
                                "raw_details": { "type": "string" },
                            },
                            "required": ["path", "start_line", "end_line", "annotation_level", "message"],
                        },
                    },
                },
            });
            properties["actions"] = json!({
                "type": "array",
                "description": "Up to 3 buttons on its page. Pressing one sends you check_run.requested_action with its identifier.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string", "description": "At most 20 characters." },
                        "description": { "type": "string", "description": "At most 40 characters." },
                        "identifier": { "type": "string", "description": "At most 20 characters." },
                    },
                    "required": ["label", "description", "identifier"],
                },
            });
            properties
        };
        let (properties, required): (Value, &[&str]) = match self {
            ChecksOp::CreateCommitStatus => (
                json!({
                    "repo": repo(),
                    "sha": { "type": "string", "description": "The commit's full SHA." },
                    "state": { "type": "string", "enum": STATUS_STATES, "description": "pending, success, failure or error." },
                    "context": { "type": "string", "description": "What reports it, such as ci/build; default when left out." },
                    "description": { "type": "string", "description": "A short word on it, at most 140 characters." },
                    "target_url": { "type": "string", "description": "Where to see more, http or https." },
                }),
                &["repo", "sha", "state"],
            ),
            ChecksOp::ListCommitStatuses | ChecksOp::GetCombinedStatus => (json!({ "repo": repo(), "ref": git_ref() }), &["repo", "ref"]),
            ChecksOp::CreateCheckRun => (run_fields(json!({ "repo": repo() }), true), &["repo", "name", "head_sha"]),
            ChecksOp::UpdateCheckRun => (run_fields(json!({ "repo": repo(), "id": run_id() }), false), &["repo", "id"]),
            ChecksOp::GetCheckRun | ChecksOp::ListCheckRunAnnotations | ChecksOp::RerequestCheckRun => {
                (json!({ "repo": repo(), "id": run_id() }), &["repo", "id"])
            }
            ChecksOp::ListCheckRunsForRef => (
                json!({
                    "repo": repo(),
                    "ref": git_ref(),
                    "check_name": { "type": "string", "description": "Only runs of this name." },
                    "status": { "type": "string", "enum": STATUSES, "description": "Only runs in this status." },
                    "app": { "type": "string", "description": "Only this reporter's runs, by slug: actions for g1t Actions." },
                    "filter": { "type": "string", "enum": ["latest", "all"], "description": "latest (the default) or all." },
                }),
                &["repo", "ref"],
            ),
            ChecksOp::ListCheckSuitesForRef => (
                json!({
                    "repo": repo(),
                    "ref": git_ref(),
                    "app": { "type": "string", "description": "Only this reporter's suites, by slug." },
                    "check_name": { "type": "string", "description": "Only suites with a run of this name." },
                }),
                &["repo", "ref"],
            ),
            ChecksOp::GetCheckSuite | ChecksOp::RerequestCheckSuite => (json!({ "repo": repo(), "id": suite_id() }), &["repo", "id"]),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    match &input[key] {
        Value::String(text) => Some(text.trim().to_owned()).filter(|text| !text.is_empty()),
        _ => None,
    }
}

/// A key in `camelCase`, as the contracts read it: `start_line` is `startLine`.
fn camel_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn camel(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (camel_key(key), camel(value))).collect::<Map<_, _>>()),
        Value::Array(items) => Value::Array(items.iter().map(camel).collect()),
        other => other.clone(),
    }
}

/// A check run's fields from a request body.
pub(crate) fn run_input(input: &Value) -> std::result::Result<CheckRunInput, String> {
    const FIELDS: [&str; 10] =
        ["name", "head_sha", "status", "conclusion", "started_at", "completed_at", "details_url", "external_id", "output", "actions"];
    let mut fields = Map::new();
    for key in FIELDS {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            fields.insert(camel_key(key), camel(value));
        }
    }
    serde_json::from_value(Value::Object(fields)).map_err(|error| format!("The check run could not be read: {error}"))
}

/// Pages on the site, which the work service names by path, as full
/// addresses.
fn absolute(value: Value, site: &str) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    let value = match value {
                        Value::String(path) if matches!(key.as_str(), "htmlUrl" | "detailsUrl" | "targetUrl") && path.starts_with('/') => {
                            Value::String(format!("{site}{path}"))
                        }
                        other => absolute(other, site),
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(|item| absolute(item, site)).collect()),
        other => other,
    }
}

async fn call<A: Serialize, T: DeserializeOwned + Serialize>(services: &Services, method: &str, args: &A) -> Result<Outcome<Value>> {
    let found: Outcome<T> = g1t_kit::call(&services.work, method, args).await?;
    Ok(match found {
        Outcome::Ok(value) => Outcome::Ok(absolute(serde_json::to_value(value)?, &services.addresses.site)),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    })
}

pub async fn run(op: ChecksOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(repo) = crate::operations::repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let actor = || viewer.clone().unwrap_or_default();
    let id = || text(input, "id").unwrap_or_default();
    let git_ref = || text(input, "ref").unwrap_or_default();
    match op {
        ChecksOp::CreateCommitStatus => {
            let args = CreateStatusArgs {
                actor: actor(),
                repo,
                sha: text(input, "sha").unwrap_or_default(),
                state: text(input, "state").unwrap_or_default(),
                context: text(input, "context"),
                description: text(input, "description"),
                target_url: text(input, "target_url"),
            };
            call::<_, g1t_contracts::work::CommitStatus>(services, "create_commit_status", &args).await
        }
        ChecksOp::ListCommitStatuses => {
            call::<_, Vec<g1t_contracts::work::CommitStatus>>(services, "commit_statuses", &RefArgs { viewer: viewer.clone(), repo, git_ref: git_ref() }).await
        }
        ChecksOp::GetCombinedStatus => {
            call::<_, CombinedStatus>(services, "combined_status", &RefArgs { viewer: viewer.clone(), repo, git_ref: git_ref() }).await
        }
        ChecksOp::CreateCheckRun | ChecksOp::UpdateCheckRun => {
            let run = match run_input(input) {
                Ok(run) => run,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            if op == ChecksOp::CreateCheckRun {
                let args = CreateCheckRunArgs { actor: actor(), repo, app: text(input, "app"), run };
                call::<_, CommitCheckRun>(services, "create_check_run", &args).await
            } else {
                call::<_, CommitCheckRun>(services, "update_check_run", &UpdateCheckRunArgs { actor: actor(), repo, id: id(), run }).await
            }
        }
        ChecksOp::GetCheckRun => call::<_, CommitCheckRun>(services, "get_check_run", &CheckIdArgs { viewer: viewer.clone(), repo, id: id() }).await,
        ChecksOp::ListCheckRunAnnotations => {
            call::<_, Vec<CheckAnnotation>>(services, "check_run_annotations", &CheckIdArgs { viewer: viewer.clone(), repo, id: id() }).await
        }
        ChecksOp::GetCheckSuite => call::<_, CommitCheckSuite>(services, "get_check_suite", &CheckIdArgs { viewer: viewer.clone(), repo, id: id() }).await,
        ChecksOp::RerequestCheckRun | ChecksOp::RerequestCheckSuite => {
            let method = if op == ChecksOp::RerequestCheckRun { "rerequest_check_run" } else { "rerequest_check_suite" };
            let done: Outcome<bool> = g1t_kit::call(&services.work, method, &RerequestArgs { actor: actor(), repo, id: id() }).await?;
            Ok(match done {
                Outcome::Ok(_) => Outcome::Ok(json!({ "rerequested": true })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            })
        }
        ChecksOp::ListCheckRunsForRef => {
            let args = RefCheckRunsArgs {
                viewer: viewer.clone(),
                repo,
                git_ref: git_ref(),
                check_name: text(input, "check_name"),
                status: text(input, "status"),
                app: text(input, "app"),
                filter: text(input, "filter"),
            };
            call::<_, CheckRunList>(services, "ref_check_runs", &args).await
        }
        ChecksOp::ListCheckSuitesForRef => {
            let args = RefCheckSuitesArgs { viewer: viewer.clone(), repo, git_ref: git_ref(), app: text(input, "app"), check_name: text(input, "check_name") };
            call::<_, CheckSuiteList>(services, "ref_check_suites", &args).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_in_snake_case_is_a_check_run() {
        let body = json!({
            "repo": "acme/web",
            "name": "lint",
            "head_sha": "a".repeat(40),
            "status": "completed",
            "conclusion": "failure",
            "output": {
                "title": "2 problems",
                "summary": "**2** problems",
                "annotations": [{ "path": "src/a.rs", "start_line": 3, "end_line": 3, "annotation_level": "warning", "message": "unused" }]
            },
            "actions": [{ "label": "Fix", "description": "Fix it", "identifier": "fix" }]
        });
        let run = run_input(&body).unwrap();
        assert_eq!(run.head_sha.as_deref(), Some("a".repeat(40).as_str()));
        let output = run.output.unwrap();
        assert_eq!(output.annotations[0].start_line, 3);
        assert_eq!(output.annotations[0].annotation_level, "warning");
        assert_eq!(run.actions.unwrap()[0].identifier, "fix");
        assert!(run_input(&json!({ "output": { "annotations": "no" } })).is_err());
    }

    #[test]
    fn pages_on_the_site_become_full_addresses() {
        let value = json!({ "checkRuns": [{ "htmlUrl": "/acme/web/checks/cr_1", "detailsUrl": "https://ci.example.com/1", "name": "/x" }] });
        let out = absolute(value, "https://g1t.sh");
        assert_eq!(out["checkRuns"][0]["htmlUrl"], "https://g1t.sh/acme/web/checks/cr_1");
        assert_eq!(out["checkRuns"][0]["detailsUrl"], "https://ci.example.com/1");
        assert_eq!(out["checkRuns"][0]["name"], "/x");
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in ChecksOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Checks(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            assert_eq!(op.reads(), g1t_contracts::scopes::scope_for(op.name()).unwrap().level() == g1t_contracts::scopes::Level::Read, "{}", op.name());
        }
    }
}
