import assert from "node:assert/strict";
import { test } from "node:test";

import { trialClosed } from "./trial.ts";

const base = { usedMicros: 0, limitMicros: 1_000_000, endsAt: null };

test("an open trial says nothing", () => {
  assert.equal(trialClosed({ ...base, open: true, reason: null }, "acme"), null);
  assert.equal(trialClosed(null, "acme"), null);
});

test("a spent trial and a given-out month say so", () => {
  assert.equal(trialClosed({ ...base, open: false, reason: "used" }, "acme"), "acme has used its trial credit on g1t.");
  assert.equal(
    trialClosed({ ...base, open: false, reason: "pool", waitsUntil: "2026-11-01T00:00:00Z" }, "acme"),
    "This month's free trials are all given out; new ones start on November 1.",
  );
});

test("a workspace without a card check is told it needs one", () => {
  assert.equal(
    trialClosed({ ...base, open: false, reason: "verify" as never }, "acme"),
    "acme needs a card check before its trial starts. The card is never charged.",
  );
});
