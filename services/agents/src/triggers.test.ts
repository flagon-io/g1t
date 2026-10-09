import assert from "node:assert/strict";
import { test } from "node:test";

import { follows, happened } from "./happened.ts";

const ev = (type: string, data: Record<string, unknown>) => ({ type, repoId: null, data }) as never;

test("events become the routine events they are, keyed so one thing runs once", () => {
  assert.deepEqual(happened(ev("pull.ready", { repoId: "rep_1", number: 12 }))?.key, "pull_ready:rep_1:12");
  assert.equal(happened(ev("pull.opened", { repoId: "rep_1", number: 12 }))?.key, "pull_ready:rep_1:12", "opened and ready are the same thing");
  assert.equal(happened(ev("checks.completed", { repoId: "rep_1", number: 3, status: "passed", commit: "abc" })), null);
  assert.equal(happened(ev("checks.completed", { repoId: "rep_1", number: 3, status: "failed", commit: "abc" }))?.key, "checks_failed:rep_1:3:abc");
  assert.notEqual(
    happened(ev("checks.completed", { repoId: "rep_1", number: 3, status: "errored", commit: "def" }))?.key,
    "checks_failed:rep_1:3:abc",
    "a new commit failing is a new thing",
  );
  assert.equal(happened(ev("issue.opened", { repoId: "rep_1", number: 9, title: "x" }))?.kind, "issue_opened");
  assert.equal(happened(ev("deployment.failed", { repoId: "rep_1", deploymentId: "dpl_1" }))?.key, "deploy_failed:dpl_1");
  assert.equal(happened(ev("pull.updated", { repoId: "rep_1", number: 1 })), null);
  assert.equal(happened(ev("pull.ready", { number: 1 })), null, "no repository, nothing to check access on");
});

test("a routine follows every repository, or only those it names", () => {
  assert.equal(follows([], "acme/web"), true);
  assert.equal(follows(["acme/web"], "Acme/Web"), true);
  assert.equal(follows(["acme/api"], "acme/web"), false);
});
