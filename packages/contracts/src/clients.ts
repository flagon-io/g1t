import type { ActionsApi } from "./actions";
import type { AiApi } from "./ai";
import type { BillingAdminApi, BillingApi } from "./billing";
import type { DeploymentsApi } from "./deployments";
import type { ProjectsApi } from "./projects";
import type { EventsApi } from "./events";
import type { IdentityAdminApi, IdentityApi } from "./identity";
import type { IntegrationsApi } from "./integrations";
import type { PackagesApi } from "./packages";
import type { WebhooksApi } from "./webhooks";
import type { RepoPath, ReposAdminApi, ReposApi } from "./repos";
import type { CommentScope, ProjectChange, PullDetail, Thread, WorkApi } from "./work";
import type { Result } from "./result";
import type { RunnersAdminApi, RunnersApi } from "./runners";

/** A service binding, as far as these clients need it. */
export type ServiceBinding = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

/**
 * Calls a method on a service that speaks the JSON protocol used by the
 * Rust services: `POST /rpc/<method>` with the arguments as the body.
 */
async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
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

/** The thread's fields as the work service reads them. */
function threadArgs(thread: Thread): { repo: RepoPath | null; workspace: string; number: number } {
  return "repo" in thread ? { repo: thread.repo, workspace: "", number: thread.number } : { repo: null, workspace: thread.workspace, number: thread.number };
}

