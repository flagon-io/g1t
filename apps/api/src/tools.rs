//! The MCP server's tools: a few resource tools, each with an `action`.
//!
//! Every operation is one action of one tool. A call is dispatched to the
//! operation it names, so permissions, the audit log, billing and outcomes
//! are exactly those of the REST API. A token sees only the actions its
//! scopes allow, and a tool none of whose actions it may use is not listed.
//!
//! The listed input schema is one flat object: `action`, then every field
//! any of its actions takes. Which fields each action needs is in the
//! `action` field's description and checked on every call. Claude's API,
//! and so most MCP clients, refuse a tool whose input schema has `oneOf`
//! at its top level, so the schema keyed by action, with each action's
//! required fields, is [`discriminated`], published on the server's card
//! and in the docs.

use g1t_contracts::credentials::NEVER;
use g1t_contracts::identity::AgentScope;
use g1t_contracts::scopes::{Level, NO_SCOPE, TokenAccess, scope_for};
use serde_json::{Map, Value, json};

use crate::operations::Op;

pub struct Action {
    pub name: &'static str,
    pub op: Op,
    /// One line, for the `action` field's description.
    pub summary: &'static str,
}

pub struct Tool {
    pub name: &'static str,
    pub title: &'static str,
    /// What it is for, in a sentence or two.
    pub description: &'static str,
    pub actions: &'static [Action],
    /// The action a call without one runs.
    pub default_action: Option<&'static str>,
}

