import assert from "node:assert/strict";
import { test } from "node:test";

import { RETRY_AFTER_MS, attemptKey, parseShot, shotKey, shouldAttempt } from "./screenshot.ts";

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