export function identityClient(service: ServiceBinding): IdentityApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    register: (username, email, password, inviteCode, client, emailProof) =>
      call("register", {
        username,
        email,
        password,
        invite_code: inviteCode ?? null,
        email_proof: emailProof ?? null,
        client: client ?? null,
      }),
    signIn: (username, password, client) => call("sign_in", { username, password, client: client ?? null }),
    twoFactorSignIn: (challenge, code, client) => call("two_factor_sign_in", { challenge, code, client: client ?? null }),
    signOut: (sessionToken) => call("sign_out", { sessionToken }),
    resendVerification: (user) => call("resend_verification", { user }),
    verifyEmail: (token) => call("verify_email", { token }),
    requestPasswordReset: (email, client) => call("request_password_reset", { email, client: client ?? null }),
    resetPassword: (token, password) => call("reset_password", { token, password }),
    deviceStart: (clientName) => call("device_start", { clientName }),
    deviceLookup: (userCode) => call("device_lookup", { userCode }),
    deviceResolve: (userCode, user, approve) => call("device_resolve", { userCode, user, approve }),
    deviceClaim: (deviceCode) => call("device_claim", { deviceCode }),
    oauthAuthorize: (user, approval) => call("oauth_authorize", { user, ...approval }),
    oauthExchange: (code, codeVerifier, clientId, redirectUri) => call("oauth_exchange", { code, codeVerifier, clientId, redirectUri }),
    oauthRefresh: (refreshToken, clientId) => call("oauth_refresh", { refreshToken, clientId }),
    listOAuthGrants: (user) => call("list_oauth_grants", { user }),
    revokeOAuthGrant: (user, id) => call("revoke_oauth_grant", { user, id }),
    updateOAuthGrant: (user, id, grant) => call("update_oauth_grant", { user, id, scopes: grant.scopes }),
    createWorkspace: (user, slug, name) => call("create_workspace", { user, slug, name }),
    getWorkspace: (slug) => call("get_workspace", { slug }),
    workspaceResidency: (slug) => call("workspace_residency", { slug }),
    setWorkspaceResidency: (actor, slug, residency) => call("set_workspace_residency", { actor, slug, residency }),
    listMembers: (slug, viewer) => call("list_members", { slug, viewer }),
    addMember: (actor, slug, username) => call("add_member", { actor, slug, username }),
    removeMember: (actor, slug, username) => call("remove_member", { actor, slug, username, surface: "web" }),
    updateMember: (actor, slug, username, change) =>
      call("update_member", { actor, slug, username, role: change.role ?? null, org_roles: change.org_roles ?? null, surface: "web" }),
    transferOwnership: (actor, slug, username) => call("transfer_ownership", { actor, slug, username, surface: "web" }),
    leaveWorkspace: (user, slug) => call("leave_workspace", { user, slug, surface: "web" }),
    setMemberPrivileges: (actor, slug, change) => call("set_member_privileges", { actor, slug, privileges: change, surface: "web" }),
    setTwoFactorRequirement: (actor, slug, required) => call("set_two_factor_requirement", { actor, slug, required, surface: "web" }),
    updateWorkspace: (actor, slug, { socialAccounts, billingEmail, ...details }) =>
      call("update_workspace", { actor, slug, ...details, social_accounts: socialAccounts, billing_email: billingEmail }),
    workspaceBillingEmail: (actor, slug) => call("workspace_billing_email", { actor, slug }),
    renameWorkspace: (actor, slug, newSlug) => call("rename_workspace", { actor, slug, newSlug }),
    checkWorkspaceRename: (actor, slug, newSlug) => call("check_workspace_rename", { actor, slug, newSlug }),
    resolveSlug: (slug) => call("resolve_slug", { slug }),
    deleteWorkspace: (actor, slug, confirm) => call("delete_workspace", { actor, slug, confirm }),
    checkWorkspaceDeletion: (actor, slug) => call("check_workspace_deletion", { actor, slug }),
    setWorkspaceAvatar: (actor, slug, image) => call("set_workspace_avatar", { actor, slug, image }),
    setUserAvatar: (user, image) => call("set_user_avatar", { user, image }),
    listWorkspaceTokens: (slug, viewer) => call("list_workspace_tokens", { slug, viewer }),
    removeWorkspaceToken: (actor, slug, id) => call("remove_workspace_token", { actor, slug, id }),
    createToken: (actor, input) =>
      call("create_token", {
        actor,
        owner: input.owner ?? null,
        name: input.name,
        description: input.description ?? null,
        ttl_seconds: input.ttlSeconds,
        workspace: input.workspace,
        repository_selection: input.repositorySelection,
        repositories: input.repositories,
        permissions: input.permissions,
        website: input.website ?? false,
      }),
    updateToken: (actor, id, change, owner) =>
      call("update_token", {
        actor,
        id,
        owner: owner ?? null,
        name: change.name ?? null,
        description: change.description ?? null,
        repository_selection: change.repositorySelection ?? null,
        repositories: change.repositories ?? null,
        permissions: change.permissions ?? null,
        website: change.website ?? null,
      }),
    regenerateToken: (actor, id, ttlSeconds, owner) => call("regenerate_token", { actor, id, owner: owner ?? null, ttl_seconds: ttlSeconds ?? null }),
    getTokenPolicy: (slug, viewer) => call("get_token_policy", { slug, viewer }),
    setTokenPolicy: (actor, slug, change) =>
      call("set_token_policy", {
        actor,
        slug,
        allow_tokens_for_all_workspaces: change.allowTokensForAllWorkspaces ?? null,
        allow_tokens_for_this_workspace: change.allowTokensForThisWorkspace ?? null,
        require_approval: change.requireApproval ?? null,
        max_lifetime_days: change.maxLifetimeDays ?? null,
        forbid_no_expiry: change.forbidNoExpiry ?? null,
        surface: "web",
      }),
    listMemberTokens: (actor, slug, filter = {}) => call("list_member_tokens", { actor, slug, status: filter.status ?? null }),
    reviewTokenRequest: (actor, slug, id, approve, reason) =>
      call("review_token_request", { actor, slug, id, approve, reason: reason ?? null, surface: "web" }),
    revokeMemberToken: (actor, slug, id, reason) => call("revoke_member_token", { actor, slug, id, reason: reason ?? null, surface: "web" }),
    userForSession: (sessionToken) => call("user_for_session", { sessionToken }),
    listInvites: (user) => call("list_invites", { user }),
    createInvite: (user, invite) =>
      call("create_invite", {
        user,
        email: invite.email,
        message: invite.message ?? null,
        join: invite.join ?? null,
        join_role: invite.join ? (invite.joinRole ?? null) : null,
        surface: "web",
      }),
    revokeInvite: (user, id) => call("revoke_invite", { user, id }),
    resendInvite: (user, id) => call("resend_invite", { user, id }),
    registration: () => call("registration", {}),
    requestAccess: (email, about, client) => call("request_access", { email, about, client: client ?? null }),
    checkInvite: (code, client, options = {}) =>
      call("check_invite", {
        code,
        client: client ?? null,
        viewer: options.viewer ?? null,
        any_status: options.anyStatus ?? false,
        email_proof: options.emailProof ?? null,
      }),
    acceptInvite: (user, code) => call("accept_invite", { user, code }),
    inviteMember: (actor, slug, who) =>
      call("invite_member", { actor, slug, email: who.email ?? "", username: who.username ?? null, role: who.role ?? null, message: who.message ?? null }),
    listInvitations: (user) => call("list_invitations", { user }),
    acceptInvitation: (user, id) => call("accept_invitation", { user, id, surface: "web" }),
    declineInvitation: (user, id) => call("decline_invitation", { user, id, surface: "web" }),
    findPeople: (query, limit) => call("find_people", { query, limit: limit ?? null }),
    workspaceInvites: (slug, viewer) => call("workspace_invites", { slug, viewer }),
    revokeWorkspaceInvite: (actor, slug, id) => call("revoke_workspace_invite", { actor, slug, id }),
    resendWorkspaceInvite: (actor, slug, id) => call("resend_workspace_invite", { actor, slug, id }),
    userForGitCredentials: (username, secret) => call("user_for_git_credentials", { username, secret }),
    userForAccessToken: (token) => call("user_for_access_token", { token }),
    userForSshKey: (fingerprint) => call("user_for_ssh_key", { fingerprint }),
    userByUsername: (username) => call("user_by_username", { username }),
    usernames: (ids) => call("usernames", { ids }),
    accounts: (ids) => call("accounts", { ids }),
    usersForAudience: (ids) => call("users_for_audience", { ids }),
    profile: (username) => call("profile", { username }),
    updateProfile: (actor, fields) => call("update_profile", { actor, ...fields }),
    profileWorkspaces: (username, viewer, publicIn) => call("profile_workspaces", { username, viewer, public: publicIn }),
    dockPins: (user, workspace) => call("dock_pins", { user, workspace }),
    setDockPins: (user, workspace, apps) => call("set_dock_pins", { user, workspace, apps }),
    onboarding: (user, workspace) => call("onboarding", { user, workspace }),
    setOnboarding: (user, workspace, change) => call("set_onboarding", { user, workspace, change }),
    soundSettings: (user) => call("sound_settings", { user }),
    setSoundSettings: (user, change) => call("set_sound_settings", { user, change }),
    listSshKeys: (user) => call("list_ssh_keys", { user }),
    addSshKey: (user, title, publicKey) => call("add_ssh_key", { user, title, publicKey }),
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
    removeAccessToken: (user, id) => call("remove_access_token", { user, id }),
    createRunCredential: (input) => call("create_run_credential", input),
    bindRunCredentials: (tokenHashes, runId) => call("bind_run_credentials", { tokenHashes, runId }),
    revokeRunCredentials: (target) => call("revoke_run_credentials", target),
    // Who has access to a repository; see access.ts.
    repoAccess: (owner, name, viewer) => call("repo_access", { viewer, path: { namespace: owner, name } }),
    addCollaborator: (actor, owner, name, invitee, role) => call("add_collaborator", { actor, path: { namespace: owner, name }, invitee, role }),
    setCollaboratorRole: (actor, owner, name, username, role) => call("set_collaborator_role", { actor, path: { namespace: owner, name }, username, role }),
    removeCollaborator: (actor, owner, name, username) => call("remove_collaborator", { actor, path: { namespace: owner, name }, username }),
    collaboratorPermission: (viewer, owner, name, username) => call("collaborator_permission", { viewer, path: { namespace: owner, name }, username }),
    myRepoInvitations: (user) => call("my_repo_invitations", { user }),
    respondRepoInvitation: (user, id, accept) => call("respond_repo_invitation", { user, id, accept }),
    revokeRepoInvitation: (actor, owner, name, id) => call("revoke_repo_invitation", { actor, path: { namespace: owner, name }, id }),
    setBasePermission: (actor, slug, base) => call("set_base_permission", { actor, slug, base_permission: base }),
    outsideCollaborators: (viewer, slug) => call("outside_collaborators", { viewer, slug }),
    // A repository's deploy keys; see deploy-keys.ts.
    listDeployKeys: (viewer, owner, name) => call("list_deploy_keys", { viewer, path: { namespace: owner, name } }),
    addDeployKey: (actor, owner, name, key) =>
      call("add_deploy_key", { actor, path: { namespace: owner, name }, title: key.title, key: key.key, read_only: key.readOnly }),
    removeDeployKey: (actor, owner, name, id) => call("remove_deploy_key", { actor, path: { namespace: owner, name }, id }),
    // Teams; see teams.ts.
    listTeams: (viewer, workspace, query) => call("list_teams", { viewer, workspace, query: query ?? null }),
    getTeam: (viewer, workspace, team) => call("get_team", { viewer, workspace, team }),
    createTeam: (actor, workspace, team) => call("create_team", { actor, workspace, ...team }),
    setTeamCreation: (actor, slug, setting) => call("set_team_creation", { actor, slug, team_creation: setting }),
    updateTeam: (actor, workspace, team, changes) => call("update_team", { actor, workspace, team, ...changes }),
    deleteTeam: (actor, workspace, team) => call("delete_team", { actor, workspace, team }),
    teamMembers: (viewer, workspace, team, includeChildTeams) =>
      call("team_members", { viewer, workspace, team, include_child_teams: includeChildTeams ?? false }),
    setTeamMember: (actor, workspace, team, username, role) => call("set_team_member", { actor, workspace, team, username, role }),
    removeTeamMember: (actor, workspace, team, username) => call("remove_team_member", { actor, workspace, team, username }),
    childTeams: (viewer, workspace, team) => call("child_teams", { viewer, workspace, team }),
    teamRepos: (viewer, workspace, team) => call("team_repos", { viewer, workspace, team }),
    setTeamRepo: (actor, workspace, team, owner, name, role) => call("set_team_repo", { actor, workspace, team, repo: { namespace: owner, name }, role }),
    removeTeamRepo: (actor, workspace, team, owner, name) => call("remove_team_repo", { actor, workspace, team, repo: { namespace: owner, name } }),
    userTeams: (viewer, workspace, username) => call("user_teams", { viewer, workspace, username }),
    teamMemberships: (viewer, workspace) => call("team_memberships", { viewer, workspace }),
    // People; see people.ts.
    peopleDirectory: (viewer, workspace) => call("people_directory", { viewer, workspace }),
    setMemberProfile: (actor, workspace, username, changes) => call("set_member_profile", { actor, workspace, username, ...changes }),
  };
}