const fn a(name: &'static str, op: Op, summary: &'static str) -> Action {
    Action { name, op, summary }
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "search",
        title: "Search",
        description: "Find things. `code` (the default) searches all of g1t you can see: repositories, code, issues, pull requests and people, with qualifiers like repo:owner/name, language:rust, is:issue. `context` searches one workspace's catalog, docs, issues and memory by meaning.",
        default_action: Some("code"),
        actions: &[
            a("code", Op::Search, "Search all of g1t: repositories, code, issues, pull requests, people"),
            a("context", Op::SearchContext, "Search a workspace's context hub by meaning"),
            a("entity", Op::GetEntity, "One catalog entry and its relations"),
            a("ticket", Op::GetContext, "A Jira, Linear or Sentry item the work refers to, as it is now"),
        ],
    },
    Tool {
        name: "repository",
        title: "Repositories",
        description: "Repositories: find, read and create them, change their settings, and see and dismiss their security alerts (secrets and vulnerable dependencies). Name one as \"owner/name\". Deleting, transferring and changing visibility need `confirm`.",
        default_action: None,
        actions: &[
            a("list", Op::ListRepos, "Repositories you can see"),
            a("get", Op::GetRepo, "One repository"),
            a("create", Op::CreateRepo, "Create one, empty or copied from a public git URL"),
            a("update", Op::UpdateRepo, "Change description, website, topics, default branch, protection"),
            a("get_settings", Op::GetRepoSettings, "Branch protection: required checks, approvals, how pull requests merge"),
            a("update_settings", Op::UpdateRepoSettings, "Change branch protection and how pull requests merge"),
            a("check_names", Op::ListCheckNames, "Check names reported lately, to require on the default branch"),
            a("list_labels", Op::ListLabels, "Labels in use"),
            a("list_events", Op::ListEvents, "Timeline: pushes, issues, pull requests, comments"),
            a("rename_branch", Op::RenameBranch, "Rename a branch"),
            a("rename", Op::RenameRepo, "Rename it; old addresses redirect"),
            a("transfer", Op::TransferRepo, "Move it to another workspace you own"),
            a("archive", Op::ArchiveRepo, "Make it read-only"),
            a("unarchive", Op::UnarchiveRepo, "Make it writable again"),
            a("set_visibility", Op::SetRepoVisibility, "Make it public or private"),
            a("delete", Op::DeleteRepo, "Delete it; restorable for 30 days"),
            a("list_deleted", Op::ListDeletedRepos, "A workspace's deleted repositories"),
            a("restore", Op::RestoreRepo, "Restore a deleted one"),
            a("purge", Op::PurgeRepo, "Remove a deleted one for good"),
            a("security_alerts", Op::ListSecurityAlerts, "Secret and dependency alerts, filtered by state"),
            a("dismiss_alert", Op::DismissSecurityAlert, "Dismiss an alert with a reason"),
            a("reopen_alert", Op::ReopenSecurityAlert, "Reopen a dismissed alert"),
        ],
    },
    Tool {
        name: "issue",
        title: "Issues",
        description: "Issues: what should change. Read one before working on it to see the pull requests already made for it. Issues and pull requests share numbers; `comment` works on either.",
        default_action: None,
        actions: &[
            a("list", Op::ListIssues, "Issues on a repository, newest first"),
            a("get", Op::GetIssue, "One issue with comments and its pull requests"),
            a("create", Op::CreateIssue, "Open an issue"),
            a("update", Op::UpdateIssue, "Change title, body, labels or assignees"),
            a("close", Op::CloseIssue, "Close it without a pull request"),
            a("reopen", Op::ReopenIssue, "Reopen it"),
            a("comment", Op::AddComment, "Comment on an issue or pull request; path and line for one line of a change"),
            a("import", Op::ImportIssue, "Open an issue from a Jira, Linear or Sentry item"),
        ],
    },
    Tool {
        name: "pull_request",
        title: "Pull requests",
        description: "Pull requests: start a change for an issue, record your session, mark it ready, review and merge. Read `overlaps` and `behind` on `get` before going far.",
        default_action: None,
        actions: &[
            a("list", Op::ListPullRequests, "Pull requests on a repository, newest first"),
            a("get", Op::GetPullRequest, "Status, checks and required checks, reviews, overlaps, whether it is behind"),
            a("changes", Op::GetPullRequestChanges, "Files and line-by-line diff"),
            a("create", Op::CreatePullRequest, "Start a draft with its own fork to push to, or open one from a pushed branch"),
            a("record_session", Op::RecordSession, "Append prompt, reasoning and tool entries to its session"),
            a("read_session", Op::ReadSession, "Its recorded session"),
            a("ready", Op::MarkPullRequestReady, "Mark a draft ready, with a summary"),
            a("review", Op::ReviewPullRequest, "Approve or request changes"),
            a("close", Op::ClosePullRequest, "Close without merging"),
            a("merge", Op::MergePullRequest, "Land it, or join the merge queue"),
            a("merge_queue", Op::GetMergeQueue, "The repository's merge queue"),
        ],
    },
    Tool {
        name: "agent",
        title: "g1t agents",
        description: "Put g1t's agent to work and talk to it. One agent per issue; to do more at once, use more issues. Starting an agent uses the workspace's money.",
        default_action: None,
        actions: &[
            a("delegate", Op::Delegate, "Open an issue and put an agent on it in one step"),
            a("assign", Op::AssignIssue, "Put an agent on an existing issue"),
            a("message", Op::MessageAgent, "Tell the agent on a pull request something, or ask another agent"),
            a("answer", Op::AnswerMessage, "Answer a question or handoff sent to you"),
            a("take_messages", Op::TakeMessages, "For a g1t agent: messages not seen yet"),
        ],
    },
    Tool {
        name: "plan",
        title: "Plans",
        description: "Turn an outcome into issues: an agent proposes them with what done means and their dependencies; nothing opens until you apply the plan.",
        default_action: None,
        actions: &[
            a("create", Op::PlanWork, "Ask an agent for a plan; read it with get until ready"),
            a("get", Op::GetPlan, "A plan and the issues it proposes"),
            a("apply", Op::ApplyPlan, "Open its issues; with assign, agents start in dependency order"),
        ],
    },
    Tool {
        name: "memory",
        title: "Memory",
        description: "What the project and its workspace remember for the next agent: how to build, conventions, decisions, traps. Recall before you start; remember one short fact at a time, never a secret.",
        default_action: None,
        actions: &[
            a("recall", Op::Recall, "Search memory, or list it all"),
            a("remember", Op::Remember, "Save one fact"),
        ],
    },
    Tool {
        name: "workflow",
        title: "Workflows",
        description: "GitHub Actions workflows from .g1t/workflows: their runs, jobs and logs, and running, cancelling or rerunning them. Also the self-hosted runners they run on: a workspace's (`workspace`) or a repository's own (`repo`), their groups, and where agent work runs.",
        default_action: None,
        actions: &[
            a("list", Op::ListWorkflows, "Workflows on the default branch"),
            a("list_runs", Op::ListWorkflowRuns, "Runs, newest first"),
            a("get_run", Op::GetWorkflowRun, "One run with its jobs and steps"),
            a("job_logs", Op::GetJobLogs, "A job's log after a sequence number"),
            a("dispatch", Op::DispatchWorkflow, "Run a workflow_dispatch workflow"),
            a("cancel", Op::CancelWorkflowRun, "Cancel a run"),
            a("rerun", Op::RerunWorkflowRun, "Run a finished run again"),
            a("update", Op::UpdateWorkflow, "Turn a workflow on or off"),
            a("list_runners", Op::ListRunners, "Self-hosted runners, with status, labels and what each is doing"),
            a("create_runner_token", Op::CreateRunnerRegistrationToken, "A one-hour token for g1t-runner register"),
            a("remove_runner", Op::RemoveRunner, "Remove a self-hosted runner"),
            a("list_runner_groups", Op::ListRunnerGroups, "A workspace's runner groups"),
            a("create_runner_group", Op::CreateRunnerGroup, "Make a group, for some repositories"),
            a("update_runner_group", Op::UpdateRunnerGroup, "Rename a group or change its repositories"),
            a("delete_runner_group", Op::DeleteRunnerGroup, "Delete a group; its runners join the default"),
            a("get_runner_settings", Op::GetRunnerSettings, "Where agent work runs; whether forks may use runners"),
            a("update_runner_settings", Op::UpdateRunnerSettings, "Change them"),
        ],
    },
    Tool {
        name: "secret",
        title: "Secrets and variables",
        description: "A repository's or workspace's secrets and variables, read by workflows and deployments. Secret values are never returned.",
        default_action: None,
        actions: &[
            a("list_secrets", Op::ListActionsSecrets, "Secrets, without values"),
            a("set_secret", Op::SetActionsSecret, "Add or change a secret"),
            a("delete_secret", Op::DeleteActionsSecret, "Remove a secret"),
            a("list_variables", Op::ListActionsVariables, "Variables, with values"),
            a("set_variable", Op::SetActionsVariable, "Add or change a variable"),
            a("delete_variable", Op::DeleteActionsVariable, "Remove a variable"),
        ],
    },
    Tool {
        name: "webhook",
        title: "Webhooks",
        description: "HTTPS addresses sent signed events as they happen, for a repository or a whole workspace.",
        default_action: None,
        actions: &[
            a("list", Op::ListWebhooks, "Webhooks, without secrets"),
            a("create", Op::CreateWebhook, "Register one; a ping is sent"),
            a("update", Op::UpdateWebhook, "Change address, events or active"),
            a("delete", Op::DeleteWebhook, "Remove one"),
            a("ping", Op::PingWebhook, "Send a ping"),
            a("list_deliveries", Op::ListWebhookDeliveries, "Latest deliveries"),
            a("redeliver", Op::RedeliverWebhook, "Send a delivery again"),
        ],
    },
    Tool {
        name: "access",
        title: "Who has access",
        description: "Who has access to a repository and with which role (read, triage, write, maintain, admin), outside collaborators, and a workspace's base permission.",
        default_action: None,
        actions: &[
            a("list_collaborators", Op::ListCollaborators, "Everyone with a role, and pending invitations"),
            a("get_permission", Op::GetCollaboratorPermission, "One person's role and capabilities"),
            a("add_collaborator", Op::AddCollaborator, "Give someone a role, by username or email"),
            a("update_collaborator", Op::UpdateCollaborator, "Change a direct role"),
            a("remove_collaborator", Op::RemoveCollaborator, "Take away a direct role"),
            a("list_invitations", Op::ListRepoInvitations, "Pending invitations to a repository"),
            a("revoke_invitation", Op::RevokeRepoInvitation, "Withdraw one"),
            a("set_base_permission", Op::SetBasePermission, "What every member gets on each repository"),
            a("list_outside_collaborators", Op::ListOutsideCollaborators, "People with roles who are not members"),
        ],
    },
    Tool {
        name: "workspace",
        title: "Workspaces",
        description: "Workspaces own repositories (g1t.sh/{workspace}/{repo}): create, update or delete one, invite members, and connect integrations and model providers.",
        default_action: None,
        actions: &[
            a("create", Op::CreateWorkspace, "Create a workspace"),
            a("delete", Op::DeleteWorkspace, "Delete a workspace and everything in it (support can restore it for 30 days)"),
            a("update", Op::UpdateWorkspace, "Change its name, description or base permission"),
            a("list_invites", Op::ListWorkspaceInvites, "Its invites"),
            a("invite_member", Op::InviteMember, "Invite an email address"),
            a("revoke_invite", Op::RevokeWorkspaceInvite, "Revoke a pending invite"),
            a("list_integrations", Op::ListIntegrations, "Model providers, alert sources, trackers"),
            a("connect_integration", Op::ConnectIntegration, "Connect one"),
            a("disconnect_integration", Op::DisconnectIntegration, "Remove one"),
            a("test_integration", Op::TestIntegration, "Check its credentials"),
            a("get_model_routes", Op::GetModelRoutes, "Where each kind of work's model requests go"),
            a("set_model_routes", Op::SetModelRoutes, "Replace them"),
        ],
    },
    Tool {
        name: "notifications",
        title: "Notifications",
        description: "Your inbox: what needs you, and what you follow. One thread per issue, pull request, workflow or deployment, with why you were told (`reason`): an agent waiting on you, a review asked of you, an assignment, a mention, your work's checks, or what you subscribe to and watch. Mark threads read or done once handled, and choose what you hear of with subscribe, unsubscribe and watch. Your own: a personal token.",
        default_action: Some("list"),
        actions: &[
            a("list", Op::ListNotifications, "Unread threads, latest first; all, a view, a reason, a repository"),
            a("get", Op::GetNotificationThread, "One thread with its recent activity and your subscription"),
            a("mark_read", Op::MarkThreadRead, "Mark a thread read, or unread"),
            a("mark_all_read", Op::MarkNotificationsRead, "Mark everything read up to a time, or one repository's"),
            a("done", Op::MarkThreadDone, "Mark a thread done; new activity brings it back"),
            a("save", Op::SaveThread, "Save a thread, or unsave it"),
            a("snooze", Op::SnoozeThread, "Snooze a thread until a time, or bring it back"),
            a("subscription", Op::GetThreadSubscription, "Your subscription to an issue or pull request"),
            a("subscribe", Op::SetThreadSubscription, "Subscribe to an issue or pull request, or ignore it"),
            a("unsubscribe", Op::DeleteThreadSubscription, "Unsubscribe until you comment or are mentioned"),
            a("watching", Op::GetRepoSubscription, "How you watch a repository"),
            a("watch", Op::SetRepoSubscription, "Watch a repository: participating, all, ignore or custom"),
            a("unwatch", Op::DeleteRepoSubscription, "Stop watching a repository"),
            a("watched", Op::ListWatchedRepos, "Repositories you watch other than the default way"),
        ],
    },
    Tool {
        name: "account",
        title: "Your account",
        description: "Who this token acts as and its workspaces (`whoami`), your email addresses, your invites, and invitations to repositories waiting for you.",
        default_action: Some("whoami"),
        actions: &[
            a("whoami", Op::Whoami, "Who the token acts as, and its workspaces"),
            a("list_emails", Op::ListEmails, "Your addresses"),
            a("add_email", Op::AddEmail, "Add an address"),
            a("remove_email", Op::RemoveEmail, "Remove an address"),
            a("update_email_settings", Op::UpdateEmailSettings, "Primary, backup and privacy"),
            a("list_invites", Op::ListInvites, "Your invites to g1t"),
            a("create_invite", Op::CreateInvite, "Make an invite"),
            a("revoke_invite", Op::RevokeInvite, "Revoke one"),
            a("list_repository_invitations", Op::ListMyRepoInvitations, "Invitations to repositories for you"),
            a("accept_repository_invitation", Op::AcceptRepoInvitation, "Accept one"),
            a("decline_repository_invitation", Op::DeclineRepoInvitation, "Decline one"),
        ],
    },
];

