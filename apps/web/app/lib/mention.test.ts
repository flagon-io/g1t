import assert from "node:assert/strict";
import { test } from "node:test";

import { partialMention } from "./mention.ts";

test("an @ that could become @g1t-agent is offered", () => {
  assert.equal(partialMention("@", 1), 0);
  assert.equal(partialMention("thanks @g1", 10), 7);
  assert.equal(partialMention("(@G1T-a", 7), 1);
  assert.equal(partialMention("line\n@g1t-agen", 14), 5);
});

test("anything else is not", () => {
  // Already complete.
  assert.equal(partialMention("@g1t-agent", 10), null);
  // Another name.
  assert.equal(partialMention("@ana", 4), null);
  // An email address.
  assert.equal(partialMention("me@g1", 5), null);
  // The caret is not at the end of it.
  assert.equal(partialMention("@g1 later", 9), null);
});