/**
 * The slug a renamed workspace has now, for a `workspace.renamed` handler:
 * asked of identity by the workspace's id, so that renames delivered twice
 * or out of order converge. Falls back to the event's `to`.
 */
export async function currentWorkspaceSlug(identity: ServiceBinding, renamed: { workspaceId: string; to: string }): Promise<string> {
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
export async function currentRepoPath(repos: ServiceBinding, transferred: { repoId: string; name: string; to: string }): Promise<string> {
  const path = await rpc<{ namespace: string; name: string } | null>(repos, "path_by_id", { id: transferred.repoId });
  return path ? `${path.namespace}/${path.name}` : `${transferred.to}/${transferred.name}`;
}

/** The paths whose rows move to `current`: the two a transfer names, less `current`. */
export function stalePaths(transferred: { name: string; from: string; to: string }, current: string): string[] {
  return [...new Set([transferred.from, transferred.to].map((ns) => `${ns}/${transferred.name}`))].filter((path) => path !== current);
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
    growth: () => call("admin_growth", {}),
    workspaces: (query) => call("admin_workspaces", { query: query ?? null }),
    workspace: (slug) => call("admin_workspace", { slug }),
    sso: (slug) => call("admin_sso", { slug }),
    waitlist: (query, status) => call("admin_waitlist", { query: query ?? null, status: status ?? null }),
    waitlistPending: () => call("admin_waitlist_pending", {}),
    registration: () => call("admin_registration", {}),
    setRegistration: (mode, staff) => call("admin_set_registration", { mode, staff }),
    decideWaitlist: (id, approve, staff, note) => call("admin_decide_waitlist", { id, approve, staff, note: note ?? null }),
    invites: (query, options = {}) => call("admin_invites", { query: query ?? null, to_g1t: options.toG1t ?? false }),
    grantInvites: (username, amount, note, staff) => call("admin_grant_invites", { username, amount, note, staff }),
    revokeInvite: (id, staff) => call("admin_revoke_invite", { id, staff }),
    suspendUser: (name, suspend, reason, staff) => call("admin_suspend_user", { name, suspend, reason, staff }),
    suspendWorkspace: (name, suspend, reason, staff) => call("admin_suspend_workspace", { name, suspend, reason, staff }),
    blockedDomains: () => call("admin_blocked_domains", {}),
    blockDomain: (domain, block, reason, staff) => call("admin_block_domain", { domain, block, reason, staff }),
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
    createBranch: (actor, path, name, from = "") => call("create_branch", { actor, path, name, from }),
    removeBranch: (actor, path, branch, head) => call("remove_branch", { actor, path, branch, head }),
    resolveBranch: (repoId, branch) => call("resolve_branch", { repoId, branch }),
    statusById: (id) => call("status_by_id", { id }),
    storageOptions: () => call("storage_options", {}),
    resolvePath: (path) => call("resolve_path", { path }),
    tree: (path, viewer, ref, treePath) => call("tree", { path, viewer, ref, treePath }),
    blob: (path, viewer, ref, filePath) => call("blob", { path, viewer, ref, filePath }),
    log: (path, viewer, ref, limit) => call("log", { path, viewer, ref, limit }),
    blame: (path, viewer, ref, filePath) => call("blame", { path, viewer, ref, filePath }),
    forkForPull: (sourceId, pullId, actor) => call("fork_for_pull", { sourceId, pullId, actor }),
    fork: (actor, path, input) => call("fork", { actor, path, ...input }),
    forks: (path, viewer, limit) => call("forks", { path, viewer, limit: limit ?? null }),
    syncFork: (actor, path, branch) => call("sync_fork", { actor, path, branch: branch ?? null }),
    detachFork: (actor, path) => call("detach_fork", { actor, path }),
    gitAccess: (path, viewer, service) => call("git_access", { path, viewer, service }),
    branches: (path, viewer) => call("branches", { path, viewer }),
    pathById: (id) => call("path_by_id", { id }),
    lastCommits: (path, viewer, ref, treePath) => call("last_commits", { path, viewer, ref, treePath }),
    branchDrift: (path, viewer, base, heads) => call("branch_drift", { path, viewer, base, heads }),
    tags: (path, viewer) => call("tags", { path, viewer }),
    about: (path, viewer) => call("about", { path, viewer }),
    languages: (path, viewer) => call("languages", { path, viewer }),
    contributors: (path, viewer) => call("contributors", { path, viewer }),
    license: (path, viewer) => call("license", { path, viewer }),
    stars: (path, viewer) => call("stars", { path, viewer }),
    star: (actor, path, starred) => call("star", { path, actor, starred }),
    stargazers: (path, viewer, page) => call("stargazers", { path, viewer, page: page ?? null }),
    starred: (username, viewer) => call("starred", { username, viewer }),
    releases: (path, viewer) => call("releases", { path, viewer }),
    release: (path, viewer, which) => call("release", { path, viewer, id: which.id ?? null, tag: which.tag ?? null, latest: which.latest ?? false }),
    createRelease: (actor, path, release) => call("create_release", { path, actor, ...release }),
    updateRelease: (actor, path, id, change) => call("update_release", { path, actor, id, ...change }),
    deleteRelease: (actor, path, id) => call("delete_release", { path, actor, id }),
    listFiles: (repoId, ref, limit, options) => call("list_files", { repoId, ref, skipDirs: [], limit, links: options?.links ?? false }),
    openArchiveToken: (path, token) => call("open_archive_token", { path, token }),
    rawBlobs: (repoId, hashes, maxBytes) => call("raw_blobs", { repoId, hashes, maxBytes }),
    rawFile: (repoId, ref, path, maxBytes) => call("raw_file", { repoId, ref, path, maxBytes }),
    commitFile: (repo, actor, file) => call("commit_file", { repo, actor, ...file }),
    land: (sourceId, actor, branch) => call("land", { sourceId, actor, branch }),
    compare: (repoId, viewer, base, head, baseBranch, paths, targetId) =>
      call("compare", { repoId, viewer, base, head, baseBranch, paths: paths ?? null, ...(targetId ? { targetId } : {}) }),
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
  return detail as PullDetail;
}

/** A comment's scope as the work service reads it. */
function commentScope(scope: CommentScope): { repo: RepoPath | null; workspace: string } {
  return "repo" in scope ? { repo: scope.repo, workspace: "" } : { repo: null, workspace: scope.workspace };
}

/** A project's change as the work service reads it: snake_case, with only the fields given. */
function projectChange(change: ProjectChange): Record<string, unknown> {
  const { startOn, targetOn, ...rest } = change;
  return {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(startOn !== undefined ? { start_on: startOn } : {}),
    ...(targetOn !== undefined ? { target_on: targetOn } : {}),
  };
}

export function workClient(service: ServiceBinding): WorkApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    // Work items are numbered in a workspace; their arguments are
    // snake_case, as the Rust service reads them.
    openWorkItem: (actor, input) =>
      call("open_work_item", {
        actor,
        workspace: input.workspace ?? "",
        repo: input.repo ?? null,
        targets: input.targets ?? [],
        title: input.title,
        body: input.body,
        labels: input.labels ?? [],
        milestone: input.milestone ?? null,
        ...(input.project ? { project: input.project } : {}),
      }),
    listWorkItems: (workspace, viewer, filter = {}) =>
      call("list_work_items", {
        workspace,
        viewer,
        repo: filter.repo ?? null,
        role: filter.role ?? null,
        state: filter.state ?? null,
        label: filter.label ?? null,
        milestone: filter.milestone ?? null,
        assignee: filter.assignee ?? null,
        parent: filter.parent ?? null,
        closed_since: filter.closedSince ?? null,
        before: filter.before ?? null,
        ...(filter.horizon ? { horizon: filter.horizon } : {}),
        ...(filter.project ? { project: filter.project } : {}),
        ...(filter.cycle ? { cycle: filter.cycle } : {}),
        ...(filter.limit ? { limit: filter.limit } : {}),
      }),
    getWorkItem: (workspace, number, viewer) => call("get_work_item", { workspace, number, viewer }),
    updateWorkItem: (actor, workspace, number, input) => call("update_work_item", { actor, workspace, number, ...input }),
    planWorkItem: (actor, workspace, number, input) => call("plan_work_item", { actor, workspace, number, ...input }),
    getPlan: (workspace, viewer, options = {}) =>
      call("get_plan", { workspace, viewer, ...(options.repo ? { repo: options.repo } : {}), ...(options.all ? { all: true } : {}) }),
    nextWorkItem: (workspace, viewer, repo) => call("next_work_item", { workspace, viewer, ...(repo ? { repo } : {}) }),
    configurePlan: (actor, workspace, nowCap) => call("configure_plan", { actor, workspace, now_cap: nowCap }),
    getSpend: (workspace, viewer, options = {}) =>
      call("get_spend", {
        workspace,
        viewer,
        ...(options.person ? { person: options.person } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
      }),
    configureSpend: (actor, workspace, visibility) => call("configure_spend", { actor, workspace, visibility }),
    listCycles: (workspace, viewer, limit) => call("list_cycles", { workspace, viewer, ...(limit === undefined ? {} : { limit }) }),
    getCycle: (workspace, viewer, number) => call("get_cycle", { workspace, viewer, ...(number === undefined ? {} : { number }) }),
    configureCycles: (actor, workspace, change) =>
      call("configure_cycles", {
        actor,
        workspace,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.lengthDays === undefined ? {} : { length_days: change.lengthDays }),
        ...(change.startsWeekday === undefined ? {} : { starts_weekday: change.startsWeekday }),
        ...(change.cooldownDays === undefined ? {} : { cooldown_days: change.cooldownDays }),
      }),
    cycleWorkItem: (actor, workspace, number, cycle) => call("cycle_work_item", { actor, workspace, number, cycle }),
    closeWorkItem: (actor, workspace, number, reason, by, subItems) =>
      call("close_work_item", {
        actor,
        workspace,
        number,
        reason: reason ?? null,
        ...(by ? { repo: by.repo, commit: by.commit } : {}),
        ...(subItems ? { sub_items: subItems.subItems, ...(subItems.moveTo ? { move_to: subItems.moveTo } : {}) } : {}),
      }),
    setWorkItemParent: (actor, workspace, number, parent, onlyFrom) =>
      call("set_work_item_parent", { actor, workspace, number, parent, ...(onlyFrom ? { only_from: onlyFrom } : {}) }),
    checkWorkItemTask: (actor, workspace, number, check) => call("check_work_item_task", { actor, workspace, number, ...check }),
    reopenWorkItem: (actor, workspace, number) => call("reopen_work_item", { actor, workspace, number }),
    linkWorkItem: (actor, workspace, number, repo, role = "target") => call("link_work_item", { actor, workspace, number, repo, role }),
    unlinkWorkItem: (actor, workspace, number, repo) => call("unlink_work_item", { actor, workspace, number, repo }),
    resolveRef: (viewer, context, number) =>
      call("resolve_ref", {
        viewer,
        number,
        ...("repo" in context ? { repo: context.repo, workspace: "" } : { repo: null, workspace: context.workspace }),
      }),
    migrateWorkItems: () => call("migrate_work_items", {}),
    closedByCommit: (repo, commit, viewer) => call("closed_by_commit", { repo, commit, viewer }),
    listLabels: (workspace, viewer) => call("list_labels", { workspace, viewer }),
    saveLabel: (actor, workspace, label) => call("save_label", { actor, workspace, ...label }),
    deleteLabel: (actor, workspace, name) => call("delete_label", { actor, workspace, name }),
    addDefaultLabels: (actor, workspace) => call("add_default_labels", { actor, workspace }),
    setLabels: (actor, thread, labels, change = "set") => call("set_labels", { actor, ...threadArgs(thread), labels, change }),
    listMilestones: (workspace, viewer, state) => call("list_milestones", { workspace, viewer, state }),
    getMilestone: (workspace, number, viewer) => call("get_milestone", { workspace, number, viewer }),
    saveMilestone: (actor, workspace, milestone) => call("save_milestone", { actor, workspace, ...milestone }),
    deleteMilestone: (actor, workspace, number) => call("delete_milestone", { actor, workspace, number }),
    // Projects' arguments are snake_case too.
    listProjects: (workspace, viewer, options = {}) =>
      call("list_projects", { workspace, viewer, ...(options.state ? { state: options.state } : {}), ...(options.archived ? { archived: true } : {}) }),
    getProject: (workspace, project, viewer) => call("get_project", { workspace, project, viewer }),
    createProject: (actor, workspace, change) => call("create_project", { actor, workspace, ...projectChange(change) }),
    updateProject: (actor, workspace, project, change) => call("update_project", { actor, workspace, project, ...projectChange(change) }),
    archiveProject: (actor, workspace, project, archived = true) => call("archive_project", { actor, workspace, project, archived }),
    addProjectMember: (actor, workspace, project, username, role) =>
      call("add_project_member", { actor, workspace, project, username, ...(role ? { role } : {}) }),
    removeProjectMember: (actor, workspace, project, username) => call("remove_project_member", { actor, workspace, project, username }),
    addProjectRepo: (actor, workspace, project, repo, defaultTarget) =>
      call("add_project_repo", { actor, workspace, project, repo, ...(defaultTarget === undefined ? {} : { default_target: defaultTarget }) }),
    removeProjectRepo: (actor, workspace, project, repo) => call("remove_project_repo", { actor, workspace, project, repo }),
    counts: (repo, viewer) => call("counts", { repo, viewer }),
    addComment: (actor, thread, comment) => call("add_comment", { actor, ...threadArgs(thread), ...comment }),
    editComment: (actor, scope, commentId, body) => call("edit_comment", { actor, ...commentScope(scope), commentId, body }),
    deleteComment: (actor, scope, commentId) => call("delete_comment", { actor, ...commentScope(scope), commentId }),
    uploadAttachment: (actor, scope, file) =>
      call("upload_attachment", {
        actor,
        ...("repo" in scope ? { repo: scope.repo } : { workspace: scope.workspace, number: scope.number }),
        name: file.name,
        content_type: file.contentType,
        data: file.data,
      }),
    react: (actor, thread, reaction) => call("react", { actor, ...threadArgs(thread), ...reaction }),
    reportChecks: (runId, token, report) => call("report_checks", { runId, token, ...report }),
    startMergecheck: (pullId) => call("start_mergecheck", { pullId }),
    failMergecheck: (pullId, token, error) => call("report_mergecheck", { pullId, token, error }),
    advance: (pullId) => call("advance", { pullId }),
    managedPulls: (repoId) => call("managed_pulls", { repoId }),
    queue: (repo, viewer) => call("queue", { repo, viewer }),
    queueBuild: (repoId) => call("queue_build", { repoId }),
    waitingQueues: () => call("waiting_queues", {}),
    failQueue: (entryId, token, error) => call("report_queue", { entryId, token, error }),
    removeFromQueue: (actor, repo, number) => call("remove_from_queue", { actor, repo, number }),
    getSettings: (repo, viewer) => call("get_settings", { repo, viewer }),
    // Rulesets travel in snake_case (rules.ts).
    listRulesets: (owner, viewer, includeParents = false) => call("list_rulesets", { viewer, ...owner, include_parents: includeParents }),
    getRuleset: (owner, id, viewer) => call("get_ruleset", { viewer, ...owner, id }),
    saveRuleset: (actor, owner, ruleset, id) => call("save_ruleset", { actor, ...owner, id: id ?? null, ruleset }),
    deleteRuleset: (actor, owner, id) => call("delete_ruleset", { actor, ...owner, id }),
    effectiveRules: (repo, name, viewer, target = "branch") => call("effective_rules", { viewer, repo, name, target }),
    ruleEvaluations: (owner, viewer, filter = {}) => call("rule_evaluations", { viewer, ...owner, ...filter }),
    seenChecks: (repo, viewer) => call("seen_checks", { repo, viewer }),
    commitChecks: (repo, viewer, shas) => call("commit_checks", { repo, viewer, shas }),
    getCheckRun: (repo, id, viewer) => call("get_check_run", { repo, id, viewer }),
    checkRunAnnotations: (repo, id, viewer) => call("check_run_annotations", { repo, id, viewer }),
    requestCheckAction: (actor, repo, id, identifier) => call("request_check_action", { actor, repo, id, identifier }),
    rerequestCheckRun: (actor, repo, id) => call("rerequest_check_run", { actor, repo, id }),
    codeownersErrors: (repo, viewer, ref) => call("codeowners_errors", { repo, viewer, ref: ref ?? null }),
    updateSettings: (actor, repo, settings) => call("update_settings", { actor, repo, settings }),
    openPull: (actor, repo, input) => call("open_pull", { actor, repo, ...input }),
    listPulls: (repo, viewer, state, { mergedSince, ...filter } = {}) =>
      call("list_pulls", { repo, viewer, state, ...filter, merged_since: mergedSince ?? null }),
    deliveryInsights: (repoIds, viewer, from, until) => call("delivery_insights", { repoIds, viewer, from, until }),
    workspaceSignals: (args, viewer) => call("workspace_signals", { ...args, viewer }),
    pullsForRepos: (repoIds, viewer, limit) => call("pulls_for_repos", { repoIds, viewer, limit }),
    // Its own fields arrive in snake_case: read into camelCase here.
    getPull: (repo, number, viewer) =>
      call<Result<Record<string, unknown>>>("get_pull", { repo, number, viewer }).then(
        (found): Result<PullDetail> => (found.ok ? { ok: true, value: pullDetailFromWire(found.value) } : found),
      ),
    updatePull: (actor, repo, number, changes) => call("update_pull", { actor, repo, number, ...changes }),
    catchUpPull: (actor, repo, number, options = {}) => call("catch_up_pull", { actor, repo, number, ...options }),
    setAutoMerge: (actor, repo, number, enabled, options = {}) => call("set_auto_merge", { actor, repo, number, enabled, ...options }),
    mergeChoices: (viewer, repo, number) => call("merge_choices", { viewer, repo, number }),
    deleteHeadBranch: (actor, repo, number) => call("delete_head_branch", { actor, repo, number }),
    restoreHeadBranch: (actor, repo, number) => call("restore_head_branch", { actor, repo, number }),
    commitComments: (viewer, repo, commit, page) => call("commit_comments", { viewer, repo, commit: commit ?? null, page: page ?? null }),
    addCommitComment: (actor, repo, commit, body, at) =>
      call("add_commit_comment", { actor, repo, commit, body, path: at?.path ?? null, line: at?.line ?? null }),
    editCommitComment: (actor, repo, id, body) => call("edit_commit_comment", { actor, repo, id, body }),
    deleteCommitComment: (actor, repo, id) => call("delete_commit_comment", { actor, repo, id }),
    readyPull: (actor, repo, number, summary) => call("ready_pull", { actor, repo, number, summary }),
    checkPullTask: (actor, repo, number, check) => call("check_pull_task", { actor, repo, number, ...check }),
    closePull: (actor, repo, number) => call("close_pull", { actor, repo, number }),
    reopenPull: (actor, repo, number) => call("reopen_pull", { actor, repo, number }),
    convertPullToDraft: (actor, repo, number) => call("convert_pull_to_draft", { actor, repo, number }),
    mergePull: (actor, repo, number, options = {}) => call("merge_pull", { actor, repo, number, ...options }),
    listActivePulls: (viewer) => call("list_active_pulls", { viewer }),
    byAuthor: (username, viewer, filter = {}) => call("by_author", { username, viewer, ...filter }),
    contributions: (username, viewer) => call("contributions", { username, viewer }),
    appendSession: (actor, repo, number, entries) => call("append_session", { actor, repo, number, entries }),
    readSession: (repo, number, viewer, afterSeq = 0) => call("read_session", { repo, number, viewer, afterSeq }),
    // Coordination: harness sessions, claims, a work item's whole context
    // and decision records. Their arguments are snake_case, as the Rust
    // service reads them; what comes back is camelCase.
    getWork: (workspace, number, viewer) => call("get_work", { workspace, number, viewer }),
    listClaims: (workspace, viewer, filter = {}) =>
      call("list_claims", {
        workspace,
        viewer,
        repo: filter.repo ?? null,
        state: filter.state ?? null,
        item: filter.item ?? null,
      }),
    claimWorkItem: (actor, workspace, number, note) => call("claim_work_item", { actor, workspace, number, ...(note ? { note } : {}) }),
    releaseClaim: (actor, workspace, number) => call("release_claim", { actor, workspace, number }),
    handOffWorkItem: (actor, workspace, number, note, to) => call("hand_off_work_item", { actor, workspace, number, note, ...(to ? { to } : {}) }),
    listWorkSessions: (repo, viewer, filter = {}) =>
      call("list_work_sessions", {
        repo,
        viewer,
        state: filter.state ?? null,
        item: filter.item ?? null,
        pull: filter.pull ?? null,
        path: filter.path ?? null,
        subagents: filter.subagents ?? false,
      }),
    getWorkSession: (repo, id, viewer, afterSeq = 0) => call("get_work_session", { repo, id, viewer, after_seq: afterSeq }),
    listWorkspaceSessions: (workspace, viewer, filter = {}) =>
      call("list_workspace_sessions", {
        workspace,
        viewer,
        shown: filter.shown ?? "recent",
        kind: filter.kind ?? null,
        harness: filter.harness ?? null,
        person: filter.person ?? null,
        repo: filter.repo ?? null,
        item: filter.item ?? null,
        subagents: filter.subagents ?? false,
        sessions_only: filter.sessionsOnly ?? false,
        limit: filter.limit ?? null,
      }),
    getWorkspaceSession: (workspace, id, viewer, afterSeq = 0) => call("get_workspace_session", { workspace, id, viewer, after_seq: afterSeq }),
    endWorkSession: (actor, repo, id) => call("end_session", { actor, repo, id, by_hand: true }),
    titleWorkSession: (actor, repo, id, title) => call("title_session", { actor, repo, id, title }),
    pullSessions: (repo, viewer, numbers) => call("pull_sessions", { repo, viewer, numbers }),
    listDecisions: (thread, viewer) => call("list_decisions", { ...threadArgs(thread), viewer }),
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
    checkout: (actor, workspace, amountCents, returnUrl, method = "card") => call("checkout", { actor, workspace, amountCents, returnUrl, method }),
    confirm: (workspace, viewer, session) => call("confirm", { workspace, viewer, session }),
    trial: (workspace, exempt) => call("trial", { workspace, exempt }),
    features: (workspace, viewer) => call("features", { workspace, viewer }),
    subscribe: (actor, workspace, feature, returnUrl) => call("subscribe", { actor, workspace, feature, returnUrl }),
    confirmSubscription: (workspace, viewer, session) => call("confirm_subscription", { workspace, viewer, session }),
    cancelSubscription: (actor, workspace, feature, resume = false) => call("cancel_subscription", { actor, workspace, feature, resume }),
    convertToPaid: (actor, workspace, returnUrl) => call("convert_to_paid", { actor, workspace, returnUrl }),
    hasFeature: (workspace, feature) => call("has_feature", { workspace, feature }),
    freeWorkspaces: (workspaces) => call("free_workspaces", { workspaces }),
    chargeFeature: (charge) => call("charge_feature", charge),
    billingPortal: (actor, workspace, returnUrl) => call("billing_portal", { actor, workspace, return_url: returnUrl }),
    setCustomerEmail: (actor, workspace, email) => call("set_customer_email", { actor, workspace, email }),
    recordSandbox: (usage) => call("record_sandbox", usage),
    limit: (workspace, viewer) => call("limit", { workspace, viewer }),
    checkLimit: (workspace) => call("check_limit", { workspace }),
    prices: () => call("prices", {}),
    notePending: (workspace, source, costMicros, detail = null, month = null) =>
      call("note_pending", { workspace, source, costMicros, detail, ...(month ? { month } : {}) }),
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
    usageReport: (workspace, viewer, range) =>
      call("usage_report", { workspace, viewer, from: range.from, until: range.until, products: range.products ?? [], projects: range.projects ?? [] }),
    setBudget: (actor, workspace, budget) => call("set_budget", { actor, workspace, ...budget }),
    billingDetails: (workspace, viewer) => call("billing_details", { workspace, viewer }),
    setBillingDetails: (actor, workspace, details) => call("set_billing_details", { actor, workspace, ...details }),
    providerConnections: (workspace, viewer) => call("provider_connections", { workspace, viewer }),
    connectProvider: (actor, workspace, provider, credential) => call("connect_provider", { actor, workspace, provider, credential }),
    disconnectProvider: (actor, workspace, provider) => call("disconnect_provider", { actor, workspace, provider }),
    providerCosts: (workspace, viewer, since) => call("provider_costs", { workspace, viewer, since }),
    providerPersonCosts: (workspace, viewer, options) =>
      call("provider_person_costs", { workspace, viewer, userId: options.userId, since: options.since, until: options.until }),
  };
}

