//! Everything a client can do through the API.
//!
//! REST routes, MCP tools and the OpenAPI document are all generated from
//! [`Op`], so the surfaces cannot drift apart: adding a variant without
//! describing it or running it does not compile.

use g1t_contracts::events::{Event, ListArgs as ListEventsArgs};
use g1t_contracts::identity::CreateWorkspaceArgs;
use g1t_contracts::repos::{
    CompareArgs, CreateArgs, GetArgs, ListArgs as ListReposArgs, Repo, RepoPath,
};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use worker::{Env, Fetcher, Result};

/// The services the API is a front for.
pub struct Services {
    pub identity: Fetcher,
    pub repos: Fetcher,
    pub work: Fetcher,
    pub events: Fetcher,
}

impl Services {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(Services {
            identity: env.service("IDENTITY")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            events: env.service("EVENTS")?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Whoami,
    CreateWorkspace,
    ListRepos,
    GetRepo,
    CreateRepo,
    ListIssues,
    GetIssue,
    CreateIssue,
    UpdateIssue,
    CloseIssue,
    ReopenIssue,
    ListLabels,
    AddComment,
    ListPullRequests,
    GetPullRequest,
    CreatePullRequest,
    RecordSession,
    ReadSession,
    MarkPullRequestReady,
    ClosePullRequest,
    GetPullRequestChanges,
    MergePullRequest,
    ListEvents,
}

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

fn ok<T: Serialize>(value: &T) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(value)?))
}

/// Calls a method that returns an `Outcome`, decoding its value as `T`.
async fn call<A: Serialize, T: DeserializeOwned>(
    service: &Fetcher,
    method: &str,
    args: &A,
) -> Result<Outcome<T>> {
    g1t_kit::call(service, method, args).await
}

/// Calls a method that returns an `Outcome`, passing its value through.
async fn pass<A: Serialize>(service: &Fetcher, method: &str, args: &A) -> Result<Outcome<Value>> {
    call(service, method, args).await
}

fn text(input: &Value, key: &str) -> String {
    input[key].as_str().unwrap_or_default().to_owned()
}

fn optional_text(input: &Value, key: &str) -> Option<String> {
    input[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A whole number given as a number or as digits.
fn integer(input: &Value, key: &str) -> Option<u32> {
    match &input[key] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.parse().ok(),
        _ => None,
    }
}

fn strings(input: &Value, key: &str) -> Option<Vec<String>> {
    input[key].as_array().map(|items| {
        items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect()
    })
}

fn state(input: &Value) -> Option<State> {
    match input["state"].as_str() {
        Some("open") => Some(State::Open),
        Some("closed") => Some(State::Closed),
        _ => None,
    }
}

/// The repository named by `repo`, written `owner/name`.
fn repo_path(input: &Value) -> Option<RepoPath> {
    let mut parts = input["repo"].as_str()?.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(namespace), Some(name), None) if !namespace.is_empty() && !name.is_empty() => {
            Some(RepoPath {
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            })
        }
        _ => None,
    }
}

