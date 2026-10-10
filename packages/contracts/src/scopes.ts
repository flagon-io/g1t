/**
 * Scopes: what an access token may do on its owner's behalf. Mirrors
 * `crates/contracts/src/scopes.rs`, which is the source of truth; a Rust
 * test keeps the tables here the same.
 *
 * A token's permissions are its scopes read per resource: each resource
 * at none or one level, such as issues: write. What a request may do is
 * the intersection of the owner's role, the token's reach (the workspace
 * it is made for, and its repositories) and its permissions.
 */

export type ScopeResource =
  | "repo"
  | "code"
  | "security"
  | "packages"
  | "issues"
  | "pull_requests"
  | "agents"
  | "workflows"
  | "workflow_files"
  | "checks"
  | "deployments"
  | "memory"
  | "account"
  | "notifications"
  | "workspace"
  | "billing"
  | "access"
  | "webhooks"
  | "secrets"
  | "runners"
  | "models"
  | "artifacts";

export type ScopeLevel = "read" | "write" | "run" | "delete" | "admin";

/** Every scope, grouped by resource, least first. */
export const SCOPES = [
  { scope: "repo:read", description: "See repositories, their settings, labels, timelines, releases, languages, contributors and security alerts, and search" },
  { scope: "repo:write", description: "Create repositories, rename branches, change how pull requests merge and publish releases" },
  { scope: "repo:admin", description: "Rename, archive, transfer, delete or change who can see a repository, change its rulesets, and dismiss security alerts" },
  { scope: "code:read", description: "Clone and fetch private repositories with git" },
  { scope: "code:write", description: "Push commits with git" },
  { scope: "security:read", description: "See secret scanning, code scanning and vulnerability alerts, custom patterns, the dependency graph and SBOM, and security settings" },
  { scope: "security:write", description: "Dismiss and reopen alerts, bypass push protection, review bypass requests, manage custom patterns, upload SARIF and change security settings" },
  { scope: "packages:read", description: "Pull container images and install private packages" },
  { scope: "packages:write", description: "Push container images and publish packages" },
  { scope: "packages:delete", description: "Delete and restore packages and their versions" },
  { scope: "issues:read", description: "Read issues, comments and plans" },
  { scope: "issues:write", description: "Open, edit, close and comment on issues" },
  { scope: "pull_requests:read", description: "Read pull requests, their changes, sessions and merge queues" },
  { scope: "pull_requests:write", description: "Open, review, close and merge pull requests" },
  { scope: "agents:run", description: "Put g1t agents to work and message them, which uses the workspace's money" },
  { scope: "workflows:read", description: "Read workflows, runs and logs" },
  { scope: "workflows:write", description: "Run, cancel, rerun and turn workflows on or off" },
  { scope: "workflow_files:write", description: "Add, change and delete workflow files under .g1t/workflows and .github/workflows, with git or the API" },
  { scope: "checks:read", description: "Read commits' statuses, check runs, check suites and annotations" },
  { scope: "checks:write", description: "Report statuses and check runs on commits, and ask for checks to run again" },
  { scope: "deployments:read", description: "See deployments, their statuses and environments" },
  { scope: "deployments:write", description: "Report deployments and their statuses, from any CI" },
  { scope: "memory:read", description: "Recall memory and search the workspace's context" },
  { scope: "memory:write", description: "Save memory for the next agent" },
  { scope: "account:read", description: "Read your email addresses, invites, invitations, pinned projects and stars" },
  { scope: "account:write", description: "Change your email addresses, make invites, answer invitations, pin projects and star repositories" },
  { scope: "notifications:read", description: "See your inbox, its threads, and what you subscribe to and watch" },
  { scope: "notifications:write", description: "Mark notifications read, done, saved or snoozed, subscribe to threads and watch repositories" },
  { scope: "workspace:read", description: "Read workspace settings, invites, integrations, model routes, teams and rulesets" },
  { scope: "workspace:admin", description: "Create and delete workspaces, invite members, connect integrations, create, change and delete teams, and change the workspace's rulesets" },
  { scope: "billing:read", description: "See a workspace's usage, budget, AI credit and invoices" },
  { scope: "billing:write", description: "Change a workspace's budget and buy AI credit" },
  { scope: "access:read", description: "See who has access to repositories" },
  { scope: "access:admin", description: "Give and take away access to repositories, a team's included" },
  { scope: "webhooks:read", description: "See webhooks and their deliveries" },
  { scope: "webhooks:admin", description: "Create, change and delete webhooks" },
  { scope: "secrets:read", description: "List secrets (never their values) and read variables" },
  { scope: "secrets:admin", description: "Set and delete secrets and variables" },
  { scope: "runners:read", description: "See self-hosted runners, their groups and where agents run" },
  { scope: "runners:admin", description: "Register and remove self-hosted runners, change their groups and settings" },
  { scope: "models:read", description: "See the workspace's AI Gateway requests: their models, tokens, cost and status" },
  { scope: "models:write", description: "Send model requests through the AI Gateway, which uses the workspace's AI credit" },
  { scope: "artifacts:read", description: "List, read and search artifacts you can see, their versions, and the numbers their dashboards show" },
  { scope: "artifacts:write", description: "Create, rename, move, edit, trash and restore artifacts, and propose changes to them" },
  { scope: "artifacts:admin", description: "Share artifacts, change who can open them, and delete them for good" },
] as const;