export function billingAdminClient(service: ServiceBinding): BillingAdminApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    accounts: (query) => call("admin_accounts", { query: query ?? null }),
    account: (id) => call("admin_account", { id }),
    setTerms: (id, terms, by) => call("admin_set_terms", { id, terms, by }),
    setAllowances: (id, allowances, note, by) => call("admin_set_allowances", { id, allowances, note, by }),
    complimentary: (workspace) => call("admin_complimentary", { workspace }),
    setComplimentary: (workspace, terms, note, by) =>
      call("admin_set_complimentary", {
        workspace,
        allowance_micros: terms.allowanceMicros,
        unlimited: terms.unlimited,
        fee_cents: terms.feeCents,
        charge_past_allowance: terms.chargePastAllowance,
        note,
        by,
      }),
    endComplimentary: (workspace, note, by) => call("admin_end_complimentary", { workspace, note, by }),
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
    detachTestStripe: (a) =>
      call("admin_detach_test_stripe", {
        workspace: a.workspace ?? null,
        exclude: a.exclude ?? null,
        dry_run: a.dryRun,
        cancel_at_stripe: a.cancelAtStripe ?? false,
        confirm: a.confirm ?? "",
        by: a.by,
      }),
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
    audit: (filter = {}) => call("admin_audit", { by: filter.by ?? null, action: filter.action ?? null, before: filter.before ?? null }),
    log: (entry, by) =>
      call("admin_log", {
        workspace: entry.workspace ?? "",
        account: entry.account ?? null,
        action: entry.action,
        detail: entry.detail,
        by,
        key: entry.key ?? null,
      }),
    limitRequests: (status = "open") => call("admin_limit_requests", { status }),
    decideLimitRequest: (id, decision, amountMicros, note, by) => call("admin_decide_limit_request", { id, decision, amount_micros: amountMicros, note, by }),
    overages: () => call("admin_overages", {}),
    goodwill: (workspace, amountMicros, reason, by, day = null, requestKey = null) =>
      call("admin_goodwill", { workspace, amount_micros: amountMicros, reason, by, day, request_key: requestKey }),
    velocity: () => call("admin_velocity", {}),
    recordPayment: (workspace, amountMicros, reference, note, by) =>
      call("admin_record_payment", { workspace, amount_micros: amountMicros, reference, note, by }),
    costs: (days) => call("admin_costs", { days: days ?? null }),
    costAlerts: () => call("admin_cost_alerts", {}),
    spendCaps: () => call("admin_spend_caps", {}),
    liftBreaker: (note, by) => call("admin_lift_breaker", { note, by }),
    platformGuard: () => call("admin_platform_guard", {}),
    setPause: (level, paused, note, by) => call("admin_set_pause", { level, paused, note, by }),
    gitEdge: () => call("admin_git_edge", {}),
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
    activityDigest: (args) => call("activity_digest", args),
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
    import: (actor, workspace, reference, options) =>
      call("import", { actor, workspace, reference, repo: options?.repo ?? null, targets: options?.targets ?? [] }),
    links: (workspace, number) => call("links", { workspace, number }),
  };
}

