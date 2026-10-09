import assert from "node:assert/strict";
import { test } from "node:test";

import { Recent } from "./chat-cache.ts";

test("the conversation cache keeps the most recently used, and no more", () => {
  const recent = new Recent<number>(3);
  recent.set("a", 1);
  recent.set("b", 2);
  recent.set("c", 3);
  // Reading a moves it to the end, so b is the oldest.
  assert.equal(recent.get("a")?.value, 1);
  recent.set("d", 4);
  assert.deepEqual(recent.keys(), ["c", "a", "d"]);
  assert.equal(recent.has("b"), false);
  // Setting again replaces and refreshes.
  recent.set("c", 30);
  assert.deepEqual(recent.keys(), ["a", "d", "c"]);
  assert.equal(recent.get("c")?.value, 30);
});
