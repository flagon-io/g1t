import assert from "node:assert/strict";
import { test } from "node:test";

import type { G1tEvent } from "@g1t/contracts";

import {
  type ActivityItem,
  type Need,
  DELETED_USER,
  FEED_EVENT_TYPES,
  PROJECT_FEED_EVENT_TYPES,
  eventItem,
  projectFeed,
  pushItem,
  actorIds,
  ageBuckets,
  agentHours,
  dailyBuckets,
  digestParts,
  firstPassRate,
  formatSpan,
  greetingFor,
  groupActivity,
  hourIn,
  issueToMerge,
  median,
  nameActor,
  nextSeen,
  pipelineStage,
  queuedNumbers,
  runHealth,
  rankNeeds,
  readCookie,
  sparkPoints,
  splitRequest,
  stuckMinutes,
  waitedFor,
} from "./mission.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-04T18:00:00Z");

test("a first visit has nothing to count from and starts the clock", () => {
  assert.deepEqual(nextSeen(null, NOW), { since: null, value: `0.${NOW}` });
  assert.deepEqual(nextSeen("garbage", NOW), { since: null, value: `0.${NOW}` });
});

test("views within a visit keep counting from the visit before", () => {
  const visitStart = NOW - 5 * MIN;
  const before = NOW - 3 * DAY;
  assert.deepEqual(nextSeen(`${before}.${visitStart}`, NOW), { since: before, value: `${before}.${NOW}` });
  // A first visit, refreshed: still nothing to count from.
  assert.deepEqual(nextSeen(`0.${visitStart}`, NOW), { since: null, value: `0.${NOW}` });
});

test("a long gap starts a new visit, counting from the last view", () => {
  const last = NOW - 2 * HOUR;
  assert.deepEqual(nextSeen(`${NOW - DAY}.${last}`, NOW), { since: last, value: `${last}.${NOW}` });
});

test("a cookie from the future is ignored", () => {
  assert.equal(nextSeen(`0.${NOW + DAY}`, NOW).since, null);
});

test("cookies are read by name", () => {
  assert.equal(readCookie("a=1; g1t_seen=0.5; b=2", "g1t_seen"), "0.5");
  assert.equal(readCookie("g1t_tz=America%2FLos_Angeles", "g1t_tz"), "America/Los_Angeles");
  assert.equal(readCookie(null, "x"), null);
  assert.equal(readCookie("x=1", "y"), null);
});

test("greetings follow the hour, in the viewer's zone", () => {
  assert.equal(greetingFor(8), "Good morning");
  assert.equal(greetingFor(13), "Good afternoon");
  assert.equal(greetingFor(20), "Good evening");
  assert.equal(greetingFor(2), "Good evening");
  assert.equal(hourIn(NOW, "UTC"), 18);
  assert.equal(hourIn(NOW, "America/Los_Angeles"), 11);
  assert.equal(hourIn(NOW, "Not/AZone"), 18);
});

test("the composer's first line is the title", () => {
  assert.deepEqual(splitRequest("  Fix the login redirect  "), { title: "Fix the login redirect", body: "" });
  assert.deepEqual(splitRequest("Fix it\n\nIt loops after signing in."), { title: "Fix it", body: "It loops after signing in." });
  const long = "word ".repeat(60).trim();
  const split = splitRequest(long, 40);
  assert.ok(split.title.length <= 40);
  assert.ok(split.title.endsWith("…"));
  assert.equal(split.body, long);
});

const repo = { namespace: "acme", name: "api" };
const item = (id: string, at: number, actor: string | null, verb: ActivityItem["verb"], number: number | null, other = repo): ActivityItem => ({
  id,
  at,
  repo: other,
  actor,
  verb,
  number,
});

