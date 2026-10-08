//! Run credentials: the least-privilege tokens a sandbox works with.
//!
//! Every sandbox run gets its own tokens, bound to the run, its repository
//! (and the pull request's fork), what that kind of run needs to do, and an
//! expiry no later than the run's timeout. Each carries a composite
//! identity: an agent acting on behalf of the person who started the work.
//! What it may do is the intersection of the two: the run's scope, and what
//! that person may do right now.
//!
//! The policy lives here, as pure functions, so that identity (which mints
//! the tokens), the API (which serves REST and MCP) and repos (which serves
//! git) all enforce the same rules, and so the rules can be tested.

use serde::{Deserialize, Serialize};

use crate::identity::AgentScope;
use crate::repos::RepoPath;
use crate::access::{BasePermission, RepoGrant, RepoRole};
use crate::{Membership, PrincipalKind, Role, User};

/// What a run does, as far as its credentials are concerned. The same names
/// as [`crate::agents::RunKind`], plus `deploy`, a build of one commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCredentialKind {
    Implement,
    Revise,
    Review,
    Answer,
    Update,
    Plan,
    Checks,
    Queue,
    Mergecheck,
    Deploy,
    /// A security update: raising one package's version in its lockfiles
    /// and pushing that to a branch of its own. Not an agent.
    Bump,
}

impl RunCredentialKind {
    pub const ALL: [RunCredentialKind; 11] = [
        RunCredentialKind::Implement,
        RunCredentialKind::Revise,
        RunCredentialKind::Review,
        RunCredentialKind::Answer,
        RunCredentialKind::Update,
        RunCredentialKind::Plan,
        RunCredentialKind::Checks,
        RunCredentialKind::Queue,
        RunCredentialKind::Mergecheck,
        RunCredentialKind::Deploy,
        RunCredentialKind::Bump,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RunCredentialKind::Implement => "implement",
            RunCredentialKind::Revise => "revise",
            RunCredentialKind::Review => "review",
            RunCredentialKind::Answer => "answer",
            RunCredentialKind::Update => "update",
            RunCredentialKind::Plan => "plan",
            RunCredentialKind::Checks => "checks",
            RunCredentialKind::Queue => "queue",
            RunCredentialKind::Mergecheck => "mergecheck",
            RunCredentialKind::Deploy => "deploy",
            RunCredentialKind::Bump => "bump",
        }
    }

    /// Whether the run works on one pull request, whose session and
    /// readiness it reports.
    fn works_on_a_pull(self) -> bool {
        matches!(
            self,
            RunCredentialKind::Implement
                | RunCredentialKind::Revise
                | RunCredentialKind::Answer
                | RunCredentialKind::Update
        )
    }
}

/// Which part of a sandbox a credential is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialUse {
    /// g1t's runner: cloning, pushing the result, recording the session.
    /// It acts as the person downstream, so that what it pushes and records
    /// is theirs, within the run's scope.
    Runner,
    /// The agent's own tools, over MCP. It acts as the agent.
    Tools,
}

impl CredentialUse {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialUse::Runner => "runner",
            CredentialUse::Tools => "tools",
        }
    }
}

/// A repository a run may push to, and the one branch, if only one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitGrant {
    pub repo: RepoPath,
    /// Null: any branch. A pull request's fork is its own repository, so
    /// the whole of it is the pull request's.
    #[serde(default)]
    pub branch: Option<String>,
}

/// What binds an agent's token to one run. Absent on agent tokens made
/// before run credentials, which keep working for the API only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBinding {
    pub kind: RunCredentialKind,
    #[serde(rename = "use")]
    pub usage: CredentialUse,
    /// The agent run, once the sandbox has recorded it.
    #[serde(default)]
    pub run_id: Option<String>,
    /// The pull request the run works on, for the kinds that work on one.
    #[serde(default)]
    pub number: Option<u32>,
    /// The agent's name, such as `g1t`.
    pub agent: String,
    /// Repositories it may clone and fetch, besides those it may push to.
    #[serde(default)]
    pub read: Vec<RepoPath>,
    /// Where it may push.
    #[serde(default)]
    pub push: Vec<GitGrant>,
    /// g1t's own run (a security update, an agent g1t put on one): the
    /// credential belongs to the workspace, and acts on behalf of g1t
    /// (`system::ID`), so what it does is g1t's, and the pull request g1t
    /// opened, and its working copy, are its own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub system: bool,
}

/// A person, by id and name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Principal {
    pub id: String,
    pub username: String,
}

impl From<&User> for Principal {
    fn from(user: &User) -> Self {
        Principal {
            id: user.id.clone(),
            username: user.username.clone(),
        }
    }
}

/// Set on a [`User`] resolved from an agent's token: the composite
/// identity, "g1t on behalf of syntaqx", and what it may do.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Acting {
    /// The token's id, as audit entries name it.
    pub credential_id: String,
    pub agent: String,
    pub on_behalf_of: Principal,
    pub scope: AgentScope,
}

impl Acting {
    pub fn run(&self) -> Option<&RunBinding> {
        self.scope.run.as_ref()
    }
}

