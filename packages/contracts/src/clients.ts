import type { ActionsApi } from "./actions";
import type { BillingAdminApi, BillingApi } from "./billing";
import type { DeploymentsApi } from "./deployments";
import type { ProjectsApi } from "./projects";
import type { EventsApi } from "./events";
import type { IdentityAdminApi, IdentityApi } from "./identity";
import type { IntegrationsApi } from "./integrations";
import type { PackagesApi } from "./packages";
import type { WebhooksApi } from "./webhooks";
import type { ReposApi } from "./repos";
import type { PullDetail, WorkApi } from "./work";
import type { Result } from "./result";
import type { RunnersApi } from "./runners";

/** A service binding, as far as these clients need it. */
export type ServiceBinding = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

/**
 * Calls a method on a service that speaks the JSON protocol used by the
 * Rust services: `POST /rpc/<method>` with the arguments as the body.
 */
async function rpc<T>(
  service: ServiceBinding,
  method: string,
  args: object,
): Promise<T> {
  // The hostname is ignored; a service binding always reaches its service.
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function identityClient(service: ServiceBinding): IdentityApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    register: (username, email, password, inviteCode, client) =>
      call("register", { username, email, password, invite_code: inviteCode ?? null, client: client ?? null }),
    signIn: (username, password, client) => call("sign_in", { username, password, client: client ?? null }),
    signOut: (sessionToken) => call("sign_out", { sessionToken }),
    resendVerification: (user) => call("resend_verification", { user }),
    verifyEmail: (token) => call("verify_email", { token }),
    requestPasswordReset: (email, client) => call("request_password_reset", { email, client: client ?? null }),
    resetPassword: (token, password) =>
      call("reset_password", { token, password }),
    deviceStart: (clientName) => call("device_start", { clientName }),
    deviceLookup: (userCode) => call("device_lookup", { userCode }),
    deviceResolve: (userCode, user, approve) =>
      call("device_resolve", { userCode, user, approve }),
    deviceClaim: (deviceCode) => call("device_claim", { deviceCode }),
    oauthAuthorize: (user, approval) => call("oauth_authorize", { user, ...approval }),
    oauthExchange: (code, codeVerifier, clientId, redirectUri) =>
      call("oauth_exchange", { code, codeVerifier, clientId, redirectUri }),
    oauthRefresh: (refreshToken, clientId) =>
      call("oauth_refresh", { refreshToken, clientId }),
    listOAuthGrants: (user) => call("list_oauth_grants", { user }),
    revokeOAuthGrant: (user, id) => call("revoke_oauth_grant", { user, id }),
    updateOAuthGrant: (user, id, grant) =>
      call("update_oauth_grant", { user, id, scopes: grant.scopes }),
    createWorkspace: (user, slug, name) => call("create_workspace", { user, slug, name }),
    getWorkspace: (slug) => call("get_workspace", { slug }),
    workspaceResidency: (slug) => call("workspace_residency", { slug }),
    setWorkspaceResidency: (actor, slug, residency) => call("set_workspace_residency", { actor, slug, residency }),
    listMembers: (slug, viewer) => call("list_members", { slug, viewer }),
    addMember: (actor, slug, username) => call("add_member", { actor, slug, username }),
    removeMember: (actor, slug, username) =>
      call("remove_member", { actor, slug, username }),
    updateWorkspace: (actor, slug, details) =>
      call("update_workspace", { actor, slug, ...details }),
    renameWorkspace: (actor, slug, newSlug) => call("rename_workspace", { actor, slug, newSlug }),
    checkWorkspaceRename: (actor, slug, newSlug) =>
      call("check_workspace_rename", { actor, slug, newSlug }),
    resolveSlug: (slug) => call("resolve_slug", { slug }),
    deleteWorkspace: (actor, slug, confirm) => call("delete_workspace", { actor, slug, confirm }),
    checkWorkspaceDeletion: (actor, slug) => call("check_workspace_deletion", { actor, slug }),
    setWorkspaceAvatar: (actor, slug, image) => call("set_workspace_avatar", { actor, slug, image }),
    setUserAvatar: (user, image) => call("set_user_avatar", { user, image }),
    listWorkspaceTokens: (slug, viewer) => call("list_workspace_tokens", { slug, viewer }),
    createWorkspaceToken: (actor, slug, name, grant) =>
      call("create_workspace_token", {
        actor,
        slug,
        name,
        scopes: grant?.scopes ?? null,
        ttl_seconds: grant?.ttlSeconds ?? null,
      }),
    removeWorkspaceToken: (actor, slug, id) =>
      call("remove_workspace_token", { actor, slug, id }),
    userForSession: (sessionToken) => call("user_for_session", { sessionToken }),
    registration: () => call("registration", {}),
    listInvites: (user) => call("list_invites", { user }),
    createInvite: (user, options = {}) =>
      call("create_invite", { user, email: options.email ?? null, workspace: options.workspace ?? null }),
    revokeInvite: (user, id) => call("revoke_invite", { user, id }),
    checkInvite: (code, client, options = {}) =>
      call("check_invite", {
        code,
        client: client ?? null,
        viewer: options.viewer ?? null,
        any_status: options.anyStatus ?? false,
      }),
    acceptInvite: (user, code) => call("accept_invite", { user, code }),
    inviteMember: (actor, slug, email) => call("invite_member", { actor, slug, email }),
    workspaceInvites: (slug, viewer) => call("workspace_invites", { slug, viewer }),
    revokeWorkspaceInvite: (actor, slug, id) => call("revoke_workspace_invite", { actor, slug, id }),
    requestAccess: (email, about, client) => call("request_access", { email, about, client: client ?? null }),
    userForGitCredentials: (username, secret) =>
      call("user_for_git_credentials", { username, secret }),
    userForAccessToken: (token) => call("user_for_access_token", { token }),
    userForSshKey: (fingerprint) => call("user_for_ssh_key", { fingerprint }),
    userByUsername: (username) => call("user_by_username", { username }),
    usernames: (ids) => call("usernames", { ids }),
    profile: (username) => call("profile", { username }),
    updateProfile: (actor, fields) => call("update_profile", { actor, ...fields }),
    profileWorkspaces: (username, viewer, publicIn) =>
      call("profile_workspaces", { username, viewer, public: publicIn }),
    listSshKeys: (user) => call("list_ssh_keys", { user }),
    addSshKey: (user, title, publicKey) =>
      call("add_ssh_key", { user, title, publicKey }),
    removeSshKey: (user, id) => call("remove_ssh_key", { user, id }),
    listAccessTokens: (user) => call("list_access_tokens", { user }),
    createAccessToken: (user, name, ttlSeconds, grant) =>
      call("create_access_token", {
        user,
        name,
        ttlSeconds,
        scopes: grant?.scopes ?? null,
        listed: grant?.listed ?? false,
      }),
    updateAccessToken: (user, id, grant) =>
      call("update_access_token", { user, id, scopes: grant.scopes }),
    createAgentToken: (onBehalfOf, scope, ttlSeconds) =>
      call("create_agent_token", { onBehalfOf, scope, ttlSeconds }),
    removeAccessToken: (user, id) => call("remove_access_token", { user, id }),
    createRunCredential: (input) => call("create_run_credential", input),
    bindRunCredentials: (tokenHashes, runId) => call("bind_run_credentials", { tokenHashes, runId }),
    revokeRunCredentials: (target) => call("revoke_run_credentials", target),
    // Who has access to a repository; see access.ts.
    repoAccess: (owner, name, viewer) => call("repo_access", { viewer, path: { namespace: owner, name } }),
    addCollaborator: (actor, owner, name, invitee, role) =>
      call("add_collaborator", { actor, path: { namespace: owner, name }, invitee, role }),
    setCollaboratorRole: (actor, owner, name, username, role) =>
      call("set_collaborator_role", { actor, path: { namespace: owner, name }, username, role }),
    removeCollaborator: (actor, owner, name, username) =>
      call("remove_collaborator", { actor, path: { namespace: owner, name }, username }),
    collaboratorPermission: (viewer, owner, name, username) =>
      call("collaborator_permission", { viewer, path: { namespace: owner, name }, username }),
    myRepoInvitations: (user) => call("my_repo_invitations", { user }),
    respondRepoInvitation: (user, id, accept) => call("respond_repo_invitation", { user, id, accept }),
    revokeRepoInvitation: (actor, owner, name, id) =>
      call("revoke_repo_invitation", { actor, path: { namespace: owner, name }, id }),
    setBasePermission: (actor, slug, base) => call("set_base_permission", { actor, slug, base_permission: base }),
    outsideCollaborators: (viewer, slug) => call("outside_collaborators", { viewer, slug }),
    // Teams; see teams.ts.
    listTeams: (viewer, workspace, query) => call("list_teams", { viewer, workspace, query: query ?? null }),
    getTeam: (viewer, workspace, team) => call("get_team", { viewer, workspace, team }),
    createTeam: (actor, workspace, team) => call("create_team", { actor, workspace, ...team }),
    setTeamCreation: (actor, slug, setting) => call("set_team_creation", { actor, slug, team_creation: setting }),
    updateTeam: (actor, workspace, team, changes) => call("update_team", { actor, workspace, team, ...changes }),
    deleteTeam: (actor, workspace, team) => call("delete_team", { actor, workspace, team }),
    teamMembers: (viewer, workspace, team, includeChildTeams) =>
      call("team_members", { viewer, workspace, team, include_child_teams: includeChildTeams ?? false }),
    setTeamMember: (actor, workspace, team, username, role) =>
      call("set_team_member", { actor, workspace, team, username, role }),
    removeTeamMember: (actor, workspace, team, username) =>
      call("remove_team_member", { actor, workspace, team, username }),
    childTeams: (viewer, workspace, team) => call("child_teams", { viewer, workspace, team }),
    teamRepos: (viewer, workspace, team) => call("team_repos", { viewer, workspace, team }),
    setTeamRepo: (actor, workspace, team, owner, name, role) =>
      call("set_team_repo", { actor, workspace, team, repo: { namespace: owner, name }, role }),
    removeTeamRepo: (actor, workspace, team, owner, name) =>
      call("remove_team_repo", { actor, workspace, team, repo: { namespace: owner, name } }),
    userTeams: (viewer, workspace, username) => call("user_teams", { viewer, workspace, username }),
    teamMemberships: (viewer, workspace) => call("team_memberships", { viewer, workspace }),
  };
}

