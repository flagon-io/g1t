import assert from "node:assert/strict";
import { test } from "node:test";

import type { BranchDrifts, Commit } from "@g1t/contracts";

import { activeBranches, branchesToRead } from "./branches.ts";

const commit = (hash: string, at: string, message = `${hash}\n\nbody`): Commit => ({
  hash,
  treeHash: `t${hash}`,
  message,
  author: { name: "Ada", email: "ada@example.com" },
  parents: [],
  authoredAt: at,
});

const branches = [
  { name: "main", hash: "m3" },
  { name: "old", hash: "o1" },
  { name: "fix", hash: "f2" },
  { name: "idea", hash: "i1" },
];
const pulls = [{ branch: "fix", number: 7, title: "Fix it", checkStatus: "passed" as const, status: "open" as const }];

test("branches with an open pull request are read first, the default branch never", () => {
  const read = branchesToRead({ defaultBranch: "main", branches, pulls }, 2);
  assert.deepEqual(read.reading.map((b) => b.name), ["fix", "old"]);
  assert.equal(read.total, 3);
  assert.equal(read.mainHead, "m3");
});

test("no default branch head, nothing to measure against", () => {
  assert.equal(branchesToRead({ defaultBranch: "trunk", branches, pulls: [] }, 10).mainHead, null);
});

test("each branch gets its measured commit and drift, newest first, by head hash", () => {
  const measured: BranchDrifts = {
    base: commit("m3", "2026-10-08T00:00:00Z"),
    branches: [
      { head: "f2", commit: commit("f2", "2026-10-07T00:00:00Z"), drift: { ahead: 2, behind: 1 } },
      { head: "o1", commit: commit("o1", "2026-01-01T00:00:00Z"), drift: null },
      { head: "i1", commit: commit("i1", "2026-10-08T00:00:00Z", "one line"), drift: { ahead: 1, behind: 0 } },
    ],
  };
  const { reading } = branchesToRead({ defaultBranch: "main", branches, pulls }, 10);
  const shown = activeBranches(reading, measured, { pulls, previews: [{ number: 7, url: "https://fix.g1t.page" }] });
  assert.deepEqual(shown.map((b) => b.name), ["idea", "fix", "old"]);
  assert.deepEqual(shown[1], {
    name: "fix",
    // No accounts given: the name on the commit, and never its address.
    commit: { hash: "f2", message: "f2", author: { kind: "author", name: "Ada", username: null, avatar: null }, coAuthors: [], at: "2026-10-07T00:00:00Z" },
    drift: { ahead: 2, behind: 1 },
    pull: { number: 7, title: "Fix it", checkStatus: "passed", draft: false },
    preview: "https://fix.g1t.page",
  });
  assert.equal(shown[2]?.drift, null);
});

test("when repos could not answer, the branches still show, without commits or counts", () => {
  const { reading } = branchesToRead({ defaultBranch: "main", branches, pulls: [] }, 10);
  const shown = activeBranches(reading, null, { pulls: [], previews: [] });
  assert.equal(shown.length, 3);
  assert.ok(shown.every((b) => b.commit == null && b.drift == null && b.pull == null));
});

test("repos' answer, as its JSON reads, keeps every count (flagon-io/hello's farewell)", () => {
  // What services/repos serializes for `branch_drift` (drift.rs
  // `the_answer_has_the_names_the_site_reads`): a name that differs here
  // would drop every count without an error.
  const wire = JSON.stringify({
    base: {
      hash: "8407eba",
      treeHash: "t1",
      message: "Use farewell() in the --both call",
      author: { name: "g1t agent", email: "agent@example.com" },
      parents: ["ac45e10"],
      authoredAt: "2026-10-03T09:11:34.000Z",
    },
    branches: [
      {
        head: "bab14ff",
        commit: {
          hash: "bab14ff",
          treeHash: "t2",
          message: "Add a farewell\n\nbody",
          author: { name: "syntaqx", email: "s@example.com" },
          parents: ["c2ef68d"],
          authoredAt: "2026-10-02T07:52:16.000Z",
        },
        drift: { ahead: 1, behind: 41 },
      },
    ],
  });
  const measured = JSON.parse(wire) as BranchDrifts;
  const shown = activeBranches([{ name: "farewell", hash: "bab14ff" }], measured, { pulls: [], previews: [] });
  assert.deepEqual(shown[0]?.drift, { ahead: 1, behind: 41 });
  assert.deepEqual(shown[0]?.commit, { hash: "bab14ff", message: "Add a farewell", author: "syntaqx", at: "2026-10-02T07:52:16.000Z" });
});
