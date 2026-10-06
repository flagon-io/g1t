import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmsSlug, deletionRefusal, whatGoes } from "./workspace-deletion.ts";

const nothing = { repositories: 0, projects: 0, members: 0, billing: null, protected: false };

test("what goes lists only what the workspace holds", () => {
  assert.deepEqual(whatGoes(nothing, null), []);
  assert.deepEqual(whatGoes({ ...nothing, repositories: 1, projects: 2, members: 1 }, 3), [
    "1 repository, with its issues, pull requests and workflow runs",
    "2 projects",
    "3 live apps, taken offline",
    "Access for 1 member; their own accounts stay",
  ]);
  assert.deepEqual(whatGoes({ ...nothing, repositories: 4 }, 0), [
    "4 repositories, with their issues, pull requests and workflow runs",
  ]);
});

test("only billing or protection stands in the way", () => {
  assert.equal(deletionRefusal("acme", null), null);
  assert.equal(deletionRefusal("acme", { ...nothing, repositories: 9, projects: 2 }), null);
  assert.equal(deletionRefusal("acme", { ...nothing, billing: "Pay first." }), "Pay first.");
  assert.equal(
    deletionRefusal("flagon-io", { ...nothing, billing: "Pay first.", protected: true }),
    "flagon-io is protected and can never be deleted.",
  );
});

test("the slug confirms in any case, and nothing else does", () => {
  assert.ok(confirmsSlug("acme", " ACME "));
  assert.ok(!confirmsSlug("acme", ""));
  assert.ok(!confirmsSlug("acme", "acme-inc"));
});
