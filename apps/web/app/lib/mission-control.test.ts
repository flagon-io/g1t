import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Merged,
  change,
  dayKey,
  isTestFile,
  landedByAgents,
  landedToday,
  parseSort,
  parseTab,
  pullFacts,
  reachesBack,
  reasonFor,
  signedPercent,
  sortRows,
  stallReason,
  summaryLine,
  waitingRows,
  weekOf,
  whyFor,
} from "./mission-control.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2026-10-05, 18:00 UTC.
const NOW = Date.parse("2026-10-05T18:00:00Z");
const repo = { namespace: "acme", name: "web" };

test("each kind of need gets its reason chip", () => {
  assert.equal(reasonFor({ kind: "deploy", detail: "" }), "blocking");
  assert.equal(reasonFor({ kind: "limit", detail: "" }), "blocking");
  assert.equal(reasonFor({ kind: "review", detail: "" }), "asked_for_you");
  assert.equal(reasonFor({ kind: "invitation", detail: "" }), "asked_for_you");
  assert.equal(reasonFor({ kind: "ready", detail: "" }), "ready_to_merge");
  assert.equal(reasonFor({ kind: "checks", detail: "" }), "checks_failing");
  assert.equal(reasonFor({ kind: "stuck", detail: "" }), "stalled");
});

test("a stopped pull request's reason comes from the sentence g1t stopped with", () => {
  assert.equal(stallReason("The acceptance checks still fail after the agent revised 3 times."), "checks_failing");
  assert.equal(stallReason("CI / push still fails after the agent revised 2 times."), "checks_failing");
  assert.equal(stallReason("The acceptance checks could not be run."), "checks_failing");
  assert.equal(
    stallReason("g1t stopped the agent's implement run when it reached its cost cap. Raise the cap under Settings, Guardrails."),
    "outside_guardrails",
  );
  assert.equal(stallReason("g1t stopped the agent's review run when it reached its time cap."), "outside_guardrails");
  assert.equal(stallReason("g1t could not merge this: the branch moved"), "blocking");
  assert.equal(stallReason("Needs 1 approving review from someone with write access."), "needs_review");
  assert.equal(stallReason("The review still asks for changes after the agent revised 3 times."), "needs_review");
  assert.equal(stallReason("alex asked for changes, and the agent has already revised 3 times."), "needs_review");
  assert.equal(stallReason("syntaqx stopped the agent's implement run."), "stalled");
  assert.equal(stallReason("g1t could not start the next step: no slot"), "stalled");
});

test("why a need needs a person is said for every reason", () => {
  for (const kind of ["deploy", "limit", "invitation", "review", "stuck", "checks", "ready", "conflict"] as const) {
    const need = { kind, detail: "" };
    assert.ok(whyFor(reasonFor(need), need).length > 20, kind);
  }
  const stalled = { kind: "stalled" as const, detail: "It reached its cost cap." };
  assert.match(whyFor(reasonFor(stalled), stalled), /Guardrails/);
});

test("what the agent knows lists only what is known", () => {
  const facts = pullFacts({
    checkStatus: "failed",
    files: [
      { path: "src/retry.ts", additions: 40, deletions: 2 },
      { path: "src/retry.test.ts", additions: 60, deletions: 0 },
    ],
    lifecycle: { revisions: 2 },
    runs: [
      { kind: "implement", costUsd: 0.5 },
      { kind: "revise", costUsd: 0.25 },
      { kind: "checks", costUsd: null },
    ],
  });
  const by = Object.fromEntries(facts.map((f) => [f.label, f]));
  assert.equal(by.Checks.value, "Failing");
  assert.equal(by.Checks.tone, "bad");
  assert.equal(by["Files changed"].value, "2");
  assert.equal(by.Lines.value, "+100 −2");
  assert.equal(by.Tests.value, "1 file");
  assert.equal(by["Sent back"].value, "2 times");
  assert.equal(by["Agent runs"].value, "2 · $0.75");

  const bare = pullFacts({ checkStatus: null, files: [] });
  assert.deepEqual(bare, [{ label: "Checks", value: "Not run", tone: null }]);
});

test("test files are recognised by the names test runners use", () => {
  assert.ok(isTestFile("src/a.test.ts"));
  assert.ok(isTestFile("src/__tests__/a.ts"));
  assert.ok(isTestFile("tests/api.rs"));
  assert.ok(isTestFile("pkg/store_test.go"));
  assert.ok(!isTestFile("src/testing-utils.ts"));
  assert.ok(!isTestFile("src/contest.ts"));
});

const merged = (daysAgo: number, mergedBy: string | null, number = 1): Merged => ({
  repo,
  number,
  title: `Change ${number}`,
  agent: "g1t-agent",
  mergedBy,
  mergedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  files: [],
});

