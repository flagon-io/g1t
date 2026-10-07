import assert from "node:assert/strict";
import { test } from "node:test";

import { shownStep } from "./agent-step";

test("a step that hands back a file says what was done, not where", () => {
  assert.equal(shownStep("Said: Done. The review is written to `/work/review.json`."), "Wrote its review.");
  assert.equal(shownStep("Said: Plan saved to /work/plan.json"), "Wrote the plan.");
  assert.equal(shownStep("Said: I wrote /work/answer.md"), "Wrote its answer.");
});

test("paths in the checkout read as the repository's own", () => {
  assert.equal(shownStep("Editing `/work/repo/src/math.js`"), "Editing src/math.js");
  assert.equal(shownStep("Running npm test"), "Running npm test");
});
