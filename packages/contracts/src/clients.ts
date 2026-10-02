import type { IdentityApi } from "./identity";
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
  return response.json();
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
    userForSession: (sessionToken) => call("user_for_session", { sessionToken }),
    userForGitCredentials: (username, secret) =>
      call("user_for_git_credentials", { username, secret }),
    userForAccessToken: (token) => call("user_for_access_token", { token }),
    userForSshKey: (fingerprint) => call("user_for_ssh_key", { fingerprint }),
    userByUsername: (username) => call("user_by_username", { username }),
    listSshKeys: (user) => call("list_ssh_keys", { user }),
    addSshKey: (user, title, publicKey) =>
      call("add_ssh_key", { user, title, publicKey }),
    removeSshKey: (user, id) => call("remove_ssh_key", { user, id }),
    listAccessTokens: (user) => call("list_access_tokens", { user }),
    createAccessToken: (user, name, ttlSeconds) =>
      call("create_access_token", { user, name, ttlSeconds }),
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
    tree: (path, viewer, ref, treePath) =>
      call("tree", { path, viewer, ref, treePath }),
    blob: (path, viewer, ref, filePath) =>
      call("blob", { path, viewer, ref, filePath }),
    log: (path, viewer, ref, limit) => call("log", { path, viewer, ref, limit }),
    forkForPull: (sourceId, pullId, actor) =>
      call("fork_for_pull", { sourceId, pullId, actor }),
    gitAccess: (path, viewer, service) =>
      call("git_access", { path, viewer, service }),
    land: (forkId, actor) => call("land", { forkId, actor }),
    compare: (repoId, viewer, base) => call("compare", { repoId, viewer, base }),
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
    addComment: (actor, repo, number, body) =>
      call("add_comment", { actor, repo, number, body }),
    openPull: (actor, repo, input) => call("open_pull", { actor, repo, ...input }),
    listPulls: (repo, viewer, state) => call("list_pulls", { repo, viewer, state }),
    getPull: (repo, number, viewer) => call("get_pull", { repo, number, viewer }),
    readyPull: (actor, repo, number, summary) =>
      call("ready_pull", { actor, repo, number, summary }),
    closePull: (actor, repo, number) => call("close_pull", { actor, repo, number }),
    mergePull: (actor, repo, number, keepIssueOpen = false) =>
      call("merge_pull", { actor, repo, number, keepIssueOpen }),
    listActivePulls: (viewer) => call("list_active_pulls", { viewer }),
    appendSession: (actor, repo, number, entries) =>
      call("append_session", { actor, repo, number, entries }),
    readSession: (repo, number, viewer, afterSeq = 0) =>
      call("read_session", { repo, number, viewer, afterSeq }),
  };
}
