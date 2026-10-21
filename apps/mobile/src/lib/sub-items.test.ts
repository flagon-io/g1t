import assert from "node:assert/strict";
import { test } from "node:test";

import { closeBody, numberList, openSubItemsLabel, parseNumber, progressLabel, progressOf, progressShare, progressShort } from "./sub-items.ts";

test("progress counts the closed sub-items of all of them", () => {
  assert.equal(progressOf([]), null);
  const progress = progressOf([{ state: "closed" }, { state: "open" }, { state: "closed" }]);
  assert.deepEqual(progress, { done: 2, total: 3 });
  assert.equal(progressLabel(progress!), "2 of 3 done");
  assert.equal(progressShort(progress!), "2/3");
  assert.equal(progressShare({ done: 0, total: 0 }), 0);
  assert.equal(progressShare({ done: 7, total: 7 }), 1);
});

test("open sub-items are named the way g1t names them", () => {
  assert.equal(numberList([230]), "#230");
  assert.equal(numberList([230, 231]), "#230 and #231");
  assert.equal(numberList([230, 231, 233]), "#230, #231 and #233");
  assert.equal(openSubItemsLabel(212, [{ number: 230 }]), "#212 has 1 open sub-item (#230).");
  assert.equal(openSubItemsLabel(212, [{ number: 230 }, { number: 231 }]), "#212 has 2 open sub-items (#230 and #231).");
});

test("closing says what to do with open sub-items only when asked", () => {
  assert.deepEqual(closeBody("completed"), { reason: "completed" });
  assert.deepEqual(closeBody("completed", "leave"), { reason: "completed", sub_items: "leave" });
  assert.deepEqual(closeBody("not_planned", "close"), { reason: "not_planned", sub_items: "close" });
  assert.deepEqual(closeBody("completed", "move", 240), { reason: "completed", sub_items: "move", move_to: 240 });
});

test("a typed work item number", () => {
  assert.equal(parseNumber("212"), 212);
  assert.equal(parseNumber(" #212 "), 212);
  assert.equal(parseNumber("0"), null);
  assert.equal(parseNumber("12a"), null);
  assert.equal(parseNumber(""), null);
});
