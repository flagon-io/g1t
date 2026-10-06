//! Every response the REST routes give, run through the converter the API
//! sends them with, checked for `camelCase` that would leak out.
//!
//! The samples are the reference's example responses, put back into the
//! `camelCase` the services send (as serde's `rename_all` writes it) and,
//! where an operation returns a contract type, decoded into that type and
//! encoded again, so that every field the type has is sent, not only the
//! ones an example shows.

use g1t_contracts::{access, actions, integrations, repos, search, webhooks, work};
use g1t_kit::wire::{self, USER_KEYED};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::openapi::document;
use crate::operations::Op;

/// A key as `#[serde(rename_all = "camelCase")]` writes it.
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

/// A response as the services send it: `camelCase`, but for the maps the
/// converter passes through, which are data.
fn as_services_send(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut out = Map::new();
            for (key, value) in fields {
                let user_keyed = value.is_object()
                    && (USER_KEYED.contains(&key.as_str()) || key.starts_with("by_"));
                let value = if user_keyed { value.clone() } else { as_services_send(value) };
                // A `by_…` map keeps its name in the converter's spelling.
                let key = if key.starts_with("by_") { key.clone() } else { camel_key(key) };
                out.insert(key, value);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(as_services_send).collect()),
        other => other.clone(),
    }
}

/// `value` decoded as `T` and encoded again, as the service would send it.
fn through<T: DeserializeOwned + Serialize>(op: Op, value: Value) -> Value {
    let decoded: T = serde_json::from_value(value)
        .unwrap_or_else(|error| panic!("{}: the example is not a {}: {error}", op.name(), std::any::type_name::<T>()));
    serde_json::to_value(decoded).unwrap()
}

/// What the service behind an operation sends, from its example.
fn sample(op: Op, example: &Value) -> Value {
    // Types serde already writes in `snake_case`: a person, and who has
    // access. Sent as they are.
    let as_is = example.clone();
    match op {
        Op::Whoami => return through::<g1t_contracts::User>(op, as_is),
        Op::ListCollaborators => return through::<access::RepoAccess>(op, as_is),
        Op::AddCollaborator => return through::<access::Added>(op, as_is),
        Op::UpdateCollaborator => return through::<access::Collaborator>(op, as_is),
        Op::GetCollaboratorPermission => return through::<access::PermissionInfo>(op, as_is),
        Op::ListRepoInvitations | Op::ListMyRepoInvitations => {
            return through::<Vec<access::RepoInvitation>>(op, as_is);
        }
        Op::RevokeRepoInvitation | Op::AcceptRepoInvitation | Op::DeclineRepoInvitation => {
            return through::<access::RepoInvitation>(op, as_is);
        }
        Op::ListOutsideCollaborators => return through::<Vec<access::OutsideCollaborator>>(op, as_is),
        _ => {}
    }
    let sent = as_services_send(example);
    match op {
        Op::CreateWorkspace => through::<g1t_contracts::identity::Workspace>(op, sent),
        Op::ListRepos => through::<Vec<repos::Repo>>(op, sent),
        Op::Search => through::<search::SearchResults>(op, sent),
        Op::GetRepo
        | Op::CreateRepo
        | Op::UpdateRepo
        | Op::TransferRepo
        | Op::RenameRepo
        | Op::RenameBranch
        | Op::ArchiveRepo
        | Op::UnarchiveRepo
        | Op::SetRepoVisibility
        | Op::RestoreRepo => through::<repos::Repo>(op, sent),
        Op::DeleteRepo => through::<repos::DeletedRepo>(op, sent),
        Op::ListDeletedRepos => through::<Vec<repos::DeletedRepo>>(op, sent),
        Op::GetRepoSettings | Op::UpdateRepoSettings => through::<work::RepoSettings>(op, sent),
        Op::ListCheckNames => through::<Vec<work::SeenCheck>>(op, sent),
        Op::GetMergeQueue => through::<work::QueueView>(op, sent),
        Op::ListIssues => through::<Vec<work::Issue>>(op, sent),
        Op::CreateIssue | Op::UpdateIssue | Op::CloseIssue | Op::ReopenIssue => {
            through::<work::Issue>(op, sent)
        }
        Op::GetIssue => through::<work::IssueDetail>(op, sent),
        Op::Delegate => through::<work::Delegated>(op, sent),
        Op::ListPullRequests => through::<Vec<work::Pull>>(op, sent),
        Op::GetPullRequest => through::<work::PullDetail>(op, sent),
        Op::MarkPullRequestReady | Op::ClosePullRequest | Op::MergePullRequest | Op::AssignIssue => {
            through::<work::Pull>(op, sent)
        }
        Op::ListWorkflows => through::<Vec<actions::Workflow>>(op, sent),
        Op::ListWorkflowRuns => through::<Vec<actions::WorkflowRun>>(op, sent),
        Op::GetWorkflowRun => through::<actions::RunDetail>(op, sent),
        Op::GetJobLogs => through::<actions::JobLog>(op, sent),
        Op::DispatchWorkflow | Op::CancelWorkflowRun | Op::RerunWorkflowRun => {
            through::<actions::WorkflowRun>(op, sent)
        }
        Op::ListActionsSecrets | Op::ListActionsVariables => through::<Vec<actions::Setting>>(op, sent),
        Op::ListRunners => through::<Vec<g1t_contracts::runners::Runner>>(op, sent),
        Op::ListRunnerGroups => through::<Vec<g1t_contracts::runners::RunnerGroup>>(op, sent),
        Op::CreateRunnerGroup | Op::UpdateRunnerGroup => through::<g1t_contracts::runners::RunnerGroup>(op, sent),
        Op::GetRunnerSettings | Op::UpdateRunnerSettings => through::<g1t_contracts::runners::RunnerSettings>(op, sent),
        Op::CreateRunnerRegistrationToken => through::<g1t_contracts::runners::RegistrationToken>(op, sent),
        Op::ListWebhooks => through::<Vec<webhooks::Hook>>(op, sent),
        Op::ListIntegrations => through::<Vec<integrations::Connection>>(op, sent),
        Op::GetModelRoutes | Op::SetModelRoutes => through::<Vec<integrations::ModelRoute>>(op, sent),
        Op::ListEvents => through::<Vec<g1t_contracts::events::Event>>(op, sent),
        Op::ListEmails | Op::AddEmail | Op::RemoveEmail | Op::UpdateEmailSettings => {
            through::<g1t_contracts::accounts::AccountEmails>(op, sent)
        }
        Op::ListInvites => through::<g1t_contracts::identity::InvitesOverview>(op, sent),
        Op::CreateInvite | Op::RevokeInvite | Op::InviteMember | Op::RevokeWorkspaceInvite => {
            through::<g1t_contracts::identity::Invite>(op, sent)
        }
        Op::ListWorkspaceInvites => through::<Vec<g1t_contracts::identity::Invite>>(op, sent),
        _ => sent,
    }
}

