import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_FREE_DOC_FILES_BYTES, filesRefusal, freeFilesCap, shownBytes } from "./quota.ts";

const GB = 1024 * 1024 * 1024;

test("the cap comes from its var, 1 GB unless set, and 0 is none", () => {
  assert.equal(freeFilesCap(undefined), DEFAULT_FREE_DOC_FILES_BYTES);
  assert.equal(freeFilesCap(""), DEFAULT_FREE_DOC_FILES_BYTES);
  assert.equal(freeFilesCap("lots"), DEFAULT_FREE_DOC_FILES_BYTES);
  assert.equal(freeFilesCap(" 5368709120 "), 5 * GB);
  assert.equal(freeFilesCap("0"), 0);
});

test("a free workspace's upload past the cap is refused, and says how to make room", () => {
  assert.equal(filesRefusal(0.5 * GB, 0.25 * GB, GB), null);
  const refused = filesRefusal(GB - 100, 1000, GB);
  assert.ok(refused?.includes("of the 1 GB"), refused ?? "");
  assert.ok(refused?.includes("start the g1t plan"), refused ?? "");
  assert.equal(filesRefusal(100 * GB, GB, 0), null);
  assert.equal(shownBytes(300 * 1024 * 1024), "300 MB");
  assert.equal(shownBytes(1.5 * GB), "1.5 GB");
});