test("one agent's burst in one project reads as one line", () => {
  const groups = groupActivity([
    item("1", NOW, "g1t", "landed", 4),
    item("2", NOW - 5 * MIN, "g1t", "started", 5),
    item("3", NOW - 10 * MIN, "g1t", "started", 6),
    item("4", NOW - 12 * MIN, "g1t", "landed", 3),
    item("5", NOW - 20 * MIN, "ana", "opened_issue", 7),
    item("6", NOW - 25 * MIN, "g1t", "landed", 2),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].count, 4);
  assert.deepEqual(groups[0].parts.map((p) => [p.verb, p.numbers]), [
    ["landed", [4, 3]],
    ["started", [5, 6]],
  ]);
  assert.equal(groups[0].from, NOW - 12 * MIN);
  assert.equal(groups[1].actor, "ana");
});

test("a burst breaks across projects and long gaps", () => {
  const other = { namespace: "acme", name: "web" };
  const groups = groupActivity([
    item("1", NOW, "g1t", "landed", 1),
    item("2", NOW - MIN, "g1t", "landed", 2, other),
    item("3", NOW - 2 * HOUR, "g1t", "landed", 3, other),
  ]);
  assert.equal(groups.length, 3);
});

test("needs are ranked by urgency, then by how long they waited", () => {
  const need = (key: string, kind: Need["kind"], at: number): Need => ({ key, kind, at, title: key, detail: "", to: "/", action: "Open", where: null });
  const ranked = rankNeeds([
    need("r1", "review", NOW - HOUR),
    need("d", "deploy", NOW),
    need("r2", "review", NOW - DAY),
    need("r2", "review", NOW - DAY),
    need("l", "limit", NOW),
  ]);
  assert.deepEqual(ranked.map((n) => n.key), ["l", "d", "r2", "r1"]);
});

test("a running agent quiet for ten minutes is stuck", () => {
  assert.equal(stuckMinutes({ status: "running", updatedAt: new Date(NOW - 14 * MIN).toISOString() }, NOW), 14);
  assert.equal(stuckMinutes({ status: "running", updatedAt: new Date(NOW - 2 * MIN).toISOString() }, NOW), null);
  assert.equal(stuckMinutes({ status: "queued", updatedAt: new Date(NOW - HOUR).toISOString() }, NOW), null);
});

test("the digest says what moved, the urgent parts toned", () => {
  const parts = digestParts({ landed: 3, reviews: 1, opened: 0, deploys: 2, failedDeploys: 1, stuck: 12 });
  assert.deepEqual(parts.map((p) => p.text), [
    "3 changes landed",
    "1 pull request needs your review",
    "an agent has been quiet for 12 min",
    "1 deploy failed",
    "2 deploys went out",
  ]);
  assert.deepEqual(digestParts({ landed: 0, reviews: 0, opened: 0, deploys: 0, failedDeploys: 0, stuck: null }), []);
});

test("daily buckets put each point on its day, oldest first", () => {
  const buckets = dailyBuckets(
    [{ at: NOW }, { at: NOW - DAY }, { at: NOW - DAY, value: 2 }, { at: NOW - 10 * DAY }],
    7,
    NOW,
  );
  assert.deepEqual(buckets, [0, 0, 0, 0, 0, 3, 1]);
});

test("median, pass rates and spans", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const rate = firstPassRate([
    { repo: "a", number: 1, at: 2, passed: true },
    { repo: "a", number: 1, at: 1, passed: false },
    { repo: "a", number: 2, at: 1, passed: true },
  ]);
  assert.deepEqual(rate, { rate: 0.5, of: 2 });
  assert.deepEqual(firstPassRate([]), { rate: null, of: 0 });
  // Workflow runs: cancelled, skipped and unfinished ones don't count; a pass on a second attempt isn't a first-try pass.
  const runs = runHealth([
    { attempt: 1, status: "completed", conclusion: "success" },
    { attempt: 2, status: "completed", conclusion: "success" },
    { attempt: 1, status: "completed", conclusion: "failure" },
    { attempt: 1, status: "completed", conclusion: "cancelled" },
    { attempt: 1, status: "in_progress", conclusion: null },
  ]);
  assert.equal(runs.checkRuns, 3);
  assert.equal(runs.passRate, 2 / 3);
  assert.deepEqual(runs.firstPass, { rate: 1 / 3, of: 3 });
  assert.deepEqual(runHealth([]), { passRate: null, firstPass: { rate: null, of: 0 }, checkRuns: 0 });
  assert.equal(formatSpan(null), "—");
  assert.equal(formatSpan(30 * MIN), "30m");
  assert.equal(formatSpan(5 * HOUR), "5h");
  assert.equal(formatSpan(2 * DAY + 4 * HOUR), "2d 4h");
});

