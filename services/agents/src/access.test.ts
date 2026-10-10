import assert from "node:assert/strict";
import { test } from "node:test";

import { canArchive, canChange, canSeeAgent, creatableScope, personalRefusal } from "./access.ts";

const owner = { id: "u0", username: "olga", kind: "user" as const, workspaces: [{ slug: "acme", role: "owner" as const }] };
const ana = { id: "u1", username: "ana", kind: "user" as const, workspaces: [{ slug: "acme", role: "member" as const }] };
const bob = { id: "u2", username: "bob", kind: "user" as const, workspaces: [{ slug: "acme", role: "member" as const }] };
const token = { id: "w1", username: "acme", kind: "workspace" as const, workspaces: [] };

const anasAgent = { scope: "personal", owner_id: "u1" };
const shared = { scope: "workspace", owner_id: null };

test("members create personal agents while the workspace lets them; owners create either", () => {
  assert.deepEqual(creatableScope(ana, "acme", undefined, true), { ok: true, scope: "personal" });
  assert.equal(creatableScope(ana, "acme", undefined, false).ok, false, "owners turned it off");
  assert.equal(creatableScope(ana, "acme", "workspace", true).ok, false, "workspace agents are the owners'");
  assert.deepEqual(creatableScope(owner, "acme", undefined, false), { ok: true, scope: "workspace" });
  assert.deepEqual(creatableScope(owner, "acme", "personal", false), { ok: true, scope: "personal" }, "an owner may keep one for themselves");
  assert.equal(creatableScope(token, "acme", "personal", true).ok, false, "a token is nobody's person");
  assert.equal(creatableScope(ana, "other", undefined, true).ok, false);
});

test("a personal agent is seen by its member and owners, and changed only by its member", () => {
  assert.equal(canSeeAgent(ana, "acme", anasAgent), true);
  assert.equal(canSeeAgent(owner, "acme", anasAgent), true);
  assert.equal(canSeeAgent(bob, "acme", anasAgent), false);
  assert.equal(canSeeAgent(bob, "acme", shared), true);
  assert.equal(canChange(ana, "acme", anasAgent), true);
  assert.equal(canChange(owner, "acme", anasAgent), false, "owners promote or archive it, not rewrite it");
  assert.equal(canChange(ana, "acme", shared), false);
  assert.equal(canChange(owner, "acme", shared), true);
  assert.equal(canArchive(owner, "acme", anasAgent), true);
  assert.equal(canArchive(ana, "acme", anasAgent), true);
  assert.equal(canArchive(bob, "acme", anasAgent), false);
});

test("a personal agent answers only its member, in the DM of the two of them", () => {
  assert.equal(personalRefusal(anasAgent, { asked_by: "u1", channel_kind: "dm", members: 2 }), null);
  assert.equal(personalRefusal(anasAgent, { asked_by: "u1", channel_kind: "dm", members: null }), null);
  assert.match(personalRefusal(anasAgent, { asked_by: "u2", channel_kind: "dm", members: 2 }) ?? "", /personal agent/);
  assert.match(personalRefusal(anasAgent, { asked_by: "u1", channel_kind: "dm", members: 3 }) ?? "", /direct message/);
  assert.match(personalRefusal(anasAgent, { asked_by: "u1", channel_kind: "channel", members: 5 }) ?? "", /direct message/);
  assert.equal(personalRefusal(shared, { asked_by: "u2", channel_kind: "channel", members: 9 }), null);
});
