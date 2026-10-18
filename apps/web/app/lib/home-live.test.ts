import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RepoChange } from "@g1t/contracts";

import { arrivedOf, homeShows, type HomeRepo } from "./home-live.ts";

const repos: HomeRepo[] = [{ id: "r1", path: "acme/web", defaultBranch: "main" }];
const change = (kind: string, extra: Partial<RepoChange> = {}): RepoChange => ({ repo_id: "r1", kind, at: "2026-10-15T00:00:00Z", ...extra });

describe("homeShows", () => {
  it("takes a default branch's pushes and tags, not another branch's", () => {
    assert.equal(homeShows(change("git.push", { ref: "refs/heads/main" }), repos), true);
    assert.equal(homeShows(change("git.push", { ref: "refs/tags/v1.0.0" }), repos), true);
    assert.equal(homeShows(change("git.push", { ref: "refs/heads/feature" }), repos), false);
  });

  it("takes any branch's push where the default branch is not known", () => {
    assert.equal(homeShows({ ...change("git.push", { ref: "refs/heads/feature" }), repo_id: "other" }, repos), true);
  });

  it("takes what Home lists and leaves a commit's checks", () => {
    for (const kind of ["pull.merged", "review.submitted", "work_item.opened", "comment.created", "workflow.completed", "run.updated", "deployment_status.created", "release.published", "session.started", "session.ended"]) {
      assert.equal(homeShows(change(kind), repos), true, kind);
    }
    for (const kind of ["status.created", "check_run.completed", "check_suite.completed", "checks.completed", "session.progressed", "git.deleted"]) {
      assert.equal(homeShows(change(kind), repos), false, kind);
    }
  });
});

describe("arrivedOf", () => {
  it("finds nothing new on the first draw", () => {
    const { arrived, seen } = arrivedOf(null, "last", ["a", "b"]);
    assert.deepEqual([...arrived], []);
    assert.deepEqual([...seen.keys], ["a", "b"]);
  });

  it("finds the rows that were not shown before", () => {
    const first = arrivedOf(null, "last", ["a", "b"]).seen;
    const { arrived } = arrivedOf(first, "last", ["c", "a", "b"]);
    assert.deepEqual([...arrived], ["c"]);
  });

  it("does not count a row that went and came back as new", () => {
    const first = arrivedOf(null, "last", ["a", "b"]).seen;
    const second = arrivedOf(first, "last", ["b"]).seen;
    assert.deepEqual([...arrivedOf(second, "last", ["a", "b"]).arrived], []);
  });

  it("starts over when the span switches", () => {
    const first = arrivedOf(null, "last", ["a"]).seen;
    assert.deepEqual([...arrivedOf(first, "7d", ["a", "b", "c"]).arrived], []);
  });
});
