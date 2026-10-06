import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVITES_DONE,
  MAX_BULK,
  doneMessage,
  invitesHref,
  parseGrant,
  parseIds,
  parseMintEmail,
  parseNote,
  parseTab,
  parseWaitlistStatus,
} from "./invites.ts";

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

test("several requests are decided at once, each once", () => {
  const ticked = (ids: string[]) => ({ getAll: (name: string) => (name === "ids" ? ids : []) });
  assert.deepEqual(parseIds(ticked(["wl_01jb2k", "wl_01jb2m", "wl_01jb2k"])), { ok: true, value: ["wl_01jb2k", "wl_01jb2m"] });
  assert.equal(parseIds(ticked([])).ok, false);
  assert.equal(parseIds(ticked(["inv_01jb2k", "wl_<script>"])).ok, false);
  const many = Array.from({ length: MAX_BULK + 1 }, (_, n) => `wl_${n.toString(36)}`);
  assert.equal(parseIds(ticked(many)).ok, false);
  assert.equal(parseIds(ticked(many.slice(0, MAX_BULK))).ok, true);
});

test("an approval's note is optional and short", () => {
  assert.deepEqual(parseNote("  Welcome aboard.  "), { ok: true, value: "Welcome aboard." });
  assert.deepEqual(parseNote(""), { ok: true, value: null });
  assert.deepEqual(parseNote(null), { ok: true, value: null });
  assert.equal(parseNote("x".repeat(501)).ok, false);
});

test("the flash says how many were decided", () => {
  assert.equal(doneMessage("approved", "3"), "Approved 3 requests. Each invite is on its way.");
  assert.equal(doneMessage("dismissed", "2"), "Dismissed 2 requests.");
  assert.equal(doneMessage("approved", null), INVITES_DONE.approved);
  assert.equal(doneMessage("approved", "1"), INVITES_DONE.approved);
  assert.equal(doneMessage("nope", "4"), null);
  assert.equal(doneMessage(null, null), null);
});