test("issue to merge pairs a merge with the issue it resolved", () => {
  const spans = issueToMerge(
    [{ repo: "a", number: 1, at: 100 }, { repo: "b", number: 1, at: 50 }],
    [{ repo: "a", issue: 1, at: 400 }, { repo: "a", issue: null, at: 500 }, { repo: "c", issue: 1, at: 900 }],
  );
  assert.deepEqual(spans, [300]);
});

test("agent hours count only agents, clipped to the window", () => {
  const hours = agentHours(
    [
      { kind: "implement", startedAt: new Date(NOW - 2 * HOUR).toISOString(), finishedAt: new Date(NOW - HOUR).toISOString() },
      { kind: "review", startedAt: new Date(NOW - 30 * MIN).toISOString(), finishedAt: null },
      { kind: "checks", startedAt: new Date(NOW - 5 * HOUR).toISOString(), finishedAt: null },
      { kind: "implement", startedAt: new Date(NOW - 9 * DAY).toISOString(), finishedAt: new Date(NOW - 7 * DAY + HOUR).toISOString() },
    ],
    NOW - 7 * DAY,
    NOW,
  );
  assert.equal(hours, 2.5);
});

test("sparkline points span the box, zero on the floor", () => {
  assert.deepEqual(sparkPoints([], 100, 20), []);
  const points = sparkPoints([0, 5, 10], 100, 20, 2);
  assert.deepEqual(points, [
    [2, 18],
    [50, 10],
    [98, 2],
  ]);
  assert.deepEqual(sparkPoints([0, 0], 10, 10, 1), [
    [1, 9],
    [9, 9],
  ]);
  assert.deepEqual(sparkPoints([3], 10, 10, 1), [[5, 1]]);
});

test("a pull request's place in the pipeline", () => {
  const queued = queuedNumbers([
    { number: 9, state: "waiting" },
    { number: 8, state: "landed" },
  ]);
  assert.equal(pipelineStage({ status: "merged", checkStatus: null, number: 1 }, undefined, queued), "landed");
  assert.equal(pipelineStage({ status: "open", checkStatus: "passed", number: 9 }, undefined, queued), "queue");
  assert.equal(pipelineStage({ status: "draft", checkStatus: null, number: 2 }, undefined, queued), "working");
  assert.equal(pipelineStage({ status: "open", checkStatus: "running", number: 3 }, undefined, queued), "checking");
  assert.equal(pipelineStage({ status: "open", checkStatus: "passed", number: 4 }, { kind: "revise" }, queued), "working");
  assert.equal(pipelineStage({ status: "open", checkStatus: "passed", number: 5 }, { kind: "review" }, queued), "reviewing");
  assert.equal(pipelineStage({ status: "open", checkStatus: "failed", number: 6 }, undefined, queued), "reviewing");
});

test("open issues by age", () => {
  const buckets = ageBuckets(
    [new Date(NOW - HOUR).toISOString(), new Date(NOW - 3 * DAY).toISOString(), new Date(NOW - 90 * DAY).toISOString()],
    NOW,
  );
  assert.deepEqual(buckets.map((b) => b.count), [1, 1, 0, 1]);
});