/// Operations that cannot be undone, or reach beyond g1t's own records:
/// clients ask before running a tool that has any of them.
fn destructive(op: Op) -> bool {
    matches!(
        op,
        Op::DeleteWorkspace
            | Op::UpdateWorkspace
            | Op::DeleteRepo
            | Op::PurgeRepo
            | Op::TransferRepo
            | Op::SetRepoVisibility
            | Op::RemoveEmail
            | Op::RemoveCollaborator
            | Op::DisconnectIntegration
            | Op::DeleteWebhook
            | Op::DeleteActionsSecret
            | Op::DeleteActionsVariable
            | Op::SetActionsSecret
            | Op::SetActionsVariable
            | Op::SetModelRoutes
            | Op::SetBasePermission
            | Op::MergePullRequest
            | Op::RemoveRunner
            | Op::DeleteRunnerGroup
            | Op::UpdateRunnerSettings
    )
}

/// Whether an operation only reads.
pub fn reads_only(op: Op) -> bool {
    NO_SCOPE.contains(&op.name())
        || scope_for(op.name()).is_some_and(|scope| scope.level() == Level::Read)
}

/// What decides which actions a caller sees.
pub enum Gate<'a> {
    /// No limit beyond the person's own role.
    Everything,
    /// A g1t agent's token: the operations its run lists.
    Agent(&'a AgentScope),
    /// An access token with scopes.
    Token(&'a TokenAccess),
}

impl Gate<'_> {
    pub fn allows(&self, op: Op) -> bool {
        match self {
            Gate::Everything => true,
            Gate::Agent(scope) => op.allowed_by(scope) && !NEVER.contains(&op.name()),
            Gate::Token(access) => {
                if NO_SCOPE.contains(&op.name()) {
                    return true;
                }
                match scope_for(op.name()) {
                    Some(scope) => access.allows(scope),
                    None => access.scopes.is_none(),
                }
            }
        }
    }
}

