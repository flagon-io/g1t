import assert from "node:assert/strict";
import { test } from "node:test";

import { beforeForgetting, cleanChannelId, forgotKey } from "./forget.ts";

test("a notification of a message from before the clear is dropped; one after is told", () => {
  const forgot = "2026-10-14T12:00:00.000Z";
  assert.ok(beforeForgetting({ created_at: "2026-10-14T11:59:59.000Z" }, forgot));
  assert.ok(beforeForgetting({ created_at: forgot }, forgot));
  assert.ok(!beforeForgetting({ created_at: "2026-10-14T12:00:00.001Z" }, forgot));
  // Without a time it counts as before; a conversation never cleared drops nothing.
  assert.ok(beforeForgetting({ created_at: "soon" }, forgot));
  assert.ok(!beforeForgetting({ created_at: "2026-10-14T11:00:00.000Z" }, null));
});

test("forgetting is kept per workspace and conversation, and takes only chat's ids", () => {
  assert.equal(forgotKey("Acme", "chn_1"), "forgot:acme:chn_1");
  assert.notEqual(forgotKey("acme", "chn_1"), forgotKey("other", "chn_1"));
  assert.equal(cleanChannelId("chn_01jabc"), "chn_01jabc");
  for (const bad of ["", "chn 1", "chn_1' OR 1=1", "x".repeat(65), 7, null]) assert.equal(cleanChannelId(bad), null, String(bad));
});