/// `create_run_credential`: a token for one sandbox run. It acts as
/// `agent` on behalf of `on_behalf_of`, can do only what `kind` and `usage`
/// allow in `repo`, and expires after `ttl_seconds`, which should be the
/// run's timeout. Returns `CreatedAccessToken`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunCredentialArgs {
    pub on_behalf_of: User,
    pub repo: RepoPath,
    pub kind: RunCredentialKind,
    #[serde(rename = "use")]
    pub usage: CredentialUse,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub read: Vec<RepoPath>,
    #[serde(default)]
    pub push: Vec<GitGrant>,
    pub ttl_seconds: u64,
    /// Defaults to `g1t`.
    #[serde(default)]
    pub agent: Option<String>,
}

/// `bind_run_credentials`: ties tokens, named by the SHA-256 of their
/// text in hex, to the agent run their sandbox recorded. Returns how many.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRunCredentialsArgs {
    pub token_hashes: Vec<String>,
    pub run_id: String,
}

/// `revoke_run_credentials`: ends tokens when their sandbox stops, by hash
/// or by run. Only run credentials are touched, never a token a person
/// made. Returns how many.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeRunCredentialsArgs {
    #[serde(default)]
    pub token_hashes: Vec<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

// --- Policy --------------------------------------------------------------

/// Operations that only read.
pub const READ_OPERATIONS: &[&str] = &[
    "whoami",
    "get_usage",
    "get_budget",
    "get_ai_credit",
    "list_invoices",
    "get_billing_details",
    "list_repos",
    "get_repo",
    "list_projects",
    "get_project",
    "list_deleted_repos",
    "list_collaborators",
    "get_collaborator_permission",
    "list_repo_invitations",
    "list_my_repo_invitations",
    "list_outside_collaborators",
    "list_teams",
    "get_team",
    "list_team_members",
    "list_child_teams",
    "list_team_repos",
    "list_user_teams",
    "get_codeowners_errors",
    "get_repo_settings",
    "list_check_names",
    "get_merge_queue",
    "recall",
    "list_issues",
    "get_issue",
    "get_plan",
    "list_labels",
    "list_issue_labels",
    "list_milestones",
    "get_milestone",
    "list_pull_requests",
    "get_pull_request",
    "read_session",
    "get_pull_request_changes",
    "list_events",
    "get_context",
    "search_context",
    "get_entity",
    "search",
    "list_workflows",
    "list_workflow_runs",
    "get_workflow_run",
    "get_job_logs",
    "get_pending_deployments",
    "get_workflow_permissions",
    "get_fork_pr_approval",
    "list_commit_statuses",
    "get_combined_status",
    "list_check_runs_for_ref",
    "get_check_run",
    "list_check_run_annotations",
    "list_check_suites_for_ref",
    "get_check_suite",
    "list_integrations",
    "get_model_routes",
    "list_webhooks",
    "list_webhook_deliveries",
    "list_actions_secrets",
    "list_actions_variables",
    "list_security_alerts",
    "list_secret_scanning_alerts",
    "get_secret_scanning_alert",
    "list_secret_scanning_locations",
    "list_bypass_requests",
    "list_custom_patterns",
    "list_code_scanning_alerts",
    "get_code_scanning_alert",
    "list_code_scanning_analyses",
    "get_sarif_upload",
    "list_vulnerability_alerts",
    "get_vulnerability_alert",
    "get_dependency_graph",
    "get_sbom",
    "compare_dependencies",
    "get_security_settings",
    "get_workspace_security_settings",
    "get_security_overview",
    "list_notifications",
    "get_notification_thread",
    "get_thread_subscription",
    "get_repo_subscription",
    "list_watched_repos",
    "list_pinned_projects",
];

