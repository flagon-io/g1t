import assert from "node:assert/strict";
import { test } from "node:test";

import { projectHealthLabel, projectLive, projectSlug, projectStateLabel } from "./work.ts";

test("a project's slug is made from its name, as the work service makes it", () => {
  assert.equal(projectSlug("Work overhaul"), "work-overhaul");
  assert.equal(projectSlug("  Mobile 2.0!! "), "mobile-2-0");
  assert.equal(projectSlug("--a__b--"), "a-b");
  assert.equal(projectSlug("!!!"), "");
  // A number would read as a work item's.
  assert.equal(projectSlug("2026"), "");
  assert.equal(projectSlug("x".repeat(100)).length, 60);
});

test("states and health read as people say them", () => {
  assert.equal(projectStateLabel("shaping"), "Shaping");
  assert.equal(projectHealthLabel("at_risk"), "At risk");
  assert.ok(projectLive("paused"));
  assert.ok(!projectLive("done"));
});
