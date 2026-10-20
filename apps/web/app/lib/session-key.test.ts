import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionKey } from "./session-key.ts";

test("a session is kept under a hash of its token, never the token", async () => {
  const token = "ab".repeat(32);
  const key = await sessionKey(token);
  assert.match(key, /^session:[0-9a-f]{64}$/);
  assert.ok(!key.includes(token));
  assert.equal(await sessionKey(token), key, "the same session, the same key");
  assert.notEqual(await sessionKey("cd".repeat(32)), key);
});