/// What no agent's token may ever do, whatever its scope says: workspaces,
/// repositories' settings, members, tokens, billing, integrations,
/// webhooks, secrets, workflows' controls, merging, and putting more agents
/// to work.
pub const NEVER: &[&str] = &[
    // Billing is people's: agents never spend or change it.
    "set_budget",
    "buy_ai_credit",
    "create_workspace",
    "delete_workspace",
    "update_workspace",
    // So is who belongs to a workspace and who owns it.
    "list_members",
    "update_member",
    "remove_member",
    "transfer_ownership",
    "leave_workspace",
    "transfer_repo",
    "create_repo",
    "update_repo",
    "update_project",
    "delete_repo",
    "list_deleted_repos",
    "restore_repo",
    "purge_repo",
    "rename_repo",
    "archive_repo",
    "unarchive_repo",
    "set_repo_visibility",
    "rename_branch",
    "update_repo_settings",
    "merge_pull_request",
    "assign_issue",
    "plan_work",
    "apply_plan",
    "import_issue",
    "list_integrations",
    "connect_integration",
    "update_integration",
    "disconnect_integration",
    "test_integration",
    "get_model_routes",
    "set_model_routes",
    "list_webhooks",
    "create_webhook",
    "update_webhook",
    "delete_webhook",
    "ping_webhook",
    "list_webhook_deliveries",
    "redeliver_webhook",
    "dispatch_workflow",
    "cancel_workflow_run",
    "rerun_workflow_run",
    "update_workflow",
    // Nor lets runs or deployments through, or changes what holds them.
    "approve_workflow_run",
    "review_pending_deployments",
    "update_environment",
    "delete_environment",
    "set_workflow_permissions",
    "set_fork_pr_approval",
    "create_repository_dispatch",
    "set_workspace_workflow_permissions",
    // An agent never reports checks on its own work, nor asks for them
    // to run again: what checks say is the integrations' to say.
    "create_commit_status",
    "create_check_run",
    "update_check_run",
    "rerequest_check_run",
    "rerequest_check_suite",
    "list_actions_secrets",
    "set_actions_secret",
    "delete_actions_secret",
    "list_actions_variables",
    "set_actions_variable",
    "delete_actions_variable",
    "list_collaborators",
    "get_collaborator_permission",
    "add_collaborator",
    "update_collaborator",
    "remove_collaborator",
    "list_repo_invitations",
    "revoke_repo_invitation",
    "list_my_repo_invitations",
    "accept_repo_invitation",
    "decline_repo_invitation",
    "set_base_permission",
    "list_outside_collaborators",
    // Deploy keys, which let a machine into a repository.
    "list_deploy_keys",
    "get_deploy_key",
    "create_deploy_key",
    "delete_deploy_key",
    // Teams: who is in which, and what they reach, is for people.
    "create_team",
    "update_team",
    "delete_team",
    "set_team_member",
    "remove_team_member",
    "set_team_repo",
    "remove_team_repo",
    "set_team_review_assignment",
    // Dismissing a secret lets it through push protection.
    "dismiss_security_alert",
    "reopen_security_alert",
    // Nor any other decision about security: closing or reopening an
    // alert, pushing past push protection or deciding who may, changing
    // what is looked for or when checks fail, or putting more agents to
    // work. An agent fixes what it finds in its own pull request.
    "update_secret_scanning_alert",
    "bypass_push_protection",
    "review_bypass_request",
    "create_custom_pattern",
    "update_custom_pattern",
    "delete_custom_pattern",
    "update_code_scanning_alert",
    "update_vulnerability_alert",
    "fix_security_alert",
    "update_security_settings",
    "update_workspace_security_settings",
    // A person's own inbox: g1t's agents act as g1t, which has none.
    "list_notifications",
    "get_notification_thread",
    "mark_notifications_read",
    "mark_thread_read",
    "mark_thread_done",
    "save_thread",
    "snooze_thread",
    "get_thread_subscription",
    "set_thread_subscription",
    "delete_thread_subscription",
    "get_repo_subscription",
    "set_repo_subscription",
    "delete_repo_subscription",
    "list_watched_repos",
    // Pins are a person's own, as the inbox is.
    "list_pinned_projects",
    "pin_project",
    "unpin_project",
    "reorder_pinned_projects",
];

/// Reading what an agent needs to know about its repository.
const TOOLS_READ: &[&str] = &[
    "get_repo",
    "list_issues",
    "get_issue",
    "list_labels",
    "list_issue_labels",
    "list_milestones",
    "get_milestone",
    "list_pull_requests",
    "get_pull_request",
    "get_pull_request_changes",
    "read_session",
    "get_merge_queue",
    "list_events",
    "recall",
    "search_context",
    "get_entity",
    "search",
    "list_workflows",
    "list_workflow_runs",
    "get_workflow_run",
    "get_job_logs",
    "get_pending_deployments",
    "get_workflow_permissions",
    "get_fork_pr_approval",
    "list_commit_statuses",
    "get_combined_status",
    "list_check_runs_for_ref",
    "get_check_run",
    "list_check_run_annotations",
    "list_check_suites_for_ref",
    "get_check_suite",
];

pub fn is_read(operation: &str) -> bool {
    READ_OPERATIONS.contains(&operation)
}

/// The API and MCP operations a run of `kind` may use with a credential
/// for `usage`. Git is separate: see [`decide_git`].
pub fn operations_for(kind: RunCredentialKind, usage: CredentialUse) -> Vec<&'static str> {
    use RunCredentialKind as K;
    let mut operations: Vec<&'static str> = Vec::new();
    match usage {
        CredentialUse::Runner => {
            if kind.works_on_a_pull() {
                operations.extend(["get_repo", "get_pull_request", "record_session"]);
            }
            if kind == K::Implement {
                operations.push("mark_pull_request_ready");
            }
        }
        CredentialUse::Tools => match kind {
            K::Implement | K::Revise | K::Answer => {
                operations.extend(TOOLS_READ.iter().copied());
                operations.extend([
                    "create_issue",
                    "add_comment",
                    "take_messages",
                    "remember",
                    "message_agent",
                    "answer_message",
                    "get_context",
                ]);
            }
            K::Review => {
                operations.extend(TOOLS_READ.iter().copied());
                operations.extend(["add_comment", "review_pull_request", "get_context"]);
            }
            K::Plan => {
                operations.extend(TOOLS_READ.iter().copied());
                operations.extend(["create_issue", "get_context"]);
            }
            K::Update => operations.extend(TOOLS_READ.iter().copied()),
            K::Checks | K::Queue | K::Mergecheck | K::Deploy | K::Bump => {}
        },
    }
    operations
}

