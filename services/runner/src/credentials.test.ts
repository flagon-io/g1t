import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { credentialHashes, holdCredentials, modelTokenHashes, pushGrant, remotePath, revokeCredentials, sha256Hex } from "./credentials.ts";

test("a remote names its repository", () => {
  assert.deepEqual(remotePath("https://g1t.sh/acme/rocket.git"), { namespace: "acme", name: "rocket" });
  assert.deepEqual(remotePath("https://g1t.sh/pulls/pul_01abc.git"), { namespace: "pulls", name: "pul_01abc" });
  assert.equal(remotePath("https://g1t.sh/acme"), null);
});

test("a fork is the pull request's own; a branch of the repository is not", () => {
  const repo = { namespace: "acme", name: "rocket" };
  assert.deepEqual(pushGrant(repo, { namespace: "pulls", name: "pul_1" }, "main"), {
    repo: { namespace: "pulls", name: "pul_1" },
    branch: null,
  });
  assert.deepEqual(pushGrant(repo, { namespace: "Acme", name: "Rocket" }, "fix-login"), {
    repo: { namespace: "Acme", name: "Rocket" },
    branch: "fix-login",
  });
});

test("tokens are hashed the way identity stores them", async () => {
  const token = "g1t_0123456789abcdef";
  assert.equal(await sha256Hex(token), createHash("sha256").update(token).digest("hex"));
  const hashes = await credentialHashes({ G1T_TOKEN: token, G1T_AGENT_TOKEN: "g1t_x", OTHER: "g1t_y", CHECK_TOKEN: "c" });
  assert.equal(hashes.length, 2);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
});

/** Identity, as far as the credentials' lifecycle uses it. */
function fakeIdentity() {
  const calls: { method: string; body: unknown }[] = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ method: url.split("/rpc/")[1], body: JSON.parse(String(init?.body)) });
      return new Response("true");
    },
  };
}

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    put: async (key: string, value: unknown) => void map.set(key, value),
    get: async <T>(key: string) => map.get(key) as T | undefined,
    delete: async (key: string) => map.delete(key),
  };
}

test("a sandbox's credentials are bound to its run and revoked once when it stops", async () => {
  const identity = fakeIdentity();
  const storage = memoryStorage();
  await holdCredentials(identity, storage, { G1T_TOKEN: "g1t_a", G1T_AGENT_TOKEN: "g1t_b" }, "run_1");
  assert.equal(identity.calls[0].method, "bind_run_credentials");
  assert.deepEqual((identity.calls[0].body as { runId: string }).runId, "run_1");
  await revokeCredentials(identity, storage);
  await revokeCredentials(identity, storage);
  const revokes = identity.calls.filter((call) => call.method === "revoke_run_credentials");
  assert.equal(revokes.length, 1);
  assert.equal((revokes[0].body as { tokenHashes: string[] }).tokenHashes.length, 2);
});

test("a sandbox with no run record still has its credentials revoked", async () => {
  const identity = fakeIdentity();
  const storage = memoryStorage();
  await holdCredentials(identity, storage, { G1T_TOKEN: "g1t_a" }, null);
  assert.equal(identity.calls.length, 0);
  await revokeCredentials(identity, storage);
  assert.equal(identity.calls[0].method, "revoke_run_credentials");
});

test("a run's model token is closed when the run stops, once", async () => {
  const identity = fakeIdentity();
  const integrations = fakeIdentity();
  const storage = memoryStorage();
  const token = "g1tm_0123456789abcdef";
  await holdCredentials(identity, storage, { G1T_TOKEN: "g1t_a", ANTHROPIC_API_KEY: token, AI_GATEWAY_TOKEN: token }, "run_1");
  assert.deepEqual(await modelTokenHashes({ ANTHROPIC_API_KEY: token, OTHER: "sk-x" }), [await sha256Hex(token)]);
  await revokeCredentials(identity, storage, integrations);
  await revokeCredentials(identity, storage, integrations);
  assert.equal(integrations.calls.length, 1);
  assert.equal(integrations.calls[0].method, "close_model_sessions");
  assert.deepEqual((integrations.calls[0].body as { token_hashes: string[] }).token_hashes, [await sha256Hex(token)]);
  assert.equal(identity.calls.filter((call) => call.method === "revoke_run_credentials").length, 1);
});

test("a sandbox with only a model token still has it closed", async () => {
  const identity = fakeIdentity();
  const integrations = fakeIdentity();
  const storage = memoryStorage();
  await holdCredentials(identity, storage, { ANTHROPIC_API_KEY: "g1tm_x" }, null);
  await revokeCredentials(identity, storage, integrations);
  assert.equal(integrations.calls[0]?.method, "close_model_sessions");
  assert.equal(identity.calls.length, 0);
});
