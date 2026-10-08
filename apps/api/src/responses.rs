//! Every response the REST routes give, run through the converter the API
//! sends them with, checked for `camelCase` that would leak out.
//!
//! The samples are the reference's example responses, put back into the
//! `camelCase` the services send (as serde's `rename_all` writes it) and,
//! where an operation returns a contract type, decoded into that type and
//! encoded again, so that every field the type has is sent, not only the
//! ones an example shows.

use g1t_contracts::{access, actions, checks, codeowners, integrations, repos, rules, search, teams, webhooks, work};
use g1t_kit::wire::{self, USER_KEYED};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::openapi::document;
use crate::operations::Op;
use crate::checks::ChecksOp;
use crate::rules::RulesOp;
use crate::deploy_keys::DeployKeysOp;

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
        // Members, also `snake_case`.
        Op::ListMembers => return through::<Vec<g1t_contracts::identity::Member>>(op, as_is),
        Op::UpdateMember => return through::<g1t_contracts::identity::Member>(op, as_is),
        Op::RemoveMember | Op::TransferOwnership | Op::LeaveWorkspace => return through::<bool>(op, as_is),
        // Teams and code owners, also `snake_case`.
        Op::ListTeams | Op::ListChildTeams | Op::ListUserTeams => return through::<Vec<teams::Team>>(op, as_is),
        Op::GetTeam | Op::CreateTeam | Op::UpdateTeam | Op::SetTeamReviewAssignment => {
            return through::<teams::Team>(op, as_is);
        }
        Op::ListTeamMembers => return through::<Vec<teams::TeamMember>>(op, as_is),
        Op::SetTeamMember => return through::<teams::TeamMember>(op, as_is),
        Op::ListTeamRepos => return through::<Vec<teams::TeamRepo>>(op, as_is),
        Op::SetTeamRepo => return through::<teams::TeamRepo>(op, as_is),
        Op::DeleteTeam | Op::RemoveTeamMember | Op::RemoveTeamRepo => return through::<bool>(op, as_is),
        Op::GetCodeownersErrors => return through::<codeowners::CodeOwnersReport>(op, as_is),
        // Rulesets travel in `snake_case` between services too.
        Op::Rules(RulesOp::ListRepoRulesets | RulesOp::ListWorkspaceRulesets) => {
            return through::<Vec<rules::Ruleset>>(op, as_is);
        }
        Op::Rules(
            RulesOp::GetRepoRuleset
            | RulesOp::CreateRepoRuleset
            | RulesOp::UpdateRepoRuleset
            | RulesOp::GetWorkspaceRuleset
            | RulesOp::CreateWorkspaceRuleset
            | RulesOp::UpdateWorkspaceRuleset,
        ) => return through::<rules::Ruleset>(op, as_is),
        Op::Rules(RulesOp::GetBranchRules) => return through::<rules::EffectiveRules>(op, as_is),
        Op::Rules(RulesOp::ListRuleEvaluations | RulesOp::ListWorkspaceRuleEvaluations) => {
            return through::<rules::EvaluationPage>(op, as_is);
        }
        // Built by the API itself.
        Op::Rules(RulesOp::DeleteRepoRuleset | RulesOp::DeleteWorkspaceRuleset) => return as_is,
        // Deployments travel in `snake_case` between services too.
        Op::Deployments(_) => return as_is,
        // Artifacts are shaped by the API itself, in `snake_case`.
        Op::Artifacts(_) => return as_is,
        // Deploy keys travel in `snake_case` from identity.
        Op::DeployKeys(DeployKeysOp::ListDeployKeys) => return through::<Vec<g1t_contracts::deploy_keys::DeployKey>>(op, as_is),
        Op::DeployKeys(DeployKeysOp::GetDeployKey | DeployKeysOp::CreateDeployKey) => {
            return through::<g1t_contracts::deploy_keys::DeployKey>(op, as_is);
        }
        Op::DeployKeys(DeployKeysOp::DeleteDeployKey) => return through::<bool>(op, as_is),
        // Built by the API itself, in `snake_case`.
        Op::ListSecurityAlerts => return through::<Vec<crate::alerts::SecurityAlert>>(op, as_is),
        Op::DismissSecurityAlert | Op::ReopenSecurityAlert => {
            return through::<crate::alerts::SecurityAlert>(op, as_is);
        }
        _ => {}
    }
    let mut sent = as_services_send(example);
    // A pull request's code owners are `snake_case` inside it.
    if op == Op::GetPullRequest
        && let Some(code_owners) = example.get("code_owners")
    {
        sent["codeOwners"] = code_owners.clone();
    }
    match op {
        Op::GetWorkspace | Op::CreateWorkspace | Op::UpdateWorkspace => through::<g1t_contracts::identity::Workspace>(op, sent),
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
        Op::UpdatePullRequest => through::<work::Pull>(op, sent),
        Op::ListLabels | Op::AddDefaultLabels | Op::ListIssueLabels => through::<Vec<work::Label>>(op, sent),
        Op::CreateLabel | Op::UpdateLabel => through::<work::Label>(op, sent),
        Op::ListMilestones => through::<Vec<work::Milestone>>(op, sent),
        Op::CreateMilestone | Op::UpdateMilestone => through::<work::Milestone>(op, sent),
        Op::GetMilestone => through::<work::MilestoneDetail>(op, sent),
        Op::GetPullRequest => through::<work::PullDetail>(op, sent),
        Op::MarkPullRequestReady
        | Op::ClosePullRequest
        | Op::MergePullRequest
        | Op::AssignIssue
        | Op::RequestReviewers
        | Op::RemoveRequestedReviewers => {
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
        Op::ListNotifications => through::<g1t_contracts::inbox::InboxPage>(op, sent),
        Op::GetNotificationThread | Op::MarkThreadRead | Op::MarkThreadDone | Op::SaveThread | Op::SnoozeThread => {
            through::<g1t_contracts::inbox::InboxThread>(op, sent)
        }
        Op::GetThreadSubscription | Op::SetThreadSubscription | Op::DeleteThreadSubscription => {
            through::<g1t_contracts::inbox::ThreadSubscription>(op, sent)
        }
        Op::Checks(ChecksOp::CreateCommitStatus) => through::<work::CommitStatus>(op, sent),
        Op::Checks(ChecksOp::ListCommitStatuses) => through::<Vec<work::CommitStatus>>(op, sent),
        Op::Checks(ChecksOp::GetCombinedStatus) => through::<checks::CombinedStatus>(op, sent),
        Op::Checks(ChecksOp::CreateCheckRun | ChecksOp::UpdateCheckRun | ChecksOp::GetCheckRun) => {
            through::<checks::CommitCheckRun>(op, sent)
        }
        Op::Checks(ChecksOp::ListCheckRunAnnotations) => through::<Vec<checks::CheckAnnotation>>(op, sent),
        Op::Checks(ChecksOp::ListCheckRunsForRef) => through::<checks::CheckRunList>(op, sent),
        Op::Checks(ChecksOp::ListCheckSuitesForRef) => through::<checks::CheckSuiteList>(op, sent),
        Op::Checks(ChecksOp::GetCheckSuite) => through::<checks::CommitCheckSuite>(op, sent),
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
