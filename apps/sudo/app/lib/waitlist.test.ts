import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNote, parseRegistrationMode, parseWaitlistDecision, parseWaitlistTab, statusFilter, waitlistHref } from "./waitlist.ts";

test("the tab is waiting unless the address names another", () => {
  assert.equal(parseWaitlistTab(null), "waiting");
  assert.equal(parseWaitlistTab("invited"), "invited");
  assert.equal(parseWaitlistTab("dismissed"), "dismissed");
  assert.equal(parseWaitlistTab("all"), "all");
  assert.equal(parseWaitlistTab("nonsense"), "waiting");
});

test("All asks identity for every status", () => {
  assert.equal(statusFilter("all"), null);
  assert.equal(statusFilter("waiting"), "waiting");
});

test("tab addresses keep the search and leave out the defaults", () => {
  assert.equal(waitlistHref("waiting"), "/waitlist");
  assert.equal(waitlistHref("invited"), "/waitlist?status=invited");
  assert.equal(waitlistHref("waiting", " ana@ "), "/waitlist?q=ana%40");
  assert.equal(waitlistHref("all", "agents"), "/waitlist?status=all&q=agents");
});

test("a note is optional, trimmed, and at most 500 characters", () => {
  assert.deepEqual(parseNote("   "), { ok: true, value: null });
  assert.deepEqual(parseNote(" Welcome! "), { ok: true, value: "Welcome!" });
  assert.equal(parseNote("x".repeat(500)).ok, true);
  assert.equal(parseNote("x".repeat(501)).ok, false);
});

test("a decision is approve or dismiss, nothing else", () => {
  assert.deepEqual(parseWaitlistDecision("approve"), { ok: true, value: true });
  assert.deepEqual(parseWaitlistDecision("dismiss"), { ok: true, value: false });
  assert.equal(parseWaitlistDecision("").ok, false);
});

test("the sign-up switch takes open or invite, nothing else", () => {
  assert.deepEqual(parseRegistrationMode("open"), { ok: true, value: "open" });
  assert.deepEqual(parseRegistrationMode("invite"), { ok: true, value: "invite" });
  assert.equal(parseRegistrationMode("").ok, false);
  assert.equal(parseRegistrationMode("Invite").ok, false);
});
