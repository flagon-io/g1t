import assert from "node:assert/strict";
import { test } from "node:test";

import { INVITES_DONE, MAX_GRANT, doneMessage, invitesHref, invitesTab, joinedThrough, parseGrant } from "./invites.ts";

test("the page has one address, with its search and tab", () => {
  assert.equal(invitesHref(), "/invites");
  assert.equal(invitesHref({ q: "g1t-k7m2", empty: "" }), "/invites?q=g1t-k7m2");
  assert.equal(invitesHref({ tab: "g1t" }), "/invites?tab=g1t");
  assert.equal(invitesTab("g1t"), "g1t");
  assert.equal(invitesTab("waitlist"), "all");
  assert.equal(invitesTab(null), "all");
});

test("revoking and granting say so, and nothing else is flashed", () => {
  assert.equal(doneMessage("revoked"), INVITES_DONE.revoked);
  assert.equal(doneMessage("granted"), INVITES_DONE.granted);
  assert.equal(doneMessage("approved"), null);
  assert.equal(doneMessage(null), null);
});

test("an account made with a shared link says where it came from", () => {
  assert.equal(joinedThrough("Cloudflare judges"), "Joined through Cloudflare judges");
});

test("a grant names a person, a whole number of invites and why", () => {
  const form = (fields: Record<string, string>) => new Map(Object.entries(fields));
  assert.deepEqual(parseGrant(form({ username: "@Ada", amount: "10", note: "Bringing her team" })), {
    ok: true,
    value: { username: "ada", amount: 10, note: "Bringing her team" },
  });
  assert.equal(parseGrant(form({ username: "ada", amount: "-5", note: "Too many" })).ok, true);
  assert.equal(parseGrant(form({ username: "not a name", amount: "10", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ username: "ada", amount: "0", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ username: "ada", amount: String(MAX_GRANT + 1), note: "why" })).ok, false);
  assert.equal(parseGrant(form({ username: "ada", amount: "2.5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ username: "ada", amount: "10", note: "" })).ok, false);
});
