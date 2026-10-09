import assert from "node:assert/strict";
import { test } from "node:test";

import { COLUMNS, ROWS, creature } from "./pixel-creature.ts";

test("a seed always draws the same creature, symmetric and whole", () => {
  assert.deepEqual(creature("margo"), creature("margo"));
  for (const seed of ["margo", "ship", "a1", "reviewer", "", "zz-top"]) {
    const { cells, colour } = creature(seed);
    assert.equal(cells.length, ROWS);
    assert.match(colour.fg, /^#[0-9a-f]{6}$/);
    for (const row of cells) {
      assert.equal(row.length, COLUMNS);
      assert.deepEqual(row, [...row].reverse(), `${seed} is symmetric`);
    }
    // The spine holds it together.
    for (let row = 1; row < ROWS - 1; row++) assert.notEqual(cells[row]![2], 0);
  }
});

test("different seeds give different creatures", () => {
  const drawn = new Set(["margo", "ship", "triage", "scribe", "builder", "reviewer", "nova", "pixel"].map((seed) => JSON.stringify(creature(seed))));
  assert.ok(drawn.size >= 7);
});
