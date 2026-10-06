/**
 * Run credentials: the tokens a sandbox works with. Each is bound to its
 * run, its repository and what that kind of run needs, acts as an agent on
 * behalf of the person who started the work, and is revoked the moment
 * the sandbox stops. See `crates/contracts/src/credentials.rs` for what
 * each kind of run may do.
 */

import type { CreateRunCredentialInput, GitGrant, RepoPath, ServiceBinding } from "@g1t/contracts";

/** The environment variables a sandbox's g1t tokens are passed in. */
export const CREDENTIAL_VARS = ["G1T_TOKEN", "G1T_AGENT_TOKEN"] as const;

const STORAGE_KEY = "credentials";

/** How a run's model token starts (a model session, held by integrations). */
export const MODEL_TOKEN_PREFIX = "g1tm_";
const MODEL_STORAGE_KEY = "modelSessions";

/** Identity's JSON protocol, as the contracts' client speaks it. */
async function call<T>(identity: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await identity.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

/** A run credential's text. */
export async function runCredential(identity: ServiceBinding, input: CreateRunCredentialInput): Promise<string> {
  const { token } = await call<{ token: string }>(identity, "create_run_credential", input);
  return token;
}

/** The repository a `https://g1t.sh/<namespace>/<name>.git` remote names. */
export function remotePath(url: string): RepoPath | null {
  const match = /^https:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { namespace: match[1], name: match[2] } : null;
}

function samePath(a: RepoPath, b: RepoPath): boolean {
  return a.namespace.toLowerCase() === b.namespace.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * Where a run working on a pull request may push: anywhere in the pull
 * request's fork, which is its own; only its branch when the change is a
 * branch of the repository itself.
 */
export function pushGrant(repo: RepoPath, source: RepoPath, branch: string | null | undefined): GitGrant {
  return samePath(repo, source) ? { repo: source, branch: branch ?? null } : { repo: source, branch: null };
}

/** SHA-256 in lowercase hex, as identity stores tokens. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The hashes of the g1t tokens among a sandbox's variables. */
export async function credentialHashes(envVars: Record<string, string>): Promise<string[]> {
  const tokens = CREDENTIAL_VARS.map((name) => envVars[name]).filter(
    (value): value is string => typeof value === "string" && value.startsWith("g1t_"),
  );
  return Promise.all(tokens.map(sha256Hex));
}

/** The hashes of the run's model tokens among a sandbox's variables, each once. */
export async function modelTokenHashes(envVars: Record<string, string>): Promise<string[]> {
  const tokens = new Set(Object.values(envVars).filter((value) => typeof value === "string" && value.startsWith(MODEL_TOKEN_PREFIX)));
  return Promise.all([...tokens].map(sha256Hex));
}

type Storage = {
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
};

/**
 * Remembers a sandbox's credentials, by hash, so they can be revoked when
 * it stops, and ties them to the run it recorded. Never stops the sandbox
 * from starting.
 */
export async function holdCredentials(
  identity: ServiceBinding,
  storage: Storage,
  envVars: Record<string, string>,
  runId: string | null,
): Promise<void> {
  const models = await modelTokenHashes(envVars);
  if (models.length > 0) await storage.put(MODEL_STORAGE_KEY, models);
  const hashes = await credentialHashes(envVars);
  if (hashes.length === 0) return;
  await storage.put(STORAGE_KEY, hashes);
  if (!runId) return;
  await call(identity, "bind_run_credentials", { tokenHashes: hashes, runId }).catch((error: unknown) => console.log("run credentials not bound", runId, String(error)));
}

/**
 * Ends a sandbox's credentials, once: its g1t tokens, and, when
 * `integrations` is given, its model tokens, which the model proxy then
 * refuses within seconds rather than when they would lapse.
 */
export async function revokeCredentials(identity: ServiceBinding, storage: Storage, integrations?: ServiceBinding): Promise<void> {
  const models = integrations ? await storage.get<string[]>(MODEL_STORAGE_KEY) : undefined;
  if (integrations && models?.length) {
    await storage.delete(MODEL_STORAGE_KEY);
    await call(integrations, "close_model_sessions", { token_hashes: models }).catch((error: unknown) =>
      console.log("model sessions not closed", String(error)),
    );
  }
  const hashes = await storage.get<string[]>(STORAGE_KEY);
  if (!hashes?.length) return;
  await storage.delete(STORAGE_KEY);
  await call(identity, "revoke_run_credentials", { tokenHashes: hashes }).catch((error: unknown) => console.log("run credentials not revoked", String(error)));
}
