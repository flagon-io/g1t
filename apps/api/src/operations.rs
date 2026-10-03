//! Everything a client can do through the API.
//!
//! REST routes, MCP tools and the OpenAPI document are all generated from
//! [`Op`], so the surfaces cannot drift apart: adding a variant without
//! describing it or running it does not compile.

use g1t_contracts::identity::AgentScope;
use g1t_contracts::events::{Event, ListArgs as ListEventsArgs};
use g1t_contracts::identity::CreateWorkspaceArgs;
use g1t_contracts::repos::{CreateArgs, GetArgs, ListArgs as ListReposArgs, Repo, RepoPath};
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
    pub runner: Fetcher,
    pub billing: Fetcher,
    /// Set for a request made with an agent's token: all it may do.
    pub scope: Option<AgentScope>,
}

impl Services {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(Services {
            identity: env.service("IDENTITY")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            events: env.service("EVENTS")?,
            runner: env.service("RUNNER")?,
            billing: env.service("BILLING")?,
            scope: None,
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
    UpdateRepo,
    GetRepoSettings,
    UpdateRepoSettings,
    GetMergeQueue,
    MessageAgent,
    TakeMessages,
    ListIssues,
    GetIssue,
    CreateIssue,
    UpdateIssue,
    CloseIssue,
    ReopenIssue,
    AssignIssue,
    PlanWork,
    GetPlan,
    ApplyPlan,
    ListLabels,
    AddComment,
    ReviewPullRequest,
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

impl Op {
    pub const ALL: [Op; 34] = [
        Op::Whoami,
        Op::CreateWorkspace,
        Op::ListRepos,
        Op::GetRepo,
        Op::CreateRepo,
        Op::UpdateRepo,
        Op::GetRepoSettings,
        Op::UpdateRepoSettings,
        Op::GetMergeQueue,
        Op::MessageAgent,
        Op::TakeMessages,
        Op::ListIssues,
        Op::GetIssue,
        Op::CreateIssue,
        Op::UpdateIssue,
        Op::CloseIssue,
        Op::ReopenIssue,
        Op::AssignIssue,
        Op::PlanWork,
        Op::GetPlan,
        Op::ApplyPlan,
        Op::ListLabels,
        Op::AddComment,
        Op::ReviewPullRequest,
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
            Op::UpdateRepo => "update_repo",
            Op::GetRepoSettings => "get_repo_settings",
            Op::GetMergeQueue => "get_merge_queue",
            Op::MessageAgent => "message_agent",
            Op::TakeMessages => "take_messages",
            Op::UpdateRepoSettings => "update_repo_settings",
            Op::ListIssues => "list_issues",
            Op::GetIssue => "get_issue",
            Op::CreateIssue => "create_issue",
            Op::UpdateIssue => "update_issue",
            Op::CloseIssue => "close_issue",
            Op::ReopenIssue => "reopen_issue",
            Op::AssignIssue => "assign_issue",
            Op::PlanWork => "plan_work",
            Op::GetPlan => "get_plan",
            Op::ApplyPlan => "apply_plan",
            Op::ListLabels => "list_labels",
            Op::AddComment => "add_comment",
            Op::ReviewPullRequest => "review_pull_request",
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
            Op::Whoami => {
                "Who the access token acts as, and the workspaces it can work in. `kind` is `user` for a person's token and `workspace` for a token that belongs to a workspace."
            }
            Op::CreateWorkspace => {
                "Create a workspace. A workspace owns repositories and is the first part of their address, g1t.sh/<workspace>/<repo>. The whoami tool lists the ones you already belong to."
            }
            Op::ListRepos => "Repositories you can see, optionally filtered by a search query.",
            Op::GetRepo => "One repository's details.",
            Op::UpdateRepo => {
                "Change a repository's description, whether it is private, and whether its default branch is protected. A protected branch refuses pushes and changes only by merging a pull request. Only the fields given are changed. Members of its workspace only."
            }
            Op::GetRepoSettings => {
                "How a repository handles pull requests: the approvals a merge needs, whether failed checks can be overridden, whether a pull request must be up to date, and how g1t's agents are reviewed, revised and merged."
            }
            Op::UpdateRepoSettings => {
                "Change how a repository handles pull requests. Only the fields given are changed. Members of its workspace only."
            }
            Op::MessageAgent => {
                "Send the agent working on a pull request a message: a correction, a hint, a change of plan. It receives it at its next step, and it is recorded in the pull request's session. The pull request's author and members of its workspace only."
            }
            Op::TakeMessages => {
                "For a g1t agent at work: the messages people have sent it that it has not seen yet. Each is returned once."
            }
            Op::GetMergeQueue => {
                "A repository's merge queue: the pull requests waiting to land, in order, each with the state it is being tested in (the default branch with the pull requests ahead of it merged in) and how that went; then those that recently landed or left. With the queue on, merging a pull request adds it here."
            }
            Op::CreateRepo => {
                "Create a repository in one of your workspaces, empty or as a copy of a public git repository elsewhere."
            }
            Op::ListIssues => {
                "Issues on a repository, newest first. An issue is something that should change: a bug, a feature, a question. Pull requests are made against it."
            }
            Op::GetIssue => {
                "An issue: its description, labels and acceptance checks, its comments, and every pull request made against it with its status. If the issue is closed, resolvedBy is the number of the pull request that was merged for it. Read this before opening a pull request, to see what others have already tried."
            }
            Op::CreateIssue => "Open an issue on a repository.",
            Op::UpdateIssue => {
                "Change an issue's title, body, labels or the people it is assigned to. Only the fields given are changed; labels and assignees each replace the whole set."
            }
            Op::CloseIssue => {
                "Close an issue without a pull request. Merging a pull request made for an issue closes it for you."
            }
            Op::ReopenIssue => "Reopen a closed issue.",
            Op::PlanWork => {
                "Turn an outcome into a plan. An agent reads the repository and proposes the issues that would get there: what each changes, the checks it must pass, the files it will touch, and which must merge before which. Returns the plan's id at once; the plan takes a minute or two to write, so read it with get_plan until its status is ready. Nothing is opened until apply_plan. Members of the repository's workspace only."
            }
            Op::GetPlan => {
                "A plan: the outcome asked for, its status (planning, ready, failed or applied), and the issues it proposes with their dependencies."
            }
            Op::ApplyPlan => {
                "Open a plan's issues, each blocked by the ones it depends on. With assign, g1t agents start at once on every issue that depends on nothing, working in parallel, and on the others as what they depend on merges. keep limits it to some of the proposed issues, by their positions counting from 1. A plan is applied once."
            }
            Op::AssignIssue => {
                "Assign an issue to the g1t agent. It opens a pull request for the issue in a sandbox of its own and sees it through: the issue's acceptance checks, a review by a second agent, revision if either finds something, and catching up when main moves. Returns the pull request at once; follow its progress with get_pull_request. There is no model or agent count to choose. To put many agents to work, assign many issues. In preview: only for accounts g1t agents are enabled for."
            }
            Op::ListLabels => "The labels available on a repository's issues.",
            Op::AddComment => {
                "Comment on an issue or a pull request. On a pull request, give path and line to comment on one line of the change."
            }
            Op::ReviewPullRequest => {
                "Give a verdict on a pull request: approve it, or request changes and say what. Read get_pull_request_changes first. You cannot review a pull request you opened."
            }
            Op::ListPullRequests => {
                "Pull requests on a repository, newest first. State open covers drafts and those ready for review; closed covers merged and closed."
            }
            Op::GetPullRequest => {
                "A pull request's status, head commit, comments and reviews, the issue it is for, the latest run of that issue's acceptance checks with each command's output, whether it is behind the branch it would merge into, and overlaps: other pull requests in progress that change the same files. An overlap with a pull request for a different issue means the two will conflict; say so, or keep clear of those files."
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
                "Land a pull request on the repository's main branch. Only members of the repository's workspace can merge, and only once it is marked ready and its acceptance checks have passed. Merging resolves the issue it was made for: the issue closes recording this pull request, and the other pull requests still in progress for that issue close as superseded. Fails if main has moved since the pull request was opened; pull main into its fork or branch and push, then merge again."
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
            Op::UpdateRepo => object(
                json!({
                    "repo": repo_schema(),
                    "description": { "type": "string", "description": "An empty string clears it." },
                    "private": { "type": "boolean" },
                    "protected": {
                        "type": "boolean",
                        "description": "Refuse pushes to the default branch, so that it changes only by merging a pull request.",
                    },
                }),
                &["repo"],
            ),
            Op::GetRepoSettings => object(json!({ "repo": repo_schema() }), &["repo"]),
            Op::GetMergeQueue => object(json!({ "repo": repo_schema() }), &["repo"]),
            Op::MessageAgent => object(
                numbered(json!({
                    "body": { "type": "string", "description": "What to tell the agent." },
                })),
                &["repo", "number", "body"],
            ),
            Op::TakeMessages => object(numbered(json!({})), &["repo", "number"]),
            Op::UpdateRepoSettings => object(
                json!({
                    "repo": repo_schema(),
                    "auto_merge": {
                        "type": "boolean",
                        "description": "Land a g1t agent's pull request without a person once every rule is met.",
                    },
                    "require_up_to_date": {
                        "type": "boolean",
                        "description": "Refuse to merge a pull request that is behind the default branch. When false, merging brings it up to date first.",
                    },
                    "required_approvals": {
                        "type": "integer",
                        "description": "How many approving reviews a merge needs.",
                    },
                    "count_agent_approvals": {
                        "type": "boolean",
                        "description": "Whether a g1t agent's approval counts towards required_approvals.",
                    },
                    "allow_ignoring_checks": {
                        "type": "boolean",
                        "description": "Whether a member may merge although the acceptance checks did not pass.",
                    },
                    "agent_review": {
                        "type": "boolean",
                        "description": "Whether a second agent reviews a g1t agent's pull request unasked.",
                    },
                    "merge_queue": {
                        "type": "boolean",
                        "description": "Merge through a queue: each pull request is tested together with those ahead of it, and only a combination that passed reaches the default branch.",
                    },
                    "max_revisions": {
                        "type": "integer",
                        "description": "How many times a g1t agent is sent back before a person is asked.",
                    },
                }),
                &["repo"],
            ),
            Op::CreateRepo => object(
                json!({
                    "workspace": {
                        "type": "string",
                        "description": "The workspace to create it in. May be left out if you belong to exactly one.",
                    },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "private": { "type": "boolean" },
                    "import_url": {
                        "type": "string",
                        "description": "Copy the default branch of a public git repository at this https address, e.g. https://github.com/owner/repo.",
                    },
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
                    "assignees": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Usernames of the people it is assigned to. Replaces the whole set; an empty list unassigns everyone. To assign it to the g1t agent, use assign_issue.",
                    },
                })),
                &["repo", "number"],
            ),
            Op::PlanWork => object(
                json!({
                    "repo": repo_schema(),
                    "brief": {
                        "type": "string",
                        "description": "What should be true when the work is done, in plain words. Say what you want, not how to split it.",
                    },
                }),
                &["repo", "brief"],
            ),
            Op::GetPlan => object(
                json!({
                    "repo": repo_schema(),
                    "plan": { "type": "string", "description": "The plan's id." },
                }),
                &["repo", "plan"],
            ),
            Op::ApplyPlan => object(
                json!({
                    "repo": repo_schema(),
                    "plan": { "type": "string", "description": "The plan's id." },
                    "assign": {
                        "type": "boolean",
                        "description": "Put g1t agents on the issues, in dependency order.",
                    },
                    "keep": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Positions, counting from 1, of the proposed issues to open. All of them if left out.",
                    },
                }),
                &["repo", "plan"],
            ),
            Op::AssignIssue => object(
                numbered(json!({
                    "instructions": {
                        "type": "string",
                        "description": "Extra guidance for this run, on top of the issue's description.",
                    },
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
                numbered(json!({
                    "body": { "type": "string", "description": "Markdown." },
                    "path": {
                        "type": "string",
                        "description": "On a pull request: the file to comment on.",
                    },
                    "line": {
                        "type": "integer",
                        "description": "The line of that file, as numbered after the change.",
                    },
                })),
                &["repo", "number", "body"],
            ),
            Op::ReviewPullRequest => object(
                numbered(json!({
                    "verdict": { "type": "string", "enum": ["approve", "request_changes"] },
                    "body": {
                        "type": "string",
                        "description": "Markdown. Required when requesting changes.",
                    },
                })),
                &["repo", "number", "verdict"],
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
                    "ignore_checks": {
                        "type": "boolean",
                        "description": "Merge although the acceptance checks have not passed.",
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
                | Op::GetRepoSettings
                | Op::GetMergeQueue
        )
    }

    /// Whether an agent's token with `scope` may use the operation.
    pub fn allowed_by(self, scope: &AgentScope) -> bool {
        scope.operations.iter().any(|name| name == self.name())
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
        // An agent's token does only what its scope lists, in its repository.
        if let Some(scope) = &services.scope {
            if !self.allowed_by(scope) {
                return failed(
                    FailureCode::Forbidden,
                    &format!("A g1t agent's token cannot use {}.", self.name()),
                );
            }
            let asked = repo_path(input);
            if self.needs_repo()
                && !asked.is_some_and(|asked| {
                    asked.namespace.eq_ignore_ascii_case(&scope.repo.namespace)
                        && asked.name.eq_ignore_ascii_case(&scope.repo.name)
                })
            {
                return failed(
                    FailureCode::Forbidden,
                    &format!(
                        "A g1t agent's token works in {}/{} only.",
                        scope.repo.namespace, scope.repo.name
                    ),
                );
            }
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
            ignore_checks: input["ignore_checks"].as_bool() == Some(true),
        };
        let Services {
            identity,
            repos,
            work,
            events,
            runner,
            ..
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
            Op::UpdateRepo => {
                pass(
                    repos,
                    "update",
                    &json!({
                        "actor": actor(),
                        "path": repo,
                        "description": input["description"].as_str(),
                        "isPrivate": input["private"].as_bool(),
                        "protected": input["protected"].as_bool(),
                    }),
                )
                .await
            }
            Op::GetRepoSettings => {
                pass(
                    work,
                    "get_settings",
                    &json!({ "repo": repo, "viewer": viewer }),
                )
                .await
            }
            Op::GetMergeQueue => {
                pass(work, "queue", &json!({ "repo": repo, "viewer": viewer })).await
            }
            Op::MessageAgent => {
                pass(
                    work,
                    "message_agent",
                    &json!({ "actor": actor(), "repo": repo, "number": number, "body": text(input, "body") }),
                )
                .await
            }
            Op::TakeMessages => {
                pass(
                    work,
                    "take_messages",
                    &json!({ "actor": actor(), "repo": repo, "number": number }),
                )
                .await
            }
            Op::UpdateRepoSettings => {
                // What is not given stays as it is.
                let current: Outcome<RepoSettings> = g1t_kit::call(
                    work,
                    "get_settings",
                    &json!({ "repo": repo, "viewer": viewer }),
                )
                .await?;
                let current = match current {
                    Outcome::Ok(settings) => settings,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                let flag = |key: &str, now: bool| input[key].as_bool().unwrap_or(now);
                let settings = RepoSettings {
                    auto_merge: flag("auto_merge", current.auto_merge),
                    require_up_to_date: flag("require_up_to_date", current.require_up_to_date),
                    required_approvals: integer(input, "required_approvals")
                        .unwrap_or(current.required_approvals),
                    count_agent_approvals: flag(
                        "count_agent_approvals",
                        current.count_agent_approvals,
                    ),
                    allow_ignoring_checks: flag(
                        "allow_ignoring_checks",
                        current.allow_ignoring_checks,
                    ),
                    agent_review: flag("agent_review", current.agent_review),
                    max_revisions: integer(input, "max_revisions").unwrap_or(current.max_revisions),
                    merge_queue: flag("merge_queue", current.merge_queue),
                    ..current
                };
                pass(
                    work,
                    "update_settings",
                    &UpdateSettingsArgs {
                        actor: actor(),
                        repo,
                        settings,
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
                        import_url: optional_text(input, "import_url"),
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
                        assignees: strings(input, "assignees"),
                    },
                )
                .await
            }
            Op::PlanWork => {
                pass(
                    runner,
                    "plan",
                    &json!({ "actor": actor(), "repo": repo, "brief": text(input, "brief") }),
                )
                .await
            }
            Op::GetPlan => {
                pass(
                    work,
                    "get_plan",
                    &PlanArgs {
                        repo,
                        viewer: viewer.clone(),
                        id: text(input, "plan"),
                    },
                )
                .await
            }
            Op::ApplyPlan => {
                pass(
                    runner,
                    "apply_plan",
                    &json!({
                        "actor": actor(),
                        "repo": repo,
                        "planId": text(input, "plan"),
                        "assign": input["assign"].as_bool() == Some(true),
                        "keep": input["keep"].as_array(),
                    }),
                )
                .await
            }
            Op::AssignIssue => {
                pass(
                    runner,
                    "run",
                    &json!({
                        "actor": actor(),
                        "repo": repo,
                        "issue": number,
                        "instructions": text(input, "instructions"),
                    }),
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
            Op::AddComment | Op::ReviewPullRequest => {
                let verdict = match (self, input["verdict"].as_str()) {
                    (Op::AddComment, _) => None,
                    (_, Some("approve")) => Some(Verdict::Approve),
                    (_, Some("request_changes")) => Some(Verdict::RequestChanges),
                    _ => {
                        return failed(
                            FailureCode::Invalid,
                            "verdict must be approve or request_changes.",
                        );
                    }
                };
                pass(
                    work,
                    "add_comment",
                    &AddCommentArgs {
                        actor: actor(),
                        repo,
                        number,
                        body: text(input, "body"),
                        path: optional_text(input, "path"),
                        line: integer(input, "line"),
                        verdict,
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
                        pass(repos, "compare", &detail.pull.comparison(viewer)).await
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
