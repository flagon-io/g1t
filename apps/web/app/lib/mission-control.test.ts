import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Merged,
  change,
  checksFact,
  confidenceAsk,
  confidenceLine,
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
  withConfidence,
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
  assert.equal(stallReason("The required check CI still fails after the agent revised 3 times."), "checks_failing");
  assert.equal(stallReason("The required checks CI and Lint still fail after the agent revised twice."), "checks_failing");
  assert.equal(stallReason("CI / push still fails after the agent revised 2 times."), "checks_failing");
  assert.equal(stallReason("It failed in the merge queue after the agent revised twice."), "checks_failing");
  assert.equal(stallReason("Its checks could not be run."), "checks_failing");
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
  assert.equal(by["Required checks"].value, "Failed in the merge queue");
  assert.equal(by["Required checks"].tone, "bad");
  assert.equal(by["Files changed"].value, "2");
  assert.equal(by.Lines.value, "+100 −2");
  assert.equal(by.Tests.value, "1 file");
  assert.equal(by["Sent back"].value, "2 times");
  assert.equal(by["Agent runs"].value, "2 · $0.75");

  const bare = pullFacts({ checkStatus: null, files: [] });
  assert.deepEqual(bare, [{ label: "Required checks", value: "Not known yet", tone: null }]);
});

test("the required checks are read from where the agent's pull request stands", () => {
  const at = (stage: Parameters<typeof checksFact>[1] extends infer L ? NonNullable<L>["stage"] : never, detail: string) =>
    checksFact(null, { stage, detail });
  assert.deepEqual(at("checking", "Waiting for CI / pull_request to finish."), { label: "Required checks", value: "Running", tone: null });
  assert.equal(at("checking", "Waiting for the required check Deploy to report on its latest commit.").value, "Not reported yet");
  assert.equal(at("revising", "CI / pull_request failed. The agent is being sent back to fix it.").value, "Failing");
  assert.equal(at("needs_you", "The required check CI still fails after the agent revised twice.").value, "Failing");
  // Past the checks: a review, an approval or a person's decision holds it, not them.
  assert.equal(at("revising", "The review asked for changes. The agent is being sent back to make them.").value, "Passing");
  assert.equal(at("needs_you", "This repository requires 1 approving review before a pull request merges; this one has 0.").value, "Passing");
  assert.equal(at("ready", "Everything this repository asks for is met. Ready to merge.").tone, "good");
  assert.equal(at("working", "g1t is making the change.").value, "Not run yet");
  assert.equal(checksFact("failed", { stage: "revising", detail: "It failed in the merge queue." }).value, "Failed in the merge queue");
});

test("a change held for low confidence is its own reason, ahead of what it would read as", () => {
  const held =
    "The agent's confidence in this change is low (checks failing, tests not added). This repository asks a person before merging it: approve it to let it land, or ask for changes.";
  // Its reasons name checks and approval, but it is held for its confidence.
  assert.equal(stallReason(held), "low_confidence");
  assert.equal(reasonFor({ kind: "stalled", detail: held }), "low_confidence");

  const low = { level: "low" as const, reasons: ["tests not added", "3 revisions"], uncertainAbout: ["the retry limit"] };
  assert.equal(withConfidence("ready_to_merge", low), "low_confidence");
  assert.equal(withConfidence("needs_review", low), "low_confidence");
  // A failure that needs someone anyway keeps its own chip.
  assert.equal(withConfidence("checks_failing", low), "checks_failing");
  assert.equal(withConfidence("ready_to_merge", { level: "medium" }), "ready_to_merge");
  assert.equal(withConfidence("ready_to_merge", null), "ready_to_merge");

  assert.equal(confidenceLine(low), "Low — tests not added, 3 revisions");
  assert.equal(confidenceLine({ level: "high", reasons: [] }), "High");
  assert.match(confidenceAsk(low), /not sure of the change: tests not added, 3 revisions\. Approve it/);

  const why = whyFor("low_confidence", { kind: "stalled", detail: held }, low);
  assert.match(why, /from tests not added, 3 revisions\./);
  assert.match(why, /unsure about the retry limit/);
  assert.match(why, /nothing merges it until you approve it/);
  // Ready, not held: it says to look before merging.
  assert.match(whyFor("low_confidence", { kind: "ready", detail: "" }, low), /Look at it before you merge it/);
});

