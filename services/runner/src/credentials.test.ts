import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { credentialHashes, holdCredentials, revokeCredentials, sha256Hex } from "./credentials.ts";

test("tokens are hashed the way identity stores them", async () => {
  const token = "g1t_0123456789abcdef";
  assert.equal(await sha256Hex(token), createHash("sha256").update(token).digest("hex"));
  const hashes = await credentialHashes({ G1T_TOKEN: token, OTHER: "g1t_y", CHECK_TOKEN: "c" });
  assert.equal(hashes.length, 1);
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
  await holdCredentials(identity, storage, { G1T_TOKEN: "g1t_a" }, "run_1");
  assert.equal(identity.calls[0].method, "bind_run_credentials");
  assert.deepEqual((identity.calls[0].body as { runId: string }).runId, "run_1");
  await revokeCredentials(identity, storage);
  await revokeCredentials(identity, storage);
  const revokes = identity.calls.filter((call) => call.method === "revoke_run_credentials");
  assert.equal(revokes.length, 1);
  assert.equal((revokes[0].body as { tokenHashes: string[] }).tokenHashes.length, 1);
});

test("a sandbox with no run record still has its credentials revoked", async () => {
  const identity = fakeIdentity();
  const storage = memoryStorage();
  await holdCredentials(identity, storage, { G1T_TOKEN: "g1t_a" }, null);
  assert.equal(identity.calls.length, 0);
  await revokeCredentials(identity, storage);
  assert.equal(identity.calls[0].method, "revoke_run_credentials");
});
