import assert from "node:assert/strict";
import { test } from "node:test";

import { commitMissing, missingCommitMessage, retryDecision, type PastBuild } from "./retries.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const GIT =
  "the commit could not be checked out: git -c failed: fatal: reference is not a tree: d2ca224ba0fea430dcc9933cda14d8aa9fa94b4b";

const build = (hoursAgo: number, over: Partial<PastBuild> = {}): PastBuild => ({
  status: "failed",
  error: "The build failed: npm run build exited 1.",
  commit_sha: "d2ca224",
  created_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  ...over,
});

test("git's words for a commit that is gone are recognised, and only those", () => {
  assert.equal(commitMissing(GIT), true);
  assert.equal(commitMissing("fatal: remote error: upload-pack: not our ref d2ca224"), true);
  assert.equal(commitMissing(missingCommitMessage({ kind: "preview", number: 1 })), true);
  assert.equal(commitMissing("The build failed: npm run build exited 1."), false);
  assert.equal(commitMissing(null), false);
});

test("a commit that is gone says so plainly, naming the pull request", () => {
  assert.equal(
    missingCommitMessage({ kind: "preview", number: 1 }),
    "This pull request's commit no longer exists. Push again, or close pull request #1.",
  );
  assert.match(missingCommitMessage({ kind: "preview", number: null }), /branch's commit no longer exists/);
  assert.match(missingCommitMessage({ kind: "production", number: null }), /default branch/);
});

test("nothing built yet, or the last build went up long ago: build", () => {
  assert.deepEqual(retryDecision([], NOW, HOUR, { backoff: true }), { kind: "build" });
  assert.deepEqual(retryDecision([build(3, { status: "ready", error: null })], NOW, HOUR, { backoff: true }), { kind: "build" });
});

test("a commit that is gone is never tried again, with or without backoff", () => {
  const history = [build(30, { error: GIT })];
  assert.deepEqual(retryDecision(history, NOW, HOUR, { backoff: true }), { kind: "stop", reason: "missing_commit" });
  assert.deepEqual(retryDecision(history, NOW, HOUR), { kind: "stop", reason: "missing_commit" });
});

test("each identical failure doubles the wait", () => {
  // One failure: an hour.
  assert.equal(retryDecision([build(0.5)], NOW, HOUR, { backoff: true }).kind, "wait");
  assert.equal(retryDecision([build(1)], NOW, HOUR, { backoff: true }).kind, "build");
  // Two in a row: two hours after the last.
  const two = [build(1.5), build(3)];
  assert.deepEqual(retryDecision(two, NOW, HOUR, { backoff: true }), { kind: "wait", until: NOW + 0.5 * HOUR });
  assert.equal(retryDecision([build(2), build(4)], NOW, HOUR, { backoff: true }).kind, "build");
});

test("three identical failures in a row stop it", () => {
  const history = [build(10), build(12), build(14)];
  assert.deepEqual(retryDecision(history, NOW, HOUR, { backoff: true }), { kind: "stop", reason: "failing" });
  assert.deepEqual(retryDecision(history, NOW, HOUR), { kind: "stop", reason: "failing" });
});

test("a different error or commit starts the count again", () => {
  const otherError = [build(10), build(12), build(14, { error: "Cloudflare did not take the app: 500" })];
  assert.equal(retryDecision(otherError, NOW, HOUR, { backoff: true }).kind, "build");
  const otherCommit = [build(10), build(12, { commit_sha: "8e500b1" }), build(14, { commit_sha: "8e500b1" })];
  assert.equal(retryDecision(otherCommit, NOW, HOUR, { backoff: true }).kind, "build");
  // A build that went up in between ends the run.
  const recovered = [build(10), build(12, { status: "ready", error: null }), build(14)];
  assert.equal(retryDecision(recovered, NOW, HOUR, { backoff: true }).kind, "build");
});

test("a refused or skipped rebuild waits the base delay with backoff, not without", () => {
  const skipped = [build(0.5, { status: "skipped", error: "Over the limit." })];
  assert.equal(retryDecision(skipped, NOW, HOUR, { backoff: true }).kind, "wait");
  assert.equal(retryDecision(skipped, NOW, HOUR).kind, "build");
});