impl Tool {
    pub fn by_name(name: &str) -> Option<&'static Tool> {
        TOOLS.iter().find(|tool| tool.name == name)
    }

    pub fn action(&self, name: &str) -> Option<&'static Action> {
        // The tools are 'static; find through TOOLS to keep the lifetime.
        TOOLS
            .iter()
            .find(|tool| tool.name == self.name)
            .and_then(|tool| tool.actions.iter().find(|action| action.name == name))
    }

    pub fn visible(&self, gate: &Gate) -> Vec<&'static Action> {
        TOOLS
            .iter()
            .find(|tool| tool.name == self.name)
            .map(|tool| tool.actions.iter().filter(|action| gate.allows(action.op)).collect())
            .unwrap_or_default()
    }

    /// The flat input schema of the actions given.
    pub fn input_schema(&self, actions: &[&Action]) -> Value {
        let mut properties = Map::new();
        let lines: Vec<String> = actions
            .iter()
            .map(|action| {
                let required: Vec<String> = action.op.required();
                if required.is_empty() {
                    format!("{}: {}.", action.name, action.summary)
                } else {
                    format!("{} ({}): {}.", action.name, required.join(", "), action.summary)
                }
            })
            .collect();
        let mut action_schema = json!({
            "type": "string",
            "enum": actions.iter().map(|action| action.name).collect::<Vec<_>>(),
            "description": lines.join("\n"),
        });
        if let Some(default) = self.default_action.filter(|name| actions.iter().any(|action| action.name == *name)) {
            action_schema["default"] = json!(default);
        }
        properties.insert("action".to_owned(), action_schema);
        for action in actions {
            for (name, schema) in action.op.properties() {
                merge_property(&mut properties, name, schema);
            }
        }
        let mut required = vec![];
        if self.default_action.is_none() {
            required.push("action");
        }
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }

    /// The input schema keyed by action: one `oneOf` branch per action,
    /// each with its own fields and the ones it needs.
    pub fn discriminated(&self, actions: &[&Action]) -> Value {
        let branches: Vec<Value> = actions
            .iter()
            .map(|action| {
                let mut properties = Map::new();
                properties.insert("action".to_owned(), json!({ "const": action.name }));
                properties.extend(action.op.properties());
                let mut required = vec![Value::String("action".to_owned())];
                // The default action may leave `action` out.
                if self.default_action == Some(action.name) {
                    required.clear();
                }
                required.extend(action.op.required().into_iter().map(Value::String));
                json!({
                    "title": action.name,
                    "description": action.summary,
                    "type": "object",
                    "properties": properties,
                    "required": required,
                })
            })
            .collect();
        json!({ "type": "object", "oneOf": branches })
    }

    /// MCP's hints about the actions given: whether the tool only reads,
    /// whether it can destroy something, and whether calling it twice is
    /// the same as once.
    pub fn annotations(&self, actions: &[&Action]) -> Value {
        let read_only = actions.iter().all(|action| reads_only(action.op));
        json!({
            "title": self.title,
            "readOnlyHint": read_only,
            "destructiveHint": !read_only && actions.iter().any(|action| destructive(action.op)),
            "idempotentHint": read_only,
            "openWorldHint": false,
        })
    }

    /// The tool as `tools/list` gives it, for a caller behind `gate`, or
    /// `None` when it may use none of its actions.
    pub fn listed(&self, gate: &Gate) -> Option<Value> {
        let actions = self.visible(gate);
        if actions.is_empty() {
            return None;
        }
        Some(json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema(&actions),
            "annotations": self.annotations(&actions),
        }))
    }
}