/**
 * The slug a renamed workspace has now, for a `workspace.renamed` handler:
 * asked of identity by the workspace's id, so that renames delivered twice
 * or out of order converge. Falls back to the event's `to`.
 */
export async function currentWorkspaceSlug(
  identity: ServiceBinding,
  renamed: { workspaceId: string; to: string },
): Promise<string> {
  const names = await identityClient(identity).usernames([renamed.workspaceId]);
  return names[renamed.workspaceId] ?? renamed.to;
}

/** The slugs whose rows move to `current`: the two a rename names, less `current`. */
export function staleSlugs(renamed: { from: string; to: string }, current: string): string[] {
  return [...new Set([renamed.from, renamed.to])].filter((slug) => slug !== current);
}

/**
 * Where a transferred repository is now, as `namespace/name`, for a
 * `repo.transferred` handler: asked of repos by id, so transfers delivered
 * twice or out of order converge. Falls back to the event's destination.
 */
export async function currentRepoPath(
  repos: ServiceBinding,
  transferred: { repoId: string; name: string; to: string },
): Promise<string> {
  const path = await rpc<{ namespace: string; name: string } | null>(repos, "path_by_id", { id: transferred.repoId });
  return path ? `${path.namespace}/${path.name}` : `${transferred.to}/${transferred.name}`;
}