/**
 * A workspace's AI providers and Ask g1t. Kept by the integrations service,
 * so it is built on the same binding, with its own methods.
 */
export function aiClient(service: ServiceBinding): AiApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace, viewer) => call("ai_list", { workspace, viewer }),
    add: (actor, workspace, input) => call("ai_add", { actor, workspace, ...input }),
    update: (actor, workspace, id, input) => call("ai_update", { actor, workspace, id, ...input }),
    remove: (actor, workspace, id) => call("ai_remove", { actor, workspace, id }),
    test: (actor, workspace, id) => call("ai_test", { actor, workspace, id }),
    askSettings: (workspace, viewer) => call("ask_settings", { workspace, viewer }),
    setAskSettings: (actor, workspace, providerId, model) => call("set_ask_settings", { actor, workspace, provider_id: providerId, model }),
    // Streamed: the response itself, not its parsed body.
    ask: (actor, workspace, messages, page, signal) =>
      service.fetch("https://service/rpc/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor, workspace, messages, page }),
        signal,
      }),
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
    run: (repo, viewer, id, attempt) => call("run", { repo, viewer, id, attempt: attempt ?? null }),
    logs: (repo, viewer, job, after = 0) => call("logs", { repo, viewer, job, after }),
    summaries: (repo, viewer, id, attempt) => call("summaries", { repo, viewer, id, attempt: attempt ?? null }),
    jobLogText: (repo, viewer, job) => call("job_log_text", { repo, viewer, job }),
    runLogs: (repo, viewer, id, attempt) => call("run_logs", { repo, viewer, id, attempt: attempt ?? null }),
    dispatch: (actor, repo, workflow, ref, inputs) => call("dispatch", { actor, repo, workflow, ref, inputs }),
    cancel: (actor, repo, id, force = false) => call("cancel", { actor, repo, id, force }),
    rerun: (actor, repo, id, failedOnly = false, options = {}) =>
      call("rerun", { actor, repo, id, failed_only: failedOnly, job: options.job ?? null, debug: options.debug ?? false }),
    setWorkflowEnabled: (actor, repo, workflow, enabled) => call("set_workflow_enabled", { actor, repo, workflow, enabled }),
    settings: (actor, owner, kind) => call("settings", { actor, ...owner, kind }),
    setSetting: (actor, owner, kind, name, value, options = {}) => call("set_setting", { actor, ...owner, kind, name, value, ...options }),
    deleteSetting: (actor, owner, kind, name, id) => call("delete_setting", { actor, ...owner, kind, name, id }),
    approveRun: (actor, repo, id) => call("approve_run", { actor, repo, id }),
    pendingDeployments: (repo, viewer, id) => call("pending_deployments", { repo, viewer, id }),
    reviewDeployments: (actor, repo, id, state, environments = [], comment) =>
      call("review_deployments", { actor, repo, id, state, environments, comment: comment ?? null }),
    actionsSettings: (repo, viewer) => call("actions_settings", { repo, viewer }),
    setActionsSettings: (actor, repo, change) => call("set_actions_settings", { actor, repo, ...change }),
    workspaceActionsSettings: (workspace, viewer) => call("workspace_actions_settings", { workspace, viewer }),
    setWorkspaceActionsSettings: (actor, workspace, change) => call("set_workspace_actions_settings", { actor, workspace, ...change }),
    workspaceManagedWorkflows: (workspace, viewer) => call("workspace_managed_workflows", { workspace, viewer }),
    setWorkspaceManagedWorkflow: (actor, workspace, name, change, create = false) =>
      call("set_workspace_managed_workflow", { actor, workspace, name, create, ...change }),
    removeWorkspaceManagedWorkflow: (actor, workspace, name) => call("remove_workspace_managed_workflow", { actor, workspace, name }),
    environments: (repo, viewer) => call("environments", { repo, viewer }),
    setEnvironment: (actor, repo, name, change) => call("set_environment", { actor, repo, name, ...change }),
    deleteEnvironment: (actor, repo, name) => call("delete_environment", { actor, repo, name }),
    artifacts: (repo, viewer, filter = {}) => call("artifacts", { repo, viewer, ...filter }),
    artifactDownload: (repo, viewer, by) => call("artifact_download", { repo, viewer, ...by }),
    deleteArtifact: (actor, repo, id) => call("delete_artifact", { actor, repo, id }),
    artifactRetention: (repo, viewer, days) => call("artifact_retention", { repo, viewer, days }),
  };
}