/// Every key of `example`, as paths, outside the maps passed through.
fn paths(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let here = format!("{path}.{key}");
                out.push(here.clone());
                let user_keyed = value.is_object()
                    && (USER_KEYED.contains(&key.as_str()) || key.starts_with("by_"));
                if !user_keyed {
                    paths(value, &here, out);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                paths(item, &format!("{path}[]"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn no_route_answers_with_camel_case() {
    let document = document();
    let (mut checked, mut converted) = (0, 0);
    for (path, methods) in document["paths"].as_object().unwrap() {
        for (method, operation) in methods.as_object().unwrap() {
            let example = &operation["responses"]["200"]["content"]["application/json"]["example"];
            let tool = operation["x-operation"].as_str().unwrap_or_default();
            let Some(op) = Op::by_name(tool) else {
                // Device sign-in, which is written in `snake_case` by hand.
                assert!(wire::camel_case_keys(example).is_empty(), "{method} {path}");
                continue;
            };
            let sample = sample(op, example);
            converted += wire::camel_case_keys(&sample).len();
            let sent = wire::snake_case(sample);
            let leaked = wire::camel_case_keys(&sent);
            assert!(leaked.is_empty(), "{method} {path} sends {leaked:?}");
            // The reference shows what is sent: each of its names is one.
            let (mut shown, mut real) = (Vec::new(), Vec::new());
            paths(example, "", &mut shown);
            paths(&sent, "", &mut real);
            for name in shown {
                assert!(real.contains(&name), "{method} {path}: the reference shows {name}, which is not sent");
            }
            checked += 1;
        }
    }
    assert!(checked >= Op::ALL.len());
    // The samples are in the services' spelling, so there was something to
    // convert.
    assert!(converted > 100, "{converted}");
}

#[test]
fn every_route_has_a_sample() {
    let document = document();
    for route in crate::rest::ROUTES {
        let path = route
            .path
            .split('/')
            .map(|segment| match segment.strip_prefix(':') {
                Some(name) => format!("{{{name}}}"),
                None => segment.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("/");
        let example = &document["paths"][&path][route.method.to_lowercase()]["responses"]["200"]
            ["content"]["application/json"]["example"];
        assert!(!example.is_null(), "{} {path}", route.method);
    }
}

#[test]
fn errors_and_reports_are_snake_case() {
    let failure = g1t_contracts::Failure {
        code: g1t_contracts::FailureCode::NotFound,
        message: "No such endpoint.".to_owned(),
    };
    assert!(wire::camel_case_keys(&wire::snake_case(json!({ "error": failure }))).is_empty());
}

#[test]
fn a_job_spec_keeps_github_s_spelling() {
    let spec = json!({
        "job": "job_1",
        "spec": { "runs-on": "ubuntu-latest", "timeoutMinutes": 5 },
        "workflow": { "env": { "nodeEnv": "x" } },
        "github": { "eventName": "push", "headRef": "" },
        "event": { "pull_request": { "headSha": "x" } },
        "contexts": { "inputs": { "dryRun": true }, "matrix": { "nodeVersion": 20 } },
        "checkout": { "ref": "main" },
        "timeoutMinutes": 30,
        "masks": [],
    });
    let sent = wire::snake_case_keeping(spec.clone(), crate::JOB_SPEC_AS_GIVEN);
    assert_eq!(sent["timeout_minutes"], 30);
    assert!(sent.get("timeoutMinutes").is_none());
    for kept in ["spec", "workflow", "github", "event", "contexts", "checkout"] {
        assert_eq!(sent[kept], spec[kept], "{kept}");
    }
}
