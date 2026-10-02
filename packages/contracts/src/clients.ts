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
    forkForAttempt: (sourceId, attemptId, actor) =>
      call("fork_for_attempt", { sourceId, attemptId, actor }),
    gitAccess: (path, viewer, service) =>
      call("git_access", { path, viewer, service }),
    land: (forkId, actor) => call("land", { forkId, actor }),
    compare: (repoId, viewer, base) => call("compare", { repoId, viewer, base }),
  };
}

export function workClient(service: ServiceBinding): WorkApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    openIntent: (actor, repo, input) => call("open_intent", { actor, repo, ...input }),
    listIntents: (repo, viewer, status) => call("list_intents", { repo, viewer, status }),
    getIntent: (repo, number, viewer) => call("get_intent", { repo, number, viewer }),
    withdrawIntent: (actor, intentId) => call("withdraw_intent", { actor, intentId }),
    startAttempt: (actor, intentId, input) =>
      call("start_attempt", { actor, intentId, ...input }),
    getAttempt: (attemptId, viewer) => call("get_attempt", { attemptId, viewer }),
    submitAttempt: (actor, attemptId, summary) =>
      call("submit_attempt", { actor, attemptId, summary }),
    abandonAttempt: (actor, attemptId) => call("abandon_attempt", { actor, attemptId }),
    shipAttempt: (actor, attemptId) => call("ship_attempt", { actor, attemptId }),
    listActiveAttempts: (viewer) => call("list_active_attempts", { viewer }),
    appendSession: (actor, attemptId, entries) =>
      call("append_session", { actor, attemptId, entries }),
    readSession: (attemptId, viewer, afterSeq = 0) =>
      call("read_session", { attemptId, viewer, afterSeq }),
  };
}