/// Adds a property to a tool's flat schema. The first action to use a name
/// describes it; a later one with other allowed values adds them.
fn merge_property(properties: &mut Map<String, Value>, name: String, schema: Value) {
    match properties.get_mut(&name) {
        None => {
            properties.insert(name, schema);
        }
        Some(existing) => {
            if let (Some(Value::Array(had)), Some(Value::Array(more))) =
                (existing.get("enum").cloned(), schema.get("enum"))
            {
                let mut merged = had;
                for value in more {
                    if !merged.contains(value) {
                        merged.push(value.clone());
                    }
                }
                existing["enum"] = Value::Array(merged);
            }
            // Different kinds of value under one name: say less, accept both.
            if existing.get("type") != schema.get("type")
                && let Some(fields) = existing.as_object_mut()
            {
                fields.remove("type");
                fields.remove("items");
            }
        }
    }
}

/// What a call to a tool runs: the operation its action names, or why not.
pub fn resolve(tool: &Tool, arguments: &Value) -> Result<Op, String> {
    let names = || {
        tool.actions
            .iter()
            .map(|action| action.name)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let Some(name) = arguments["action"].as_str().or(tool.default_action) else {
        return Err(format!("Give an action: one of {}.", names()));
    };
    let Some(action) = tool.action(name) else {
        return Err(format!("{} has no action {name}. Its actions: {}.", tool.name, names()));
    };
    let missing: Vec<String> = action
        .op
        .required()
        .into_iter()
        .filter(|field| arguments.get(field).is_none_or(Value::is_null))
        .collect();
    if !missing.is_empty() {
        return Err(format!("{}.{name} needs {}.", tool.name, missing.join(", ")));
    }
    Ok(action.op)
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Preset, Scope};

    fn listed(gate: &Gate) -> Vec<Value> {
        TOOLS.iter().filter_map(|tool| tool.listed(gate)).collect()
    }

    fn token(scopes: Option<Vec<Scope>>) -> TokenAccess {
        TokenAccess {
            token_id: "tok_1".to_owned(),
            scopes: scopes.map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            legacy: false,
        }
    }

    #[test]
    fn every_operation_is_exactly_one_action_of_one_tool() {
        for op in Op::ALL {
            let count = TOOLS
                .iter()
                .flat_map(|tool| tool.actions.iter())
                .filter(|action| action.op == op)
                .count();
            assert_eq!(count, 1, "{} is {count} actions", op.name());
        }
        for tool in TOOLS {
            let mut names = std::collections::HashSet::new();
            for action in tool.actions {
                assert!(names.insert(action.name), "{}.{} twice", tool.name, action.name);
            }
            if let Some(default) = tool.default_action {
                assert!(tool.action(default).is_some(), "{}", tool.name);
            }
        }
        assert!(TOOLS.len() <= 16, "{} tools", TOOLS.len());
    }

    #[test]
    fn every_operation_needs_exactly_one_scope_or_none() {
        use g1t_contracts::scopes::OPERATIONS;
        for op in Op::ALL {
            let mapped = OPERATIONS.iter().filter(|(name, _)| *name == op.name()).count();
            let free = NO_SCOPE.contains(&op.name());
            assert_eq!(mapped + usize::from(free), 1, "{}", op.name());
        }
        for (name, _) in OPERATIONS {
            assert!(Op::by_name(name).is_some(), "{name} is not an operation");
        }
    }

    #[test]
    fn each_tool_schema_is_valid_with_one_branch_per_action() {
        for tool in TOOLS {
            let actions: Vec<&Action> = tool.actions.iter().collect();
            let flat = tool.input_schema(&actions);
            assert_eq!(flat["type"], "object");
            assert!(flat.get("oneOf").is_none(), "no oneOf at the top level");
            let listed: Vec<&str> = flat["properties"]["action"]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            assert_eq!(listed, tool.actions.iter().map(|action| action.name).collect::<Vec<_>>());
            for action in tool.actions {
                for field in action.op.required() {
                    assert!(flat["properties"].get(&field).is_some(), "{}.{}: {field}", tool.name, action.name);
                }
            }
            let keyed = tool.discriminated(&actions);
            let branches = keyed["oneOf"].as_array().unwrap();
            assert_eq!(branches.len(), tool.actions.len());
            for (branch, action) in branches.iter().zip(tool.actions) {
                assert_eq!(branch["properties"]["action"]["const"], action.name);
                for field in branch["required"].as_array().unwrap() {
                    assert!(branch["properties"].get(field.as_str().unwrap()).is_some(), "{}.{}: {field}", tool.name, action.name);
                }
            }
            // A well-formed JSON Schema object throughout.
            let text = serde_json::to_string(&flat).unwrap();
            assert!(serde_json::from_str::<Value>(&text).is_ok());
        }
    }

    #[test]
    fn a_read_only_token_sees_read_actions_only() {
        let access = token(Preset::ReadOnly.scopes());
        let gate = Gate::Token(&access);
        for tool in TOOLS {
            for action in tool.visible(&gate) {
                assert!(reads_only(action.op), "{}.{}", tool.name, action.name);
            }
        }
        let tools = listed(&gate);
        for tool in &tools {
            assert_eq!(tool["annotations"]["readOnlyHint"], true, "{}", tool["name"]);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
        }
        let issue = tools.iter().find(|tool| tool["name"] == "issue").unwrap();
        assert_eq!(issue["inputSchema"]["properties"]["action"]["enum"], json!(["list", "get"]));
        // Nothing of the agent tool is a read.
        assert!(!tools.iter().any(|tool| tool["name"] == "agent"));
    }

    #[test]
    fn a_narrow_token_sees_only_its_tools() {
        let access = token(Some(vec![Scope::IssuesWrite]));
        let names: Vec<Value> = listed(&Gate::Token(&access)).into_iter().map(|tool| tool["name"].clone()).collect();
        assert_eq!(names, vec![json!("issue"), json!("plan"), json!("account")]);
        // Notifications are a resource of their own: reading them lists
        // only what reads.
        let reader = token(Some(vec![Scope::NotificationsRead]));
        let tools = listed(&Gate::Token(&reader));
        let notifications = tools.iter().find(|tool| tool["name"] == "notifications").unwrap();
        assert_eq!(
            notifications["inputSchema"]["properties"]["action"]["enum"],
            json!(["list", "get", "subscription", "watching", "watched"])
        );
        assert_eq!(notifications["annotations"]["readOnlyHint"], true);
        let full = token(None);
        assert_eq!(listed(&Gate::Token(&full)).len(), TOOLS.len());
        assert_eq!(listed(&Gate::Everything).len(), TOOLS.len());
    }

    #[test]
    fn a_tool_that_can_destroy_says_so() {
        let tools = listed(&Gate::Everything);
        let repository = tools.iter().find(|tool| tool["name"] == "repository").unwrap();
        assert_eq!(repository["annotations"]["destructiveHint"], true);
        assert_eq!(repository["annotations"]["readOnlyHint"], false);
        let memory = tools.iter().find(|tool| tool["name"] == "memory").unwrap();
        assert_eq!(memory["annotations"]["destructiveHint"], false);
    }

    #[test]
    fn calls_resolve_to_their_operation_or_say_what_is_missing() {
        let issue = Tool::by_name("issue").unwrap();
        assert_eq!(resolve(issue, &json!({ "action": "get", "repo": "a/b", "number": 1 })), Ok(Op::GetIssue));
        assert_eq!(resolve(issue, &json!({ "action": "get", "repo": "a/b" })), Err("issue.get needs number.".to_owned()));
        assert!(resolve(issue, &json!({})).unwrap_err().starts_with("Give an action"));
        assert!(resolve(issue, &json!({ "action": "explode" })).unwrap_err().contains("no action explode"));
        let search = Tool::by_name("search").unwrap();
        assert_eq!(resolve(search, &json!({ "query": "x" })), Ok(Op::Search));
        let account = Tool::by_name("account").unwrap();
        assert_eq!(resolve(account, &json!({})), Ok(Op::Whoami));
    }

    /// How much smaller `tools/list` is than one tool per operation. Run
    /// with `--nocapture` to see the numbers.
    #[test]
    fn the_tool_list_is_much_smaller_than_one_tool_per_operation() {
        let before: Vec<Value> = Op::ALL
            .into_iter()
            .map(|op| json!({ "name": op.name(), "description": op.description(), "inputSchema": op.input() }))
            .collect();
        let after = listed(&Gate::Everything);
        let before_bytes = serde_json::to_string(&json!({ "tools": before })).unwrap().len();
        let after_bytes = serde_json::to_string(&json!({ "tools": after })).unwrap().len();
        let agent = token(Preset::Agent.scopes());
        let agent_bytes = serde_json::to_string(&json!({ "tools": listed(&Gate::Token(&agent)) })).unwrap().len();
        let read = token(Preset::ReadOnly.scopes());
        let read_bytes = serde_json::to_string(&json!({ "tools": listed(&Gate::Token(&read)) })).unwrap().len();
        println!(
            "tools/list: before {} tools, {before_bytes} bytes (~{} tokens); after {} tools, {after_bytes} bytes (~{} tokens); agent preset {agent_bytes} bytes (~{} tokens); read only {read_bytes} bytes (~{} tokens)",
            before.len(),
            before_bytes / 4,
            after.len(),
            after_bytes / 4,
            agent_bytes / 4,
            read_bytes / 4,
        );
        assert!(after_bytes * 2 < before_bytes, "{after_bytes} vs {before_bytes}");
    }
}
