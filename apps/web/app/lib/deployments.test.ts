import assert from "node:assert/strict";
import { test } from "node:test";

import { buildError, groupBuilds } from "./deployments.ts";

const GIT =
  "the commit could not be checked out: git -c failed: fatal: reference is not a tree: d2ca224ba0fea430dcc9933cda14d8aa9fa94b4b";

type Build = Parameters<typeof groupBuilds>[0][number] & { id: string };

let hour = 0;
const build = (over: Partial<Build>): Build => ({
  id: `dep_${hour}`,
  kind: "preview",
  branch: "v2",
  number: 1,
  status: "failed",
  error: GIT,
  createdAt: new Date(Date.parse("2026-10-07T12:00:00Z") - hour++ * 3_600_000).toISOString(),
  ...over,
});

test("a commit that is gone is said plainly, naming the pull request", () => {
  assert.equal(
    buildError({ kind: "preview", number: 1, error: GIT }),
    "This pull request's commit no longer exists. Push again, or close pull request #1.",
  );
  assert.match(buildError({ kind: "production", number: null, error: GIT })!, /default branch/);
  assert.equal(buildError({ kind: "preview", number: 1, error: "npm run build exited 1." }), "npm run build exited 1.");
  assert.equal(buildError({ kind: "preview", number: 1, error: null }), null);
});

test("a run of the same failure of one app is one row, counted, linking to the newest", () => {
  hour = 0;
  const builds = [build({}), build({}), build({}), build({ status: "ready", error: null }), build({})];
  const groups = groupBuilds(builds);
  assert.deepEqual(
    groups.map((g) => [g.build.id, g.count]),
    [
      ["dep_0", 3],
      ["dep_3", 1],
      ["dep_4", 1],
    ],
  );
  assert.equal(groups[0]!.firstAt, builds[2]!.createdAt);
});

test("other apps' builds in between do not break a run; a different error does", () => {
  hour = 0;
  const groups = groupBuilds([
    build({}),
    build({ kind: "production", branch: null, number: null, status: "ready", error: null }),
    build({}),
    build({ branch: "add-ci", number: 2, error: "fatal: reference is not a tree: 213e9095" }),
    build({}),
    build({ error: "npm run build exited 1." }),
    build({ error: "npm run build exited 1." }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.build.id, g.count]),
    [
      ["dep_0", 3],
      ["dep_1", 1],
      ["dep_3", 1],
      ["dep_5", 2],
    ],
  );
});

test("builds that did not fail are never folded", () => {
  hour = 0;
  const ready = groupBuilds([build({ status: "ready", error: null }), build({ status: "ready", error: null })]);
  assert.deepEqual(ready.map((g) => g.count), [1, 1]);
  assert.deepEqual(groupBuilds([]), []);
});