/** The paths whose rows move to `current`: the two a transfer names, less `current`. */
export function stalePaths(transferred: { name: string; from: string; to: string }, current: string): string[] {
  return [...new Set([transferred.from, transferred.to].map((ns) => `${ns}/${transferred.name}`))].filter(
    (path) => path !== current,
  );
}

/**
 * A repository's path change, from `repo.transferred` or `repo.renamed`,
 * read the same way: the two paths (`namespace/name`) the event names, old
 * then new. Null for any other event.
 */
export type RepoMove = { repoId: string; paths: [string, string] };

export function repoMove(event: { type: string; data: unknown }): RepoMove | null {
  const data = event.data as Record<string, string>;
  if (event.type === "repo.transferred") {
    return { repoId: data.repoId!, paths: [`${data.from}/${data.name}`, `${data.to}/${data.name}`] };
  }
  if (event.type === "repo.renamed") {
    return { repoId: data.repoId!, paths: [`${data.namespace}/${data.from}`, `${data.namespace}/${data.to}`] };
  }
  return null;
}

/**
 * Where a moved repository is now, as `namespace/name`: asked of repos by
 * id, so moves delivered twice or out of order converge. Falls back to the
 * event's new path.
 */
export async function currentMovedPath(repos: ServiceBinding, move: RepoMove): Promise<string> {
  const path = await rpc<{ namespace: string; name: string } | null>(repos, "path_by_id", { id: move.repoId });
  return path ? `${path.namespace}/${path.name}` : move.paths[1];
}

/** The paths whose rows move to `current`: the two a move names, less `current`. */
export function staleMovedPaths(move: RepoMove, current: string): string[] {
  return [...new Set(move.paths)].filter((path) => path !== current);
}

/** Staff-only identity. Only sudo binds to it; see `IdentityAdminApi`. */
export function identityAdminClient(service: ServiceBinding): IdentityAdminApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    workspaces: (query) => call("admin_workspaces", { query: query ?? null }),
    workspace: (slug) => call("admin_workspace", { slug }),
    waitlist: (query, status) => call("admin_waitlist", { query: query ?? null, status: status ?? null }),
    waitlistPending: () => call("admin_waitlist_pending", {}),
    decideWaitlist: (id, approve, staff, note) => call("admin_decide_waitlist", { id, approve, staff, note: note ?? null }),
    invites: (query) => call("admin_invites", { query: query ?? null }),
    revokeInvite: (id, staff) => call("admin_revoke_invite", { id, staff }),
    mintInvite: (email, staff) => call("admin_mint_invite", { email, staff }),
    grantInvites: (target, name, amount, note, staff) =>
      call("admin_grant_invites", { target, name, amount, note, staff }),
    inviteTree: (username) => call("admin_invite_tree", { username }),
    workspaceInvites: (slug) => call("admin_workspace_invites", { slug }),
    deletedWorkspaces: () => call("admin_deleted_workspaces", {}),
    restoreWorkspace: (workspaceId, staff) => call("admin_restore_workspace", { workspaceId, staff }),
    purgeWorkspace: (workspaceId, staff, confirm) => call("admin_purge_workspace", { workspaceId, staff, confirm }),
    aliases: () => call("admin_aliases", {}),
    setAlias: (alias, workspace, note, staff) => call("admin_set_alias", { alias, workspace, note, staff }),
    removeAlias: (alias, reason, staff) => call("admin_remove_alias", { alias, reason, staff }),
  };
}