/**
 * Scopes of resources being built that tokens are not offered yet (Rust:
 * `Resource::offered`). They parse in Rust and are typed here, but no
 * preset, full access, OAuth request or token form hands them out, and no
 * operation needs them. When one ships, its rows move to the end of
 * `SCOPES` and `SCOPE_RESOURCES`. Empty now: Artifacts shipped last.
 */
export const UPCOMING_SCOPES: readonly { scope: Scope; description: string }[] = [
] as const;

export type Scope = (typeof SCOPES)[number]["scope"];

/** Where a resource sits on the token form; only a person's token may hold account ones. */
export type ResourceGroup = "repository" | "workspace" | "account";

/** Resources in the order settings show them, with their names for people and their group. */
export const SCOPE_RESOURCES: { resource: ScopeResource; label: string; group: ResourceGroup }[] = [
  { resource: "repo", label: "Repositories", group: "repository" },
  { resource: "code", label: "Code", group: "repository" },
  { resource: "security", label: "Security", group: "repository" },
  { resource: "packages", label: "Packages", group: "repository" },
  { resource: "issues", label: "Issues", group: "repository" },
  { resource: "pull_requests", label: "Pull requests", group: "repository" },
  { resource: "agents", label: "g1t agents", group: "repository" },
  { resource: "workflows", label: "Workflows", group: "repository" },
  { resource: "workflow_files", label: "Workflow files", group: "repository" },
  { resource: "checks", label: "Checks and statuses", group: "repository" },
  { resource: "deployments", label: "Deployments", group: "repository" },
  { resource: "memory", label: "Memory and context", group: "repository" },
  { resource: "account", label: "Your account", group: "account" },
  { resource: "notifications", label: "Notifications", group: "account" },
  { resource: "workspace", label: "Workspaces", group: "workspace" },
  { resource: "billing", label: "Billing", group: "workspace" },
  { resource: "access", label: "Who has access", group: "repository" },
  { resource: "webhooks", label: "Webhooks", group: "repository" },
  { resource: "secrets", label: "Secrets and variables", group: "repository" },
  { resource: "runners", label: "Self-hosted runners", group: "workspace" },
  { resource: "models", label: "AI Gateway", group: "workspace" },
  { resource: "artifacts", label: "Artifacts", group: "workspace" },
];

/** Resources not offered yet, as `UPCOMING_SCOPES`: settings never show them. */
export const UPCOMING_RESOURCES: { resource: ScopeResource; label: string; group: ResourceGroup }[] = [
];

const LEVEL_ORDER: Record<ScopeLevel, number> = { read: 0, write: 1, run: 2, delete: 3, admin: 4 };

export function scopeResource(scope: Scope): ScopeResource {
  return scope.split(":")[0] as ScopeResource;
}

export function scopeLevel(scope: Scope): ScopeLevel {
  return scope.split(":")[1] as ScopeLevel;
}

export function isScope(text: string): text is Scope {
  return SCOPES.some((row) => row.scope === text);
}

/** Changes that are hard to undo, or decide who can reach what. */
export function isDangerous(scope: Scope): boolean {
  const level = scopeLevel(scope);
  return level === "admin" || level === "delete";
}

