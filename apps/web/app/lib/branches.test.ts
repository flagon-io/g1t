import assert from "node:assert/strict";
import { test } from "node:test";

import { count, drift } from "./branches.ts";

test("a branch two ahead of where main was, with main one further on", () => {
  // main: m3 m2 m1; the branch left at m2 and added b2 b1.
  assert.deepEqual(drift(["b2", "b1", "m2", "m1"], ["m3", "m2", "m1"], 50), {
    ahead: 2,
    behind: 1,
    aheadMore: false,
    behindMore: false,
  });
});

test("a branch at main's head is level", () => {
  assert.deepEqual(drift(["m2", "m1"], ["m2", "m1"], 50), { ahead: 0, behind: 0, aheadMore: false, behindMore: false });
});

test("a branch with no shared commit in reach says how much it read", () => {
  assert.deepEqual(drift(["b3", "b2", "b1"], ["m2", "m1"], 3), { ahead: 3, behind: 0, aheadMore: true, behindMore: true });
  assert.equal(count(3, true), "3+");
  assert.equal(count(3, false), "3");
  // Behind by an unknown number: not "0+", which reads as up to date.
  assert.equal(count(0, true), "?");
});