export function reposClient(service: ServiceBinding): ReposApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    get: (path, viewer) => call("get", { path, viewer }),
    getById: (id, viewer) => call("get_by_id", { id, viewer }),
    readable: (ids, viewer) => call("readable", { ids, viewer }),
    publicNamespaces: (ownerId) => call("public_namespaces", { ownerId }),
    list: (viewer, options = {}) => call("list", { viewer, ...options }),
    create: (owner, input) => call("create", { owner, ...input }),
    update: (actor, path, changes) => call("update", { actor, path, ...changes }),
    transfer: (actor, path, to) => call("transfer", { actor, path, to }),
    delete: (actor, path, confirm) => call("delete", { actor, path, confirm }),
    deleted: (viewer, namespace) => call("deleted", { viewer, namespace }),
    restore: (actor, path) => call("restore", { actor, path }),
    purge: (actor, path, confirm) => call("purge", { actor, path, confirm }),
    rename: (actor, path, name) => call("rename", { actor, path, name }),
    archive: (actor, path, archived) => call("archive", { actor, path, archived }),
    setVisibility: (actor, path, isPrivate, confirm) => call("set_visibility", { actor, path, isPrivate, confirm }),
    setDefaultBranch: (actor, path, branch) => call("set_default_branch", { actor, path, branch }),
    renameBranch: (actor, path, from, to) => call("rename_branch", { actor, path, from, to }),
    resolveBranch: (repoId, branch) => call("resolve_branch", { repoId, branch }),
    statusById: (id) => call("status_by_id", { id }),
    storageOptions: () => call("storage_options", {}),
    resolvePath: (path) => call("resolve_path", { path }),
    tree: (path, viewer, ref, treePath) =>
      call("tree", { path, viewer, ref, treePath }),
    blob: (path, viewer, ref, filePath) =>
      call("blob", { path, viewer, ref, filePath }),
    log: (path, viewer, ref, limit) => call("log", { path, viewer, ref, limit }),
    blame: (path, viewer, ref, filePath) => call("blame", { path, viewer, ref, filePath }),
    forkForPull: (sourceId, pullId, actor) =>
      call("fork_for_pull", { sourceId, pullId, actor }),
    gitAccess: (path, viewer, service) =>
      call("git_access", { path, viewer, service }),
    branches: (path, viewer) => call("branches", { path, viewer }),
    lastCommits: (path, viewer, ref, treePath) => call("last_commits", { path, viewer, ref, treePath }),
    tags: (path, viewer) => call("tags", { path, viewer }),
    listFiles: (repoId, ref, limit) => call("list_files", { repoId, ref, skipDirs: [], limit }),
    rawBlobs: (repoId, hashes, maxBytes) => call("raw_blobs", { repoId, hashes, maxBytes }),
    commitFile: (repo, actor, file) => call("commit_file", { repo, actor, ...file }),
    land: (sourceId, actor, branch) => call("land", { sourceId, actor, branch }),
    compare: (repoId, viewer, base, head, baseBranch) => call("compare", { repoId, viewer, base, head, baseBranch }),
    claimBackups: (limit, maxRunning) => call("claim_backups", { limit, maxRunning }),
    // The sandbox's own calls are snake_case (they come through the API).
    failBackup: (jobId, token, error) => call("backup_fail", { job_id: jobId, token, error }),
  };
}

/**
 * `PullDetail`'s own fields that the work service writes in snake_case:
 * `g1t_contracts::work::PullDetail` has no camelCase renaming, though what
 * it holds (`Pull`, `CheckRun` and the rest) does. Each with its name here.
 */
const PULL_DETAIL_FIELDS = [
  ["review_pending", "reviewPending"],
  ["earlier_checks", "earlierChecks"],
  ["required_checks", "requiredChecks"],
  ["code_owners", "codeOwners"],
] as const;

/**
 * A pull request's detail as the work service sent it, with its own fields
 * in the camelCase this package uses: read at the edge, by `workClient`'s
 * `getPull`. Either spelling is taken, so a service that already sends
 * camelCase reads the same.
 */
export function pullDetailFromWire(raw: Record<string, unknown>): PullDetail {
  const detail: Record<string, unknown> = { ...raw };
  for (const [snake, camel] of PULL_DETAIL_FIELDS) {
    if (snake in detail) {
      if (!(camel in detail)) detail[camel] = detail[snake];
      delete detail[snake];
    }
  }
  if (typeof detail.reviewPending !== "boolean") detail.reviewPending = false;
  return detail as PullDetail;
}

