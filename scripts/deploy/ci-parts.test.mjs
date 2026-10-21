import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARTS, SECONDS, ciParts, cost, split, withParts } from "./ci-parts.mjs";

const CI = readFileSync(fileURLToPath(new URL("../../.g1t/workflows/ci.yml", import.meta.url)), "utf8");

test("ci.yml's Rust parts are the split by measured time", () => {
  const parts = ciParts(CI);
  assert.equal(parts.length, PARTS);
  const timed = Object.keys(SECONDS).sort();
  assert.deepEqual(
    parts.flat().sort(),
    timed,
    "a crate in ci.yml has no time in ci-parts.mjs SECONDS, or one there is in no part: add its time and run `node scripts/deploy/ci-parts.mjs --write`",
  );
  assert.deepEqual(
    parts,
    split(SECONDS).map((p) => p.crates),
    "ci.yml's parts are not the split by time: run `node scripts/deploy/ci-parts.mjs --write`",
  );
});

test("a crate costs a quarter of its compile and all of its tests", () => {
  assert.equal(cost([40, 3]), 13);
});

test("the longest crate goes first, each into the part with the least so far", () => {
  const parts = split({ a: [0, 10], b: [28, 0], c: [0, 6], d: [4, 4], e: [0, 2], f: [8, 0] }, 3);
  assert.deepEqual(
    parts.map((p) => [p.crates, p.seconds]),
    [
      [["a"], 10],
      [["b", "e", "f"], 11],
      [["c", "d"], 11],
    ],
  );
  // Crates of equal time go by name, and a tie goes to the earlier part.
  assert.deepEqual(
    split({ y: [0, 1], x: [4, 0] }, 2).map((p) => p.crates),
    [["x"], ["y"]],
  );
});

test("writing the parts replaces only the crates lines", () => {
  const text = CI.replace(/-p g1t-kit\b/, "-p g1t-kit -p g1t-new");
  assert.notDeepEqual(ciParts(text), ciParts(CI));
  const parts = ciParts(CI);
  assert.equal(withParts(text, parts), CI);
  assert.throws(() => withParts(CI, parts.slice(1)));
});