export function describeScope(scope: Scope): string {
  return [...SCOPES, ...UPCOMING_SCOPES].find((row) => row.scope === scope)?.description ?? scope;
}

/** Whether holding `held` gives `needed`: the same resource, at its level or lower. */
export function scopeIncludes(held: Scope, needed: Scope): boolean {
  return (
    scopeResource(held) === scopeResource(needed) &&
    LEVEL_ORDER[scopeLevel(held)] >= LEVEL_ORDER[scopeLevel(needed)]
  );
}

/** The levels a resource has, least first. */
export function levelsOf(resource: ScopeResource): ScopeLevel[] {
  return SCOPES.filter((row) => scopeResource(row.scope) === resource).map((row) => scopeLevel(row.scope));
}

/** The token form's groups, in order. */
export const RESOURCE_GROUPS: { group: ResourceGroup; label: string; about: string }[] = [
  { group: "repository", label: "Repository permissions", about: "What it may do in the repositories it reaches." },
  { group: "workspace", label: "Workspace permissions", about: "What it may do with the workspaces it reaches themselves." },
  { group: "account", label: "Account permissions", about: "What it may do with your own account. Personal tokens only." },
];

/** A token's permissions: each resource held, at its highest level; left out is none. */
export type Permissions = Partial<Record<ScopeResource, ScopeLevel>>;

/** Scopes as permissions. Null scopes (full access) are every resource at its highest. */
export function permissionsOf(scopes: readonly string[] | null): Permissions {
  const permissions: Permissions = {};
  const held = scopes === null ? SCOPES.map((row) => row.scope) : parseScopes(scopes.join(" "));
  for (const scope of held) {
    const resource = scopeResource(scope);
    const now = permissions[resource];
    if (!now || LEVEL_ORDER[scopeLevel(scope)] > LEVEL_ORDER[now]) permissions[resource] = scopeLevel(scope);
  }
  return permissions;
}

/** Permissions as the scopes a token stores: the highest of each resource, in table order. */
export function scopesOfPermissions(permissions: Permissions): Scope[] {
  const wanted = new Set(
    Object.entries(permissions)
      .filter(([, level]) => level)
      .map(([resource, level]) => `${resource}:${level}`),
  );
  return SCOPES.map((row) => row.scope).filter((scope) => wanted.has(scope));
}

/** The longest a token with an expiry may last, in days. */
export const MAX_TOKEN_LIFETIME_DAYS = 366;

/** The most repositories a token may select. */
export const MAX_SELECTED_REPOSITORIES = 50;

/** Scopes from text separated by spaces or commas, in table order; unknown ones are left out. */
export function parseScopes(text: string): Scope[] {
  const given = new Set(text.split(/[\s,]+/).map((part) => part.trim().toLowerCase()));
  return SCOPES.map((row) => row.scope).filter((scope) => given.has(scope));
}

/** What a token stores for full access. */
export const FULL_ACCESS = "*";

export type PresetId = "read_only" | "agent" | "ci" | "full";

/** Starting points for choosing scopes. `*` is full access. */
export const PRESET_SCOPES = {
  read_only: [
    "repo:read", "code:read", "security:read", "packages:read", "issues:read", "pull_requests:read", "workflows:read", "checks:read", "deployments:read", "memory:read", "account:read", "notifications:read", "workspace:read", "billing:read", "access:read", "webhooks:read", "secrets:read", "runners:read", "models:read", "artifacts:read",
  ] as const,
  agent: [
    "repo:read", "code:read", "code:write", "security:read", "packages:read", "issues:read", "issues:write", "pull_requests:read", "pull_requests:write", "agents:run", "workflows:read", "checks:read", "deployments:read", "memory:read", "memory:write", "account:read", "notifications:read", "notifications:write", "workspace:read", "billing:read", "access:read", "webhooks:read", "secrets:read", "models:read", "artifacts:read",
  ] as const,
  ci: [
    "repo:read", "code:read", "code:write", "packages:read", "packages:write", "workflows:read", "workflows:write", "checks:read", "checks:write", "deployments:read", "deployments:write",
  ] as const,
  full: [
    "*",
  ] as const,
};

