import type { ActionsApi } from "./actions";
import type { BillingApi } from "./billing";
import type { DeploymentsApi } from "./deployments";
import type { ProjectsApi } from "./projects";
import type { EventsApi } from "./events";
import type { IdentityApi } from "./identity";
import type { IntegrationsApi } from "./integrations";
import type { WebhooksApi } from "./webhooks";
import type { ReposApi } from "./repos";
import type { WorkApi } from "./work";

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
    register: (username, email, password) =>
      call("register", { username, email, password }),
    signIn: (username, password) => call("sign_in", { username, password }),
    signOut: (sessionToken) => call("sign_out", { sessionToken }),
    resendVerification: (user) => call("resend_verification", { user }),
    verifyEmail: (token) => call("verify_email", { token }),
    requestPasswordReset: (email) => call("request_password_reset", { email }),
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
    createWorkspace: (user, slug, name) => call("create_workspace", { user, slug, name }),
    getWorkspace: (slug) => call("get_workspace", { slug }),
    listMembers: (slug, viewer) => call("list_members", { slug, viewer }),
    addMember: (actor, slug, username) => call("add_member", { actor, slug, username }),
    removeMember: (actor, slug, username) =>
      call("remove_member", { actor, slug, username }),
    updateWorkspace: (actor, slug, details) =>
      call("update_workspace", { actor, slug, ...details }),
    listWorkspaceTokens: (slug, viewer) => call("list_workspace_tokens", { slug, viewer }),
    createWorkspaceToken: (actor, slug, name) =>
      call("create_workspace_token", { actor, slug, name }),
    removeWorkspaceToken: (actor, slug, id) =>
      call("remove_workspace_token", { actor, slug, id }),
    userForSession: (sessionToken) => call("user_for_session", { sessionToken }),
    userForGitCredentials: (username, secret) =>
      call("user_for_git_credentials", { username, secret }),
    userForAccessToken: (token) => call("user_for_access_token", { token }),
    userForSshKey: (fingerprint) => call("user_for_ssh_key", { fingerprint }),
    userByUsername: (username) => call("user_by_username", { username }),
    usernames: (ids) => call("usernames", { ids }),
    listSshKeys: (user) => call("list_ssh_keys", { user }),
    addSshKey: (user, title, publicKey) =>
      call("add_ssh_key", { user, title, publicKey }),
    removeSshKey: (user, id) => call("remove_ssh_key", { user, id }),
    listAccessTokens: (user) => call("list_access_tokens", { user }),
    createAccessToken: (user, name, ttlSeconds) =>
      call("create_access_token", { user, name, ttlSeconds }),
    createAgentToken: (onBehalfOf, scope, ttlSeconds) =>
      call("create_agent_token", { onBehalfOf, scope, ttlSeconds }),
    removeAccessToken: (user, id) => call("remove_access_token", { user, id }),
  };
}

export function reposClient(service: ServiceBinding): ReposApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    get: (path, viewer) => call("get", { path, viewer }),
    getById: (id, viewer) => call("get_by_id", { id, viewer }),
    list: (viewer, options = {}) => call("list", { viewer, ...options }),
    create: (owner, input) => call("create", { owner, ...input }),
    update: (actor, path, changes) => call("update", { actor, path, ...changes }),
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
    land: (sourceId, actor, branch) => call("land", { sourceId, actor, branch }),
    compare: (repoId, viewer, base, head) => call("compare", { repoId, viewer, base, head }),
  };
}

export function workClient(service: ServiceBinding): WorkApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    openIssue: (actor, repo, input) => call("open_issue", { actor, repo, ...input }),
    listIssues: (repo, viewer, filter = {}) => call("list_issues", { repo, viewer, ...filter }),
    getIssue: (repo, number, viewer) => call("get_issue", { repo, number, viewer }),
    updateIssue: (actor, repo, number, input) =>
      call("update_issue", { actor, repo, number, ...input }),
    closeIssue: (actor, repo, number, reason) =>
      call("close_issue", { actor, repo, number, reason }),
    reopenIssue: (actor, repo, number) => call("reopen_issue", { actor, repo, number }),
    listLabels: (repo, viewer) => call("list_labels", { repo, viewer }),
    counts: (repo, viewer) => call("counts", { repo, viewer }),
    addComment: (actor, repo, number, comment) =>
      call("add_comment", { actor, repo, number, ...comment }),
    startChecks: (pullId) => call("start_checks", { pullId }),
    reportChecks: (runId, token, report) =>
      call("report_checks", { runId, token, ...report }),
    startReview: (pullId) => call("start_review", { pullId }),
    failReview: (runId, token, error) => call("report_review", { runId, token, error }),
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
    updateSettings: (actor, repo, settings) =>
      call("update_settings", { actor, repo, settings }),
    openPull: (actor, repo, input) => call("open_pull", { actor, repo, ...input }),
    listPulls: (repo, viewer, state) => call("list_pulls", { repo, viewer, state }),
    getPull: (repo, number, viewer) => call("get_pull", { repo, number, viewer }),
    updatePull: (actor, repo, number, changes) =>
      call("update_pull", { actor, repo, number, ...changes }),
    readyPull: (actor, repo, number, summary) =>
      call("ready_pull", { actor, repo, number, summary }),
    closePull: (actor, repo, number) => call("close_pull", { actor, repo, number }),
    mergePull: (actor, repo, number, options = {}) =>
      call("merge_pull", { actor, repo, number, ...options }),
    listActivePulls: (viewer) => call("list_active_pulls", { viewer }),
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
    usage: (workspace, viewer, since) => call("usage", { workspace, viewer, since }),
    checkout: (actor, workspace, amountCents, returnUrl) =>
      call("checkout", { actor, workspace, amountCents, returnUrl }),
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
    chargeFeature: (charge) => call("charge_feature", charge),
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
    dependencies: (workspace, slug, viewer) => call("dependencies", { workspace, slug, viewer }),
    addDependency: (actor, workspace, slug, on, as) => call("add_dependency", { actor, workspace, slug, on, as }),
    removeDependency: (actor, workspace, slug, on) => call("remove_dependency", { actor, workspace, slug, on }),
    graph: (projectId) => call("graph", { projectId }),
  };
}
