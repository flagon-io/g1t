import assert from "node:assert/strict";
import { test } from "node:test";

import { FOLLOW_SLACK, endPlace } from "./log-follow.ts";

const end = (bottom: number) => ({ top: bottom - 1, bottom, width: 600, height: 1 });

test("the end above the window's bottom edge is in view", () => {
  assert.equal(endPlace(end(700), { height: 800, covered: 12 }), "here");
  assert.equal(endPlace(end(788), { height: 800, covered: 12 }), "here");
  // Scrolled past it, the latest is still on screen.
  assert.equal(endPlace(end(-40), { height: 800, covered: 12 }), "here");
});

test("an end one row below the edge is not reached: following stops there", () => {
  // Before, anything within 160 px below the window counted, so a log
  // could stop with its last lines cut off and no Jump to latest.
  assert.equal(endPlace(end(800 - 12 + 20), { height: 800, covered: 12 }), "below");
  assert.equal(endPlace(end(800 + 20), { height: 800, covered: 0 }), "below");
  assert.equal(endPlace(end(800 + FOLLOW_SLACK), { height: 800, covered: 0 }), "here");
});

test("what covers the bottom of the window hides the end: a phone's tab bar", () => {
  // 56 px of tab bar and 12 px of room: an end at 760 is under the bar.
  assert.equal(endPlace(end(760), { height: 812, covered: 68 }), "below");
  assert.equal(endPlace(end(744), { height: 812, covered: 68 }), "here");
});

test("a folded step has no end to follow", () => {
  assert.equal(endPlace(null, { height: 800, covered: 0 }), "folded");
  assert.equal(endPlace({ top: 0, bottom: 0, width: 0, height: 0 }, { height: 800, covered: 0 }), "folded");
});
