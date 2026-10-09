import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HISTORY,
  DEFAULT_PAGE,
  MAX_BODY,
  MAX_HISTORY,
  MAX_PAGE,
  historyOf,
  historySize,
  isTypingFrame,
  messageBody,
  meterDay,
  pageOf,
  pageSize,
} from "./messages.ts";

test("a message needs something in it, and not too much", () => {
  assert.deepEqual(messageBody("hello  \n"), { ok: true, body: "hello" });
  assert.equal(messageBody("   ").ok, false);
  assert.equal(messageBody(undefined).ok, false);
  // A card can stand alone.
  assert.deepEqual(messageBody("", true), { ok: true, body: "" });
  assert.equal(messageBody("x".repeat(MAX_BODY)).ok, true);
  assert.equal(messageBody("x".repeat(MAX_BODY + 1)).ok, false);
});

test("a page holds the default, or what was asked within limits", () => {
  assert.equal(pageSize(null), DEFAULT_PAGE);
  assert.equal(pageSize(10), 10);
  assert.equal(pageSize(0), 1);
  assert.equal(pageSize(10_000), MAX_PAGE);
  assert.equal(pageSize("20"), DEFAULT_PAGE);
});

test("a page read one past its size says where to read on from", () => {
  const rows = ["m5", "m4", "m3"].map((id) => ({ id }));
  assert.deepEqual(pageOf(rows, 2), { rows: rows.slice(0, 2), older: "m4" });
  assert.deepEqual(pageOf(rows, 3), { rows, older: null });
  assert.deepEqual(pageOf([], 3), { rows: [], older: null });
});

test("an agent reads 30 messages unless it asks, and at most 100", () => {
  assert.equal(historySize(null), DEFAULT_HISTORY);
  assert.equal(DEFAULT_HISTORY, 30);
  assert.equal(historySize(5), 5);
  assert.equal(historySize(0), 1);
  assert.equal(historySize(500), MAX_HISTORY);
  assert.equal(MAX_HISTORY, 100);
});

test("an agent's history is oldest first, a thread's root leading", () => {
  const newestFirst = ["m9", "m8", "m7"].map((id) => ({ id }));
  assert.deepEqual(historyOf(newestFirst).map((r) => r.id), ["m7", "m8", "m9"]);
  assert.deepEqual(historyOf(newestFirst, { id: "m1" }).map((r) => r.id), ["m1", "m7", "m8", "m9"]);
  // The root is never there twice.
  assert.deepEqual(historyOf([{ id: "m2" }, { id: "m1" }], { id: "m1" }).map((r) => r.id), ["m1", "m2"]);
  assert.deepEqual(historyOf([], { id: "m1" }).map((r) => r.id), ["m1"]);
});

test("the meter counts by UTC day", () => {
  assert.equal(meterDay("2026-10-08T23:59:59.999Z"), "2026-10-08");
});

test("a socket frame says typing in this channel, or is ignored", () => {
  assert.equal(isTypingFrame('{"type":"typing"}', "chn_1"), true);
  assert.equal(isTypingFrame('{"type":"typing","channel_id":"chn_1"}', "chn_1"), true);
  assert.equal(isTypingFrame('{"type":"typing","channel_id":"chn_2"}', "chn_1"), false);
  assert.equal(isTypingFrame('{"type":"post","body":"hi"}', "chn_1"), false);
  assert.equal(isTypingFrame("typing", "chn_1"), false);
  assert.equal(isTypingFrame("null", "chn_1"), false);
  assert.equal(isTypingFrame(new ArrayBuffer(4), "chn_1"), false);
});
