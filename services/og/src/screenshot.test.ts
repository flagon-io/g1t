import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEP_DAYS, RETRY_AFTER_MS, attemptKey, expired, isCurrent, parseShot, shotKey, shouldAttempt } from "./screenshot.ts";

const commit = "abc1234def5678abc1234def5678abc1234def56";

test("only apps on g1t.page, with a commit, are taken", () => {
  assert.deepEqual(parseShot({ host: "Web-Acme.g1t.page", commit: commit.toUpperCase() }), { host: "web-acme.g1t.page", commit });
  for (const host of [
    "web-acme.g1t.sh",
    "example.com",
    "g1t.page",
    "a.b.g1t.page",
    "domains.g1t.page",
    "-web.g1t.page",
    "web-acme.g1t.page.evil.com",
    "web acme.g1t.page",
  ]) {
    assert.equal(parseShot({ host, commit }), null, host);
  }
  assert.equal(parseShot({ host: "web-acme.g1t.page", commit: "main" }), null);
  assert.equal(parseShot({ host: "web-acme.g1t.page" }), null);
  assert.equal(parseShot(null), null);
});

test("keys are by hostname", () => {
  assert.equal(shotKey("web-acme.g1t.page"), "production/web-acme.g1t.page.jpg");
  assert.equal(attemptKey("web-acme.g1t.page"), "attempts/web-acme.g1t.page");
});

test("a failed attempt at a commit waits before it is tried again", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.equal(shouldAttempt(null, commit, now), true);
  const just = { commit, at: new Date(now - 1000).toISOString() };
  assert.equal(shouldAttempt(just, commit, now), false);
  assert.equal(shouldAttempt(just, "fff0000", now), true);
  assert.equal(shouldAttempt({ commit, at: new Date(now - RETRY_AFTER_MS).toISOString() }, commit, now), true);
});

test("a screenshot is current when it shows the commit and was taken after the deploy", () => {
  const kept = { commit, capturedAt: "2026-10-06T10:00:00Z" };
  assert.ok(isCurrent(kept, { host: "a.g1t.page", commit }));
  assert.ok(isCurrent(kept, { host: "a.g1t.page", commit, since: "2026-10-06T09:00:00Z" }));
  // Resumed (deployed again at the same commit) after it was taken.
  assert.ok(!isCurrent(kept, { host: "a.g1t.page", commit, since: "2026-10-06T11:00:00Z" }));
  assert.ok(!isCurrent(kept, { host: "a.g1t.page", commit: "f".repeat(40) }));
  assert.deepEqual(parseShot({ host: "a-b.g1t.page", commit, since: "2026-10-06T11:00:00Z" })?.since, "2026-10-06T11:00:00Z");
  assert.equal(parseShot({ host: "a-b.g1t.page", commit, since: "nope" })?.since, undefined);
});

test("kept objects expire after KEEP_DAYS", () => {
  const now = Date.parse("2026-10-06T00:00:00Z");
  assert.ok(expired(new Date(now - (KEEP_DAYS + 1) * 86_400_000), now));
  assert.ok(!expired(new Date(now - 86_400_000), now));
});
