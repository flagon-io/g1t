import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXTERNAL_MAX_AGE_MS,
  KEEP_DAYS,
  RETRY_AFTER_MS,
  attemptKey,
  dayOf,
  dueForRefresh,
  expired,
  externalAttemptKey,
  externalShotKey,
  isCurrent,
  isFresh,
  isPublicHost,
  parseExternalShot,
  parseShot,
  shotKey,
  shouldAttempt,
} from "./screenshot.ts";

test("an external production is visited only at a public address", () => {
  for (const host of ["g1t.sh", "www.g1t.sh", "example.com", "app.example.co.uk", "8.8.8.8", "acme-web.vercel.app"]) {
    assert.ok(isPublicHost(host), host);
  }
  for (const host of [
    "localhost",
    "app.localhost",
    "printer.local",
    "db.internal",
    "intranet",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "999.1.1.1",
    "2130706433",
    "0x7f.0.0.1",
    "[::1]",
    "::1",
    "fe80::1",
    // g1t's own services, but g1t.sh itself.
    "api.g1t.sh",
    "og.g1t.sh",
    "sudo.g1t.sh",
    "g1tusercontent.com",
    "x.g1tusercontent.com",
    "web-acme.g1t.page",
    "g1t.page",
  ]) {
    assert.equal(isPublicHost(host), false, host);
  }
});

test("an external request names a public http(s) address and a commit or a day", () => {
  const commit = "abc1234def5678abc1234def5678abc1234def56";
  assert.deepEqual(parseExternalShot({ url: "https://G1T.sh/#top", commit }), { host: "g1t.sh", url: "https://g1t.sh/", commit });
  assert.deepEqual(parseExternalShot({ url: "http://example.com/app?x=1", commit: "2026-10-11", since: "2026-10-11T00:00:00Z" }), {
    host: "example.com",
    url: "http://example.com/app?x=1",
    commit: "2026-10-11",
    since: "2026-10-11T00:00:00Z",
  });
  for (const url of [
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "https://api.g1t.sh/",
    "https://web-acme.g1t.page/",
    "not a url",
  ]) {
    assert.equal(parseExternalShot({ url, commit }), null, url);
  }
  assert.equal(parseExternalShot({ url: "https://example.com/", commit: "main" }), null);
  assert.equal(parseExternalShot({ url: "https://example.com/", commit: "2026-13-45" }), null);
  assert.equal(parseExternalShot({ url: "https://example.com/" }), null);
  assert.equal(parseExternalShot(null), null);
});

test("external screenshots are kept apart, by host", () => {
  assert.equal(externalShotKey("g1t.sh"), "external/g1t.sh.jpg");
  assert.equal(externalAttemptKey("g1t.sh"), "attempts/external/g1t.sh");
  assert.equal(dayOf(Date.parse("2026-10-11T23:59:00Z")), "2026-10-11");
});

test("an external screenshot stands for a day, and not from before the deploy", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const kept = { capturedAt: "2026-10-11T06:00:00Z" };
  assert.ok(isFresh(kept, now));
  assert.ok(isFresh(kept, now, "2026-10-11T05:00:00Z"));
  assert.ok(!isFresh(kept, now, "2026-10-11T07:00:00Z"));
  assert.ok(!isFresh({ capturedAt: new Date(now - EXTERNAL_MAX_AGE_MS).toISOString() }, now));
  assert.ok(!isFresh(null, now));
});

test("the daily refresh takes the missing and the stalest first, up to its limit", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const targets = [
    { name: "fresh", capturedAt: "2026-10-11T06:00:00Z" },
    { name: "two days", capturedAt: "2026-10-09T06:00:00Z" },
    { name: "missing", capturedAt: null },
    { name: "a week", capturedAt: "2026-10-04T06:00:00Z" },
  ];
  assert.deepEqual(
    dueForRefresh(targets, now).map((t) => t.name),
    ["missing", "a week", "two days"],
  );
  assert.deepEqual(
    dueForRefresh(targets, now, 1).map((t) => t.name),
    ["missing"],
  );
});

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
