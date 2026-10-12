import assert from "node:assert/strict";
import { test } from "node:test";

import { BUSY_LIMIT, stillBusy } from "./busy.ts";

test("a pressed button is busy until the status changes", () => {
  const press = { status: "starting", at: 1_000 };
  assert.equal(stillBusy(press, "starting", 1_500), true);
  assert.equal(stillBusy(press, "running", 1_500), false);
});

test("a pressed button is given back when nothing changes for a while", () => {
  const press = { status: "starting", at: 1_000 };
  assert.equal(stillBusy(press, "starting", 1_000 + BUSY_LIMIT - 1), true);
  assert.equal(stillBusy(press, "starting", 1_000 + BUSY_LIMIT), false);
  assert.equal(BUSY_LIMIT, 20_000);
});

test("a button nobody pressed is not busy", () => {
  assert.equal(stillBusy(null, "starting", 0), false);
});
