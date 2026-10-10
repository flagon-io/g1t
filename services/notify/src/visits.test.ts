import assert from "node:assert/strict";
import { test } from "node:test";

import { VISIT_GAP_MS, lastVisit, markVisit, visitWorkspace } from "./visits.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("a workspace slug is lowercased and checked", () => {
  assert.equal(visitWorkspace(" Acme "), "acme");
  assert.equal(visitWorkspace("flagon-io"), "flagon-io");
  assert.equal(visitWorkspace(""), null);
  assert.equal(visitWorkspace("a/b"), null);
  assert.equal(visitWorkspace(7), null);
  assert.equal(visitWorkspace("x".repeat(65)), null);
});

test("the first mark starts a visit with nothing before it", () => {
  assert.deepEqual(markVisit(null, new Date(NOW - HOUR).toISOString(), NOW), { seen_at: NOW - HOUR, previous_at: null });
});

test("marks close together are one visit; a gap starts the next", () => {
  const first = { seen_at: NOW - 3 * DAY, previous_at: null };
  // Back after three days: the new visit counts from the old one's last mark.
  const back = markVisit(first, NOW - 10 * MIN, NOW)!;
  assert.deepEqual(back, { seen_at: NOW - 10 * MIN, previous_at: NOW - 3 * DAY });
  // A refresh a few minutes later is the same visit.
  assert.deepEqual(markVisit(back, NOW, NOW), { seen_at: NOW, previous_at: NOW - 3 * DAY });
});

test("a mark never moves the visit back", () => {
  const kept = { seen_at: NOW - HOUR, previous_at: null };
  assert.equal(markVisit(kept, NOW - 2 * HOUR, NOW), null);
  assert.equal(markVisit(kept, NOW - HOUR, NOW), null);
});

test("a mark is never in the future, nor more than a day behind", () => {
  assert.equal(markVisit(null, NOW + HOUR, NOW)!.seen_at, NOW);
  assert.equal(markVisit(null, NOW - 72 * HOUR, NOW)!.seen_at, NOW - DAY);
  assert.equal(markVisit(null, "not a time", NOW), null);
  assert.equal(markVisit(null, undefined, NOW), null);
});

test("last here: the visit before during one, its last mark after", () => {
  assert.equal(lastVisit(null, NOW), null);
  const during = { seen_at: NOW - 5 * MIN, previous_at: NOW - 3 * DAY };
  assert.equal(lastVisit(during, NOW), NOW - 3 * DAY);
  assert.equal(lastVisit({ seen_at: NOW - 5 * MIN, previous_at: null }, NOW), null);
  assert.equal(lastVisit(during, NOW - 5 * MIN + VISIT_GAP_MS), NOW - 5 * MIN);
});
