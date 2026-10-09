import assert from "node:assert/strict";
import { test } from "node:test";

import { expiresIn, formatBytes, legacyArtifactsWorthAsking } from "./artifacts.ts";

test("sizes read as KB, MB or GB", () => {
  assert.equal(formatBytes(10), "1 KB");
  assert.equal(formatBytes(412_870), "403 KB");
  assert.equal(formatBytes(18_734_120), "17.9 MB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.00 GB");
});

test("expiry reads from now", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(expiresIn("2026-10-22T12:00:00Z", now), "expires in 14 days");
  assert.equal(expiresIn("2026-10-09T13:00:00Z", now), "expires tomorrow");
  assert.equal(expiresIn("2026-10-08T20:00:00Z", now), "expires today");
  assert.equal(expiresIn("2026-10-08T11:00:00Z", now), "expired");
  assert.equal(expiresIn(null, now), "");
});

test("KV is asked for an old, finished run's artifacts only until they have expired", () => {
  const old = { createdAt: "2026-10-07T12:00:00Z", status: "completed" };
  const now = Date.parse("2026-10-10T00:00:00Z");
  assert.ok(legacyArtifactsWorthAsking(old, now));
  // Still going: its artifacts are in R2, and its page refreshes.
  assert.ok(!legacyArtifactsWorthAsking({ ...old, status: "in_progress" }, now));
  // Made after the move to R2.
  assert.ok(!legacyArtifactsWorthAsking({ ...old, createdAt: "2026-10-09T08:00:00Z" }, now));
  // Every KV artifact has expired.
  assert.ok(!legacyArtifactsWorthAsking(old, Date.parse("2026-10-22T00:00:00Z")));
});
