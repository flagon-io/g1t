import assert from "node:assert/strict";
import { test } from "node:test";

import { formatLineHash, inRange, parseLineHash, pickLine } from "./line-anchor.ts";

test("one line and a run of lines are read from the fragment", () => {
  assert.deepEqual(parseLineHash("#L679"), { start: 679, end: 679 });
  assert.deepEqual(parseLineHash("#L10-L20"), { start: 10, end: 20 });
  assert.deepEqual(parseLineHash("L10-L20"), { start: 10, end: 20 });
  assert.deepEqual(parseLineHash("#L10-20"), { start: 10, end: 20 });
});

test("a run written backwards is put in order", () => {
  assert.deepEqual(parseLineHash("#L20-L10"), { start: 10, end: 20 });
});

test("anything else names no lines", () => {
  for (const hash of ["", "#", "#top", "#L", "#Lx", "#l12", "#L12-", "#L12-L", "#L1-L2-L3", "#L0", "#L-3", "#L12 "]) {
    assert.equal(parseLineHash(hash), null, hash);
  }
});

test("a run is held to the file's length", () => {
  assert.deepEqual(parseLineHash("#L10-L900", 40), { start: 10, end: 40 });
  assert.deepEqual(parseLineHash("#L40", 40), { start: 40, end: 40 });
  assert.equal(parseLineHash("#L41", 40), null);
  assert.equal(parseLineHash("#L41-L50", 40), null);
});

test("a run is written back the way it is read", () => {
  assert.equal(formatLineHash({ start: 12, end: 12 }), "#L12");
  assert.equal(formatLineHash({ start: 10, end: 20 }), "#L10-L20");
  for (const hash of ["#L1", "#L3-L9"]) assert.equal(formatLineHash(parseLineHash(hash)!), hash);
});

test("a pick is one line; a shift-pick runs from the line already picked", () => {
  assert.deepEqual(pickLine(null, 7, false), { start: 7, end: 7 });
  assert.deepEqual(pickLine(null, 7, true), { start: 7, end: 7 });
  assert.deepEqual(pickLine({ start: 10, end: 10 }, 7, false), { start: 7, end: 7 });
  assert.deepEqual(pickLine({ start: 10, end: 10 }, 20, true), { start: 10, end: 20 });
  assert.deepEqual(pickLine({ start: 10, end: 10 }, 4, true), { start: 4, end: 10 });
  assert.deepEqual(pickLine({ start: 10, end: 20 }, 15, true), { start: 10, end: 15 });
});

test("a line is in the run when it is between its ends", () => {
  assert.equal(inRange({ start: 10, end: 20 }, 10), true);
  assert.equal(inRange({ start: 10, end: 20 }, 20), true);
  assert.equal(inRange({ start: 10, end: 20 }, 21), false);
  assert.equal(inRange(null, 1), false);
});
