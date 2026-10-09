import assert from "node:assert/strict";
import { test } from "node:test";

import { inviteTarget, looksLikeEmail, peopleQuery } from "./people-search.ts";
import { declinedLine, invitationLine } from "./invitations.ts";

test("people are searched by username or name, and an email address is never looked up", () => {
  assert.equal(peopleQuery("  @daw "), "daw");
  assert.equal(peopleQuery("Dawn W"), "Dawn W");
  assert.equal(peopleQuery("dawn@example.com"), null);
  assert.equal(peopleQuery(" "), null);
  assert.equal(peopleQuery("@"), null);
  assert.equal(looksLikeEmail("@ada"), false);
});

test("the invite form names an address or a username", () => {
  assert.deepEqual(inviteTarget("Ada@Example.com "), { email: "Ada@Example.com" });
  assert.deepEqual(inviteTarget("@DaWeazl"), { username: "daweazl" });
  assert.equal(inviteTarget("  "), null);
});

test("an invitation says the role it joins with and how long it works", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(
    invitationLine({ role: "member", expiresAt: "2026-11-07T12:00:00Z" }, now),
    "invited you to join as a member. It works for 30 more days.",
  );
  assert.equal(invitationLine({ role: "owner", expiresAt: "2026-10-09T00:00:00Z" }, now), "invited you to join as an owner. It expires within a day.");
  assert.match(declinedLine("Flagon, Inc."), /declined the invitation to Flagon, Inc\..*told/);
});
