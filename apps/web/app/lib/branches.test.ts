import assert from "node:assert/strict";
import { test } from "node:test";

import type { BranchDrifts, Commit } from "@g1t/contracts";

import { activeBranches, branchSections, branchTab, branchesToRead, driftScale, isMerged, isStale, isYours } from "./branches.ts";

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
  assert.deepEqual(
    read.reading.map((b) => b.name),
    ["fix", "old"],
  );
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
  assert.deepEqual(
    shown.map((b) => b.name),
    ["idea", "fix", "old"],
  );
  assert.deepEqual(shown[1], {
    name: "fix",
    head: "f2",
    // No accounts given: the name on the commit, and never its address.
    commit: { hash: "f2", message: "f2", author: { kind: "author", name: "Ada", username: null, avatar: null }, coAuthors: [], at: "2026-10-07T00:00:00Z" },
    drift: { ahead: 2, behind: 1 },
    pull: { number: 7, title: "Fix it", checkStatus: "passed", draft: false, status: "open" },
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
  assert.deepEqual(shown[0]?.commit, {
    hash: "bab14ff",
    message: "Add a farewell",
    author: { kind: "author", name: "syntaqx", username: null, avatar: null },
    coAuthors: [],
    at: "2026-10-02T07:52:16.000Z",
  });
});

test("a branch's pull request is the open one, else the newest merged or closed", () => {
  const reading = [
    { name: "fix", hash: "f2" },
    { name: "done", hash: "d1" },
  ];
  const newestFirst = [
    { branch: "done", number: 9, title: "Second try", checkStatus: null, status: "merged" as const },
    { branch: "fix", number: 8, title: "Closed", checkStatus: null, status: "closed" as const },
    { branch: "done", number: 5, title: "First try", checkStatus: null, status: "closed" as const },
    { branch: "fix", number: 7, title: "Fix it", checkStatus: "passed" as const, status: "open" as const },
  ];
  const shown = activeBranches(reading, null, { pulls: newestFirst, previews: [] });
  assert.deepEqual(
    shown.map((b) => [b.name, b.pull?.number, b.pull?.status]),
    [
      ["fix", 7, "open"],
      ["done", 9, "merged"],
    ],
  );
  // Only an open pull request puts a branch first in line to be read.
  const all = [
    { name: "main", hash: "m" },
    { name: "a", hash: "a" },
    { name: "done", hash: "d1" },
  ];
  assert.deepEqual(
    branchesToRead({ defaultBranch: "main", branches: all, pulls: newestFirst }, 1).reading.map((b) => b.name),
    ["a"],
  );
});

const now = Date.parse("2026-10-11T00:00:00Z");
const row = (name: string, at: string | null, username: string | null = null, drift: { ahead: number; behind: number } | null = null) => ({
  name,
  head: name,
  commit: at ? { hash: name, message: name, author: { kind: "user" as const, name, username, avatar: null }, coAuthors: [], at } : null,
  drift,
  pull: null,
  preview: null,
});

test("a tab comes from the address, the overview otherwise", () => {
  assert.equal(branchTab("stale"), "stale");
  assert.equal(branchTab("STALE"), "overview");
  assert.equal(branchTab(null), "overview");
});

test("stale is no commits in 90 days; yours is the viewer's latest commit", () => {
  assert.equal(isStale(row("old", "2026-07-01T00:00:00Z"), now), true);
  assert.equal(isStale(row("new", "2026-09-01T00:00:00Z"), now), false);
  assert.equal(isStale(row("unread", null), now), false);
  assert.equal(isYours(row("mine", "2026-10-01T00:00:00Z", "Ada"), "ada"), true);
  assert.equal(isYours(row("theirs", "2026-10-01T00:00:00Z", "grace"), "ada"), false);
  assert.equal(isYours(row("nobody", "2026-10-01T00:00:00Z", null), null), false);
});

test("a branch with nothing the default branch lacks, or a merged pull request, is merged", () => {
  assert.equal(isMerged({ drift: { ahead: 0, behind: 3 }, pull: null }), true);
  assert.equal(isMerged({ drift: { ahead: 2, behind: 0 }, pull: null }), false);
  assert.equal(isMerged({ drift: null, pull: null }), false);
  assert.equal(isMerged({ drift: { ahead: 2, behind: 0 }, pull: { number: 1, title: "", checkStatus: null, draft: false, status: "merged" } }), true);
});

test("the overview shows a few of yours, the active and the stale ones; each tab lists its own", () => {
  const rows = [
    row("a", "2026-10-10T00:00:00Z", "ada"),
    row("b", "2026-10-09T00:00:00Z", "grace"),
    row("c", "2026-10-08T00:00:00Z", "ada"),
    row("d", "2026-01-01T00:00:00Z", "ada"),
  ];
  const viewer = { username: "ada", now };
  assert.deepEqual(
    branchSections(rows, "overview", viewer, 2).map((s) => [s.tab, s.branches.map((b) => b.name), s.more]),
    [
      ["yours", ["a", "c"], 1],
      ["active", ["a", "b"], 1],
      ["stale", ["d"], 0],
    ],
  );
  // Someone with no branches of their own sees no section of theirs.
  assert.deepEqual(
    branchSections(rows, "overview", { username: "linus", now }).map((s) => s.tab),
    ["active", "stale"],
  );
  assert.deepEqual(
    branchSections(rows, "stale", viewer)[0]?.branches.map((b) => b.name),
    ["d"],
  );
  assert.deepEqual(
    branchSections(rows, "active", viewer)[0]?.branches.map((b) => b.name),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    branchSections(rows, "yours", viewer)[0]?.branches.map((b) => b.name),
    ["a", "c", "d"],
  );
  assert.equal(branchSections(rows, "all", viewer)[0]?.branches.length, 4);
});

test("the bars are drawn against the longest count shown", () => {
  assert.equal(driftScale([row("a", null, null, { ahead: 3, behind: 40 }), row("b", null, null, { ahead: 12, behind: 0 })]), 40);
  assert.equal(driftScale([row("a", null)]), 1);
});