test("what the agent knows gains its confidence, across the row", () => {
  const facts = pullFacts({
    checkStatus: "passed",
    files: [{ path: "src/retry.ts", additions: 40, deletions: 2 }],
    lifecycle: { revisions: 3 },
    confidence: { level: "low", reasons: ["tests not added", "3 revisions"] },
  });
  const fact = facts.find((f) => f.label === "Confidence");
  assert.deepEqual(fact, { label: "Confidence", value: "Low — tests not added, 3 revisions", tone: "bad", wide: true });
  assert.equal(facts.at(-1)?.label, "Confidence");
});

test("test files are recognised by the names test runners use", () => {
  assert.ok(isTestFile("src/a.test.ts"));
  assert.ok(isTestFile("src/__tests__/a.ts"));
  assert.ok(isTestFile("tests/api.rs"));
  assert.ok(isTestFile("pkg/store_test.go"));
  assert.ok(!isTestFile("src/testing-utils.ts"));
  assert.ok(!isTestFile("src/contest.ts"));
});

const merged = (daysAgo: number, mergedBy: string | null, number = 1, authoredByAgent = true): Merged => ({
  repo,
  number,
  title: `Change ${number}`,
  agent: "g1t",
  authoredByAgent,
  mergedBy,
  mergedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  files: [],
});

test("a change landed without a person when g1t merged it", () => {
  assert.ok(landedByAgents({ mergedBy: "g1t" }));
  assert.ok(landedByAgents({ mergedBy: "g1t" }));
  assert.ok(landedByAgents({ mergedBy: null }));
  assert.ok(!landedByAgents({ mergedBy: "syntaqx" }));
});

test("the week is seven days, each split by who did the work, with the week before", () => {
  const week = weekOf(
    [
      merged(0, "g1t"),
      merged(0, "syntaqx"),
      // A person's own change, merged by them and auto-merged by g1t: both theirs.
      merged(0, "syntaqx", 2, false),
      merged(1, "g1t", 3, false),
      merged(1, "g1t"),
      merged(6, "g1t"),
      merged(8, "g1t"),
      merged(10, "alex"),
      merged(20, "g1t"),
    ],
    NOW,
    "UTC",
  );
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].key, "2026-10-05");
  assert.equal(week.days[6].label, "Mon");
  assert.deepEqual(
    week.days.map((d) => [d.agents, d.assisted, d.people]),
    [[1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 1], [1, 1, 1]],
  );
  assert.equal(week.total, 6);
  assert.equal(week.byAgents, 3);
  assert.equal(week.agentChanges, 4);
  assert.equal(week.people, 2);
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
  const week = weekOf([{ mergedAt: new Date(late).toISOString(), mergedBy: "g1t", authoredByAgent: true }], NOW, "America/Los_Angeles");
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
    agent: "g1t",
    updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    checkStatus: null,
    files: [],
  });
  const rows = waitingRows({
    active: [
      { pull: pull(1, 30), lifecycle: { stage: "checking", detail: "Waiting for CI / pull_request to finish.", revisions: 0 }, repo },
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
        agent: "g1t",
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
        agent: "g1t",
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
  const none = { total: 0, byAgents: 0, agentChanges: 0, people: 0, live: 0, needs: 0 };
  assert.equal(
    summaryLine({ ...none, total: 47, byAgents: 39, agentChanges: 47 }),
    "Agents landed 39 of their 47 changes this week without you.",
  );
  assert.equal(
    summaryLine({ ...none, total: 3, byAgents: 3, agentChanges: 3 }),
    "Agents landed all 3 changes of theirs this week without you.",
  );
  assert.equal(
    summaryLine({ ...none, total: 2, agentChanges: 2 }),
    "Agents made 2 changes this week, each merged by a person.",
  );
  // People's own work is counted as theirs, never as agents' that needed help.
  assert.equal(
    summaryLine({ ...none, total: 7, byAgents: 4, agentChanges: 5, people: 2 }),
    "Agents landed 4 of their 5 changes this week without you, and people landed 2 changes of their own.",
  );
  assert.equal(summaryLine({ ...none, total: 3, people: 3 }), "People landed 3 changes this week; none were agents'.");
  assert.equal(summaryLine({ ...none, live: 1 }), "1 agent is at work. Nothing has landed this week yet.");
  assert.match(summaryLine(none), /Assign an issue/);
});
