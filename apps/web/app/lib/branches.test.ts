import assert from "node:assert/strict";
import { test } from "node:test";

import { bounded, drift, type Link } from "./branches.ts";

/** A history from `[hash, ...parents]` rows. */
const graph = (...rows: string[][]): Link[] => rows.map(([hash, ...parents]) => ({ hash: hash as string, parents }));

// main: m1 <- m2 <- m3; the branch left at m2 and added b1 <- b2.
const forked = graph(["m3", "m2"], ["m2", "m1"], ["m1"], ["b2", "b1"], ["b1", "m2"]);

test("a branch two ahead of where main was, with main one further on", () => {
  assert.deepEqual(drift("b2", "m3", forked), { ahead: 2, behind: 1 });
});

test("a branch at main's head is level", () => {
  assert.deepEqual(drift("m3", "m3", forked), { ahead: 0, behind: 0 });
});

test("a branch merged long ago is nothing ahead and all of main since behind", () => {
  const history = graph(["m5", "m4"], ["m4", "m3"], ["m3", "m2"], ["m2", "m1"]);
  // Neither history was read to its start, but they meet in what was.
  assert.deepEqual(drift("m2", "m5", history), { ahead: 0, behind: 3 });
});

test("a merge into main counts the merged side once", () => {
  // main merged side branch s1 <- s2 at m3; the branch is still at m1.
  const history = graph(["m3", "m2", "s2"], ["s2", "s1"], ["s1", "m1"], ["m2", "m1"], ["m1"], ["b1", "m1"]);
  assert.deepEqual(drift("b1", "m3", history), { ahead: 1, behind: 4 });
});

test("histories that never meet count everything on each, once read to the start", () => {
  const history = graph(["b2", "b1"], ["b1"], ["m2", "m1"], ["m1"]);
  assert.deepEqual(drift("b2", "m2", history), { ahead: 2, behind: 2 });
});

test("no answer when what was read stops before the two meet", () => {
  // Main's history was read only to m2, whose parent the branch may share.
  const history = graph(["m3", "m2"], ["m2", "m1"], ["b2", "b1"], ["b1", "m0"]);
  assert.equal(drift("b2", "m3", history), null);
});

test("no answer without either head", () => {
  assert.equal(drift("b9", "m3", forked), null);
  assert.equal(drift("b2", "m9", forked), null);
});

test("bounded loads everything in order, never more at once than asked", async () => {
  let running = 0;
  let most = 0;
  const out = await bounded([5, 1, 4, 2, 3], 2, async (wait) => {
    running++;
    most = Math.max(most, running);
    await new Promise((done) => setTimeout(done, wait));
    running--;
    return wait * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(most, 2);
});