/// What a run's credential may do, in the scope vocabulary that access
/// tokens use (see [`crate::scopes`]): the scopes of its operations, and
/// for a runner, git's. Its operations, its repository and its run still
/// bound it more tightly than these scopes say.
pub fn run_scopes(kind: RunCredentialKind, usage: CredentialUse) -> Vec<crate::scopes::Scope> {
    use crate::scopes::{Scope, normalize, scope_for};
    let mut scopes: Vec<Scope> = operations_for(kind, usage)
        .into_iter()
        .filter_map(scope_for)
        .collect();
    if usage == CredentialUse::Runner {
        scopes.push(Scope::CodeRead);
        if matches!(
            kind,
            RunCredentialKind::Implement
                | RunCredentialKind::Revise
                | RunCredentialKind::Answer
                | RunCredentialKind::Update
                | RunCredentialKind::Bump
        ) {
            scopes.push(Scope::CodeWrite);
        }
    }
    normalize(&mut scopes);
    scopes
}

/// Operations that change a pull request, which a runner may do only to
/// the pull request its run works on.
const PULL_WRITES: &[&str] = &["record_session", "mark_pull_request_ready"];

/// Whether something was allowed, and the rule that decided it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub allowed: bool,
    /// A short, stable name: `run:implement/tools`, `never`,
    /// `scope:repository` and so on. Shown in the audit log.
    pub rule: String,
    /// Why it was refused, for the caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Decision {
    pub fn allow(rule: impl Into<String>) -> Self {
        Decision {
            allowed: true,
            rule: rule.into(),
            reason: None,
        }
    }

    pub fn deny(rule: impl Into<String>, reason: impl Into<String>) -> Self {
        Decision {
            allowed: false,
            rule: rule.into(),
            reason: Some(reason.into()),
        }
    }
}

fn same_repo(a: &RepoPath, b: &RepoPath) -> bool {
    a.namespace.eq_ignore_ascii_case(&b.namespace) && a.name.eq_ignore_ascii_case(&b.name)
}

fn scope_rule(scope: &AgentScope) -> String {
    match &scope.run {
        Some(run) => format!("run:{}/{}", run.kind.as_str(), run.usage.as_str()),
        None => "agent-token".to_owned(),
    }
}

/// Whether `user`, resolved from an agent's token with `scope`, may use
/// `operation`. `repo` is the repository the call names, if any, and
/// `needs_repo` whether the operation is about one; `number` the issue or
/// pull request it names.
pub fn decide_operation(
    user: &User,
    scope: &AgentScope,
    operation: &str,
    repo: Option<&RepoPath>,
    needs_repo: bool,
    number: Option<u32>,
) -> Decision {
    let who = "A g1t agent's token";
    if NEVER.contains(&operation) {
        return Decision::deny(
            "never",
            format!(
                "{who} can never use {operation}: settings, members, tokens, billing, integrations, webhooks, secrets and merging are for people."
            ),
        );
    }
    if !scope.operations.iter().any(|name| name == operation) {
        return Decision::deny(
            "scope:operation",
            format!("{who} for this run cannot use {operation}."),
        );
    }
    if needs_repo && !repo.is_some_and(|asked| same_repo(asked, &scope.repo)) {
        return Decision::deny(
            "scope:repository",
            format!(
                "{who} works in {}/{} only.",
                scope.repo.namespace, scope.repo.name
            ),
        );
    }
    // The intersection: the person it acts for must still be able to work
    // in the repository's workspace, as a member or with a role on its
    // repositories. What it may do in the repository itself is their
    // role there, which services check (`access::can`).
    if !crate::access::has_access_in(user, &scope.repo.namespace) {
        return Decision::deny(
            "on-behalf-of:membership",
            format!(
                "The person this agent works for is no longer a member of {}.",
                scope.repo.namespace
            ),
        );
    }
    if let Some(run) = &scope.run
        && run.usage == CredentialUse::Runner
        && PULL_WRITES.contains(&operation)
        && run.number.is_some()
        && number != run.number
    {
        return Decision::deny(
            "scope:pull",
            format!(
                "{who} can change pull request #{} only.",
                run.number.unwrap_or_default()
            ),
        );
    }
    Decision::allow(scope_rule(scope))
}

/// Whether a run credential may clone or fetch (`write` false), or push to
/// (`write` true), the repository at `repo`.
pub fn decide_git(scope: &AgentScope, repo: &RepoPath, write: bool) -> Decision {
    let Some(run) = scope
        .run
        .as_ref()
        .filter(|run| run.usage == CredentialUse::Runner)
    else {
        return Decision::deny(
            "git:not-a-run",
            "A g1t agent's tools token cannot be used with git.",
        );
    };
    let pushable = run.push.iter().any(|grant| same_repo(&grant.repo, repo));
    if write {
        return if pushable {
            Decision::allow(format!("{}:push", scope_rule(scope)))
        } else {
            Decision::deny(
                "git:push",
                format!(
                    "A {} run cannot push to {}/{}.",
                    run.kind.as_str(),
                    repo.namespace,
                    repo.name
                ),
            )
        };
    }
    let readable = pushable
        || same_repo(&scope.repo, repo)
        || run.read.iter().any(|path| same_repo(path, repo));
    if readable {
        Decision::allow(format!("{}:read", scope_rule(scope)))
    } else {
        Decision::deny(
            "git:read",
            format!(
                "A {} run cannot read {}/{}.",
                run.kind.as_str(),
                repo.namespace,
                repo.name
            ),
        )
    }
}