export function workClient(service: ServiceBinding): WorkApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    openIssue: (actor, repo, input) => call("open_issue", { actor, repo, ...input }),
    delegateIssue: (actor, repo, input) => call("delegate_issue", { actor, repo, ...input }),
    listIssues: (repo, viewer, filter = {}) => call("list_issues", { repo, viewer, ...filter }),
    getIssue: (repo, number, viewer) => call("get_issue", { repo, number, viewer }),
    updateIssue: (actor, repo, number, input) =>
      call("update_issue", { actor, repo, number, ...input }),
    closeIssue: (actor, repo, number, reason) =>
      call("close_issue", { actor, repo, number, reason }),
    reopenIssue: (actor, repo, number) => call("reopen_issue", { actor, repo, number }),
    listLabels: (repo, viewer) => call("list_labels", { repo, viewer }),
    saveLabel: (actor, repo, label) => call("save_label", { actor, repo, ...label }),
    deleteLabel: (actor, repo, name) => call("delete_label", { actor, repo, name }),
    addDefaultLabels: (actor, repo) => call("add_default_labels", { actor, repo }),
    setLabels: (actor, repo, number, labels, change = "set") =>
      call("set_labels", { actor, repo, number, labels, change }),
    listMilestones: (repo, viewer, state) => call("list_milestones", { repo, viewer, state }),
    getMilestone: (repo, number, viewer) => call("get_milestone", { repo, number, viewer }),
    saveMilestone: (actor, repo, milestone) => call("save_milestone", { actor, repo, ...milestone }),
    deleteMilestone: (actor, repo, number) => call("delete_milestone", { actor, repo, number }),
    counts: (repo, viewer) => call("counts", { repo, viewer }),
    addComment: (actor, repo, number, comment) =>
      call("add_comment", { actor, repo, number, ...comment }),
    startChecks: (pullId) => call("start_checks", { pullId }),
    reportChecks: (runId, token, report) =>
      call("report_checks", { runId, token, ...report }),
    startReview: (pullId) => call("start_review", { pullId }),
    failReview: (runId, token, error) => call("report_review", { runId, token, error }),
    startMergecheck: (pullId) => call("start_mergecheck", { pullId }),
    failMergecheck: (pullId, token, error) => call("report_mergecheck", { pullId, token, error }),
    advance: (pullId) => call("advance", { pullId }),
    stall: (pullId, reason) => call("stall", { pullId, reason }),
    managedPulls: (repoId) => call("managed_pulls", { repoId }),
    queue: (repo, viewer) => call("queue", { repo, viewer }),
    queueBuild: (repoId) => call("queue_build", { repoId }),
    failQueue: (entryId, token, error) => call("report_queue", { entryId, token, error }),
    removeFromQueue: (actor, repo, number) => call("remove_from_queue", { actor, repo, number }),
    messageAgent: (actor, repo, number, body) => call("message_agent", { actor, repo, number, body }),
    catchUpJob: (pullId) => call("catch_up_job", { pullId }),
    wakeForMessages: (pullId) => call("wake_for_messages", { pullId }),
    getSettings: (repo, viewer) => call("get_settings", { repo, viewer }),
    seenChecks: (repo, viewer) => call("seen_checks", { repo, viewer }),
    codeownersErrors: (repo, viewer, ref) => call("codeowners_errors", { repo, viewer, ref: ref ?? null }),
    updateSettings: (actor, repo, settings) =>
      call("update_settings", { actor, repo, settings }),
    openPull: (actor, repo, input) => call("open_pull", { actor, repo, ...input }),
    listPulls: (repo, viewer, state, filter = {}) => call("list_pulls", { repo, viewer, state, ...filter }),
    pullsForRepos: (repoIds, viewer, limit) => call("pulls_for_repos", { repoIds, viewer, limit }),
    // Its own fields arrive in snake_case: read into camelCase here.
    getPull: (repo, number, viewer) =>
      call<Result<Record<string, unknown>>>("get_pull", { repo, number, viewer }).then(
        (found): Result<PullDetail> => (found.ok ? { ok: true, value: pullDetailFromWire(found.value) } : found),
      ),
    updatePull: (actor, repo, number, changes) =>
      call("update_pull", { actor, repo, number, ...changes }),
    catchUpPull: (actor, repo, number) => call("catch_up_pull", { actor, repo, number }),
    readyPull: (actor, repo, number, summary) =>
      call("ready_pull", { actor, repo, number, summary }),
    closePull: (actor, repo, number) => call("close_pull", { actor, repo, number }),
    mergePull: (actor, repo, number, options = {}) =>
      call("merge_pull", { actor, repo, number, ...options }),
    listActivePulls: (viewer) => call("list_active_pulls", { viewer }),
    byAuthor: (username, viewer, filter = {}) => call("by_author", { username, viewer, ...filter }),
    startPlan: (actor, repo, brief) => call("start_plan", { actor, repo, brief }),
    failPlan: (planId, token, error) => call("report_plan", { planId, token, error }),
    getPlan: (repo, viewer, id) => call("get_plan", { repo, viewer, id }),
    listPlans: (repo, viewer) => call("list_plans", { repo, viewer }),
    applyPlan: (actor, repo, id, options = {}) =>
      call("apply_plan", { actor, repo, id, ...options }),
    queueIssue: (actor, repo, number, queued) =>
      call("queue_issue", { actor, repo, number, queued }),
    readyIssues: (repoId) => call("ready_issues", { repoId }),
    listAssignedIssues: (viewer) => call("list_assigned_issues", { viewer }),
    appendSession: (actor, repo, number, entries) =>
      call("append_session", { actor, repo, number, entries }),
    readSession: (repo, number, viewer, afterSeq = 0) =>
      call("read_session", { repo, number, viewer, afterSeq }),
  };
}

