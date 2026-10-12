import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Merged,
  placePushes,
  historyCovers,
  change,
  checksFact,
  dayKey,
  isTestFile,
  landedToday,
  mergedAutomatically,
  parseSort,
  parseTab,
  pullFacts,
  reachesBack,
  reasonFor,
  signedPercent,
  sortRows,
  summaryLine,
  pushedByPerson,
  pushedCommits,
  weekOf,
  whyFor,
} from "./mission-control.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2026-10-05, 18:00 UTC.
const NOW = Date.parse("2026-10-05T18:00:00Z");
const repo = { namespace: "acme", name: "web" };

test("each kind of need gets its reason chip", () => {
  assert.equal(reasonFor({ kind: "deploy" }), "blocking");
  assert.equal(reasonFor({ kind: "review" }), "needs_review");
  assert.equal(reasonFor({ kind: "invitation" }), "invited");
  assert.equal(reasonFor({ kind: "checks" }), "checks_failing");
  assert.equal(reasonFor({ kind: "runner" }), "stalled");
});

test("why a need needs a person is said for every reason", () => {
  for (const kind of ["deploy", "invitation", "review", "stuck", "checks", "ready", "conflict", "stalled", "runner"] as const) {
    const need = { kind };
    assert.ok(whyFor(reasonFor(need), need).length > 15, kind);
  }
});

test("what is known lists only what is known", () => {
  const facts = pullFacts({
    checkStatus: "failed",
    files: [
      { path: "src/retry.ts", additions: 40, deletions: 2 },
      { path: "src/retry.test.ts", additions: 60, deletions: 0 },
    ],
  });
  const by = Object.fromEntries(facts.map((f) => [f.label, f]));
  assert.equal(by["Required checks"].value, "Failed in the merge queue");
  assert.equal(by["Required checks"].tone, "bad");
  assert.equal(by["Files changed"].value, "2");
  assert.equal(by.Lines.value, "+100 −2");
  assert.equal(by.Tests.value, "1 file");

  const bare = pullFacts({ checkStatus: null, files: [] });
  assert.deepEqual(bare, [{ label: "Required checks", value: "Not known yet", tone: null }]);
});

test("the required checks are read from the pull request's check status", () => {
  assert.deepEqual(checksFact("running"), { label: "Required checks", value: "Running", tone: null });
  assert.equal(checksFact("passed").tone, "good");
  assert.equal(checksFact("failed").value, "Failed in the merge queue");
});

test("test files are recognised by the names test runners use", () => {
  assert.ok(isTestFile("src/a.test.ts"));
  assert.ok(isTestFile("src/__tests__/a.ts"));
  assert.ok(isTestFile("tests/api.rs"));
  assert.ok(isTestFile("pkg/store_test.go"));
  assert.ok(!isTestFile("src/testing-utils.ts"));
  assert.ok(!isTestFile("src/contest.ts"));
  assert.ok(isTestFile("test.js"));
  assert.ok(isTestFile("lib/spec.rb"));
});

const merged = (daysAgo: number, mergedBy: string | null, number = 1): Merged => ({
  repo,
  number,
  title: `Change ${number}`,
  mergedBy,
  mergedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  files: [],
});

test("a push to the default branch counts a person's own commits, not merges or g1t's", () => {
  const c = (hash: string, email: string, parents = 1) => ({ hash, author: { name: "g1t", email }, parents: Array(parents).fill("p") });
  // Every commit is named "g1t": the name decides nothing, the address does.
  const history = [c("e", "chase@example.com"), c("d", "agent@g1t.sh"), c("m", "chase@example.com", 2), c("b", "chase@example.com"), c("a", "chase@example.com")];
  const byG1t = (commit: { author: { email: string } }) => commit.author.email === "agent@g1t.sh";
  assert.deepEqual(pushedCommits(history, "a", byG1t).map((x) => x.hash), ["e", "b"]);
  // Where it pointed before was not read: everything read counts.
  assert.deepEqual(pushedCommits(history, "zz", byG1t).map((x) => x.hash), ["e", "b", "a"]);
});

