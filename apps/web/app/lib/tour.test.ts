import assert from "node:assert/strict";
import { test } from "node:test";

import { BEAT, CHECKS, LOOP_MS, PILLS, STEPS, STILLS, frameAt, pillAt, pillProgress, sameFrame } from "./tour.ts";

test("the first frame is the pull request before its checks, the same on the server and the client", () => {
  const frame = frameAt(0);
  assert.equal(frame.scene, "code");
  assert.equal(frame.checks, 0);
  assert.equal(frame.merged, false);
  assert.equal(frame.cursorShown, false);
  assert.ok(sameFrame(frame, frameAt(0)));
});

test("the scenes come in the story's order: Code first", () => {
  const order: string[] = [];
  for (let t = 0; t < LOOP_MS; t += 100) {
    const scene = frameAt(t).scene;
    if (order[order.length - 1] !== scene) order.push(scene);
  }
  assert.deepEqual(order, ["code", "chat", "agents", "docs"]);
});

test("checks pass before review, and the queue merges only after approval", () => {
  assert.equal(frameAt(BEAT.approved).checks, CHECKS.length);
  assert.equal(frameAt(BEAT.merged - 1).merged, false);
  assert.equal(frameAt(BEAT.merged).approved, true);
});

test("the cursor leaves the code only once it has merged", () => {
  assert.equal(frameAt(BEAT.merged - 1).cursorShown, false);
  assert.equal(frameAt(BEAT.railChatClick).cursor, "rail-chat");
  assert.equal(frameAt(BEAT.railChatClick).click, true);
});

test("Otto's work is done before the story opens", () => {
  for (const t of [0, BEAT.chat, BEAT.agents]) assert.equal(frameAt(t).steps, STEPS.length);
});

test("the loop wraps", () => {
  assert.ok(sameFrame(frameAt(LOOP_MS + 1234), frameAt(1234)));
  assert.ok(sameFrame(frameAt(-1), frameAt(LOOP_MS - 1)));
});

test("pills start where their scene does, and progress runs 0 to 1", () => {
  assert.equal(PILLS[0].scene, "code");
  PILLS.forEach((pill, index) => {
    assert.equal(frameAt(pill.start + 1).scene, pill.scene);
    assert.equal(pillAt(pill.start + 1), index);
  });
  assert.ok(pillProgress(PILLS[1].start) < 0.01);
  assert.ok(pillProgress(PILLS[2].start - 1) > 0.99);
});

test("each still shows its step's point", () => {
  assert.equal(frameAt(STILLS.code).approved, true);
  assert.equal(frameAt(STILLS.chat).izzy, true);
  assert.equal(frameAt(STILLS.agents).scene, "agents");
  assert.equal(frameAt(STILLS.docs).docUpdated, true);
});

test("Izzy tells #support after g1t says it shipped", () => {
  assert.equal(frameAt(BEAT.izzy - 1).izzy, false);
  assert.equal(frameAt(BEAT.izzy).shipped, true);
});
