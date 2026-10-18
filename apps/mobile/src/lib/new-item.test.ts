import assert from "node:assert/strict";
import { test } from "node:test";

import { originOf, workspaceRepos } from "./new-item.ts";

test("a new work item may land in its own workspace's repositories, each once", () => {
  const projects = [
    { repository: "acme/web" },
    { repository: null },
    { repository: "Acme/Web" },
    { repository: "acme/api" },
    // Shared with someone from another workspace: not this one's to land in.
    { repository: "other/tool" },
  ];
  assert.deepEqual(workspaceRepos("acme", projects), ["acme/web", "acme/api"]);
  assert.deepEqual(workspaceRepos("beta", projects), []);
});

test("a new work item is filed from a repository of its workspace, by name or path", () => {
  assert.equal(originOf("acme", "web"), "acme/web");
  assert.equal(originOf("acme", "Acme/web"), "acme/web");
  assert.equal(originOf("acme", "other/web"), null);
  assert.equal(originOf("acme", ""), null);
  assert.equal(originOf("acme", undefined), null);
});