test("who pushed is the account that signed in, not the name on the commits", () => {
  assert.ok(pushedByPerson({ actor: "usr_chase", data: {} }));
  assert.ok(pushedByPerson({ actor: null, data: {} }));
  assert.ok(!pushedByPerson({ actor: "usr_g1t_agent", data: {} }));
  assert.ok(!pushedByPerson({ actor: "g1t_policy", data: {} }));
  // A workflow job's own token is not a person either.
  assert.ok(!pushedByPerson({ actor: "usr_chase", data: { causedByJob: "run_1" } }));

  const c = (hash: string, name: string) => ({ hash, parents: ["p"], author: { name, email: `${hash}@example.com` } });
  // A person whose git name is "g1t" pushed m1; g1t pushed w1 under a person's name.
  const history = [c("w1", "Chase Pierce"), c("m1", "g1t"), c("old", "Chase Pierce")];
  const pushes = [
    { time: "2026-10-07T12:00:00Z", actor: "usr_g1t_agent", data: { after: "w1", before: "m1" } },
    { time: "2026-10-05T12:00:00Z", actor: "usr_chase", data: { after: "m1", before: "old" } },
  ];
  assert.deepEqual(placePushes(history, pushes), [{ hash: "m1", at: "2026-10-05T12:00:00Z" }]);
});

test("a short read of the branch is enough when it reaches the oldest push", () => {
  const h = (...hashes: string[]) => hashes.map((hash) => ({ hash }));
  const pushes = [
    { time: "2026-10-07T12:00:00Z", data: { after: "c1", before: "c2" } },
    { time: "2026-10-05T12:00:00Z", data: { after: "c2", before: "c3" } },
  ];
  // Holds the oldest push's before.
  assert.ok(historyCovers(h("c1", "c2", "c3"), pushes, 3));
  // Full, and the oldest push reaches past it: read further.
  assert.ok(!historyCovers(h("c1", "c2", "x"), pushes, 3));
  // Shorter than asked: the whole branch.
  assert.ok(historyCovers(h("c1", "c2"), pushes, 3));
  // The oldest push made the branch: only the whole branch will do.
  assert.ok(!historyCovers(h("c1", "c2", "c3"), [{ time: "", data: { after: "c1" } }], 3));
});

test("each push to the default branch places the commits it brought, at its time, from one read of the history", () => {
  const c = (hash: string, parents = ["p"], email = "chase@example.com") => ({ hash, parents, author: { name: "Chase Pierce", email } });
  // Newest first: a Wednesday push of two, a Monday push of one, a merge, and g1t's own commit.
  const history = [c("w2"), c("w1"), c("m1"), c("merge", ["a", "b"]), c("bot", ["p"], "g1t@users.noreply.g1t.sh"), c("old")];
  const pushes = [
    { time: "2026-10-07T12:00:00Z", actor: "usr_chase", data: { after: "w2", before: "m1" } },
    { time: "2026-10-05T12:00:00Z", actor: "usr_chase", data: { after: "m1", before: "old" } },
    { time: "2026-10-01T12:00:00Z", actor: "usr_chase", data: { after: "gone", before: "older" } },
  ];
  const byG1t = (commit: { author: { email: string } }) => commit.author.email.endsWith("@users.noreply.g1t.sh");
  assert.deepEqual(placePushes(history, pushes, byG1t), [
    { hash: "m1", at: "2026-10-05T12:00:00Z" },
    { hash: "w2", at: "2026-10-07T12:00:00Z" },
    { hash: "w1", at: "2026-10-07T12:00:00Z" },
  ]);
});

test("a change merged automatically when g1t merged it", () => {
  assert.ok(mergedAutomatically({ mergedBy: "g1t" }));
  assert.ok(mergedAutomatically({ mergedBy: null }));
  assert.ok(!mergedAutomatically({ mergedBy: "syntaqx" }));
});

