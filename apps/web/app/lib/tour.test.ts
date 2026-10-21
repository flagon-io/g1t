import assert from "node:assert/strict";
import { test } from "node:test";

import { BEAT, CHECKS, LOOP_MS, PILLS, SESSION, SETTLED, STILLS, SUMMARIZED, SUMMARY_WORDS, frameAt, pillAt, pillProgress, sameFrame } from "./tour.ts";

test("the first frame is Home before anything settles, the same on the server and the client", () => {
  const frame = frameAt(0);
  assert.equal(frame.scene, "home");
  assert.equal(frame.settled, 0);
  assert.equal(frame.summarizing, false);
  assert.equal(frame.checks, 0);
  assert.equal(frame.cursorShown, false);
  assert.ok(sameFrame(frame, frameAt(0)));
});

test("the scenes come in the story's order: Home first", () => {
  const order: string[] = [];
  for (let t = 0; t < LOOP_MS; t += 100) {
    const scene = frameAt(t).scene;
    if (order[order.length - 1] !== scene) order.push(scene);
  }
  assert.deepEqual(order, ["home", "code", "session", "chat"]);
});

test("checks pass before review, and the queue merges only after approval", () => {
  assert.equal(frameAt(BEAT.approved).checks, CHECKS.length);
  assert.equal(frameAt(BEAT.merged - 1).merged, false);
  assert.equal(frameAt(BEAT.merged).approved, true);
});

test("Home's #431 opens the pull request, and the cursor stays out of its way until it has merged", () => {
  assert.equal(frameAt(BEAT.prClick).cursor, "home-pr");
  assert.equal(frameAt(BEAT.prClick).click, true);
  assert.equal(frameAt(BEAT.prClick).scene, "home");
  assert.equal(frameAt(BEAT.code).scene, "code");
  assert.equal(frameAt(BEAT.code).checks, 0);
  assert.equal(frameAt(BEAT.merged - 1).cursorShown, false);
  assert.equal(frameAt(BEAT.sessionClick).cursor, "pr-session");
  assert.equal(frameAt(BEAT.sessionClick).click, true);
  assert.equal(frameAt(BEAT.chatTabClick).cursor, "tab-chat");
  assert.equal(frameAt(BEAT.chatTabClick).click, true);
});

test("the session plays back in full before the tour moves on to Chat", () => {
  assert.equal(frameAt(BEAT.session - 1).entries, 0);
  assert.equal(frameAt(BEAT.chatTabClick - 1).entries, SESSION.length);
  assert.equal(SESSION[0].kind, "prompt");
});

test("the loop wraps", () => {
  assert.ok(sameFrame(frameAt(LOOP_MS + 1234), frameAt(1234)));
  assert.ok(sameFrame(frameAt(-1), frameAt(LOOP_MS - 1)));
});

test("pills start where their scene does, and progress runs 0 to 1", () => {
  assert.equal(PILLS[0].scene, "home");
  PILLS.forEach((pill, index) => {
    assert.equal(frameAt(pill.start + 1).scene, pill.scene);
    assert.equal(pillAt(pill.start + 1), index);
  });
  assert.ok(pillProgress(PILLS[1].start) < 0.01);
  assert.ok(pillProgress(PILLS[2].start - 1) > 0.99);
});

test("each still shows its step's point", () => {
  assert.equal(frameAt(STILLS.code).approved, true);
  assert.equal(frameAt(STILLS.session).entries, SESSION.length);
  assert.equal(frameAt(STILLS.chat).told, true);
  assert.equal(frameAt(STILLS.home).words, SUMMARY_WORDS.length);
  assert.equal(frameAt(STILLS.home).cleared, SETTLED.length);
});

test("Dana tells support only after Priya says it shipped", () => {
  assert.equal(frameAt(BEAT.told - 1).told, false);
  assert.equal(frameAt(BEAT.told).shipped, true);
});

test("on Home, notifications settle and leave before Summarize, and the summary finishes before #431 is opened", () => {
  assert.equal(frameAt(BEAT.settle0 - 1).settled, 0);
  const before = frameAt(BEAT.summarizeClick);
  assert.equal(before.settled, SETTLED.length);
  assert.equal(before.cleared, SETTLED.length);
  assert.equal(before.cursor, "home-summarize");
  assert.equal(before.click, true);
  assert.equal(frameAt(BEAT.word0 - 1).words, 0);
  assert.ok(SUMMARIZED < BEAT.prClick - 700);
  assert.equal(frameAt(BEAT.prClick - 1).words, SUMMARY_WORDS.length);
  assert.ok(SUMMARY_WORDS.some((word) => word.includes("#431")));
});
