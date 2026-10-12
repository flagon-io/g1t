import assert from "node:assert/strict";
import { test } from "node:test";

import { INVITES_DONE, doneMessage, invitesHref, joinedThrough } from "./invites.ts";

test("the page has one address, with its search", () => {
  assert.equal(invitesHref(), "/invites");
  assert.equal(invitesHref({ q: "g1t-k7m2", empty: "" }), "/invites?q=g1t-k7m2");
});

test("revoking says so, and nothing else is flashed", () => {
  assert.equal(doneMessage("revoked"), INVITES_DONE.revoked);
  assert.equal(doneMessage("approved"), null);
  assert.equal(doneMessage(null), null);
});

test("an account made with a shared link says where it came from", () => {
  assert.equal(joinedThrough("Cloudflare judges"), "Joined through Cloudflare judges");
});
