//! Keeping workflow runs safe, over REST and MCP: environments' protection
//! rules, the reviews of the jobs they hold, approving a pull request's
//! run from outside, what a job's token gets when its workflow names no
//! `permissions:`, which pull requests' runs wait for approval, and
//! `repository_dispatch`. The actions service decides and keeps all of it
//! (services/actions/src/protection.rs); these shape requests and answers
//! as the standard Actions REST API does.

use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectionOp {
    UpdateEnvironment,
    DeleteEnvironment,
    GetPendingDeployments,
    ReviewPendingDeployments,
    ApproveWorkflowRun,
    GetWorkflowPermissions,
    SetWorkflowPermissions,
    GetForkPrApproval,
    SetForkPrApproval,
    GetActionsAccess,
    SetActionsAccess,
    GetActionsPermissions,
    SetActionsPermissions,
    CreateRepositoryDispatch,
    GetWorkspaceWorkflowPermissions,
    SetWorkspaceWorkflowPermissions,
    ListWorkspaceManagedWorkflows,
    CreateWorkspaceManagedWorkflow,
    UpdateWorkspaceManagedWorkflow,
    DeleteWorkspaceManagedWorkflow,
}

impl ProtectionOp {
    /// Every one: `Op::ALL` lists each as `Op::Protection(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [ProtectionOp; 20] = [
        ProtectionOp::UpdateEnvironment,
        ProtectionOp::DeleteEnvironment,
        ProtectionOp::GetPendingDeployments,
        ProtectionOp::ReviewPendingDeployments,
        ProtectionOp::ApproveWorkflowRun,
        ProtectionOp::GetWorkflowPermissions,
        ProtectionOp::SetWorkflowPermissions,
        ProtectionOp::GetForkPrApproval,
        ProtectionOp::SetForkPrApproval,
        ProtectionOp::GetActionsAccess,
        ProtectionOp::SetActionsAccess,
        ProtectionOp::GetActionsPermissions,
        ProtectionOp::SetActionsPermissions,
        ProtectionOp::CreateRepositoryDispatch,
        ProtectionOp::GetWorkspaceWorkflowPermissions,
        ProtectionOp::SetWorkspaceWorkflowPermissions,
        ProtectionOp::ListWorkspaceManagedWorkflows,
        ProtectionOp::CreateWorkspaceManagedWorkflow,
        ProtectionOp::UpdateWorkspaceManagedWorkflow,
        ProtectionOp::DeleteWorkspaceManagedWorkflow,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ProtectionOp::UpdateEnvironment => "update_environment",
            ProtectionOp::DeleteEnvironment => "delete_environment",
            ProtectionOp::GetPendingDeployments => "get_pending_deployments",
            ProtectionOp::ReviewPendingDeployments => "review_pending_deployments",
            ProtectionOp::ApproveWorkflowRun => "approve_workflow_run",
            ProtectionOp::GetWorkflowPermissions => "get_workflow_permissions",
            ProtectionOp::SetWorkflowPermissions => "set_workflow_permissions",
            ProtectionOp::GetForkPrApproval => "get_fork_pr_approval",
            ProtectionOp::SetForkPrApproval => "set_fork_pr_approval",
            ProtectionOp::GetActionsAccess => "get_actions_access",
            ProtectionOp::SetActionsAccess => "set_actions_access",
            ProtectionOp::GetActionsPermissions => "get_actions_permissions",
            ProtectionOp::SetActionsPermissions => "set_actions_permissions",
            ProtectionOp::CreateRepositoryDispatch => "create_repository_dispatch",
            ProtectionOp::GetWorkspaceWorkflowPermissions => "get_workspace_workflow_permissions",
            ProtectionOp::SetWorkspaceWorkflowPermissions => "set_workspace_workflow_permissions",
            ProtectionOp::ListWorkspaceManagedWorkflows => "list_workspace_managed_workflows",
            ProtectionOp::CreateWorkspaceManagedWorkflow => "create_workspace_managed_workflow",
            ProtectionOp::UpdateWorkspaceManagedWorkflow => "update_workspace_managed_workflow",
            ProtectionOp::DeleteWorkspaceManagedWorkflow => "delete_workspace_managed_workflow",
        }
    }

    /// Whether it is about one repository, named by `repo`; the rest are a
    /// workspace's.
    pub fn needs_repo(self) -> bool {
        !self.managed() && !matches!(self, ProtectionOp::GetWorkspaceWorkflowPermissions | ProtectionOp::SetWorkspaceWorkflowPermissions)
    }

    /// Whether it is about a workspace's managed workflows.
    fn managed(self) -> bool {
        matches!(
            self,
            ProtectionOp::ListWorkspaceManagedWorkflows
                | ProtectionOp::CreateWorkspaceManagedWorkflow
                | ProtectionOp::UpdateWorkspaceManagedWorkflow
                | ProtectionOp::DeleteWorkspaceManagedWorkflow
        )
    }

    pub fn title(self) -> &'static str {
        match self {
            ProtectionOp::UpdateEnvironment => "Create or update an environment's protection rules",
            ProtectionOp::DeleteEnvironment => "Delete an environment's protection rules",
            ProtectionOp::GetPendingDeployments => "Get a run's pending deployments",
            ProtectionOp::ReviewPendingDeployments => "Review a run's pending deployments",
            ProtectionOp::ApproveWorkflowRun => "Approve a workflow run",
            ProtectionOp::GetWorkflowPermissions => "Get the default workflow permissions",
            ProtectionOp::SetWorkflowPermissions => "Set the default workflow permissions",
            ProtectionOp::GetForkPrApproval => "Get the approval policy for outside pull requests",
            ProtectionOp::SetForkPrApproval => "Set the approval policy for outside pull requests",
            ProtectionOp::GetActionsAccess => "Get who may use a repository's actions and workflows",
            ProtectionOp::SetActionsAccess => "Set who may use a repository's actions and workflows",
            ProtectionOp::GetActionsPermissions => "Get whether a repository's workflows run",
            ProtectionOp::SetActionsPermissions => "Turn a repository's workflows on or off",
            ProtectionOp::CreateRepositoryDispatch => "Create a repository dispatch event",
            ProtectionOp::GetWorkspaceWorkflowPermissions => "Get a workspace's default workflow permissions",
            ProtectionOp::SetWorkspaceWorkflowPermissions => "Set a workspace's default workflow permissions",
            ProtectionOp::ListWorkspaceManagedWorkflows => "List the workflows a workspace manages",
            ProtectionOp::CreateWorkspaceManagedWorkflow => "Add a workflow a workspace manages",
            ProtectionOp::UpdateWorkspaceManagedWorkflow => "Update a workflow a workspace manages",
            ProtectionOp::DeleteWorkspaceManagedWorkflow => "Remove a workflow a workspace manages",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ProtectionOp::UpdateEnvironment => {
                "Create an environment's protection rules, or change them; fields left out stay as they are. A job that names the environment with `environment:` waits, once its needs are done, until the rules let it through, and only then gets the environment's secrets. reviewers: up to 6, each {\"type\": \"User\" or \"Team\", \"name\": a username or a team's slug} (id is read as the name too); a job waits until one of them approves it. prevent_self_review: whoever started the run may not approve it. wait_timer: minutes each job waits, 0 to 43200. deployment_branch_policy: null lets every branch deploy; {\"protected_branches\": true} only branches the repository's rules protect (the default branch included); {\"custom_branch_policies\": true} only the branches and tags in branch_policies, each {\"name\": a pattern such as release/*, \"type\": \"branch\" or \"tag\"}. can_admins_bypass (true unless you say): admins may approve without being reviewers, which also skips the wait. The environment's name is up to 40 letters, digits, - and _, matched without regard to case. Needs the Admin role. Returns the environment with its protection_rules."
            }
            ProtectionOp::DeleteEnvironment => {
                "Delete an environment's protection rules: its jobs run without waiting from then on. Its secrets, variables and deployments stay. Needs the Admin role."
            }
            ProtectionOp::GetPendingDeployments => {
                "The environments whose protection rules hold a run's jobs, this attempt: each with the environment's name, state (waiting, approved or rejected), wait_timer and wait_until (when its timer lets its jobs start), its reviewers, the jobs it holds, who reviewed it and their comment, and current_user_can_approve. Needs the Read role."
            }
            ProtectionOp::ReviewPendingDeployments => {
                "Approve or reject the jobs a run's environments hold. environment_names names them (every waiting one if left out; environment_ids is read as names too); state is approved or rejected; comment is kept with the review. Only one of the environment's reviewers may, or an admin when can_admins_bypass is on, which also skips the wait timer; with prevent_self_review, not whoever started the run. A rejected environment's jobs fail. A workflow job's own token cannot review. Returns the pending deployments as they stand."
            }
            ProtectionOp::ApproveWorkflowRun => {
                "Let a run of a pull request from outside start: it waits as action_required, by the repository's approval policy (get_fork_pr_approval), until someone with the Write role approves it. A workflow job's own token cannot approve. Returns the run."
            }
            ProtectionOp::GetWorkflowPermissions => {
                "What a job's G1T_TOKEN (GITHUB_TOKEN) may do when its workflow and job write no `permissions:`: default_workflow_permissions is read (contents and packages read) or write (every permission). Unless the repository chose (default_chosen), a repository made before restricted tokens has write and a newer one its workspace's default; it is never more than the workspace's max_workflow_permissions. can_approve_pull_request_reviews says whether its jobs may open and approve pull requests (off unless chosen, and only where the workspace allows it). Needs the Read role."
            }
            ProtectionOp::SetWorkflowPermissions => {
                "Set default_workflow_permissions to read, write (refused where the workspace's maximum is read) or inherit (back to the workspace's default, or write for a repository made before restricted tokens), and can_approve_pull_request_reviews, \"Allow g1t Actions to create and approve pull requests\" (refused where the workspace does not allow it). Workflows that write `permissions:` get what they write either way, and a pull request's run from outside gets read-only. Needs the Admin role."
            }
            ProtectionOp::GetForkPrApproval => {
                "Which pull requests' runs wait for someone with the Write role to approve them before anything runs (approve_workflow_run): approval_policy is first_time_contributors (a pull request from someone outside the workspace who has not had one merged here), outside_contributors (the default: also everyone outside who cannot push here) or all_external_contributors (everyone outside the workspace, outside collaborators included). Members never wait, nor does g1t's own work. Needs the Read role."
            }
            ProtectionOp::SetForkPrApproval => {
                "Set approval_policy: first_time_contributors, outside_contributors or all_external_contributors. Needs the Admin role."
            }
            ProtectionOp::GetActionsAccess => {
                "Which other repositories' workflows may use this private repository's actions (uses: owner/repo@ref) and reusable workflows (jobs.<id>.uses: owner/repo/.g1t/workflows/build.yml@ref): access_level is none (the default: only this repository) or organization (private repositories in the same workspace). A public repository's actions and workflows are anyone's, whatever this says, and a public repository's workflows never use a private one's. Needs the Read role."
            }
            ProtectionOp::SetActionsAccess => {
                "Set access_level: none, or organization to let the workspace's other private repositories use this repository's actions and reusable workflows (user is read as organization). Needs the Admin role."
            }
            ProtectionOp::GetActionsPermissions => {
                "Whether a repository's workflows run at all: enabled is on for a repository and off for a fork until someone chooses (enabled_chosen says whether anyone has), so a fork never runs the workflows it copied until they are turned on. While it is off, no push, pull request, schedule, dispatch, repository_dispatch, merge queue or re-run starts a run; its workflows stay listed. allowed_actions is always all. Needs the Read role."
            }
            ProtectionOp::SetActionsPermissions => {
                "Turn a repository's workflows on or off (enabled). Off, nothing starts a run, and a dispatch or re-run is refused with \"Actions is turned off for owner/name\"; runs already going finish. Turning it on runs nothing by itself: the next event does. Needs the Admin role; a workflow job's own token cannot."
            }
            ProtectionOp::GetWorkspaceWorkflowPermissions => {
                "A workspace's policy for its repositories' job tokens: default_workflow_permissions (read, the default, or write) is what a repository made from now on gets until it chooses; max_workflow_permissions (write, the default, or read) is the most any repository's default may be, so read holds every repository to read-only; can_approve_pull_request_reviews (off by default) lets its repositories allow jobs to open and approve pull requests. Members only."
            }
            ProtectionOp::SetWorkspaceWorkflowPermissions => {
                "Change a workspace's default_workflow_permissions, max_workflow_permissions and can_approve_pull_request_reviews; fields left out stay as they are. A maximum of read makes the default read too. Owners only."
            }
            ProtectionOp::ListWorkspaceManagedWorkflows => {
                "The workflows a workspace's owners added to its repositories, g1t's required workflows: each runs in every repository it targets as that repository's own workflow (its token, its secrets, its checks), under the path managed/<name>.yml, from a copy of its source file taken when it was saved. Each has name, path, workflow_name (its `name:`), source (owner/repo/path@ref), source_sha (the commit it was copied at), source_private, mode, repositories, visibility, content (the copy that runs) and when and by whom it was last saved. Owners only."
            }
            ProtectionOp::CreateWorkspaceManagedWorkflow => {
                "Add a workflow to a workspace's repositories. name (lowercase letters, digits and hyphens) makes its path managed/<name>.yml. source is a workflow file in one of the workspace's repositories, owner/repo/.g1t/workflows/file.yml@ref; g1t copies it at the commit ref names, and the copy runs until it is copied again (update_workspace_managed_workflow with refresh). mode is required (a repository's workflow of the same `name:` is set aside, and no one in the repository can turn it off, so its check can be required by a ruleset) or default (a repository's own workflow of the same name runs in its place, and the repository's admins can turn it off). repositories lists names and patterns (* matches any characters, ! excludes), read in order, the last match deciding; empty or left out is every repository. visibility is all (the default), public or private. A source in a private repository runs in private repositories only, so visibility must be private. Owners only. Returns the workflow."
            }
            ProtectionOp::UpdateWorkspaceManagedWorkflow => {
                "Change a workflow a workspace manages: its source, mode, repositories or visibility; fields left out stay as they are. Giving source, or refresh: true, copies the source again at the commit its ref names now. Owners only. Returns the workflow."
            }
            ProtectionOp::DeleteWorkspaceManagedWorkflow => {
                "Take a workflow out of every repository of the workspace. Its runs stay. Owners only."
            }
            ProtectionOp::CreateRepositoryDispatch => {
                "Start the default branch's workflows that run `on: repository_dispatch` for event_type (those listing it under types, or with none). client_payload, a JSON object of at most 10 properties and 64 KB, is github.event.client_payload; github.event.action is event_type. A workflow job's own token may send one: with workflow_dispatch, it is how one workflow starts another. Needs the Write role (code:write). Returns how many runs started."
            }
        }
    }

    /// Whether it changes anything (the caller is its actor).
    pub fn writes(self) -> bool {
        !matches!(
            self,
            ProtectionOp::GetPendingDeployments
                | ProtectionOp::GetWorkflowPermissions
                | ProtectionOp::GetForkPrApproval
                | ProtectionOp::GetActionsAccess
                | ProtectionOp::GetActionsPermissions
                | ProtectionOp::GetWorkspaceWorkflowPermissions
                | ProtectionOp::ListWorkspaceManagedWorkflows
        )
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let run = json!({ "type": "string", "description": "The run's id, run_…." });
        let workspace = json!({ "type": "string", "description": "The workspace's name, e.g. \"acme\"." });
        let environment = json!({ "type": "string", "description": "The environment's name, such as production." });
        let (properties, required): (Value, &[&str]) = match self {
            ProtectionOp::UpdateEnvironment => (
                json!({
                    "repo": repo,
                    "environment": environment,
                    "wait_timer": { "type": "integer", "description": "Minutes each job waits before it may start, 0 to 43200." },
                    "prevent_self_review": { "type": "boolean", "description": "Whoever started a run may not approve its jobs." },
                    "reviewers": {
                        "type": ["array", "null"],
                        "description": "Up to 6 people or teams who may approve its jobs; empty for none.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["User", "Team"] },
                                "name": { "type": "string", "description": "A username, or a team's slug in the repository's workspace." },
                            },
                        },
                    },
                    "deployment_branch_policy": {
                        "type": ["object", "null"],
                        "description": "null: every branch may deploy. protected_branches: only protected ones. custom_branch_policies: only those in branch_policies.",
                        "properties": {
                            "protected_branches": { "type": "boolean" },
                            "custom_branch_policies": { "type": "boolean" },
                        },
                    },
                    "branch_policies": {
                        "type": "array",
                        "description": "With custom_branch_policies: the branches and tags that may deploy, at most 50.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "A pattern, such as main, release/* or v*." },
                                "type": { "type": "string", "enum": ["branch", "tag"] },
                            },
                        },
                    },
                    "can_admins_bypass": { "type": "boolean", "description": "Admins may approve without being reviewers, skipping the wait. True unless you say." },
                }),
                &["repo", "environment"],
            ),
            ProtectionOp::DeleteEnvironment => (json!({ "repo": repo, "environment": environment }), &["repo", "environment"]),
            ProtectionOp::GetPendingDeployments | ProtectionOp::ApproveWorkflowRun => (json!({ "repo": repo, "id": run }), &["repo", "id"]),
            ProtectionOp::ReviewPendingDeployments => (
                json!({
                    "repo": repo,
                    "id": run,
                    "environment_names": { "type": "array", "items": { "type": "string" }, "description": "The environments to review; every waiting one if left out." },
                    "state": { "type": "string", "enum": ["approved", "rejected"] },
                    "comment": { "type": "string", "description": "Why, kept with the review." },
                }),
                &["repo", "id", "state"],
            ),
            ProtectionOp::GetWorkflowPermissions
            | ProtectionOp::GetForkPrApproval
            | ProtectionOp::GetActionsAccess
            | ProtectionOp::GetActionsPermissions => (json!({ "repo": repo }), &["repo"]),
            ProtectionOp::SetActionsPermissions => (
                json!({
                    "repo": repo,
                    "enabled": { "type": "boolean", "description": "Whether its workflows run." },
                }),
                &["repo", "enabled"],
            ),
            ProtectionOp::SetActionsAccess => (
                json!({
                    "repo": repo,
                    "access_level": { "type": "string", "enum": ["none", "organization", "user"] },
                }),
                &["repo", "access_level"],
            ),
            ProtectionOp::SetWorkflowPermissions => (
                json!({
                    "repo": repo,
                    "default_workflow_permissions": { "type": "string", "enum": ["read", "write", "inherit"] },
                    "can_approve_pull_request_reviews": { "type": "boolean", "description": "Allow g1t Actions to create and approve pull requests." },
                }),
                &["repo"],
            ),
            ProtectionOp::GetWorkspaceWorkflowPermissions | ProtectionOp::ListWorkspaceManagedWorkflows => {
                (json!({ "workspace": workspace }), &["workspace"])
            }
            ProtectionOp::CreateWorkspaceManagedWorkflow => (
                json!({
                    "workspace": workspace,
                    "name": { "type": "string", "description": "Lowercase letters, digits and hyphens: its path is managed/<name>.yml." },
                    "source": managed_source(),
                    "mode": managed_mode(),
                    "repositories": managed_repositories(),
                    "visibility": managed_visibility(),
                }),
                &["workspace", "name", "source", "mode"],
            ),
            ProtectionOp::UpdateWorkspaceManagedWorkflow => (
                json!({
                    "workspace": workspace,
                    "workflow": managed_name(),
                    "source": managed_source(),
                    "mode": managed_mode(),
                    "repositories": managed_repositories(),
                    "visibility": managed_visibility(),
                    "refresh": { "type": "boolean", "description": "Copy the source again, at the commit its ref names now." },
                }),
                &["workspace", "workflow"],
            ),
            ProtectionOp::DeleteWorkspaceManagedWorkflow => {
                (json!({ "workspace": workspace, "workflow": managed_name() }), &["workspace", "workflow"])
            }
            ProtectionOp::SetWorkspaceWorkflowPermissions => (
                json!({
                    "workspace": workspace,
                    "default_workflow_permissions": { "type": "string", "enum": ["read", "write"], "description": "What new repositories get." },
                    "max_workflow_permissions": { "type": "string", "enum": ["read", "write"], "description": "The most any repository's default may be." },
                    "can_approve_pull_request_reviews": { "type": "boolean", "description": "Let repositories allow jobs to open and approve pull requests." },
                }),
                &["workspace"],
            ),
            ProtectionOp::SetForkPrApproval => (
                json!({
                    "repo": repo,
                    "approval_policy": { "type": "string", "enum": ["first_time_contributors", "outside_contributors", "all_external_contributors"] },
                }),
                &["repo", "approval_policy"],
            ),
            ProtectionOp::CreateRepositoryDispatch => (
                json!({
                    "repo": repo,
                    "event_type": { "type": "string", "description": "What happened, 1 to 100 characters; workflows choose it with `types:`." },
                    "client_payload": { "type": "object", "description": "Anything the workflows should read, as github.event.client_payload." },
                }),
                &["repo", "event_type"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn managed_name() -> Value {
    json!({ "type": "string", "description": "The managed workflow's name, as in managed/<name>.yml." })
}

fn managed_source() -> Value {
    json!({ "type": "string", "description": "A workflow file in one of the workspace's repositories: owner/repo/.g1t/workflows/file.yml@ref." })
}

fn managed_mode() -> Value {
    json!({ "type": "string", "enum": ["required", "default"], "description": "required: a repository cannot take its place or turn it off. default: a repository's workflow of the same name takes its place." })
}

fn managed_repositories() -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": "Repository names and patterns (* matches any characters, ! excludes); empty is every repository." })
}

fn managed_visibility() -> Value {
    json!({ "type": "string", "enum": ["all", "public", "private"], "description": "Which repositories, by visibility. A private source needs private." })
}

/// A workspace's managed workflow, in the API's shape.
fn managed_view(workflow: &Value) -> Value {
    json!({
        "name": workflow["name"],
        "path": workflow["path"],
        "workflow_name": workflow["workflowName"],
        "source": workflow["source"],
        "source_sha": workflow["sourceSha"],
        "source_private": workflow["sourcePrivate"],
        "mode": workflow["mode"],
        "repositories": workflow["repositories"],
        "visibility": workflow["visibility"],
        "content": workflow["content"],
        "created_at": workflow["createdAt"],
        "updated_at": workflow["updatedAt"],
        "updated_by": workflow["updatedBy"],
    })
}

/// A workspace's managed workflows: listed, added, changed and removed.
async fn run_managed(
    op: ProtectionOp,
    actions: &worker::Fetcher,
    viewer: &Viewer,
    actor: g1t_contracts::User,
    workspace: String,
    input: &Value,
) -> Result<Outcome<Value>> {
    let strings = |key: &str| -> Option<Vec<String>> {
        input.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
    };
    Ok(match op {
        ProtectionOp::ListWorkspaceManagedWorkflows => {
            let listed: Outcome<Vec<Value>> =
                g1t_kit::call(actions, "workspace_managed_workflows", &json!({ "viewer": viewer, "workspace": workspace })).await?;
            map(listed, |list| json!({ "total_count": list.len(), "managed_workflows": list.iter().map(managed_view).collect::<Vec<_>>() }))
        }
        ProtectionOp::CreateWorkspaceManagedWorkflow | ProtectionOp::UpdateWorkspaceManagedWorkflow => {
            let create = op == ProtectionOp::CreateWorkspaceManagedWorkflow;
            let name = if create { text(input, "name") } else { text(input, "workflow") };
            let saved: Outcome<Value> = g1t_kit::call(
                actions,
                "set_workspace_managed_workflow",
                &json!({
                    "actor": actor,
                    "workspace": workspace,
                    "name": name.unwrap_or_default(),
                    "create": create,
                    "source": text(input, "source"),
                    "mode": text(input, "mode"),
                    "repositories": strings("repositories"),
                    "visibility": text(input, "visibility"),
                    "refresh": flag(input, "refresh").unwrap_or(false),
                }),
            )
            .await?;
            map(saved, |workflow| managed_view(&workflow))
        }
        ProtectionOp::DeleteWorkspaceManagedWorkflow => {
            let removed: Outcome<bool> = g1t_kit::call(
                actions,
                "remove_workspace_managed_workflow",
                &json!({ "actor": actor, "workspace": workspace, "name": text(input, "workflow").unwrap_or_default() }),
            )
            .await?;
            map(removed, |removed| json!({ "deleted": removed }))
        }
        _ => Outcome::fail(FailureCode::Invalid, "Not a managed workflow operation."),
    })
}

fn text(input: &Value, key: &str) -> Option<String> {
    match &input[key] {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

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

/// The actions service's arguments for an environment's change, from a
/// request shaped as the standard environments API is.
pub(crate) fn environment_change(input: &Value) -> std::result::Result<Map<String, Value>, String> {
    let mut out = Map::new();
    if let Some(minutes) = input.get("wait_timer").filter(|v| !v.is_null()) {
        let minutes = minutes
            .as_u64()
            .or_else(|| minutes.as_str().and_then(|s| s.trim().parse().ok()))
            .ok_or("wait_timer is a number of minutes.")?;
        out.insert("waitMinutes".into(), minutes.into());
    }
    if let Some(value) = flag(input, "prevent_self_review") {
        out.insert("preventSelfReview".into(), value.into());
    }
    if let Some(value) = flag(input, "can_admins_bypass") {
        out.insert("adminsBypass".into(), value.into());
    }
    match input.get("reviewers") {
        None => {}
        Some(Value::Null) => {
            out.insert("reviewers".into(), json!([]));
        }
        Some(Value::Array(given)) => {
            let mut reviewers = Vec::new();
            for reviewer in given {
                let kind = reviewer["type"].as_str().unwrap_or("User").to_ascii_lowercase();
                let name = text(reviewer, "name")
                    .or_else(|| text(reviewer, "id"))
                    .or_else(|| text(reviewer, "login"))
                    .or_else(|| text(reviewer, "slug"));
                let Some(name) = name else { return Err("Each reviewer has a name: a username or a team's slug.".to_owned()) };
                reviewers.push(json!({ "type": kind, "name": name }));
            }
            out.insert("reviewers".into(), Value::Array(reviewers));
        }
        Some(_) => return Err("reviewers is a list of {\"type\", \"name\"}.".to_owned()),
    }
    match input.get("deployment_branch_policy") {
        None => {}
        Some(Value::Null) => {
            out.insert("branchPolicy".into(), "all".into());
        }
        Some(policy @ Value::Object(_)) => {
            let protected = flag(policy, "protected_branches") == Some(true);
            let custom = flag(policy, "custom_branch_policies") == Some(true);
            let chosen = match (protected, custom) {
                (true, true) => {
                    return Err("deployment_branch_policy is protected_branches or custom_branch_policies, not both.".to_owned());
                }
                (true, false) => "protected",
                (false, true) => "selected",
                (false, false) => "all",
            };
            out.insert("branchPolicy".into(), chosen.into());
        }
        Some(_) => return Err("deployment_branch_policy is an object, or null.".to_owned()),
    }
    if let Some(Value::Array(patterns)) = input.get("branch_policies") {
        let patterns: Vec<Value> = patterns
            .iter()
            .map(|pattern| json!({ "name": pattern["name"].as_str().unwrap_or_default(), "type": pattern["type"].as_str().unwrap_or("branch") }))
            .collect();
        out.insert("branchPatterns".into(), Value::Array(patterns));
    }
    Ok(out)
}

/// An environment as the actions service keeps it (camelCase), in the
/// standard shape: `protection_rules`, `deployment_branch_policy` and
/// `can_admins_bypass`, with g1t's `branch_policies` beside them.
pub(crate) fn environment_view(env: &Value) -> Value {
    let reviewers: Vec<Value> = env["reviewers"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|r| match r["type"].as_str() {
                    Some("team") => json!({ "type": "Team", "reviewer": { "slug": r["name"] } }),
                    _ => json!({ "type": "User", "reviewer": { "login": r["name"] } }),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut rules = Vec::new();
    if !reviewers.is_empty() {
        rules.push(json!({ "type": "required_reviewers", "prevent_self_review": env["preventSelfReview"], "reviewers": reviewers }));
    }
    if env["waitMinutes"].as_u64().unwrap_or(0) > 0 {
        rules.push(json!({ "type": "wait_timer", "wait_timer": env["waitMinutes"] }));
    }
    let policy = env["branchPolicy"].as_str().unwrap_or("all");
    if policy != "all" {
        rules.push(json!({ "type": "branch_policy" }));
    }
    json!({
        "name": env["name"],
        "protection_rules": rules,
        "deployment_branch_policy": match policy {
            "protected" => json!({ "protected_branches": true, "custom_branch_policies": false }),
            "selected" => json!({ "protected_branches": false, "custom_branch_policies": true }),
            _ => Value::Null,
        },
        "branch_policies": env["branchPatterns"],
        "can_admins_bypass": env["adminsBypass"],
        "protected": env["protected"],
        "updated_at": env["updatedAt"],
        "updated_by": env["updatedBy"],
    })
}

/// A pending deployment, in the standard shape.
fn pending_view(pending: &Value) -> Value {
    let reviewers: Vec<Value> = pending["reviewers"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|r| match r["type"].as_str() {
                    Some("team") => json!({ "type": "Team", "reviewer": { "slug": r["name"] } }),
                    _ => json!({ "type": "User", "reviewer": { "login": r["name"] } }),
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "environment": { "name": pending["environment"] },
        "state": pending["state"],
        "needs_review": pending["needsReview"],
        "wait_until": pending["waitUntil"],
        "current_user_can_approve": pending["canReview"],
        "reviewers": reviewers,
        "jobs": pending["jobs"],
        "reviewed_by": pending["reviewedBy"],
        "comment": pending["comment"],
        "reviewed_at": pending["reviewedAt"],
    })
}

fn map<T>(outcome: Outcome<T>, view: impl FnOnce(T) -> Value) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(view(value)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    }
}

/// The protection rules of the environments `listed` (the deployments
/// service's answer to `list_environments` or `get_environment`) added to
/// it, and environments with rules but no deployments yet added to a list.
pub(crate) async fn with_protection(
    services: &Services,
    viewer: &Viewer,
    input: &Value,
    listed: Outcome<Value>,
    one: Option<&str>,
) -> Result<Outcome<Value>> {
    let Some(repo) = repo_path(input) else { return Ok(listed) };
    let mut args = json!({ "viewer": viewer, "repo": repo });
    if let Some(name) = one {
        args["name"] = json!(name);
    }
    let rules: Outcome<Vec<Value>> = g1t_kit::call(&services.actions, "environments", &args).await.unwrap_or(Outcome::Ok(Vec::new()));
    let rules = match rules {
        Outcome::Ok(rules) => rules,
        Outcome::Fail(_) => return Ok(listed),
    };
    let protection =
        |name: &str| rules.iter().find(|env| env["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))).map(environment_view);
    let add = |env: &mut Value| {
        if let Some(view) = env["name"].as_str().and_then(protection) {
            for key in ["protection_rules", "deployment_branch_policy", "branch_policies", "can_admins_bypass"] {
                env[key] = view[key].clone();
            }
        }
    };
    Ok(match (listed, one) {
        (Outcome::Ok(mut env), Some(_)) => {
            add(&mut env);
            Outcome::Ok(env)
        }
        // Never deployed, but protected: still an environment.
        (Outcome::Fail(refused), Some(name)) => match protection(name).filter(|view| view["protected"] == true) {
            Some(view) => Outcome::Ok(view),
            None => Outcome::Fail(refused),
        },
        (Outcome::Ok(mut list), None) => {
            if let Some(environments) = list["environments"].as_array_mut() {
                for env in environments.iter_mut() {
                    add(env);
                }
                for env in rules.iter().filter(|env| env["protected"] == true) {
                    let name = env["name"].as_str().unwrap_or_default();
                    if !environments.iter().any(|known| known["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))) {
                        environments.push(environment_view(env));
                    }
                }
            }
            Outcome::Ok(list)
        }
        (failed, None) => failed,
    })
}

/// A workspace's policy, in the standard shape.
fn workspace_view(settings: &Value) -> Value {
    json!({
        "default_workflow_permissions": settings["defaultPermissions"],
        "max_workflow_permissions": settings["maxPermissions"],
        "can_approve_pull_request_reviews": settings["canApprovePullRequests"],
    })
}

pub async fn run(op: ProtectionOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    if op.writes() && viewer.is_none() {
        return Ok(Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token."));
    }
    let actor = || viewer.clone().unwrap_or_default();
    let actions = &services.actions;
    if !op.needs_repo() {
        let Some(workspace) = text(input, "workspace") else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
        };
        if op.managed() {
            return run_managed(op, actions, viewer, actor(), workspace, input).await;
        }
        let settings: Outcome<Value> = if op == ProtectionOp::GetWorkspaceWorkflowPermissions {
            g1t_kit::call(actions, "workspace_actions_settings", &json!({ "viewer": viewer, "workspace": workspace })).await?
        } else {
            g1t_kit::call(
                actions,
                "set_workspace_actions_settings",
                &json!({
                    "actor": actor(),
                    "workspace": workspace,
                    "defaultPermissions": text(input, "default_workflow_permissions"),
                    "maxPermissions": text(input, "max_workflow_permissions"),
                    "canApprovePullRequests": flag(input, "can_approve_pull_request_reviews"),
                }),
            )
            .await?
        };
        return Ok(map(settings, |s| workspace_view(&s)));
    }
    let Some(repo) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let id = text(input, "id").unwrap_or_default();
    let environment = text(input, "environment").unwrap_or_default();
    Ok(match op {
        ProtectionOp::UpdateEnvironment => {
            let mut args = match environment_change(input) {
                Ok(args) => args,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            args.insert("actor".into(), serde_json::to_value(actor())?);
            args.insert("repo".into(), serde_json::to_value(&repo)?);
            args.insert("name".into(), environment.into());
            let saved: Outcome<Value> = g1t_kit::call(actions, "set_environment", &Value::Object(args)).await?;
            map(saved, |env| environment_view(&env))
        }
        ProtectionOp::DeleteEnvironment => {
            let removed: Outcome<bool> =
                g1t_kit::call(actions, "delete_environment", &json!({ "actor": actor(), "repo": repo, "name": environment })).await?;
            map(removed, |removed| json!({ "deleted": removed }))
        }
        ProtectionOp::GetPendingDeployments => {
            let pending: Outcome<Vec<Value>> =
                g1t_kit::call(actions, "pending_deployments", &json!({ "viewer": viewer, "repo": repo, "id": id })).await?;
            map(pending, |list| Value::Array(list.iter().map(pending_view).collect()))
        }
        ProtectionOp::ReviewPendingDeployments => {
            let names: Vec<String> = ["environment_names", "environments", "environment_ids"]
                .iter()
                .find_map(|key| input[*key].as_array())
                .map(|list| {
                    list.iter().filter_map(|v| v.as_str().map(str::to_owned).or_else(|| v.as_u64().map(|n| n.to_string()))).collect()
                })
                .unwrap_or_default();
            let reviewed: Outcome<Vec<Value>> = g1t_kit::call(
                actions,
                "review_deployments",
                &json!({
                    "actor": actor(),
                    "repo": repo,
                    "id": id,
                    "environments": names,
                    "state": text(input, "state").unwrap_or_default(),
                    "comment": text(input, "comment"),
                }),
            )
            .await?;
            map(reviewed, |list| Value::Array(list.iter().map(pending_view).collect()))
        }
        ProtectionOp::ApproveWorkflowRun => {
            g1t_kit::call(actions, "approve_run", &json!({ "actor": actor(), "repo": repo, "id": id })).await?
        }
        ProtectionOp::GetWorkflowPermissions | ProtectionOp::SetWorkflowPermissions => {
            let settings: Outcome<Value> = if op == ProtectionOp::GetWorkflowPermissions {
                g1t_kit::call(actions, "actions_settings", &json!({ "viewer": viewer, "repo": repo })).await?
            } else {
                g1t_kit::call(
                    actions,
                    "set_actions_settings",
                    &json!({
                        "actor": actor(),
                        "repo": repo,
                        "defaultPermissions": text(input, "default_workflow_permissions"),
                        "canApprovePullRequests": flag(input, "can_approve_pull_request_reviews"),
                    }),
                )
                .await?
            };
            map(settings, |s| {
                json!({
                    "default_workflow_permissions": s["defaultPermissions"],
                    "default_chosen": s["defaultChosen"],
                    "max_workflow_permissions": s["maxPermissions"],
                    "can_approve_pull_request_reviews": s["canApprovePullRequests"],
                })
            })
        }
        ProtectionOp::GetForkPrApproval | ProtectionOp::SetForkPrApproval => {
            let settings: Outcome<Value> = if op == ProtectionOp::GetForkPrApproval {
                g1t_kit::call(actions, "actions_settings", &json!({ "viewer": viewer, "repo": repo })).await?
            } else {
                g1t_kit::call(
                    actions,
                    "set_actions_settings",
                    &json!({ "actor": actor(), "repo": repo, "approvalPolicy": text(input, "approval_policy").unwrap_or_default() }),
                )
                .await?
            };
            map(settings, |s| json!({ "approval_policy": s["approvalPolicy"] }))
        }
        ProtectionOp::GetActionsAccess | ProtectionOp::SetActionsAccess => {
            let settings: Outcome<Value> = if op == ProtectionOp::GetActionsAccess {
                g1t_kit::call(actions, "actions_settings", &json!({ "viewer": viewer, "repo": repo })).await?
            } else {
                g1t_kit::call(
                    actions,
                    "set_actions_settings",
                    &json!({ "actor": actor(), "repo": repo, "accessLevel": text(input, "access_level").unwrap_or_default() }),
                )
                .await?
            };
            map(settings, |s| json!({ "access_level": s["accessLevel"] }))
        }
        ProtectionOp::GetActionsPermissions | ProtectionOp::SetActionsPermissions => {
            let settings: Outcome<Value> = if op == ProtectionOp::GetActionsPermissions {
                g1t_kit::call(actions, "actions_settings", &json!({ "viewer": viewer, "repo": repo })).await?
            } else {
                let Some(enabled) = flag(input, "enabled") else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "enabled is true or false."));
                };
                g1t_kit::call(actions, "set_actions_settings", &json!({ "actor": actor(), "repo": repo, "enabled": enabled })).await?
            };
            map(settings, |s| {
                json!({
                    "enabled": s.get("enabled").cloned().unwrap_or(Value::Bool(true)),
                    "enabled_chosen": s.get("enabledChosen").cloned().unwrap_or(Value::Bool(false)),
                    "allowed_actions": "all",
                })
            })
        }
        ProtectionOp::CreateRepositoryDispatch => {
            let started: Outcome<u32> = g1t_kit::call(
                actions,
                "repository_dispatch",
                &json!({
                    "actor": actor(),
                    "repo": repo,
                    "eventType": text(input, "event_type").unwrap_or_default(),
                    "clientPayload": input.get("client_payload").cloned().unwrap_or(Value::Null),
                }),
            )
            .await?;
            map(started, |runs| json!({ "runs": runs }))
        }
        // Answered above, before a repository is read.
        ProtectionOp::GetWorkspaceWorkflowPermissions
        | ProtectionOp::SetWorkspaceWorkflowPermissions
        | ProtectionOp::ListWorkspaceManagedWorkflows
        | ProtectionOp::CreateWorkspaceManagedWorkflow
        | ProtectionOp::UpdateWorkspaceManagedWorkflow
        | ProtectionOp::DeleteWorkspaceManagedWorkflow => Outcome::fail(FailureCode::Invalid, "Name the workspace."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_environment_change_reads_the_standard_shape() {
        let args = environment_change(&json!({
            "wait_timer": 30,
            "prevent_self_review": true,
            "reviewers": [{ "type": "User", "id": "ada" }, { "type": "Team", "name": "deployers" }],
            "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true },
            "branch_policies": [{ "name": "release/*", "type": "branch" }],
        }))
        .unwrap();
        assert_eq!(args["waitMinutes"], 30);
        assert_eq!(args["preventSelfReview"], true);
        assert_eq!(args["reviewers"], json!([{ "type": "user", "name": "ada" }, { "type": "team", "name": "deployers" }]));
        assert_eq!(args["branchPolicy"], "selected");
        assert_eq!(args["branchPatterns"], json!([{ "name": "release/*", "type": "branch" }]));
        // Left out stays; null clears.
        let cleared = environment_change(&json!({ "deployment_branch_policy": null, "reviewers": null })).unwrap();
        assert_eq!(cleared["branchPolicy"], "all");
        assert_eq!(cleared["reviewers"], json!([]));
        assert!(!environment_change(&json!({})).unwrap().contains_key("waitMinutes"));
        assert!(
            environment_change(&json!({ "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": true } }))
                .is_err()
        );
    }

    #[test]
    fn an_environment_reads_as_the_standard_shape() {
        let view = environment_view(&json!({
            "name": "production", "reviewers": [{ "type": "user", "name": "ada" }], "preventSelfReview": true,
            "waitMinutes": 10, "branchPolicy": "protected", "branchPatterns": [], "adminsBypass": false, "protected": true,
        }));
        let types: Vec<&str> = view["protection_rules"].as_array().unwrap().iter().map(|r| r["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["required_reviewers", "wait_timer", "branch_policy"]);
        assert_eq!(view["protection_rules"][0]["reviewers"][0]["reviewer"]["login"], "ada");
        assert_eq!(view["deployment_branch_policy"]["protected_branches"], true);
        assert_eq!(view["can_admins_bypass"], false);
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in ProtectionOp::ALL {
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            let needs = if op.needs_repo() { "repo" } else { "workspace" };
            assert!(op.input()["required"].as_array().unwrap().contains(&json!(needs)), "{}", op.name());
        }
    }
}