export function billingClient(service: ServiceBinding): BillingApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    status: () => call("status", {}),
    account: (workspace, viewer) => call("account", { workspace, viewer }),
    ledger: (workspace, viewer) => call("ledger", { workspace, viewer }),
    credits: (workspace, viewer) => call("credits", { workspace, viewer }),
    statement: (workspace, viewer, month = null, group = "day") => call("statement", { workspace, viewer, month, group }),
    statementEntries: (workspace, viewer, filter) =>
      call("statement_entries", {
        workspace,
        viewer,
        month: filter.month,
        kind: filter.kind,
        day: filter.day ?? null,
        project: filter.project ?? null,
        before: filter.before ?? null,
      }),
    usage: (workspace, viewer, since) => call("usage", { workspace, viewer, since }),
    tokenUsage: (workspace, viewer, options = {}) =>
      call("token_usage", { workspace, viewer, person: options.person ?? null, days: options.days ?? null }),
    recordTokens: (usage) => call("record_tokens", usage),
    checkout: (actor, workspace, amountCents, returnUrl, method = "card") =>
      call("checkout", { actor, workspace, amountCents, returnUrl, method }),
    confirm: (workspace, viewer, session) => call("confirm", { workspace, viewer, session }),
    canStart: (workspace) => call("can_start", { workspace }),
    trial: (workspace, exempt) => call("trial", { workspace, exempt }),
    startRun: (run) => call("start_run", run),
    features: (workspace, viewer) => call("features", { workspace, viewer }),
    subscribe: (actor, workspace, feature, returnUrl) =>
      call("subscribe", { actor, workspace, feature, returnUrl }),
    confirmSubscription: (workspace, viewer, session) =>
      call("confirm_subscription", { workspace, viewer, session }),
    cancelSubscription: (actor, workspace, feature, resume = false) =>
      call("cancel_subscription", { actor, workspace, feature, resume }),
    hasFeature: (workspace, feature) => call("has_feature", { workspace, feature }),
    freeWorkspaces: (workspaces) => call("free_workspaces", { workspaces }),
    chargeFeature: (charge) => call("charge_feature", charge),
    billingPortal: (actor, workspace, returnUrl) => call("billing_portal", { actor, workspace, return_url: returnUrl }),
    recordSandbox: (usage) => call("record_sandbox", usage),
    limit: (workspace, viewer) => call("limit", { workspace, viewer }),
    checkLimit: (workspace) => call("check_limit", { workspace }),
    prices: () => call("prices", {}),
    notePending: (workspace, source, costMicros, detail = null) => call("note_pending", { workspace, source, costMicros, detail }),
    usageMeters: (workspace, viewer) => call("usage_meters", { workspace, viewer }),
    setSpendLimit: (actor, workspace, spendLimitMicros, useFullLimit = false, raiseOnce = false) =>
      call("set_spend_limit", { actor, workspace, spendLimitMicros, use_full_limit: useFullLimit, raise_once: raiseOnce }),
    invoices: (workspace, viewer) => call("invoices", { workspace, viewer }),
    entitlements: (workspace) => call("entitlements", { workspace }),
    reserve: (reservation) => call("reserve", reservation),
    settle: (reservationId, actualMicros) => call("settle", { reservationId, actualMicros }),
    cardCheck: (actor, workspace, returnUrl) => call("card_check", { actor, workspace, returnUrl }),
    confirmCardCheck: (workspace, viewer, session) => call("confirm_card_check", { workspace, viewer, session }),
    requestLimit: (actor, workspace, request) => call("request_limit", { actor, workspace, ...request }),
    limitRequests: (workspace, viewer) => call("limit_requests", { workspace, viewer }),
    confirmSpike: (actor, workspace, keepGoing) => call("confirm_spike", { actor, workspace, keepGoing }),
    setCaps: (actor, workspace, caps) => call("set_caps", { actor, workspace, ...caps }),
    usageReport: (workspace, viewer, range) =>
      call("usage_report", { workspace, viewer, from: range.from, until: range.until, products: range.products ?? [], projects: range.projects ?? [] }),
    aiCredit: (workspace, viewer) => call("ai_credit", { workspace, viewer }),
    buyAiCredit: (actor, workspace, amountCents, returnUrl) => call("buy_ai_credit", { actor, workspace, amountCents, returnUrl }),
    confirmAiCredit: (workspace, viewer, session) => call("confirm_ai_credit", { workspace, viewer, session }),
    setAiReload: (actor, workspace, reload) => call("set_ai_reload", { actor, workspace, ...reload }),
    setBudget: (actor, workspace, budget) => call("set_budget", { actor, workspace, ...budget }),
    billingDetails: (workspace, viewer) => call("billing_details", { workspace, viewer }),
    setBillingDetails: (actor, workspace, details) => call("set_billing_details", { actor, workspace, ...details }),
  };
}