test("the week is seven days of landed changes, with the week before", () => {
  const week = weekOf(
    [merged(0, "g1t"), merged(0, "syntaqx"), merged(0, "syntaqx", 2), merged(1, "g1t", 3), merged(1, "g1t"), merged(6, "g1t"), merged(8, "g1t"), merged(10, "alex"), merged(20, "g1t")],
    NOW,
    "UTC",
  );
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].key, "2026-10-05");
  assert.equal(week.days[6].label, "Mon");
  assert.deepEqual(
    week.days.map((d) => d.count),
    [1, 0, 0, 0, 0, 2, 3],
  );
  assert.equal(week.total, 6);
  assert.equal(week.previous, 2);
  // Not knowing the week before is not the same as nothing in it.
  assert.equal(weekOf([merged(0, "g1t")], NOW, "UTC", false).previous, null);
});

test("days follow the viewer's time zone", () => {
  // 02:00 UTC on the 5th is still the 4th in Los Angeles.
  const late = Date.parse("2026-10-05T02:00:00Z");
  assert.equal(dayKey(late, "America/Los_Angeles"), "2026-10-04");
  assert.equal(dayKey(late, "UTC"), "2026-10-05");
  assert.equal(dayKey(late, "Not/AZone"), "2026-10-05");
  const week = weekOf([{ mergedAt: new Date(late).toISOString() }], NOW, "America/Los_Angeles");
  assert.equal(week.days.find((d) => d.key === "2026-10-04")?.count, 1);
});

test("the change from last week, and how it reads", () => {
  assert.equal(change(12, 10), 0.2);
  assert.equal(change(5, 0), null);
  assert.equal(change(5, null), null);
  assert.equal(signedPercent(0.2), "+20%");
  assert.equal(signedPercent(-0.054), "−5%");
  assert.equal(signedPercent(0.001), "0%");
});

test("a repository's merged list reaches back when it is not full or its oldest is old enough", () => {
  const since = NOW - 14 * DAY;
  const at = (days: number) => ({ mergedAt: new Date(NOW - days * DAY).toISOString(), updatedAt: new Date(NOW).toISOString() });
  assert.ok(reachesBack([at(1), at(2)], since, 100));
  assert.ok(reachesBack([at(1), at(20)], since, 2));
  assert.ok(!reachesBack([at(1), at(3)], since, 2));
});

test("landed today is the viewer's calendar day, newest first", () => {
  const rows = landedToday([merged(0.1, "g1t", 3), merged(0.5, "syntaqx", 4), merged(1, "g1t", 2)], NOW, "UTC");
  assert.deepEqual(
    rows.map((r) => [r.ref, r.automatic]),
    [
      ["#3", true],
      ["#4", false],
    ],
  );
  assert.equal(rows[1].by?.name, "syntaqx");
});

test("tabs and sorting come from the address", () => {
  assert.equal(parseTab("landed"), "landed");
  assert.equal(parseTab("waiting"), null);
  assert.equal(parseTab("nope"), null);
  assert.equal(parseSort("newest"), "newest");
  assert.equal(parseSort(null), "impact");
  const rows = [{ at: 1 }, { at: 3 }, { at: 2 }];
  assert.deepEqual(sortRows(rows, "impact"), rows);
  assert.deepEqual(
    sortRows(rows, "newest").map((r) => r.at),
    [3, 2, 1],
  );
});

test("the summary says the week plainly", () => {
  assert.equal(summaryLine({ total: 47, needs: 0 }), "47 changes landed in the last 7 days.");
  assert.equal(summaryLine({ total: 1, needs: 2 }), "1 change landed in the last 7 days.");
  assert.equal(summaryLine({ total: 0, needs: 2 }), "Nothing has landed this week. What is waiting on you is below.");
  assert.equal(summaryLine({ total: 0, needs: 0 }), "Nothing has landed this week yet.");
});

test("a job waiting for a self-hosted runner says so", () => {
  const runner = { kind: "runner" as const };
  assert.equal(reasonFor(runner), "stalled");
  assert.match(whyFor(reasonFor(runner), runner), /self-hosted runner/);
});
