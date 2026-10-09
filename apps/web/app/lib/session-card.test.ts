import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_STATES, sessionChip } from "./session-card.ts";

test("a session card's state reads as what is happening", () => {
  assert.deepEqual(sessionChip("Working"), { tone: "accent", live: true });
  assert.deepEqual(sessionChip("Needs approval"), { tone: "warn", live: false });
  assert.deepEqual(sessionChip("Done"), { tone: "success", live: false });
  assert.deepEqual(sessionChip("Failed"), { tone: "danger", live: false });
  assert.deepEqual(sessionChip("Stopped"), { tone: "neutral", live: false });
  assert.deepEqual(sessionChip("Queued"), { tone: "neutral", live: false });
  assert.equal(sessionChip("Waiting on helpers").live, true);
});

test("every state has a chip, whatever its case; an unknown one is quiet", () => {
  for (const state of SESSION_STATES) assert.ok(sessionChip(state.toUpperCase()));
  assert.deepEqual(sessionChip("Exploding"), { tone: "neutral", live: false });
  assert.deepEqual(sessionChip(null), { tone: "neutral", live: false });
});
