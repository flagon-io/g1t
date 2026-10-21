import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_STATES, WAITING_ON_YOU, hostedState, sessionChip } from "./session-card.ts";

test("a session card's state reads as what is happening", () => {
  assert.deepEqual(sessionChip("Working"), { tone: "accent", live: false });
  assert.deepEqual(sessionChip("Needs approval"), { tone: "warn", live: false });
  assert.deepEqual(sessionChip("Done"), { tone: "success", live: false });
  assert.deepEqual(sessionChip("Failed"), { tone: "danger", live: false });
  assert.deepEqual(sessionChip("Stopped"), { tone: "neutral", live: false });
  assert.deepEqual(sessionChip("Queued"), { tone: "neutral", live: false });
  assert.equal(sessionChip("Waiting on helpers").live, false);
});

test("every state has a chip, whatever its case; an unknown one is quiet", () => {
  for (const state of SESSION_STATES) assert.ok(sessionChip(state.toUpperCase()));
  assert.deepEqual(sessionChip("Exploding"), { tone: "neutral", live: false });
  assert.deepEqual(sessionChip(null), { tone: "neutral", live: false });
});

test("g1t's card for a hosted session says Working, Waiting on you while a call waits on the viewer, then Done", () => {
  assert.equal(hostedState({ running: true, waiting: false }), "Working");
  assert.equal(hostedState({ running: true }), "Working", "a follow route that did not say");
  assert.equal(hostedState({ running: true, waiting: true }), WAITING_ON_YOU);
  assert.equal(hostedState({ running: false, waiting: true }), "Done", "an ended session waits on nobody");
  assert.deepEqual(sessionChip(WAITING_ON_YOU), { tone: "warn", live: false });
});
