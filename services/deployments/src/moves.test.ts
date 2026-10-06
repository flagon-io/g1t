import assert from "node:assert/strict";
import { test } from "node:test";

import { moveTargets, ownerOf, rebuildOutcome, retryDue, type MovedApp } from "./moves.ts";

const app = (over: Partial<MovedApp>): MovedApp => ({
  script: "lab-api-syntaqx",
  project_id: "prj_api",
  kind: "production",
  branch: null,
  number: null,
  commit_sha: "aaa",
  deployed_at: "2026-10-05T00:26:29Z",
  ...over,
});

test("each stale app is one target, paused or not, with the names it replaces", () => {
  const targets = moveTargets([
    app({}),
    app({ script: "lab-api-git-v2-syntaqx", kind: "preview", branch: "v2", number: 1, commit_sha: "bbb" }),
    app({ script: "automation-lab-syntaqx", project_id: "prj_lab", commit_sha: "ccc" }),
  ]);
  assert.deepEqual(
    targets.map((t) => [t.projectId, t.kind, t.branch, t.number, t.commit, t.from]),
    [
      ["prj_api", "production", null, null, "aaa", ["lab-api-syntaqx"]],
      ["prj_api", "preview", "v2", 1, "bbb", ["lab-api-git-v2-syntaqx"]],
      ["prj_lab", "production", null, null, "ccc", ["automation-lab-syntaqx"]],
    ],
  );
});

test("an app under two old names (moved twice) is built once, replacing both", () => {
  const targets = moveTargets([
    app({ script: "lab-api-acme", deployed_at: "2026-10-01T00:00:00Z", commit_sha: "old" }),
    app({ script: "lab-api-syntaqx", deployed_at: "2026-10-05T00:00:00Z", commit_sha: "new" }),
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].commit, "new");
  assert.deepEqual(targets[0].from.sort(), ["lab-api-acme", "lab-api-syntaqx"]);
});

test("a build a move dropped is built again, at its newer commit", () => {
  const targets = moveTargets(
    [app({})],
    [
      { project_id: "prj_api", kind: "production", branch: null, number: null, commit_sha: "newer", created_at: "2026-10-06T01:00:00Z" },
      { project_id: "prj_web", kind: "preview", branch: "x", number: 4, commit_sha: "w", created_at: "2026-10-06T01:00:00Z" },
    ],
  );
  assert.deepEqual(
    targets.map((t) => [t.projectId, t.commit, t.from]),
    [
      ["prj_api", "newer", ["lab-api-syntaqx"]],
      ["prj_web", "w", []],
    ],
  );
});

test("only a queued build counts as rebuilt; refusals and errors are tried again", () => {
  assert.equal(rebuildOutcome({ ok: true, value: { status: "queued" } }), "queued");
  assert.equal(rebuildOutcome({ ok: true, value: { status: "skipped" } }), "failed");
  assert.equal(rebuildOutcome({ ok: true, value: { status: "failed" } }), "failed");
  assert.equal(rebuildOutcome({ ok: false }), "failed");
  assert.equal(rebuildOutcome(null), "none");
});

test("a rebuild that could not start waits before it is tried again", () => {
  const now = Date.parse("2026-10-06T02:00:00Z");
  assert.equal(retryDue(null, now, 3600_000), true);
  assert.equal(retryDue("2026-10-06T01:30:00Z", now, 3600_000), false);
  assert.equal(retryDue("2026-10-06T01:00:00Z", now, 3600_000), true);
});

test("an app is its project's current workspace's, not the one its row names", () => {
  const owners = new Map([["prj_api", "flagon-io"]]);
  assert.equal(ownerOf({ project_id: "prj_api", workspace: "syntaqx" }, owners), "flagon-io");
  assert.equal(ownerOf({ project_id: "prj_gone", workspace: "syntaqx" }, owners), "syntaqx");
});
