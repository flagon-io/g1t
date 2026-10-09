import assert from "node:assert/strict";
import { test } from "node:test";

import { ASK, BEAT, CHECKS, LOOP_MS, PILLS, STEPS, STILLS, frameAt, pillAt, pillProgress, sameFrame } from "./tour.ts";

test("the first frame is the empty channel, the same on the server and the client", () => {
  const frame = frameAt(0);
  assert.equal(frame.scene, "chat");
  assert.equal(frame.typed, 0);
  assert.equal(frame.sent, false);
  assert.equal(frame.cursorShown, false);
  assert.ok(sameFrame(frame, frameAt(0)));
});

test("the message is typed in full before it is sent, then the composer empties", () => {
  assert.equal(frameAt(BEAT.typed).typed, ASK.length);
  assert.equal(frameAt(BEAT.typed - 1).typed, ASK.length - 1);
  const sent = frameAt(BEAT.sent);
  assert.equal(sent.sent, true);
  assert.equal(sent.typed, 0);
});

test("typing only ever moves forward", () => {
  let last = 0;
  for (let t = 0; t <= BEAT.typed; t += 17) {
    const typed = frameAt(t).typed;
    assert.ok(typed >= last);
    last = typed;
  }
});

test("the scenes come in the story's order", () => {
  const order: string[] = [];
  for (let t = 0; t < LOOP_MS; t += 100) {
    const scene = frameAt(t).scene;
    if (order[order.length - 1] !== scene) order.push(scene);
  }
  assert.deepEqual(order, ["chat", "agents", "code", "chat", "docs"]);
});

test("steps and checks finish before the cursor leaves them", () => {
  assert.equal(frameAt(BEAT.pullClick).steps, STEPS.length);
  assert.equal(frameAt(BEAT.approved).checks, CHECKS.length);
  assert.equal(frameAt(BEAT.pullClick).cursor, "task-pull");
});

test("the loop wraps", () => {
  assert.ok(sameFrame(frameAt(LOOP_MS + 1234), frameAt(1234)));
  assert.ok(sameFrame(frameAt(-1), frameAt(LOOP_MS - 1)));
});

test("pills start where their scene does, and progress runs 0 to 1", () => {
  PILLS.forEach((pill, index) => {
    assert.equal(frameAt(pill.start + 1).scene, pill.scene);
    assert.equal(pillAt(pill.start + 1), index);
  });
  assert.equal(pillAt(BEAT.chatAgain + 10), 2);
  assert.ok(pillProgress(PILLS[1].start) < 0.01);
  assert.ok(pillProgress(PILLS[2].start - 1) > 0.99);
});

test("each still shows its step's point", () => {
  assert.equal(frameAt(STILLS.chat).handoff, true);
  assert.equal(frameAt(STILLS.agents).steps, STEPS.length);
  assert.equal(frameAt(STILLS.code).approved, true);
  assert.equal(frameAt(STILLS.docs).docUpdated, true);
});

test("Izzy tells #support after g1t says it shipped, and the consult shows while Otto works", () => {
  assert.equal(frameAt(BEAT.izzy - 1).izzy, false);
  assert.equal(frameAt(BEAT.izzy).shipped, true);
  assert.equal(frameAt(BEAT.agents).consult, false);
  assert.equal(frameAt(BEAT.pullClick).consult, true);
});