test("the feed names people, not account ids", () => {
  const actors = ["usr_b51a1a09", "g1t", null, "usr_b51a1a09", "usr_g1t_agent", "g1t_policy", "usr_gone"];
  assert.deepEqual(actorIds(actors), ["usr_b51a1a09", "usr_gone"]);
  const names = { usr_b51a1a09: "syntaqx" };
  assert.equal(nameActor("usr_b51a1a09", names), "syntaqx");
  assert.equal(nameActor("ada", names), "ada");
  assert.equal(nameActor(null, names), null);
  assert.equal(nameActor("usr_g1t_agent", names), "g1t");
  // Unknown to the lookup: the account is gone. No lookup at all: only "someone".
  assert.equal(nameActor("usr_gone", names), DELETED_USER);
  assert.equal(nameActor("usr_gone", null), "someone");
});

test("waits read in the largest whole unit", () => {
  assert.equal(waitedFor(0), "0 min");
  assert.equal(waitedFor(45.7), "45 min");
  assert.equal(waitedFor(60), "1 h");
  assert.equal(waitedFor(1022), "17 h");
  assert.equal(waitedFor(24 * 60), "1 d");
  assert.equal(waitedFor(3 * 24 * 60 - 1), "2 d");
});

// --- A project's feed -----------------------------------------------------------

const REPO = { namespace: "flagon-io", name: "g1t" };
const event = (type: string, data: Record<string, unknown>, id = `evt_${type}`, actor: string | null = "usr_ada"): G1tEvent =>
  ({ id, type, source: "test", time: "2026-10-08T12:00:00Z", repoId: "rep_1", actor, data }) as unknown as G1tEvent;
const deployment = (state: string, production = true) =>
  event("deployment_status.created", {
    repoId: "rep_1",
    deployment: { id: "dep_9", environment: production ? "production" : "preview", production_environment: production },
    deploymentStatus: { state },
  });

test("the feed asks the log only for the kinds it shows, and pushes for one project", () => {
  for (const type of ["session.appended", "queue.changed", "pull.updated", "pull.mergecheck", "workflow.completed"]) {
    assert.ok(!(PROJECT_FEED_EVENT_TYPES as readonly string[]).includes(type), type);
  }
  assert.ok((PROJECT_FEED_EVENT_TYPES as readonly string[]).includes("git.push"));
  assert.ok(!(FEED_EVENT_TYPES as readonly string[]).includes("git.push"));
  // Every kind asked for makes a line of some events.
  for (const type of FEED_EVENT_TYPES) assert.ok(type.includes("."), type);
});

test("a production deploy that finished is a line, linked to it on the current path", () => {
  const up = eventItem(deployment("success"), REPO);
  assert.equal(up?.verb, "deployed");
  assert.equal(up?.to, "/flagon-io/g1t/deployments/dep_9");
  assert.equal(eventItem(deployment("failure"), REPO)?.verb, "deploy_failed");
  assert.equal(eventItem(deployment("in_progress"), REPO), null);
  assert.equal(eventItem(deployment("success", false), REPO), null);
});

test("a project's feed has its pushes to the default branch, but not the ones that only landed a pull request", () => {
  const events = [
    event("pull.merged", { pullId: "pul_1", repoId: "rep_1", number: 5, commit: "aaaaaaa1111" }, "evt_1"),
    event("git.push", { repoId: "rep_1", ref: "refs/heads/main", after: "aaaaaaa1111", defaultBranch: true }, "evt_2"),
    event("git.push", { repoId: "rep_1", ref: "refs/heads/main", after: "bbbbbbb2222", defaultBranch: true }, "evt_3"),
    event("git.push", { repoId: "rep_1", ref: "refs/heads/topic", after: "ccccccc3333", defaultBranch: false }, "evt_4"),
    event("session.appended", { repoId: "rep_1", number: 5 }, "evt_5"),
  ];
  const feed = projectFeed(events, REPO);
  assert.deepEqual(
    feed.map((item) => [item.verb, item.text ?? item.number]),
    [
      ["landed", 5],
      ["pushed", "bbbbbbb"],
    ],
  );
  assert.equal(feed[1]?.to, "/flagon-io/g1t/commit/bbbbbbb2222");
  assert.equal(pushItem(events[4]!, REPO, new Set()), null);
});