export const PRESETS: { id: PresetId; label: string; description: string }[] = [
  { id: "read_only", label: "Read only", description: "Read everything you can read; change nothing." },
  { id: "agent", label: "Agent", description: "Read everything, work on issues and pull requests, push code and run g1t agents." },
  { id: "ci", label: "CI", description: "Clone and push code, push and pull packages, run workflows, and report checks and deployments." },
  { id: "full", label: "Full access", description: "Everything you can do, including deleting repositories and changing who has access." },
];

/** The scopes of a preset, or null for full access. */
export function presetScopes(id: PresetId): Scope[] | null {
  if (id === "full") return null;
  return [...PRESET_SCOPES[id]] as Scope[];
}

/** What an OAuth client gets when it asks for nothing in particular. */
export const OAUTH_DEFAULT_SCOPES: Scope[] = [...PRESET_SCOPES.agent];

/** The operation each scope gates, by the API's operation names. */
export const OPERATION_SCOPES = [
  ["list_emails", "account:read"],
  ["add_email", "account:write"],
  ["confirm_email", "account:write"],
  ["remove_email", "account:write"],
  ["update_email_settings", "account:write"],
  ["list_invites", "account:read"],
  ["create_invite", "account:write"],
  ["revoke_invite", "account:write"],
  ["list_invitations", "account:read"],
  ["accept_invitation", "account:write"],
  ["decline_invitation", "account:write"],
  ["list_my_repo_invitations", "account:read"],
  ["accept_repo_invitation", "account:write"],
  ["decline_repo_invitation", "account:write"],
  // Your pinned projects: a preference of your account.
  ["list_pinned_projects", "account:read"],
  ["pin_project", "account:write"],
  // Your stars: a preference of your account.
  ["list_starred", "account:read"],
  ["check_starred", "account:read"],
  ["star_repo", "account:write"],
  ["unstar_repo", "account:write"],
  ["unpin_project", "account:write"],
  ["reorder_pinned_projects", "account:write"],
  // Your inbox: notifications, subscriptions and watching.
  ["list_notifications", "notifications:read"],
  ["get_notification_thread", "notifications:read"],
  ["get_thread_subscription", "notifications:read"],
  ["get_repo_subscription", "notifications:read"],
  ["list_watched_repos", "notifications:read"],
  ["mark_notifications_read", "notifications:write"],
  ["mark_thread_read", "notifications:write"],
  ["mark_thread_done", "notifications:write"],
  ["save_thread", "notifications:write"],
  ["snooze_thread", "notifications:write"],
  ["set_thread_subscription", "notifications:write"],
  ["delete_thread_subscription", "notifications:write"],
  ["set_repo_subscription", "notifications:write"],
  ["delete_repo_subscription", "notifications:write"],
  ["create_workspace", "workspace:admin"],
  ["delete_workspace", "workspace:admin"],
  ["get_workspace", "workspace:read"],
  ["update_workspace", "workspace:admin"],
  ["list_members", "workspace:read"],
  ["update_member", "workspace:admin"],
  ["remove_member", "workspace:admin"],
  ["transfer_ownership", "workspace:admin"],
  ["leave_workspace", "account:write"],
  ["list_workspace_invites", "workspace:read"],
  ["invite_member", "workspace:admin"],
  ["revoke_workspace_invite", "workspace:admin"],
  ["list_integrations", "workspace:read"],
  ["connect_integration", "workspace:admin"],
  ["update_integration", "workspace:admin"],
  ["disconnect_integration", "workspace:admin"],
  ["test_integration", "workspace:admin"],
  ["get_model_routes", "workspace:read"],
  ["set_model_routes", "workspace:admin"],
  ["list_teams", "workspace:read"],
  ["get_team", "workspace:read"],
  ["list_team_members", "workspace:read"],
  ["list_child_teams", "workspace:read"],
  ["list_team_repos", "workspace:read"],
  ["list_user_teams", "workspace:read"],
  ["create_team", "workspace:admin"],
  ["list_workspace_rulesets", "workspace:read"],
  ["get_workspace_ruleset", "workspace:read"],
  ["list_workspace_rule_evaluations", "workspace:read"],
  ["create_workspace_ruleset", "workspace:admin"],
  ["update_workspace_ruleset", "workspace:admin"],
  ["delete_workspace_ruleset", "workspace:admin"],
  ["update_team", "workspace:admin"],
  ["delete_team", "workspace:admin"],
  ["set_team_member", "workspace:admin"],
  ["remove_team_member", "workspace:admin"],
  ["set_team_review_assignment", "workspace:admin"],
  // A workspace's billing: usage, budget, AI credit and invoices.
  ["get_usage", "billing:read"],
  ["get_budget", "billing:read"],
  ["get_ai_credit", "billing:read"],
  ["list_invoices", "billing:read"],
  ["get_billing_details", "billing:read"],
  ["set_budget", "billing:write"],
  ["buy_ai_credit", "billing:write"],
  ["list_repos", "repo:read"],
  ["get_repo", "repo:read"],
  // Projects follow their repositories.
  ["list_projects", "repo:read"],
  ["get_project", "repo:read"],
  ["search", "repo:read"],
  ["list_events", "repo:read"],
  // What the default branch says about a repository, who starred it, and
  // its releases.
  ["get_languages", "repo:read"],
  ["list_contributors", "repo:read"],
  ["get_license", "repo:read"],
  ["list_stargazers", "repo:read"],
  ["list_releases", "repo:read"],
  ["get_latest_release", "repo:read"],
  ["get_release_by_tag", "repo:read"],
  ["get_release", "repo:read"],
  ["create_release", "repo:write"],
  ["update_release", "repo:write"],
  ["delete_release", "repo:write"],
  ["list_labels", "repo:read"],
  ["list_milestones", "repo:read"],
  ["get_milestone", "repo:read"],
  ["create_label", "issues:write"],
  ["update_label", "issues:write"],
  ["delete_label", "issues:write"],
  ["add_default_labels", "issues:write"],
  ["create_milestone", "issues:write"],
  ["update_milestone", "issues:write"],
  ["delete_milestone", "issues:write"],
  ["get_repo_settings", "repo:read"],
  ["list_check_names", "repo:read"],
  ["list_deleted_repos", "repo:read"],
  ["list_security_alerts", "repo:read"],
  ["get_codeowners_errors", "repo:read"],
  ["create_repo", "repo:write"],
  ["update_repo", "repo:write"],
  ["update_project", "repo:write"],
  ["update_repo_settings", "repo:write"],
  ["list_repo_rulesets", "repo:read"],
  ["get_repo_ruleset", "repo:read"],
  ["get_branch_rules", "repo:read"],
  ["list_rule_evaluations", "repo:read"],
  ["create_repo_ruleset", "repo:admin"],
  ["update_repo_ruleset", "repo:admin"],
  ["delete_repo_ruleset", "repo:admin"],
  ["rename_branch", "repo:write"],
  ["rename_repo", "repo:admin"],
  ["transfer_repo", "repo:admin"],
  ["archive_repo", "repo:admin"],
  ["unarchive_repo", "repo:admin"],
  ["set_repo_visibility", "repo:admin"],
  ["delete_repo", "repo:admin"],
  ["restore_repo", "repo:admin"],
  ["purge_repo", "repo:admin"],
  ["dismiss_security_alert", "repo:admin"],
  ["reopen_security_alert", "repo:admin"],
  // The security suite.
  ["list_secret_scanning_alerts", "security:read"],
  ["get_secret_scanning_alert", "security:read"],
  ["list_secret_scanning_locations", "security:read"],
  ["list_bypass_requests", "security:read"],
  ["list_custom_patterns", "security:read"],
  ["list_code_scanning_alerts", "security:read"],
  ["get_code_scanning_alert", "security:read"],
  ["list_code_scanning_analyses", "security:read"],
  ["get_sarif_upload", "security:read"],
  ["list_vulnerability_alerts", "security:read"],
  ["get_vulnerability_alert", "security:read"],
  ["get_dependency_graph", "security:read"],
  ["get_sbom", "security:read"],
  ["compare_dependencies", "security:read"],
  ["get_security_settings", "security:read"],
  ["get_workspace_security_settings", "security:read"],
  ["get_security_overview", "security:read"],
  ["update_secret_scanning_alert", "security:write"],
  ["bypass_push_protection", "security:write"],
  ["check_secret_validity", "security:write"],
  ["review_bypass_request", "security:write"],
  ["create_custom_pattern", "security:write"],
  ["update_custom_pattern", "security:write"],
  ["delete_custom_pattern", "security:write"],
  ["dry_run_custom_pattern", "security:write"],
  ["update_code_scanning_alert", "security:write"],
  ["upload_sarif", "security:write"],
  ["update_vulnerability_alert", "security:write"],
  ["fix_security_alert", "security:write"],
  ["update_security_settings", "security:write"],
  ["update_workspace_security_settings", "security:write"],
  ["list_issues", "issues:read"],
  ["get_issue", "issues:read"],
  ["get_plan", "issues:read"],
  ["create_issue", "issues:write"],
  ["update_issue", "issues:write"],
  ["list_issue_labels", "issues:read"],
  ["add_issue_labels", "issues:write"],
  ["set_issue_labels", "issues:write"],
  ["remove_issue_labels", "issues:write"],
  ["close_issue", "issues:write"],
  ["reopen_issue", "issues:write"],
  ["add_comment", "issues:write"],
  ["edit_comment", "issues:write"],
  ["delete_comment", "issues:write"],
  ["import_issue", "issues:write"],
  ["apply_plan", "issues:write"],
  ["list_pull_requests", "pull_requests:read"],
  ["get_pull_request", "pull_requests:read"],
  ["get_pull_request_changes", "pull_requests:read"],
  ["read_session", "pull_requests:read"],
  ["get_merge_queue", "pull_requests:read"],
  ["create_pull_request", "pull_requests:write"],
  ["update_pull_request", "pull_requests:write"],
  ["record_session", "pull_requests:write"],
  ["mark_pull_request_ready", "pull_requests:write"],
  ["close_pull_request", "pull_requests:write"],
  ["reopen_pull_request", "pull_requests:write"],
  ["convert_pull_request_to_draft", "pull_requests:write"],
  ["review_pull_request", "pull_requests:write"],
  ["merge_pull_request", "pull_requests:write"],
  ["request_reviewers", "pull_requests:write"],
  ["remove_requested_reviewers", "pull_requests:write"],
  ["assign_issue", "agents:run"],
  ["delegate", "agents:run"],
  ["plan_work", "agents:run"],
  ["message_agent", "agents:run"],
  ["answer_message", "agents:run"],
  ["take_messages", "agents:run"],
  ["list_workflows", "workflows:read"],
  ["list_workflow_runs", "workflows:read"],
  ["get_workflow_run", "workflows:read"],
  ["get_job_logs", "workflows:read"],
  ["dispatch_workflow", "workflows:write"],
  ["cancel_workflow_run", "workflows:write"],
  ["rerun_workflow_run", "workflows:write"],
  ["update_workflow", "workflows:write"],
  ["list_artifacts", "workflows:read"],
  ["list_workflow_run_artifacts", "workflows:read"],
  ["get_artifact", "workflows:read"],
  ["download_artifact", "workflows:read"],
  ["get_artifact_retention", "workflows:read"],
  ["delete_artifact", "workflows:write"],
  ["set_artifact_retention", "workflows:write"],
  ["list_commit_statuses", "checks:read"],
  ["get_combined_status", "checks:read"],
  ["list_check_runs_for_ref", "checks:read"],
  ["get_check_run", "checks:read"],
  ["list_check_run_annotations", "checks:read"],
  ["list_check_suites_for_ref", "checks:read"],
  ["get_check_suite", "checks:read"],
  ["create_commit_status", "checks:write"],
  ["create_check_run", "checks:write"],
  ["update_check_run", "checks:write"],
  ["rerequest_check_run", "checks:write"],
  ["rerequest_check_suite", "checks:write"],
  // Deployments, wherever they run: reading them, and reporting them.
  ["list_deployments", "deployments:read"],
  ["get_deployment", "deployments:read"],
  ["list_deployment_statuses", "deployments:read"],
  ["list_environments", "deployments:read"],
  ["get_environment", "deployments:read"],
  ["create_deployment", "deployments:write"],
  ["create_deployment_status", "deployments:write"],
  // What keeps runs safe: the runs environments hold and reviewing them,
  // approving a pull request's run, and a repository's own rules for its
  // environments and tokens, which are an admin's.
  ["get_pending_deployments", "workflows:read"],
  ["review_pending_deployments", "workflows:write"],
  ["approve_workflow_run", "workflows:write"],
  ["get_workflow_permissions", "repo:read"],
  ["get_fork_pr_approval", "repo:read"],
  ["get_actions_access", "repo:read"],
  ["update_environment", "repo:admin"],
  ["delete_environment", "repo:admin"],
  ["set_workflow_permissions", "repo:admin"],
  ["set_fork_pr_approval", "repo:admin"],
  ["set_actions_access", "repo:admin"],
  // Starting workflows from outside, as a push would.
  ["create_repository_dispatch", "code:write"],
  // A workspace's policy for its repositories' tokens.
  ["get_workspace_workflow_permissions", "workspace:read"],
  ["set_workspace_workflow_permissions", "workspace:admin"],
  // A workspace's rules for personal access tokens, and its members' tokens.
  ["get_token_policy", "workspace:read"],
  ["set_token_policy", "workspace:admin"],
  ["list_member_tokens", "access:read"],
  ["list_token_requests", "access:read"],
  ["review_token_request", "access:admin"],
  ["revoke_member_token", "access:admin"],
  ["recall", "memory:read"],
  ["search_context", "memory:read"],
  ["get_entity", "memory:read"],
  ["get_context", "memory:read"],
  ["remember", "memory:write"],
  ["list_collaborators", "access:read"],
  ["get_collaborator_permission", "access:read"],
  ["list_repo_invitations", "access:read"],
  ["list_outside_collaborators", "access:read"],
  ["add_collaborator", "access:admin"],
  ["update_collaborator", "access:admin"],
  ["remove_collaborator", "access:admin"],
  ["revoke_repo_invitation", "access:admin"],
  ["set_base_permission", "access:admin"],
  ["set_team_repo", "access:admin"],
  ["remove_team_repo", "access:admin"],
  ["list_deploy_keys", "access:read"],
  ["get_deploy_key", "access:read"],
  ["create_deploy_key", "access:admin"],
  ["delete_deploy_key", "access:admin"],
  ["get_mirror", "repo:read"],
  ["sync_mirror", "code:write"],
  ["get_hand_back_plan", "repo:admin"],
  ["take_over_mirror", "repo:admin"],
  ["set_ci_failover", "repo:admin"],
  ["hand_back_mirror", "repo:admin"],
  ["move_mirror_to_g1t", "repo:admin"],
  ["add_mirror_remote", "repo:admin"],
  ["update_mirror_remote", "repo:admin"],
  ["remove_mirror_remote", "repo:admin"],
  ["list_webhooks", "webhooks:read"],
  ["list_webhook_deliveries", "webhooks:read"],
  ["create_webhook", "webhooks:admin"],
  ["update_webhook", "webhooks:admin"],
  ["delete_webhook", "webhooks:admin"],
  ["ping_webhook", "webhooks:admin"],
  ["redeliver_webhook", "webhooks:admin"],
  ["list_actions_secrets", "secrets:read"],
  ["list_actions_variables", "secrets:read"],
  ["set_actions_secret", "secrets:admin"],
  ["delete_actions_secret", "secrets:admin"],
  ["set_actions_variable", "secrets:admin"],
  ["delete_actions_variable", "secrets:admin"],
  // Self-hosted runners.
  ["list_runners", "runners:read"],
  ["list_runner_groups", "runners:read"],
  ["get_runner_settings", "runners:read"],
  ["create_runner_registration_token", "runners:admin"],
  ["remove_runner", "runners:admin"],
  ["create_runner_group", "runners:admin"],
  ["update_runner_group", "runners:admin"],
  ["delete_runner_group", "runners:admin"],
  ["update_runner_settings", "runners:admin"],
  // Packages: reading them, their versions and who may use them needs
  // `packages:read`; changing their settings, access and Manage Actions
  // access `packages:write` (and the Admin role on the package, which the
  // packages service checks); deleting and restoring packages and
  // versions `packages:delete`, as the registries' own deletes do.
  ["list_packages", "packages:read"],
  ["get_package", "packages:read"],
  ["list_package_versions", "packages:read"],
  ["get_package_version", "packages:read"],
  ["list_package_access", "packages:read"],
  ["list_package_actions_access", "packages:read"],
  ["update_package", "packages:write"],
  ["link_package", "packages:write"],
  ["unlink_package", "packages:write"],
  ["set_package_access", "packages:write"],
  ["remove_package_access", "packages:write"],
  ["set_package_actions_access", "packages:write"],
  ["remove_package_actions_access", "packages:write"],
  ["delete_package", "packages:delete"],
  ["restore_package", "packages:delete"],
  ["delete_package_version", "packages:delete"],
  ["restore_package_version", "packages:delete"],
  // The AI Gateway. Sending a request to a model needs `models:write`,
  // checked by the model proxy at models.g1t.sh.
  ["list_gateway_requests", "models:read"],
  // Artifacts mode's docs, slides, designs and dashboards (the `artifact`
  // MCP tool). The artifacts service then checks the person's role on each.
  ["list_workspace_artifacts", "artifacts:read"],
  ["search_workspace_artifacts", "artifacts:read"],
  ["get_workspace_artifact", "artifacts:read"],
  ["get_workspace_artifact_content", "artifacts:read"],
  ["list_workspace_artifact_versions", "artifacts:read"],
  ["get_workspace_artifact_access", "artifacts:read"],
  ["list_workspace_artifact_templates", "artifacts:read"],
  ["list_workspace_artifact_spaces", "artifacts:read"],
  ["query_workspace_dataset", "artifacts:read"],
  ["create_workspace_artifact", "artifacts:write"],
  ["update_workspace_artifact", "artifacts:write"],
  ["edit_workspace_artifact", "artifacts:write"],
  ["trash_workspace_artifact", "artifacts:write"],
  ["restore_workspace_artifact", "artifacts:write"],
  ["restore_workspace_artifact_version", "artifacts:write"],
  ["set_workspace_artifact_access", "artifacts:admin"],
  ["purge_workspace_artifact", "artifacts:admin"],
] as const;