test("a change landed without a person when g1t merged it", () => {
  assert.ok(landedByAgents({ mergedBy: "g1t" }));
  assert.ok(landedByAgents({ mergedBy: "g1t-agent" }));
  assert.ok(landedByAgents({ mergedBy: null }));
  assert.ok(!landedByAgents({ mergedBy: "syntaqx" }));
});

test("the week is seven days, each split by who landed it, with the week before", () => {
  const week = weekOf(
    [merged(0, "g1t"), merged(0, "syntaqx"), merged(1, "g1t"), merged(6, "g1t"), merged(8, "g1t"), merged(10, "alex"), merged(20, "g1t")],
    NOW,
    "UTC",
  );
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].key, "2026-10-05");
  assert.equal(week.days[6].label, "Mon");
  assert.deepEqual(
    week.days.map((d) => [d.agents, d.people]),
    [[1, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [1, 1]],
  );
  assert.equal(week.total, 4);
  assert.equal(week.byAgents, 3);
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
  const week = weekOf([{ mergedAt: new Date(late).toISOString(), mergedBy: "g1t" }], NOW, "America/Los_Angeles");
  assert.equal(week.days.find((d) => d.key === "2026-10-04")?.agents, 1);
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
    rows.map((r) => [r.ref, r.byAgents]),
    [
      ["#3", true],
      ["#4", false],
    ],
  );
  assert.equal(rows[1].by?.name, "syntaqx");
});

test("waiting on agents holds each pull request once, running ones first, and nothing that needs you", () => {
  const pull = (number: number, minutesAgo: number) => ({
    number,
    title: `Pull ${number}`,
    agent: "g1t-agent",
    updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    checkStatus: null,
    files: [],
  });
  const rows = waitingRows({
    active: [
      { pull: pull(1, 30), lifecycle: { stage: "checking", detail: "The acceptance checks are running.", revisions: 0 }, repo },
      { pull: pull(2, 5), lifecycle: { stage: "needs_you", detail: "Stopped.", revisions: 0 }, repo },
      { pull: pull(3, 50), lifecycle: { stage: "queued", detail: "In the merge queue.", revisions: 0 }, repo },
      { pull: pull(9, 1), lifecycle: { stage: "reviewing", detail: "Reviewing.", revisions: 0 }, repo },
    ],
    live: [
      {
        id: "r1",
        repo,
        number: 3,
        title: "Pull 3",
        kind: "update",
        agent: "g1t-agent",
        step: "Merging main in",
        costUsd: 0.1,
        startedAt: new Date(NOW - 60_000).toISOString(),
        createdAt: new Date(NOW - 60_000).toISOString(),
        updatedAt: new Date(NOW - 10_000).toISOString(),
      },
      {
        id: "r2",
        repo,
        number: null,
        title: null,
        kind: "plan",
        agent: "g1t-agent",
        step: null,
        costUsd: null,
        startedAt: null,
        createdAt: new Date(NOW - 120_000).toISOString(),
        updatedAt: new Date(NOW - 120_000).toISOString(),
      },
    ],
    drafts: [
      { ...pull(1, 30), repo },
      { ...pull(4, 20), repo },
      { ...pull(5, 20), agent: "syntaqx", repo },
    ],
    needKeys: new Set(["acme/web#9"]),
  });
  assert.deepEqual(
    rows.map((r) => [r.ref, r.chip, r.live]),
    [
      ["#3", "In queue", true],
      [null, "Planning", true],
      ["#4", "Working", false],
      ["#1", "Checking", false],
    ],
  );
  assert.equal(rows[0].detail, "Merging main in");
  assert.equal(rows[0].run, "/acme/web/agents/runs/r1");
  assert.equal(rows[1].title, "Planning in web");
});

test("tabs and sorting come from the address", () => {
  assert.equal(parseTab("waiting"), "waiting");
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

test("the summary says the week honestly", () => {
  assert.equal(summaryLine({ total: 47, byAgents: 39, live: 2, needs: 8 }), "Agents landed 39 of 47 changes this week without you.");
  assert.equal(summaryLine({ total: 3, byAgents: 3, live: 0, needs: 0 }), "Agents landed all 3 changes this week without you.");
  assert.equal(summaryLine({ total: 2, byAgents: 0, live: 0, needs: 0 }), "2 changes landed this week, each merged by a person.");
  assert.equal(summaryLine({ total: 0, byAgents: 0, live: 1, needs: 0 }), "1 agent is at work. Nothing has landed this week yet.");
  assert.match(summaryLine({ total: 0, byAgents: 0, live: 0, needs: 0 }), /Assign an issue/);
});