/// An object schema. `required` names the properties that must be given.
fn object(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// The properties naming an issue or pull request, with `more` added.
fn numbered(more: Value) -> Value {
    let mut properties = json!({
        "repo": repo_schema(),
        "number": {
            "type": "integer",
            "description": "The number shown after the #. Issues and pull requests share one sequence.",
        },
    });
    if let (Some(all), Value::Object(more)) = (properties.as_object_mut(), more) {
        all.extend(more);
    }
    properties
}

fn repo_schema() -> Value {
    json!({
        "type": "string",
        "description": "Repository as \"owner/name\", e.g. \"syntaqx/hello\".",
    })
}

/// What `ReposApi.compare` needs to show what a pull request changes.
///
/// A fork is compared as a whole. A branch is compared by name while the
/// pull request is open, and by the commit it was merged or closed at
/// afterwards, so later pushes to the branch do not change the record.
fn comparison(pull: Pull, viewer: &Viewer) -> CompareArgs {
    let settled = matches!(pull.status, PullStatus::Merged | PullStatus::Closed);
    let (repo_id, head) = match pull.fork_repo_id {
        Some(fork) => (fork, None),
        None => (
            pull.repo_id,
            pull.head_commit.filter(|_| settled).or(pull.branch),
        ),
    };
    CompareArgs {
        repo_id,
        viewer: viewer.clone(),
        base: pull.merge_base,
        head,
    }
}

impl Op {
    pub const ALL: [Op; 23] = [
        Op::Whoami,
        Op::CreateWorkspace,
        Op::ListRepos,
        Op::GetRepo,
        Op::CreateRepo,
        Op::ListIssues,
        Op::GetIssue,
        Op::CreateIssue,
        Op::UpdateIssue,
        Op::CloseIssue,
        Op::ReopenIssue,
        Op::ListLabels,
        Op::AddComment,
        Op::ListPullRequests,
        Op::GetPullRequest,
        Op::CreatePullRequest,
        Op::RecordSession,
        Op::ReadSession,
        Op::MarkPullRequestReady,
        Op::ClosePullRequest,
        Op::GetPullRequestChanges,
        Op::MergePullRequest,
        Op::ListEvents,
    ];

    pub fn by_name(name: &str) -> Option<Op> {
        Op::ALL.into_iter().find(|op| op.name() == name)
    }

    /// The operation's name: its MCP tool name and OpenAPI operation id.
    pub fn name(self) -> &'static str {
        match self {
            Op::Whoami => "whoami",
            Op::CreateWorkspace => "create_workspace",
            Op::ListRepos => "list_repos",
            Op::GetRepo => "get_repo",
            Op::CreateRepo => "create_repo",
            Op::ListIssues => "list_issues",
            Op::GetIssue => "get_issue",
            Op::CreateIssue => "create_issue",
            Op::UpdateIssue => "update_issue",
            Op::CloseIssue => "close_issue",
            Op::ReopenIssue => "reopen_issue",
            Op::ListLabels => "list_labels",
            Op::AddComment => "add_comment",
            Op::ListPullRequests => "list_pull_requests",
            Op::GetPullRequest => "get_pull_request",
            Op::CreatePullRequest => "create_pull_request",
            Op::RecordSession => "record_session",
            Op::ReadSession => "read_session",
            Op::MarkPullRequestReady => "mark_pull_request_ready",
            Op::ClosePullRequest => "close_pull_request",
            Op::GetPullRequestChanges => "get_pull_request_changes",
            Op::MergePullRequest => "merge_pull_request",
            Op::ListEvents => "list_events",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Op::Whoami => "The account the access token belongs to, and its workspaces.",
            Op::CreateWorkspace => {
                "Create a workspace. A workspace owns repositories and is the first part of their address, g1t.sh/<workspace>/<repo>. The whoami tool lists the ones you already belong to."
            }
            Op::ListRepos => "Repositories you can see, optionally filtered by a search query.",
            Op::GetRepo => "One repository's details.",
            Op::CreateRepo => "Create a repository in one of your workspaces.",
            Op::ListIssues => {
                "Issues on a repository, newest first. An issue is something that should change: a bug, a feature, a question. Pull requests are made against it."
            }
            Op::GetIssue => {
                "An issue: its description, labels and acceptance checks, its comments, and every pull request made against it with its status. If the issue is closed, resolvedBy is the number of the pull request that was merged for it. Read this before opening a pull request, to see what others have already tried."
            }
            Op::CreateIssue => "Open an issue on a repository.",
            Op::UpdateIssue => {
                "Change an issue's title, body or labels. Only the fields given are changed; labels replaces the whole set."
            }
            Op::CloseIssue => {
                "Close an issue without a pull request. Merging a pull request made for an issue closes it for you."
            }
            Op::ReopenIssue => "Reopen a closed issue.",
            Op::ListLabels => "The labels available on a repository's issues.",
            Op::AddComment => "Comment on an issue or a pull request.",
            Op::ListPullRequests => {
                "Pull requests on a repository, newest first. State open covers drafts and those ready for review; closed covers merged and closed."
            }
            Op::GetPullRequest => {
                "A pull request's status, head commit, comments and the issue it is for."
            }
            Op::CreatePullRequest => {
                "Start a change. Opens a draft pull request with its own fork of the repository and returns the fork's git remote. Clone it, commit your work there, push, record your session as you go, then call mark_pull_request_ready. Give the issue it is for whenever there is one. If the change is already on a branch pushed to the repository, give that branch instead: no fork is made and the pull request is ready for review at once."
            }
            Op::RecordSession => {
                "Append entries to a pull request's session: the prompt you were given, your reasoning, the tools you ran. This is how people later see why a change was made, so record as you work, not only at the end."
            }
            Op::ReadSession => "The recorded session of a pull request, oldest entry first.",
            Op::MarkPullRequestReady => {
                "Mark a draft pull request ready for review. Push your commits first. The summary becomes its description and should say what changed and why."
            }
            Op::ClosePullRequest => "Close a pull request without merging it.",
            Op::GetPullRequestChanges => {
                "What a pull request changes: the files it touches and their line-by-line diff against the commit it started from. Use it to review a pull request or to compare several made for the same issue."
            }
            Op::MergePullRequest => {
                "Land a pull request on the repository's main branch. Only members of the repository's workspace can merge, and only once it is marked ready. Merging resolves the issue it was made for: the issue closes recording this pull request, and the other pull requests still in progress for that issue close as superseded. Fails if main has moved since the pull request was opened; pull main into its fork or branch and push, then merge again."
            }
            Op::ListEvents => {
                "The timeline of a repository: pushes, issues, pull requests, comments and session activity, newest first."
            }
        }
    }

    /// The JSON Schema of the operation's input.
    pub fn input(self) -> Value {
        let repo_only = || object(json!({ "repo": repo_schema() }), &["repo"]);
        let just_numbered = || object(numbered(json!({})), &["repo", "number"]);
        let states = json!({ "type": "string", "enum": ["open", "closed"] });
        match self {
            Op::Whoami => object(json!({}), &[]),
            Op::CreateWorkspace => object(
                json!({
                    "slug": {
                        "type": "string",
                        "description": "Its name in URLs: lowercase letters, digits and single hyphens.",
                    },
                    "name": { "type": "string", "description": "A display name." },
                }),
                &["slug"],
            ),
            Op::ListRepos => object(
                json!({
                    "query": { "type": "string", "description": "Matches name or description." },
                }),
                &[],
            ),
            Op::GetRepo | Op::ListLabels => repo_only(),
            Op::CreateRepo => object(
                json!({
                    "workspace": {
                        "type": "string",
                        "description": "The workspace to create it in. May be left out if you belong to exactly one.",
                    },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "private": { "type": "boolean" },
                }),
                &["name"],
            ),
            Op::ListIssues => object(
                json!({
                    "repo": repo_schema(),
                    "state": states,
                    "label": { "type": "string", "description": "Only issues carrying this label." },
                }),
                &["repo"],
            ),
            Op::GetIssue
            | Op::ReopenIssue
            | Op::GetPullRequest
            | Op::ClosePullRequest
            | Op::GetPullRequestChanges => just_numbered(),
            Op::CreateIssue => object(
                json!({
                    "repo": repo_schema(),
                    "title": { "type": "string", "description": "The problem or goal in one line." },
                    "body": {
                        "type": "string",
                        "description": "Markdown. What an agent or a person needs to do the work: what is wrong or wanted, constraints, context.",
                    },
                    "labels": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "What kind of issue this is, e.g. \"bug\" or \"feature\". list_labels shows the labels in use; a new name creates a new label.",
                    },
                    "checks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Commands that must pass for a pull request to be accepted.",
                    },
                }),
                &["repo", "title"],
            ),
            Op::UpdateIssue => object(
                numbered(json!({
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "labels": { "type": "array", "items": { "type": "string" } },
                })),
                &["repo", "number"],
            ),
            Op::CloseIssue => object(
                numbered(json!({
                    "reason": {
                        "type": "string",
                        "enum": ["completed", "not_planned"],
                        "description": "Defaults to completed.",
                    },
                })),
                &["repo", "number"],
            ),
            Op::AddComment => object(
                numbered(json!({ "body": { "type": "string", "description": "Markdown." } })),
                &["repo", "number", "body"],
            ),
            Op::ListPullRequests => {
                object(json!({ "repo": repo_schema(), "state": states }), &["repo"])
            }
            Op::CreatePullRequest => object(
                json!({
                    "repo": repo_schema(),
                    "issue": { "type": "integer", "description": "The number of the issue this is for." },
                    "title": {
                        "type": "string",
                        "description": "Defaults to the issue's title. Required when there is no issue.",
                    },
                    "branch": {
                        "type": "string",
                        "description": "A branch already pushed to the repository that holds the change. Leave out to get a fork.",
                    },
                    "body": {
                        "type": "string",
                        "description": "Markdown: what changed and why. Mainly for pull requests from a branch.",
                    },
                    "agent": {
                        "type": "string",
                        "description": "A label for the agent doing the work, e.g. \"claude-code\".",
                    },
                }),
                &["repo"],
            ),
            Op::RecordSession => object(
                numbered(json!({
                    "entries": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["prompt", "message", "tool_call", "tool_result", "note"],
                                },
                                "text": { "type": "string" },
                                "tool": { "type": "string", "description": "Tool name, for tool entries." },
                            },
                            "required": ["kind", "text"],
                        },
                    },
                })),
                &["repo", "number", "entries"],
            ),
            Op::ReadSession => object(
                numbered(json!({
                    "after": { "type": "integer", "description": "Only entries after this sequence number." },
                })),
                &["repo", "number"],
            ),
            Op::MarkPullRequestReady => object(
                numbered(json!({ "summary": { "type": "string", "description": "Markdown." } })),
                &["repo", "number", "summary"],
            ),
            Op::MergePullRequest => object(
                numbered(json!({
                    "keep_issue_open": {
                        "type": "boolean",
                        "description": "Set when this pull request is only part of the work: the issue stays open and the other pull requests for it are left alone.",
                    },
                })),
                &["repo", "number"],
            ),
            Op::ListEvents => object(
                json!({
                    "repo": repo_schema(),
                    "before": { "type": "string", "description": "Event id to page back from." },
                }),
                &["repo"],
            ),
        }
    }

    /// Whether the operation refuses an anonymous caller outright.
    fn needs_user(self) -> bool {
        !matches!(
            self,
            Op::ListRepos
                | Op::GetRepo
                | Op::ListIssues
                | Op::GetIssue
                | Op::ListLabels
                | Op::ListPullRequests
                | Op::GetPullRequest
                | Op::ReadSession
                | Op::GetPullRequestChanges
                | Op::ListEvents
        )
    }

    /// Whether the operation is about one repository, named by `repo`.
    fn needs_repo(self) -> bool {
        !matches!(
            self,
            Op::Whoami | Op::CreateWorkspace | Op::ListRepos | Op::CreateRepo
        )
    }

    pub async fn run(
        self,
        services: &Services,
        viewer: &Viewer,
        input: &Value,
    ) -> Result<Outcome<Value>> {
        if self.needs_user() && viewer.is_none() {
            return failed(
                FailureCode::Unauthenticated,
                "This needs a g1t access token.",
            );
        }
        // Checked above for every operation that uses it.
        let actor = || viewer.clone().unwrap_or_default();
        let repo = match repo_path(input) {
            Some(repo) => repo,
            None if self.needs_repo() => {
                return failed(
                    FailureCode::Invalid,
                    "Give the repository as \"owner/name\".",
                );
            }
            None => RepoPath {
                namespace: String::new(),
                name: String::new(),
            },
        };
        let number = integer(input, "number").unwrap_or_default();
        let view = || ViewArgs {
            repo: repo.clone(),
            number,
            viewer: viewer.clone(),
            after_seq: integer(input, "after").unwrap_or_default(),
        };
        let pull_action = || PullActionArgs {
            actor: actor(),
            repo: repo.clone(),
            number,
            summary: text(input, "summary"),
            keep_issue_open: input["keep_issue_open"].as_bool() == Some(true),
        };
        let Services {
            identity,
            repos,
            work,
            events,
        } = services;

        match self {
            Op::Whoami => ok(&actor()),
            Op::CreateWorkspace => {
                pass(
                    identity,
                    "create_workspace",
                    &CreateWorkspaceArgs {
                        user: actor(),
                        slug: text(input, "slug"),
                        name: text(input, "name"),
                    },
                )
                .await
            }
            Op::ListRepos => {
                let found: Vec<Repo> = g1t_kit::call(
                    repos,
                    "list",
                    &ListReposArgs {
                        viewer: viewer.clone(),
                        query: optional_text(input, "query"),
                        namespace: None,
                        member_only: false,
                    },
                )
                .await?;
                ok(&found)
            }
            Op::GetRepo => {
                pass(
                    repos,
                    "get",
                    &GetArgs {
                        path: repo,
                        viewer: viewer.clone(),
                    },
                )
                .await
            }
            Op::CreateRepo => {
                let owner = actor();
                // Someone in exactly one workspace need not name it.
                let namespace = optional_text(input, "workspace").unwrap_or_else(|| {
                    match owner.workspaces.as_slice() {
                        [only] => only.slug.clone(),
                        _ => String::new(),
                    }
                });
                pass(
                    repos,
                    "create",
                    &CreateArgs {
                        owner,
                        namespace,
                        name: text(input, "name"),
                        description: optional_text(input, "description"),
                        is_private: input["private"].as_bool() == Some(true),
                    },
                )
                .await
            }
            Op::ListIssues => {
                pass(
                    work,
                    "list_issues",
                    &ListIssuesArgs {
                        repo,
                        viewer: viewer.clone(),
                        state: state(input),
                        label: optional_text(input, "label"),
                    },
                )
                .await
            }
            Op::GetIssue => pass(work, "get_issue", &view()).await,
            Op::CreateIssue => {
                pass(
                    work,
                    "open_issue",
                    &OpenIssueArgs {
                        actor: actor(),
                        repo,
                        title: text(input, "title"),
                        body: text(input, "body"),
                        labels: strings(input, "labels").unwrap_or_default(),
                        checks: strings(input, "checks").unwrap_or_default(),
                    },
                )
                .await
            }
            Op::UpdateIssue => {
                pass(
                    work,
                    "update_issue",
                    &UpdateIssueArgs {
                        actor: actor(),
                        repo,
                        number,
                        title: input["title"].as_str().map(str::to_owned),
                        body: input["body"].as_str().map(str::to_owned),
                        labels: strings(input, "labels"),
                    },
                )
                .await
            }
            Op::CloseIssue | Op::ReopenIssue => {
                let reason = match input["reason"].as_str() {
                    Some("not_planned") => IssueReason::NotPlanned,
                    _ => IssueReason::Completed,
                };
                let method = if self == Op::CloseIssue {
                    "close_issue"
                } else {
                    "reopen_issue"
                };
                pass(
                    work,
                    method,
                    &IssueActionArgs {
                        actor: actor(),
                        repo,
                        number,
                        reason: Some(reason),
                    },
                )
                .await
            }
            Op::ListLabels => pass(work, "list_labels", &view()).await,
            Op::AddComment => {
                pass(
                    work,
                    "add_comment",
                    &AddCommentArgs {
                        actor: actor(),
                        repo,
                        number,
                        body: text(input, "body"),
                    },
                )
                .await
            }
            Op::ListPullRequests => {
                pass(
                    work,
                    "list_pulls",
                    &ListPullsArgs {
                        repo,
                        viewer: viewer.clone(),
                        state: state(input),
                    },
                )
                .await
            }
            Op::GetPullRequest => pass(work, "get_pull", &view()).await,
            Op::CreatePullRequest => {
                let user = actor();
                let opened: Outcome<Pull> = call(
                    work,
                    "open_pull",
                    &OpenPullArgs {
                        actor: user.clone(),
                        repo: repo.clone(),
                        issue: integer(input, "issue"),
                        title: text(input, "title"),
                        body: text(input, "body"),
                        branch: optional_text(input, "branch"),
                        agent: optional_text(input, "agent").unwrap_or_else(|| "agent".into()),
                        runtime: Runtime::External,
                    },
                )
                .await?;
                let pull = match opened {
                    Outcome::Ok(pull) => pull,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                // Where to push. A pull request from a branch has no fork:
                // push to that branch of the repository.
                let source = pull.fork.as_ref().unwrap_or(&repo);
                let remote = format!("https://g1t.sh/{}/{}.git", source.namespace, source.name);
                ok(&json!({
                    "pull": pull,
                    "git": {
                        "remote": remote,
                        "username": user.username,
                        "password": "your g1t access token",
                    },
                }))
            }
            Op::RecordSession => {
                let Ok(entries) = serde_json::from_value(input["entries"].clone()) else {
                    return failed(
                        FailureCode::Invalid,
                        "entries must be a list of objects with a kind and a text.",
                    );
                };
                pass(
                    work,
                    "append_session",
                    &AppendSessionArgs {
                        actor: actor(),
                        repo,
                        number,
                        entries,
                    },
                )
                .await
            }
            Op::ReadSession => pass(work, "read_session", &view()).await,
            Op::MarkPullRequestReady => pass(work, "ready_pull", &pull_action()).await,
            Op::ClosePullRequest => pass(work, "close_pull", &pull_action()).await,
            Op::MergePullRequest => pass(work, "merge_pull", &pull_action()).await,
            Op::GetPullRequestChanges => {
                let found: Outcome<PullDetail> = call(work, "get_pull", &view()).await?;
                match found {
                    Outcome::Ok(detail) => {
                        pass(repos, "compare", &comparison(detail.pull, viewer)).await
                    }
                    Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                }
            }
            Op::ListEvents => {
                let found: Outcome<Repo> = call(
                    repos,
                    "get",
                    &GetArgs {
                        path: repo,
                        viewer: viewer.clone(),
                    },
                )
                .await?;
                let repo = match found {
                    Outcome::Ok(repo) => repo,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                let timeline: Vec<Event> = g1t_kit::call(
                    events,
                    "list",
                    &ListEventsArgs {
                        repo_id: Some(repo.id),
                        before: optional_text(input, "before"),
                        ..ListEventsArgs::default()
                    },
                )
                .await?;
                ok(&timeline)
            }
        }
    }
}

impl Op {
    /// The properties of the operation's input schema.
    pub fn properties(self) -> Map<String, Value> {
        match self.input() {
            Value::Object(mut schema) => match schema.remove("properties") {
                Some(Value::Object(properties)) => properties,
                _ => Map::new(),
            },
            _ => Map::new(),
        }
    }

    /// The names of the properties that must be given.
    pub fn required(self) -> Vec<String> {
        self.input()["required"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_found_again() {
        for op in Op::ALL {
            assert_eq!(Op::by_name(op.name()), Some(op));
        }
        assert_eq!(Op::by_name("start_attempt"), None);
    }

    #[test]
    fn required_properties_exist() {
        for op in Op::ALL {
            let properties = op.properties();
            for name in op.required() {
                assert!(properties.contains_key(&name), "{}: {name}", op.name());
            }
        }
    }

    #[test]
    fn a_repository_is_owner_slash_name() {
        let path = repo_path(&json!({ "repo": "syntaqx/hello" })).unwrap();
        assert_eq!(
            (path.namespace.as_str(), path.name.as_str()),
            ("syntaqx", "hello")
        );
        for bad in ["syntaqx", "a/b/c", "/hello", "syntaqx/", ""] {
            assert!(repo_path(&json!({ "repo": bad })).is_none(), "{bad}");
        }
    }

    #[test]
    fn numbers_are_read_from_numbers_and_digits() {
        assert_eq!(integer(&json!({ "number": 12 }), "number"), Some(12));
        assert_eq!(integer(&json!({ "number": "12" }), "number"), Some(12));
        assert_eq!(integer(&json!({ "number": "x" }), "number"), None);
        assert_eq!(integer(&json!({}), "number"), None);
    }
}
