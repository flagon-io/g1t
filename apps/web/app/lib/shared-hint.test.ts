import assert from "node:assert/strict";
import { test } from "node:test";

import { placeHint } from "./shared-hint.ts";

const view = { width: 1000, height: 800 };
const bubble = { width: 200, height: 30 };

test("the shared hint sits centred above its mark", () => {
  const place = placeHint({ left: 400, top: 300, width: 100, height: 20 }, bubble, view);
  assert.deepEqual(place, { left: 350, top: 264, side: "top", arrow: 100 });
});

test("with no room above, it goes below", () => {
  const place = placeHint({ left: 400, top: 10, width: 100, height: 20 }, bubble, view);
  assert.equal(place.side, "bottom");
  assert.equal(place.top, 36);
});

test("near an edge it stays in the window, its arrow still at the mark", () => {
  const left = placeHint({ left: 0, top: 300, width: 40, height: 20 }, bubble, view);
  assert.equal(left.left, 8);
  assert.equal(left.arrow, 12);
  const right = placeHint({ left: 980, top: 300, width: 20, height: 20 }, bubble, view);
  assert.equal(right.left, 1000 - 8 - 200);
  assert.equal(right.arrow, 194);
});
