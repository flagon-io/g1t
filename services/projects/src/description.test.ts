import { test } from "node:test";
import assert from "node:assert/strict";

import { effectiveDescription, ownDescription } from "./description.ts";

test("a project without its own description shows its repository's, as it is now", () => {
  assert.deepEqual(effectiveDescription({ description: null, repo_description: "Git for agents" }), {
    description: "Git for agents",
    inherited: true,
  });
  assert.deepEqual(effectiveDescription({ description: null, repo_description: null }), { description: null, inherited: true });
  assert.deepEqual(effectiveDescription({ description: null }), { description: null, inherited: true });
});

test("its own description wins over the repository's", () => {
  assert.deepEqual(effectiveDescription({ description: "The storefront", repo_description: "Monorepo" }), {
    description: "The storefront",
    inherited: false,
  });
});

test("a change sets its own, clears back to the repository's, or leaves it", () => {
  assert.equal(ownDescription("Old", undefined), "Old");
  assert.equal(ownDescription(null, undefined), null);
  assert.equal(ownDescription("Old", "  New  "), "New");
  assert.equal(ownDescription("Old", ""), null);
  assert.equal(ownDescription("Old", "   "), null);
  assert.equal(ownDescription("Old", null), null);
  assert.equal(ownDescription(null, "x".repeat(300))?.length, 200);
});
