import assert from "node:assert/strict";
import { test } from "node:test";

import { MARK_TTL_MS, type Marks, takeMark } from "./one-tab.ts";

function memory(): Marks & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), keys: () => [...data.keys()], remove: (k) => void data.delete(k) };
}

test("the first tab to claim an arrival pings, and every other tab stays quiet", () => {
  const shared = memory();
  assert.equal(takeMark(shared, "msg:1", 1_000), true);
  assert.equal(takeMark(shared, "msg:1", 1_200), false);
  assert.equal(takeMark(shared, "msg:2", 1_300), true);
});

test("old marks are cleared as tabs claim, and other keys are left alone", () => {
  const shared = memory();
  shared.set("g1t:pinged:msg:old", "0");
  shared.set("g1t:pinged:msg:bad", "nope");
  shared.set("g1t_theme", "dark");
  takeMark(shared, "msg:new", MARK_TTL_MS + 1);
  assert.deepEqual([...shared.data.keys()].sort(), ["g1t:pinged:msg:new", "g1t_theme"]);
});