/// Whether a push to `repo` is limited to certain branches, so that the
/// refs it moves have to be read and checked with [`decide_refs`].
pub fn limits_branches(scope: &AgentScope, repo: &RepoPath) -> bool {
    scope
        .run
        .iter()
        .flat_map(|run| run.push.iter())
        .any(|grant| same_repo(&grant.repo, repo) && grant.branch.is_some())
}

/// Whether a push to `repo` may move `refs` (full refs, such as
/// `refs/heads/main`). Tags are never a run's to move.
pub fn decide_refs(scope: &AgentScope, repo: &RepoPath, refs: &[String]) -> Decision {
    let repo_decision = decide_git(scope, repo, true);
    if !repo_decision.allowed {
        return repo_decision;
    }
    let grants: Vec<&GitGrant> = scope
        .run
        .iter()
        .flat_map(|run| run.push.iter())
        .filter(|grant| same_repo(&grant.repo, repo))
        .collect();
    for git_ref in refs {
        let Some(branch) = git_ref.strip_prefix("refs/heads/") else {
            return Decision::deny("git:ref", format!("A run cannot push {git_ref}."));
        };
        let allowed = grants
            .iter()
            .any(|grant| grant.branch.as_deref().is_none_or(|only| only == branch));
        if !allowed {
            return Decision::deny(
                "git:ref",
                format!(
                    "A run cannot push to {branch} in {}/{}.",
                    repo.namespace, repo.name
                ),
            );
        }
    }
    repo_decision
}

/// The most an agent may be on a repository, whoever it works for: it
/// can push, merge and run, never change settings or who has access.
pub const AGENT_CEILING: RepoRole = RepoRole::Write;

/// The memberships an agent working for `person` has: the run's
/// workspace, as a member, only if the person is in it now, with the
/// person's role on its repositories (an owner's Admin included) cut down
/// to [`AGENT_CEILING`].
pub fn intersect(person: &[Membership], namespace: &str) -> Vec<Membership> {
    let namespace = namespace.to_lowercase();
    person
        .iter()
        .filter(|membership| membership.slug == namespace)
        .map(|membership| {
            let base = match membership.role {
                Role::Owner => BasePermission::Admin,
                Role::Member => membership.base_permission.unwrap_or_default(),
            };
            Membership {
                role: Role::Member,
                base_permission: Some(match base {
                    BasePermission::Admin => BasePermission::Write,
                    base => base,
                }),
                // Billing and security manager are the person's, never
                // their agent's.
                org_roles: Vec::new(),
                ..membership.clone()
            }
        })
        .collect()
}

/// The repository grants an agent working for `person` has: those in the
/// run's workspace, each cut down to [`AGENT_CEILING`].
pub fn intersect_grants(person: &[RepoGrant], namespace: &str) -> Vec<RepoGrant> {
    let namespace = namespace.to_lowercase();
    person
        .iter()
        .filter(|grant| grant.workspace == namespace)
        .map(|grant| RepoGrant {
            role: grant.role.min(AGENT_CEILING),
            ..grant.clone()
        })
        .collect()
}

/// Who a runner's credential acts as downstream: the person, with only the
/// agent's (already intersected) memberships. `None` for anything else.
pub fn as_person(user: &User) -> Option<User> {
    let acting = user.acting.as_ref()?;
    if user.kind != PrincipalKind::Agent {
        return None;
    }
    let run = acting.run()?;
    if run.usage != CredentialUse::Runner {
        return None;
    }
    Some(User {
        id: acting.on_behalf_of.id.clone(),
        username: acting.on_behalf_of.username.clone(),
        kind: PrincipalKind::User,
        verified: user.verified,
        workspaces: user.workspaces.clone(),
        avatar: None,
        acting: None,
        grants: user.grants.clone(),
        token: None,
        held: Vec::new(),
    })
}

