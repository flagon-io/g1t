import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCheckSections } from "./project-checks.ts";

test("a CLI-only fix keeps latest branch checks separate from the older production commit", () => {
  assert.deepEqual(projectCheckSections("6049e67", "main", "a8f62b9"), [
    { kind: "branch", label: "Latest on main", sha: "6049e67" },
    { kind: "production", label: "Checks for deployed commit", sha: "a8f62b9" },
  ]);
});

test("the same commit is not reported twice, and a project without deployment still shows branch checks", () => {
  const branch = [{ kind: "branch", label: "Latest on trunk", sha: "head" }];
  assert.deepEqual(projectCheckSections("head", "trunk", "head"), branch);
  assert.deepEqual(projectCheckSections("head", "trunk", null), branch);
});

test("an unavailable branch head never mislabels deployed checks as latest branch checks", () => {
  assert.deepEqual(projectCheckSections(null, "main", "old"), [{ kind: "production", label: "Checks for deployed commit", sha: "old" }]);
  assert.deepEqual(projectCheckSections(null, null, null), []);
});
