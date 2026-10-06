import assert from "node:assert/strict";
import { test } from "node:test";

import { iso, isoPath, pts, stagger, timing } from "./art.ts";

test("iso projects the floor axes and lifts by z", () => {
  assert.deepEqual(iso(0, 0), [0, 0]);
  const [x, y] = iso(10, 0);
  assert.ok(Math.abs(x - 8.660254) < 1e-5);
  assert.equal(y, 5);
  assert.deepEqual(iso(0, 0, 7), [0, -7]);
  // Equal steps along x and y cancel sideways.
  assert.equal(iso(4, 4)[0], 0);
});

test("pts and isoPath round to one decimal place", () => {
  assert.equal(pts([[1.234, 5.678], [0, 0]]), "1.2,5.7 0.0,0.0");
  assert.equal(isoPath([[0, 0], [10, 0]], 2), "M0.0 -2.0 L8.7 3.0");
});

test("stagger spreads starts evenly inside the loop", () => {
  assert.deepEqual(stagger(4, 8), ["0s", "2s", "4s", "6s"]);
  assert.deepEqual(stagger(3, 4, 1), ["1s", "2s", "3s"]);
  assert.deepEqual(stagger(0, 5), []);
  assert.deepEqual(stagger(3, 1), ["0s", "0.33s", "0.67s"]);
});

test("timing names the custom properties the stylesheet reads", () => {
  assert.deepEqual(timing(6, 1.5), { "--dur": "6s", "--delay": "1.5s" });
  assert.deepEqual(timing(3.333, "2s"), { "--dur": "3.33s", "--delay": "2s" });
});