export function billingAdminClient(service: ServiceBinding): BillingAdminApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    accounts: (query) => call("admin_accounts", { query: query ?? null }),
    account: (id) => call("admin_account", { id }),
    setTerms: (id, terms, by) => call("admin_set_terms", { id, terms, by }),
    setAllowances: (id, allowances, note, by) => call("admin_set_allowances", { id, allowances, note, by }),
    createEnterprise: (name, workspaces, by) => call("admin_create_enterprise", { name, workspaces, by }),
    attach: (workspace, account, by) => call("admin_attach", { workspace, account, by }),
    credit: (workspace, amountMicros, note, by, options = { kind: "goodwill" }) =>
      call("admin_credit", {
        workspace,
        amount_micros: amountMicros,
        note,
        by,
        kind: options.kind,
        expires_at: options.expiresAt ?? null,
        refund_for: options.refundFor ?? null,
        refund_day: options.refundDay ?? null,
      }),
    credits: (filter = {}) =>
      call("admin_credits", {
        workspace: filter.workspace ?? null,
        kind: filter.kind ?? null,
        month: filter.month ?? null,
        by: filter.by ?? null,
      }),
    revokeCredit: (id, note, by) => call("admin_revoke_credit", { id, note, by }),
    resetBilling: (workspace, confirm, note, by) => call("admin_reset_billing", { workspace, confirm, note, by }),
    billingLink: (workspace, by) => call("admin_billing_link", { workspace, by }),
    stripe: (fix = false, by) => call("admin_stripe", { fix, by: by ?? null }),
    enterpriseBilling: (id, email, by) => call("admin_enterprise_billing", { id, email, by }),
    enterpriseAddress: (id, address, taxIdType, taxId, by) => call("admin_enterprise_address", { id, address, taxIdType, taxId, by }),
    invoiceEnterprise: (id, by) => call("admin_invoice_enterprise", { id, by }),
    accountsFor: (workspaces) => call("admin_accounts", { query: null, workspaces }),
    signals: () => call("admin_signals", {}),
    overview: () => call("admin_overview", {}),
    sales: (workspace) => call("admin_sales", { workspace }),
    setSales: (workspace, record, by) =>
      call("admin_set_sales", {
        workspace,
        stage: record.stage,
        owner: record.owner ?? null,
        next_step: record.nextStep ?? null,
        next_at: record.nextAt ?? null,
        by,
      }),
    addNote: (workspace, text, by) => call("admin_add_note", { workspace, text, by }),
    workspaceInvoices: (workspace) => call("admin_workspace_invoices", { workspace }),
    allInvoices: (filter = {}) => call("admin_invoices", { status: filter.status ?? null, month: filter.month ?? null }),
    audit: (filter = {}) =>
      call("admin_audit", { by: filter.by ?? null, action: filter.action ?? null, before: filter.before ?? null }),
    limitRequests: (status = "open") => call("admin_limit_requests", { status }),
    decideLimitRequest: (id, decision, amountMicros, note, by) =>
      call("admin_decide_limit_request", { id, decision, amount_micros: amountMicros, note, by }),
    overages: () => call("admin_overages", {}),
    goodwill: (workspace, amountMicros, reason, by, day = null) =>
      call("admin_goodwill", { workspace, amount_micros: amountMicros, reason, by, day }),
    velocity: () => call("admin_velocity", {}),
    recordPayment: (workspace, amountMicros, reference, note, by) =>
      call("admin_record_payment", { workspace, amount_micros: amountMicros, reference, note, by }),
    costs: (days) => call("admin_costs", { days: days ?? null }),
    costAlerts: () => call("admin_cost_alerts", {}),
    spendCaps: () => call("admin_spend_caps", {}),
    liftBreaker: (note, by) => call("admin_lift_breaker", { note, by }),
    decideProposal: (id, decision, note, by) => call("admin_decide_proposal", { id, decision, note, by }),
    setCostSettings: (settings, by) => call("admin_set_cost_settings", { settings, by }),
    setCostMapping: (mapping, by) =>
      call("admin_set_cost_mapping", {
        product: mapping.product,
        meter: mapping.meter,
        bucket: mapping.bucket ?? "",
        price_meter: mapping.priceMeter ?? null,
        own_meter: mapping.ownMeter ?? null,
        scale_to_own: mapping.scaleToOwn ?? false,
        drift_percent: mapping.driftPercent ?? null,
        note: mapping.note ?? "",
        remove: mapping.remove ?? false,
        by,
      }),
    runCosts: (by) => call("admin_run_costs", { by }),
  };
}

export function eventsClient(service: ServiceBinding): EventsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    publish: (events) => call("publish", { events }),
    list: (query) => call("list", query),
  };
}

export function integrationsClient(service: ServiceBinding): IntegrationsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace, viewer) => call("list", { workspace, viewer }),
    connect: (actor, workspace, input) => call("connect", { actor, workspace, ...input }),
    update: (actor, workspace, id, input) => call("update", { actor, workspace, id, ...input }),
    disconnect: (actor, workspace, id) => call("disconnect", { actor, workspace, id }),
    test: (actor, workspace, id) => call("test", { actor, workspace, id }),
    deliveries: (workspace, viewer, id) => call("deliveries", { workspace, viewer, id }),
    resolve: (workspace, viewer, reference) => call("resolve", { workspace, viewer, reference }),
    references: (workspace, text, limit) => call("references", { workspace, text, limit }),
    import: (actor, repo, reference, assign) => call("import", { actor, repo, reference, assign }),
    links: (repo, number) => call("links", { repo, number }),
    modelProvider: (workspace) => call("model_provider", { workspace }),
    openModelSession: (run) => call("open_model_session", run),
    modelUpstream: (token) => call("model_upstream", { token }),
    closeModelSessions: (tokenHashes) => call("close_model_sessions", { token_hashes: tokenHashes }),
    routes: (workspace, viewer) => call("routes", { workspace, viewer }),
    setRoutes: (actor, workspace, routes) => call("set_routes", { actor, workspace, routes }),
  };
}

export function webhooksClient(service: ServiceBinding): WebhooksApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (viewer, owner) => call("list", { viewer, ...owner }),
    create: (actor, owner, input) => call("create", { actor, ...owner, ...input }),
    update: (actor, owner, id, input) => call("update", { actor, ...owner, id, ...input }),
    delete: (actor, owner, id) => call("delete", { actor, ...owner, id }),
    ping: (actor, owner, id) => call("ping", { actor, ...owner, id }),
    deliveries: (viewer, owner, id) => call("deliveries", { viewer, ...owner, id }),
    redeliver: (actor, owner, deliveryId) => call("redeliver", { actor, ...owner, deliveryId }),
  };
}

