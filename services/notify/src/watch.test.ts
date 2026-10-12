import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CHANGES, WATCH_MS, byRepo, cleanChange, cleanRepoId, cleanRepoPath, named, stillWatching, watchUntil } from "./watch.ts";

const AT = "2026-10-11T10:00:00Z";

test("a change keeps only what a change carries", () => {
  const change = cleanChange({
    repo_id: "rep_1",
    kind: "git.push",
    ref: "refs/heads/main",
    sha: "abc123",
    commits: 3,
    at: AT,
    title: "a secret title",
    body: "and its body",
  });
  assert.deepEqual(change, { repo_id: "rep_1", kind: "git.push", ref: "refs/heads/main", sha: "abc123", commits: 3, at: AT });
});

test("what is not a change is dropped", () => {
  assert.equal(cleanChange(null), null);
  assert.equal(cleanChange("git.push"), null);
  assert.equal(cleanChange({ kind: "git.push", at: AT }), null);
  assert.equal(cleanChange({ repo_id: "rep 1", kind: "git.push", at: AT }), null);
  assert.equal(cleanChange({ repo_id: "rep_1", kind: "<script>", at: AT }), null);
  // A field of the wrong shape goes; the change stays.
  assert.deepEqual(cleanChange({ repo_id: "rep_1", kind: "pull.updated", number: -1, sha: "not a sha", run: "run 9", at: AT }), {
    repo_id: "rep_1",
    kind: "pull.updated",
    at: AT,
  });
  assert.deepEqual(cleanChange({ repo_id: "rep_1", kind: "run.updated", run: "run_9", number: 4, at: AT }), {
    repo_id: "rep_1",
    kind: "run.updated",
    run: "run_9",
    number: 4,
    at: AT,
  });
});

test("changes go to their repositories in the order they came", () => {
  const grouped = byRepo([
    { repo_id: "rep_1", kind: "pull.opened", number: 1, at: AT },
    { repo_id: "rep_2", kind: "issue.opened", number: 2, at: AT },
    { repo_id: "rep_1", kind: "pull.updated", number: 1, at: AT },
    { nonsense: true },
  ]);
  assert.deepEqual([...grouped.keys()], ["rep_1", "rep_2"]);
  assert.deepEqual(
    grouped.get("rep_1")!.map((change) => change.kind),
    ["pull.opened", "pull.updated"],
  );
  assert.equal(byRepo("nope").size, 0);
  const many = Array.from({ length: MAX_CHANGES + 10 }, (_, n) => ({ repo_id: "rep_1", kind: "pull.updated", number: n, at: AT }));
  assert.equal(byRepo(many).get("rep_1")!.length, MAX_CHANGES);
});

test("each watcher hears the repository by the name it asked for", () => {
  const changes = [{ repo_id: "rep_1", kind: "git.push", at: AT }];
  assert.deepEqual(named(changes, "acme/rocket"), [{ repo_id: "rep_1", kind: "git.push", at: AT, repo: "acme/rocket" }]);
  assert.equal(Object.hasOwn(changes[0]!, "repo"), false, "the topic's own list is left as it was");
});

test("repository ids and paths are checked", () => {
  assert.equal(cleanRepoId("rep_01J9"), "rep_01J9");
  assert.equal(cleanRepoId("../x"), null);
  assert.equal(cleanRepoPath("acme/rocket.js"), "acme/rocket.js");
  assert.equal(cleanRepoPath("acme"), null);
  assert.equal(cleanRepoPath("acme/rocket/extra"), null);
});

test("a watch lasts its time and no longer", () => {
  const now = Date.parse(AT);
  const until = watchUntil(now);
  assert.equal(until, now + WATCH_MS);
  assert.equal(stillWatching(until, now + WATCH_MS - 1), true);
  assert.equal(stillWatching(until, now + WATCH_MS), false);
  assert.equal(stillWatching(null, now), false);
});
