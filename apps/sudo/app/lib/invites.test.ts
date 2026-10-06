import assert from "node:assert/strict";
import { test } from "node:test";

import { INVITES_DONE, invitesHref, parseGrant, parseMintEmail, parseTab, parseWaitlistStatus } from "./invites.ts";

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });

test("the page opens on the waitlist, and each tab has an address", () => {
  assert.equal(parseTab(null), "waitlist");
  assert.equal(parseTab("tree"), "tree");
  assert.equal(parseTab("nope"), "waitlist");
  assert.equal(invitesHref("invites", { q: "g1t-k7m2", empty: "" }), "/invites?tab=invites&q=g1t-k7m2");
  assert.equal(parseWaitlistStatus(null), "waiting");
  assert.equal(parseWaitlistStatus("all"), "all");
  assert.equal(parseWaitlistStatus("dismissed"), "dismissed");
});

test("a grant names who, how many and why", () => {
  assert.deepEqual(parseGrant(form({ target: "user", name: "@Ada", amount: "10", note: "Launch partner" })), {
    ok: true,
    value: { target: "user", name: "ada", amount: 10, note: "Launch partner" },
  });
  assert.deepEqual(parseGrant(form({ target: "workspace", name: "acme", amount: "-5", note: "Abuse" })), {
    ok: true,
    value: { target: "workspace", name: "acme", amount: -5, note: "Abuse" },
  });
  assert.equal(parseGrant(form({ target: "team", name: "acme", amount: "5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "not a name", amount: "5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "0", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "1.5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "5000", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "5", note: "" })).ok, false);
});

test("a minted invite is for one address, or for anyone", () => {
  assert.deepEqual(parseMintEmail(""), { ok: true, value: null });
  assert.deepEqual(parseMintEmail(" Ada@Example.com "), { ok: true, value: "ada@example.com" });
  assert.equal(parseMintEmail("ada@").ok, false);
});

test("every outcome has words", () => {
  for (const key of ["approved", "dismissed", "revoked", "granted"]) assert.ok(INVITES_DONE[key]);
});