export function actionsClient(service: ServiceBinding): ActionsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    workflows: (repo, viewer) => call("workflows", { repo, viewer }),
    runs: (repo, viewer, filter = {}) => call("runs", { repo, viewer, ...filter }),
    run: (repo, viewer, id) => call("run", { repo, viewer, id }),
    logs: (repo, viewer, job, after = 0) => call("logs", { repo, viewer, job, after }),
    dispatch: (actor, repo, workflow, ref, inputs) => call("dispatch", { actor, repo, workflow, ref, inputs }),
    cancel: (actor, repo, id) => call("cancel", { actor, repo, id }),
    rerun: (actor, repo, id, failedOnly = false) => call("rerun", { actor, repo, id, failed_only: failedOnly }),
    setWorkflowEnabled: (actor, repo, workflow, enabled) =>
      call("set_workflow_enabled", { actor, repo, workflow, enabled }),
    settings: (actor, owner, kind) => call("settings", { actor, ...owner, kind }),
    setSetting: (actor, owner, kind, name, value, options = {}) =>
      call("set_setting", { actor, ...owner, kind, name, value, ...options }),
    deleteSetting: (actor, owner, kind, name, id) => call("delete_setting", { actor, ...owner, kind, name, id }),
  };
}


/** Self-hosted runners, kept by the actions service. */
export function runnersClient(service: ServiceBinding): RunnersApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    stuck: (viewer) => call("stuck_jobs", { viewer }),
    list: (actor, owner) => call("runners", { actor, ...owner }),
    createToken: (actor, owner, group) => call("create_registration_token", { actor, ...owner, group }),
    remove: (actor, owner, id) => call("remove_runner", { actor, ...owner, id }),
    groups: (actor, workspace) => call("runner_groups", { actor, workspace }),
    setGroup: (actor, workspace, group) => call("set_runner_group", { actor, workspace, ...group }),
    deleteGroup: (actor, workspace, id) => call("delete_runner_group", { actor, workspace, id }),
    settings: (actor, owner) => call("runner_settings", { actor, ...owner }),
    setSettings: (actor, owner, change) => call("set_runner_settings", { actor, ...owner, ...change }),
  };
}

export function deploymentsClient(service: ServiceBinding): DeploymentsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    settings: (project, viewer) => call("settings", { project, viewer }),
    updateSettings: (actor, project, changes) => call("update_settings", { actor, project, changes }),
    list: (project, viewer) => call("list", { project, viewer }),
    get: (project, id, viewer) => call("get", { project, id, viewer }),
    redeploy: (actor, project, branch) => call("redeploy", { actor, project, branch }),
    takeDown: (actor, project, branch) => call("take_down", { actor, project, branch }),
    stack: (actor, project, branch) => call("stack", { actor, project, branch }),
    overview: (workspace, viewer) => call("overview", { workspace, viewer }),
    usage: (workspace, viewer) => call("usage", { workspace, viewer }),
    domains: (project, viewer) => call("domains", { project, viewer }),
    addDomain: (actor, project, hostname, options = {}) =>
      call("add_domain", { actor, project, hostname, twin: !!options.twin }),
    removeDomain: (actor, project, id) => call("remove_domain", { actor, project, id }),
    refreshDomain: (actor, project, id) => call("refresh_domain", { actor, project, id }),
  };
}

/** Packages: the registries beside the code (services/packages). */
export function packagesClient(service: ServiceBinding): PackagesApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace, viewer, filter = {}) =>
      call("list_packages", {
        workspace,
        viewer,
        ecosystem: filter.ecosystem ?? null,
        repo_id: filter.repoId ?? null,
        query: filter.query ?? null,
      }),
    get: (workspace, ecosystem, name, viewer) => call("get_package", { workspace, ecosystem, name, viewer }),
    deleteVersion: (actor, workspace, ecosystem, name, version, surface) =>
      call("delete_version", { actor, workspace, ecosystem, name, version, surface: surface ?? null }),
    deletePackage: (actor, workspace, ecosystem, name, surface) =>
      call("delete_package", { actor, workspace, ecosystem, name, surface: surface ?? null }),
    set: (actor, workspace, ecosystem, name, change, surface) =>
      call("set_package", {
        actor,
        workspace,
        ecosystem,
        name,
        visibility: change.visibility ?? null,
        link: change.link ?? null,
        unlink: change.unlink ?? false,
        surface: surface ?? null,
      }),
    storage: (workspace) => call("storage", { workspace }),
    storageAll: () => call("storage_all", {}),
    syncComposer: (repoId) => call("sync_composer", { repo_id: repoId }),
  };
}

export function projectsClient(service: ServiceBinding): ProjectsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace, viewer) => call("list", { workspace, viewer }),
    get: (workspace, slug, viewer) => call("get", { workspace, slug, viewer }),
    byRepo: (repoId) => call("by_repo", { repoId }),
    create: (actor, workspace, input) => call("create", { actor, workspace, input }),
    update: (actor, workspace, slug, changes) => call("update", { actor, workspace, slug, changes }),
    deploymentsChanged: (projectId, enabled) => call("deployments_changed", { projectId, enabled }),
    dependencies: (workspace, slug, viewer) => call("dependencies", { workspace, slug, viewer }),
    addDependency: (actor, workspace, slug, on, as) => call("add_dependency", { actor, workspace, slug, on, as }),
    removeDependency: (actor, workspace, slug, on) => call("remove_dependency", { actor, workspace, slug, on }),
    graph: (projectId) => call("graph", { projectId }),
    shortcuts: (workspace, viewer) => call("shortcuts", { workspace, viewer }),
    pin: (actor, workspace, slug, position) => call("pin", { actor, workspace, slug, position: position ?? null }),
    unpin: (actor, workspace, slug) => call("unpin", { actor, workspace, slug }),
    reorderPins: (actor, workspace, slugs) => call("reorder_pins", { actor, workspace, slugs }),
    visited: (actor, projectId) => call("visited", { actor, projectId }),
  };
}
