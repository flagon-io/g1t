import assert from "node:assert/strict";
import { test } from "node:test";

import { exactTime, timeAgo } from "./time-ago.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("a moment within the last week is said in minutes, hours or days", () => {
  assert.equal(timeAgo(before(10_000), NOW, "UTC"), "just now");
  assert.equal(timeAgo(before(-30_000), NOW, "UTC"), "just now");
  assert.equal(timeAgo(before(50_000), NOW, "UTC"), "1m ago");
  assert.equal(timeAgo(before(5 * MINUTE), NOW, "UTC"), "5m ago");
  assert.equal(timeAgo(before(3 * HOUR), NOW, "UTC"), "3h ago");
  assert.equal(timeAgo(before(30 * HOUR), NOW, "UTC"), "yesterday");
  assert.equal(timeAgo(before(4 * DAY), NOW, "UTC"), "4d ago");
});

test("a moment weeks ago is said in weeks, and older ones by their date", () => {
  assert.equal(timeAgo(before(10 * DAY), NOW, "UTC"), "1w ago");
  assert.equal(timeAgo(before(27 * DAY), NOW, "UTC"), "3w ago");
  assert.equal(timeAgo("2026-09-01T09:00:00.000Z", NOW, "UTC"), "Sep 1");
  assert.equal(timeAgo("2023-07-24T09:00:00.000Z", NOW, "UTC"), "Jul 24, 2023");
  assert.equal(timeAgo(Date.parse("2023-07-24T09:00:00.000Z"), NOW, "UTC"), "Jul 24, 2023");
});

test("a moment that can't be read says nothing", () => {
  assert.equal(timeAgo("not a date", NOW), "");
  assert.equal(exactTime("not a date"), "");
});

test("the hint gives the moment in full", () => {
  assert.equal(exactTime("2026-10-13T15:04:00.000Z", "UTC"), "Oct 13, 2026, 3:04 PM UTC");
});
