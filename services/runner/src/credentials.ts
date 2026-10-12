/**
 * Run credentials: the tokens a sandbox works with. Each is bound to its
 * run, its repository and what that kind of run needs, acts on behalf of
 * the person (or g1t itself) the work is for, and is revoked the moment
 * the sandbox stops. See `crates/contracts/src/credentials.rs` for what
 * each kind of run may do.
 */

import type { CreateRunCredentialInput, ServiceBinding } from "@g1t/contracts";

/** The environment variable a sandbox's g1t token is passed in. */
export const CREDENTIAL_VARS = ["G1T_TOKEN"] as const;

const STORAGE_KEY = "credentials";

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
  const hashes = await credentialHashes(envVars);
  if (hashes.length === 0) return;
  await storage.put(STORAGE_KEY, hashes);
  if (!runId) return;
  await call(identity, "bind_run_credentials", { tokenHashes: hashes, runId }).catch((error: unknown) => console.log("run credentials not bound", runId, String(error)));
}

/** Ends a sandbox's g1t credentials, once. */
export async function revokeCredentials(identity: ServiceBinding, storage: Storage): Promise<void> {
  const hashes = await storage.get<string[]>(STORAGE_KEY);
  if (!hashes?.length) return;
  await storage.delete(STORAGE_KEY);
  await call(identity, "revoke_run_credentials", { tokenHashes: hashes }).catch((error: unknown) => console.log("run credentials not revoked", String(error)));
}