/// How an actor is described: "g1t on behalf of syntaqx".
pub fn describe(user: &User) -> String {
    match &user.acting {
        Some(acting) => format!(
            "{} on behalf of {}",
            acting.agent, acting.on_behalf_of.username
        ),
        None => user.username.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_s_scopes_are_never_admin() {
        for kind in RunCredentialKind::ALL {
            for usage in [CredentialUse::Runner, CredentialUse::Tools] {
                let scopes = run_scopes(kind, usage);
                assert!(scopes.iter().all(|scope| !scope.dangerous()), "{kind:?} {usage:?}: {scopes:?}");
            }
        }
        let review = run_scopes(RunCredentialKind::Review, CredentialUse::Tools);
        assert!(review.contains(&crate::scopes::Scope::PullRequestsWrite));
        assert!(!review.contains(&crate::scopes::Scope::CodeWrite));
    }

    #[test]
    fn agents_can_search_the_context_hub() {
        for kind in [RunCredentialKind::Implement, RunCredentialKind::Review, RunCredentialKind::Plan] {
            let tools = operations_for(kind, CredentialUse::Tools);
            assert!(tools.contains(&"search_context") && tools.contains(&"get_entity"));
        }
        assert!(is_read("search_context") && is_read("get_entity"));
    }

    #[test]
    fn agents_can_search_all_of_g1t() {
        // Site-wide search only reads: every run that reads its repository
        // may use it, and nothing that never reads gets it.
        assert!(is_read("search"));
        assert!(!NEVER.contains(&"search"));
        for kind in [
            RunCredentialKind::Implement,
            RunCredentialKind::Revise,
            RunCredentialKind::Answer,
            RunCredentialKind::Review,
            RunCredentialKind::Plan,
            RunCredentialKind::Update,
        ] {
            let tools = operations_for(kind, CredentialUse::Tools);
            assert!(tools.contains(&"search"), "{kind:?} should search");
            // The context hub's search stays its own tool beside it.
            assert!(tools.contains(&"search_context"), "{kind:?} keeps search_context");
        }
        for kind in [RunCredentialKind::Checks, RunCredentialKind::Queue, RunCredentialKind::Mergecheck, RunCredentialKind::Deploy, RunCredentialKind::Bump] {
            assert!(!operations_for(kind, CredentialUse::Tools).contains(&"search"));
        }
        assert!(!operations_for(RunCredentialKind::Implement, CredentialUse::Runner).contains(&"search"));
    }

    fn path(namespace: &str, name: &str) -> RepoPath {
        RepoPath {
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        }
    }

    fn scope(kind: RunCredentialKind, usage: CredentialUse) -> AgentScope {
        AgentScope {
            repo: path("acme", "rocket"),
            operations: operations_for(kind, usage)
                .into_iter()
                .map(str::to_owned)
                .collect(),
            run: Some(RunBinding {
                kind,
                usage,
                run_id: Some("run_1".to_owned()),
                number: Some(7),
                agent: "g1t".to_owned(),
                system: false,
                read: vec![path("acme", "rocket")],
                push: match kind {
                    RunCredentialKind::Implement
                    | RunCredentialKind::Revise
                    | RunCredentialKind::Answer => vec![GitGrant {
                        repo: path("pulls", "pul_7"),
                        branch: None,
                    }],
                    RunCredentialKind::Update => vec![GitGrant {
                        repo: path("acme", "rocket"),
                        branch: Some("fix-login".to_owned()),
                    }],
                    _ => vec![],
                },
            }),
        }
    }

    fn agent(member_of: &[&str], scope: AgentScope) -> User {
        User {
            id: "usr_g1t_agent".to_owned(),
            username: "g1t".to_owned(),
            kind: PrincipalKind::Agent,
            verified: true,
            workspaces: member_of
                .iter()
                .map(|slug| Membership::member(*slug))
                .collect(),
            avatar: None,
            grants: Vec::new(),
            token: None,
            held: Vec::new(),
            acting: Some(Box::new(Acting {
                credential_id: "tok_1".to_owned(),
                agent: "g1t".to_owned(),
                on_behalf_of: Principal {
                    id: "usr_1".to_owned(),
                    username: "syntaqx".to_owned(),
                },
                scope,
            })),
        }
    }

    fn op(kind: RunCredentialKind, usage: CredentialUse, operation: &str) -> Decision {
        let scope = scope(kind, usage);
        let user = agent(&["acme"], scope.clone());
        decide_operation(
            &user,
            &scope,
            operation,
            Some(&path("acme", "rocket")),
            true,
            Some(7),
        )
    }

    use CredentialUse::{Runner, Tools};
    use RunCredentialKind as K;

    /// Which operations each kind of run may use through its tools: the
    /// allowed and denied matrix.
    #[test]
    fn tools_matrix() {
        let cases: [(&str, [bool; 6]); 12] = [
            //                       implement revise answer review plan checks
            ("get_issue", [true, true, true, true, true, false]),
            ("create_issue", [true, true, true, false, true, false]),
            ("add_comment", [true, true, true, true, false, false]),
            (
                "review_pull_request",
                [false, false, false, true, false, false],
            ),
            ("remember", [true, true, true, false, false, false]),
            ("take_messages", [true, true, true, false, false, false]),
            ("record_session", [false, false, false, false, false, false]),
            (
                "merge_pull_request",
                [false, false, false, false, false, false],
            ),
            (
                "update_repo_settings",
                [false, false, false, false, false, false],
            ),
            ("create_webhook", [false, false, false, false, false, false]),
            (
                "set_actions_secret",
                [false, false, false, false, false, false],
            ),
            ("assign_issue", [false, false, false, false, false, false]),
        ];
        let kinds = [
            K::Implement,
            K::Revise,
            K::Answer,
            K::Review,
            K::Plan,
            K::Checks,
        ];
        for (operation, expected) in cases {
            for (kind, allowed) in kinds.into_iter().zip(expected) {
                assert_eq!(
                    op(kind, Tools, operation).allowed,
                    allowed,
                    "{operation} by a {} run's tools",
                    kind.as_str()
                );
            }
        }
    }

    #[test]
    fn runner_matrix() {
        assert!(op(K::Implement, Runner, "record_session").allowed);
        assert!(op(K::Implement, Runner, "mark_pull_request_ready").allowed);
        assert!(op(K::Revise, Runner, "record_session").allowed);
        assert!(!op(K::Revise, Runner, "mark_pull_request_ready").allowed);
        assert!(!op(K::Implement, Runner, "create_issue").allowed);
        assert!(!op(K::Review, Runner, "record_session").allowed);
        assert!(!op(K::Checks, Runner, "get_issue").allowed);
    }

    #[test]
    fn settings_billing_tokens_and_members_are_never_reachable() {
        for kind in RunCredentialKind::ALL {
            for usage in [Runner, Tools] {
                for operation in NEVER.iter().copied() {
                    let decision = op(kind, usage, operation);
                    assert!(!decision.allowed);
                    assert_eq!(decision.rule, "never");
                }
            }
        }
        // Even a scope that lists one is refused.
        let mut wide = scope(K::Implement, Tools);
        wide.operations.push("merge_pull_request".to_owned());
        let user = agent(&["acme"], wide.clone());
        let decision = decide_operation(
            &user,
            &wide,
            "merge_pull_request",
            Some(&path("acme", "rocket")),
            true,
            Some(7),
        );
        assert_eq!(decision.rule, "never");
    }

    #[test]
    fn another_repository_is_refused() {
        let scope = scope(K::Implement, Tools);
        let user = agent(&["acme"], scope.clone());
        let decision = decide_operation(
            &user,
            &scope,
            "create_issue",
            Some(&path("acme", "other")),
            true,
            None,
        );
        assert!(!decision.allowed);
        assert_eq!(decision.rule, "scope:repository");
        let decision = decide_operation(&user, &scope, "create_issue", None, true, None);
        assert_eq!(decision.rule, "scope:repository");
        // The repository's name is matched without regard to case.
        let decision = decide_operation(
            &user,
            &scope,
            "create_issue",
            Some(&path("Acme", "Rocket")),
            true,
            None,
        );
        assert!(decision.allowed);
        assert_eq!(decision.rule, "run:implement/tools");
    }

    #[test]
    fn the_permission_is_the_intersection_with_the_person() {
        let scope = scope(K::Implement, Tools);
        // The person left the workspace: their agent can do nothing there.
        let user = agent(&[], scope.clone());
        let decision = decide_operation(
            &user,
            &scope,
            "get_issue",
            Some(&path("acme", "rocket")),
            true,
            Some(1),
        );
        assert!(!decision.allowed);
        assert_eq!(decision.rule, "on-behalf-of:membership");
        // And an owner's agent is only ever a member.
        let owner = vec![
            Membership {
                slug: "acme".to_owned(),
                role: Role::Owner,
                name: None,
                avatar: None,
                base_permission: Some(BasePermission::None),
                team_creation: None,
                org_roles: vec![crate::OrgRole::SecurityManager],
                privileges: None,
            },
            Membership::member("elsewhere"),
        ];
        let memberships = intersect(&owner, "Acme");
        assert_eq!(memberships.len(), 1);
        assert_eq!(memberships[0].slug, "acme");
        assert_eq!(memberships[0].role, Role::Member);
        assert!(memberships[0].org_roles.is_empty());
        assert!(intersect(&owner, "nowhere").is_empty());
    }

    /// An agent gets at most the person's role on the repository, and
    /// never more than Write; nothing outside the run's workspace.
    #[test]
    fn an_agent_has_at_most_its_persons_role() {
        use crate::access::{Capability, RepoRef, can, permission};
        let rocket = RepoRef { id: "rep_1", namespace: "acme", private: true };
        let other = RepoRef { id: "rep_2", namespace: "acme", private: true };
        let elsewhere = RepoRef { id: "rep_3", namespace: "globex", private: true };
        let tools = scope(K::Implement, Tools);
        let scope = scope(K::Implement, Runner);
        // An owner's agent: Write, never Admin.
        let owner = [Membership { role: Role::Owner, ..Membership::member("acme") }, Membership::member("globex")];
        let mut agent_user = agent(&[], scope.clone());
        agent_user.workspaces = intersect(&owner, "acme");
        assert_eq!(permission(Some(&agent_user), rocket), Some(RepoRole::Write));
        assert!(!can(Some(&agent_user), rocket, Capability::ManageSettings));
        assert_eq!(permission(Some(&agent_user), elsewhere), None);
        // A member whose workspace gives Read: Read, so it cannot push.
        let reader = [Membership { base_permission: Some(BasePermission::Read), ..Membership::member("acme") }];
        agent_user.workspaces = intersect(&reader, "acme");
        assert_eq!(permission(Some(&agent_user), rocket), Some(RepoRole::Read));
        assert!(!can(Some(&agent_user), rocket, Capability::Push));
        // An outside collaborator with Maintain on one repository: Write
        // there, nothing elsewhere, and the run is allowed.
        let grants = [
            RepoGrant { repo_id: "rep_1".into(), workspace: "acme".into(), role: RepoRole::Maintain, team: None },
            RepoGrant { repo_id: "rep_3".into(), workspace: "globex".into(), role: RepoRole::Admin, team: None },
        ];
        agent_user.workspaces = intersect(&[], "acme");
        agent_user.grants = intersect_grants(&grants, "Acme");
        assert_eq!(permission(Some(&agent_user), rocket), Some(RepoRole::Write));
        assert_eq!(permission(Some(&agent_user), other), None);
        assert_eq!(permission(Some(&agent_user), elsewhere), None);
        let decision = decide_operation(&agent_user, &tools, "get_issue", Some(&path("acme", "rocket")), true, Some(1));
        assert!(decision.allowed, "{}", decision.reason.unwrap_or_default());
        // The person, downstream of a runner's credential, carries the same.
        let person = as_person(&agent_user).expect("a runner acts as the person");
        assert_eq!(permission(Some(&person), rocket), Some(RepoRole::Write));
    }

    #[test]
    fn a_runner_changes_only_its_own_pull_request() {
        let scope = scope(K::Implement, Runner);
        let user = agent(&["acme"], scope.clone());
        let repo = path("acme", "rocket");
        let other = decide_operation(&user, &scope, "record_session", Some(&repo), true, Some(8));
        assert!(!other.allowed);
        assert_eq!(other.rule, "scope:pull");
        let own = decide_operation(&user, &scope, "record_session", Some(&repo), true, Some(7));
        assert!(own.allowed);
        // Reading another is fine.
        assert!(
            decide_operation(
                &user,
                &scope,
                "get_pull_request",
                Some(&repo),
                true,
                Some(8)
            )
            .allowed
        );
    }

    #[test]
    fn git_matrix() {
        let fork = path("pulls", "pul_7");
        let upstream = path("acme", "rocket");
        let elsewhere = path("acme", "billing");
        let implement = scope(K::Implement, Runner);
        assert!(decide_git(&implement, &fork, true).allowed);
        assert!(decide_git(&implement, &fork, false).allowed);
        assert!(decide_git(&implement, &upstream, false).allowed);
        assert_eq!(decide_git(&implement, &upstream, true).rule, "git:push");
        assert_eq!(decide_git(&implement, &elsewhere, false).rule, "git:read");
        let review = scope(K::Review, Runner);
        assert!(decide_git(&review, &upstream, false).allowed);
        assert!(!decide_git(&review, &upstream, true).allowed);
        assert!(!decide_git(&review, &fork, true).allowed);
        // A tools token made before run credentials never reaches git.
        let old = AgentScope {
            repo: upstream.clone(),
            operations: vec!["get_issue".to_owned()],
            run: None,
        };
        assert_eq!(decide_git(&old, &upstream, false).rule, "git:not-a-run");
        // Nor does an agent's tools token.
        assert_eq!(
            decide_git(&scope(K::Implement, Tools), &upstream, false).rule,
            "git:not-a-run"
        );
    }

    #[test]
    fn a_push_moves_only_granted_branches() {
        let update = scope(K::Update, Runner);
        let repo = path("acme", "rocket");
        let refs = |names: &[&str]| {
            names
                .iter()
                .map(|name| (*name).to_owned())
                .collect::<Vec<_>>()
        };
        assert!(decide_refs(&update, &repo, &refs(&["refs/heads/fix-login"])).allowed);
        assert_eq!(
            decide_refs(&update, &repo, &refs(&["refs/heads/main"])).rule,
            "git:ref"
        );
        assert_eq!(
            decide_refs(
                &update,
                &repo,
                &refs(&["refs/heads/fix-login", "refs/tags/v1"])
            )
            .rule,
            "git:ref"
        );
        let implement = scope(K::Implement, Runner);
        assert!(
            decide_refs(
                &implement,
                &path("pulls", "pul_7"),
                &refs(&["refs/heads/main"])
            )
            .allowed
        );
    }

    #[test]
    fn a_runner_acts_downstream_as_the_person() {
        let user = agent(&["acme"], scope(K::Implement, Runner));
        let person = as_person(&user).unwrap();
        assert_eq!(person.id, "usr_1");
        assert_eq!(person.username, "syntaqx");
        assert_eq!(person.kind, PrincipalKind::User);
        assert!(person.is_member("acme"));
        assert!(person.acting.is_none());
        assert_eq!(describe(&user), "g1t on behalf of syntaqx");
        // The tools act as the agent.
        assert!(as_person(&agent(&["acme"], scope(K::Implement, Tools))).is_none());
    }

    #[test]
    fn scopes_without_a_run_still_parse() {
        let old: AgentScope = serde_json::from_str(
            r#"{"repo":{"namespace":"acme","name":"rocket"},"operations":["get_issue"]}"#,
        )
        .unwrap();
        assert!(old.run.is_none());
        let written = serde_json::to_string(&scope(K::Review, Tools)).unwrap();
        assert!(written.contains(r#""use":"tools""#));
        assert!(written.contains(r#""kind":"review""#));
        let back: AgentScope = serde_json::from_str(&written).unwrap();
        assert_eq!(back.run.unwrap().kind, K::Review);
        // Only g1t's own runs say so; every other reads as not.
        assert!(!written.contains("system"));
        assert!(!back_run(&written).system);
        let mut own = scope(K::Bump, Runner);
        own.run.as_mut().unwrap().system = true;
        let written = serde_json::to_string(&own).unwrap();
        assert!(written.contains(r#""system":true"#));
        assert!(back_run(&written).system);
    }

    fn back_run(written: &str) -> RunBinding {
        serde_json::from_str::<AgentScope>(written).unwrap().run.unwrap()
    }
}