/**
 * The scopes a token or grant holds, as stored: null for full access, or
 * the list. `legacy` marks a token made before scopes, which has full
 * access until someone narrows it.
 */
export type TokenScopes = {
  scopes: Scope[] | null;
  legacy: boolean;
};

/**
 * How settings group scopes into a checklist: each group's scopes, least
 * first. Admin scopes are not here; they are under "Dangerous" on their
 * own (see `DANGEROUS_SCOPES`). Every other scope is in exactly one group.
 */
export const SCOPE_GROUPS: { id: string; label: string; scopes: Scope[] }[] = [
  { id: "code", label: "Repositories & code", scopes: ["repo:read", "repo:write", "code:read", "code:write"] },
  { id: "security", label: "Security", scopes: ["security:read", "security:write"] },
  { id: "packages", label: "Packages", scopes: ["packages:read", "packages:write"] },
  { id: "work", label: "Issues & pull requests", scopes: ["issues:read", "issues:write", "pull_requests:read", "pull_requests:write"] },
  { id: "agents", label: "Agents", scopes: ["agents:run"] },
  { id: "workflows", label: "Workflows", scopes: ["workflows:read", "workflows:write", "workflow_files:write"] },
  { id: "checks", label: "Checks", scopes: ["checks:read", "checks:write"] },
  { id: "deployments", label: "Deployments", scopes: ["deployments:read", "deployments:write"] },
  { id: "memory", label: "Memory & search", scopes: ["memory:read", "memory:write"] },
  { id: "account", label: "Account", scopes: ["account:read", "account:write"] },
  { id: "notifications", label: "Notifications", scopes: ["notifications:read", "notifications:write"] },
  { id: "workspace", label: "Workspace", scopes: ["workspace:read", "access:read", "webhooks:read", "secrets:read"] },
  { id: "billing", label: "Billing", scopes: ["billing:read", "billing:write"] },
  { id: "runners", label: "Runners", scopes: ["runners:read"] },
  { id: "models", label: "AI Gateway", scopes: ["models:read", "models:write"] },
  { id: "artifacts", label: "Artifacts", scopes: ["artifacts:read", "artifacts:write"] },
];

/** The admin and delete scopes, shown under "Dangerous" behind a warning. */
export const DANGEROUS_SCOPES: Scope[] = SCOPES.map((row) => row.scope).filter(isDangerous);