/** Staff-only self-hosted runners, on the actions service: only sudo calls it. */
export function runnersAdminClient(service: ServiceBinding): RunnersAdminApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace) => call("admin_runners", { workspace }),
    remove: (workspace, id, staff) => call("admin_remove_runners", { workspace, id, staff }),
  };
}

/** Staff-only public storage holds, on the repos service: only sudo calls it. */
export function reposAdminClient(service: ServiceBinding): ReposAdminApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    holds: (limit) => call("admin_storage_holds", { limit: limit ?? null }),
    inspect: (kind, id) => call("admin_inspect_storage_hold", { kind, id }),
    release: (kind, id, staff, reason) => call("admin_release_storage_hold", { kind, id, staff, reason }),
    recoveries: (limit) => call("admin_storage_recoveries", { limit: limit ?? null }),
    drift: (options = {}) =>
      call("admin_storage_drift", { sample: options.sample ?? null, maxBytes: options.maxBytes ?? null, repoIds: options.repoIds ?? [] }),
  };
}

/** Self-hosted runners, kept by the actions service. */
export function runnersClient(service: ServiceBinding): RunnersApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    stuck: (viewer) => call("stuck_jobs", { viewer }),
    activity: (actor, workspace) => call("runner_activity", { actor, workspace }),
    list: (actor, owner) => call("runners", { actor, ...owner }),
    createToken: (actor, owner, group) => call("create_registration_token", { actor, ...owner, group }),
    remove: (actor, owner, id) => call("remove_runner", { actor, ...owner, id }),
    groups: (actor, workspace) => call("runner_groups", { actor, workspace }),
    setGroup: (actor, workspace, group) => call("set_runner_group", { actor, workspace, ...group }),
    deleteGroup: (actor, workspace, id) => call("delete_runner_group", { actor, workspace, id }),
    settings: (actor, owner) => call("runner_settings", { actor, ...owner }),
    setSettings: (actor, owner, change) => call("set_runner_settings", { actor, ...owner, ...change }),
    reportDesktop: (actor, report) => call("report_desktop", { actor, ...report }),
    desktops: (actor, workspace) => call("desktop_runners", { actor, workspace }),
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
    overview: (workspace, viewer) => call("overview", { workspace, viewer }),
    usage: (workspace, viewer) => call("usage", { workspace, viewer }),
    domains: (project, viewer) => call("domains", { project, viewer }),
    addDomain: (actor, project, hostname, options = {}) => call("add_domain", { actor, project, hostname, twin: !!options.twin }),
    removeDomain: (actor, project, id) => call("remove_domain", { actor, project, id }),
    refreshDomain: (actor, project, id) => call("refresh_domain", { actor, project, id }),
    repoDeployments: (repo, viewer, filter = {}) => call("list_deployments", { repo, viewer, ...filter }),
    repoDeployment: (repo, id, viewer) => call("get_deployment", { repo, id, viewer }),
    environments: (repo, viewer) => call("list_environments", { repo, viewer }),
    createDeployment: (actor, repo, input) => call("create_deployment", { repo, actor, ...input }),
    createDeploymentStatus: (actor, repo, id, input) => call("create_deployment_status", { repo, actor, id, ...input }),
    shipped: (workspace, viewer, repos) => call("shipped", { workspace, viewer, repos }),
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
    deletePackage: (actor, workspace, ecosystem, name, surface) => call("delete_package", { actor, workspace, ecosystem, name, surface: surface ?? null }),
    set: (actor, workspace, ecosystem, name, change, surface) =>
      call("set_package", {
        actor,
        workspace,
        ecosystem,
        name,
        visibility: change.visibility ?? null,
        link: change.link ?? null,
        unlink: change.unlink ?? false,
        inherit_access: change.inheritAccess ?? null,
        surface: surface ?? null,
      }),
    settings: (workspace, ecosystem, name, viewer) => call("package_settings", { workspace, ecosystem, name, viewer }),
    deleted: (workspace, viewer) => call("deleted_packages", { workspace, viewer }),
    restorePackage: (actor, workspace, ecosystem, name, surface) => call("restore_package", { actor, workspace, ecosystem, name, surface: surface ?? null }),
    restoreVersion: (actor, workspace, ecosystem, name, version, surface) =>
      call("restore_version", { actor, workspace, ecosystem, name, version, surface: surface ?? null }),
    setAccess: (actor, workspace, ecosystem, name, who, role, surface) =>
      call("set_package_access", {
        actor,
        workspace,
        ecosystem,
        name,
        user: "user" in who ? who.user : null,
        team: "team" in who ? who.team : null,
        role,
        surface: surface ?? null,
      }),
    removeAccess: (actor, workspace, ecosystem, name, who, surface) =>
      call("remove_package_access", {
        actor,
        workspace,
        ecosystem,
        name,
        user: "user" in who ? who.user : null,
        team: "team" in who ? who.team : null,
        surface: surface ?? null,
      }),
    setActionsAccess: (actor, workspace, ecosystem, name, repo, role, surface) =>
      call("set_actions_access", { actor, workspace, ecosystem, name, repo, role, surface: surface ?? null }),
    removeActionsAccess: (actor, workspace, ecosystem, name, repo, surface) =>
      call("remove_actions_access", { actor, workspace, ecosystem, name, repo, surface: surface ?? null }),
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
    describe: (actor, repoId, description) => call("describe", { actor, repoId, description }),
    descriptions: (repoIds) => (repoIds.length ? call("descriptions", { repoIds }) : Promise.resolve({})),
    create: (actor, workspace, input) => call("create", { actor, workspace, input }),
    update: (actor, workspace, slug, changes) => call("update", { actor, workspace, slug, changes }),
    setProductionImage: (actor, workspace, slug, change) => call("set_production_image", { actor, workspace, slug, change }),
    externalProductions: () => call("external_productions", {}),
    deploymentsChanged: (projectId, enabled) => call("deployments_changed", { projectId, enabled }),
    shortcuts: (workspace, viewer) => call("shortcuts", { workspace, viewer }),
    pin: (actor, workspace, slug, position) => call("pin", { actor, workspace, slug, position: position ?? null }),
    unpin: (actor, workspace, slug) => call("unpin", { actor, workspace, slug }),
    reorderPins: (actor, workspace, slugs) => call("reorder_pins", { actor, workspace, slugs }),
    visited: (actor, projectId) => call("visited", { actor, projectId }),
    publicLinks: (repos) => call("public_links", { repos }),
  };
}
