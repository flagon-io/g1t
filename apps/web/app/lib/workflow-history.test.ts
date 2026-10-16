import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWorkflows, isArchivedWorkflow } from "./workflow-history.ts";

test("only a removed file is archived, not a disabled, invalid or branch-only workflow", () => {
  const current = [
    { id: "active", error: null },
    { id: "disabled", error: null, state: "disabled" },
    { id: "invalid", error: "Invalid YAML" },
    { id: "branch", error: "Its file is not on the default branch." },
  ];
  const removed = { id: "removed", error: "Its file is no longer on the default branch." };
  assert.deepEqual(groupWorkflows([current[0], removed, ...current.slice(1)]), { current, archived: [removed] });
  assert.equal(isArchivedWorkflow({ ...removed, error: null }), false);
});

test("an archive-only repository keeps its workflow history available", () => {
  const removed = { id: "old", error: "Its file is no longer on the default branch." };
  assert.deepEqual(groupWorkflows([removed]), { current: [], archived: [removed] });
  assert.deepEqual(groupWorkflows([]), { current: [], archived: [] });
});
