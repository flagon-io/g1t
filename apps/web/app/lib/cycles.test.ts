import assert from "node:assert/strict";
import { test } from "node:test";

import type { Cycle, CycleMember, WorkItem } from "@g1t/contracts";

import {
  burnUp,
  byAgent,
  byPerson,
  cycleDays,
  cycleDaysLeft,
  cyclePath,
  cycleReport,
  cycleStageOf,
  dayNumber,
  dayOf,
  daysLeftText,
  sidebarCycle,
  stageCounts,
  weekdayName,
} from "./cycles.ts";

const cycle: Cycle = {
  workspace: "acme",
  number: 14,
  startsOn: "2026-10-19",
  endsOn: "2026-11-01",
  closedAt: null,
  state: "running",
  scope: 5,
  done: 2,
  carriedIn: 1,
  carriedOut: 0,
  added: 1,
};

function item(number: number, more: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `wki_${number}`,
    workspace: "acme",
    number,
    title: `Item ${number}`,
    body: "",
    labels: [],
    state: "open",
    reason: null,
    resolutions: [],
    author: { id: "usr_1", username: "ana" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    pullCount: 0,
    commentCount: 0,
    assignees: [],
    blockedBy: [],
    repos: [],
    horizon: "now",
    urgent: false,
    cycle: 14,
    ...more,
  } as WorkItem;
}

function member(number: number, more: Partial<CycleMember> = {}): CycleMember {
  return {
    number,
    addedAt: "2026-10-19T00:00:00.000Z",
    added: false,
    carriedIn: false,
    carriedOut: false,
    claimed: false,
    live: false,
    agent: null,
    draftPulls: 0,
    openPulls: 0,
    mergedPulls: 0,
    ...more,
  };
}

// #1 done on day 3; #2 in review; #3 added on day 4, claimed; #4 carried in, assigned; #5 closed as not planned.
const items = [
  item(1, { state: "closed", reason: "completed", closedAt: "2026-10-21T15:00:00.000Z", assignees: ["ana"] }),
  item(2, { assignees: ["ana", "bo"] }),
  item(3, {}),
  item(4, { assignees: ["bo"] }),
  item(5, { state: "closed", reason: "not_planned", closedAt: "2026-10-20T00:00:00.000Z" }),
];
const members = [
  member(1, { agent: "claude-code", mergedPulls: 1 }),
  member(2, { openPulls: 1, agent: "claude-code" }),
  member(3, { addedAt: "2026-10-22T09:00:00.000Z", added: true, claimed: true }),
  member(4, { addedAt: "2026-10-05T00:00:00.000Z", carriedIn: true }),
  member(5),
];
const detail = { cycle, items, members };

test("the burn-up counts what the cycle took on and what was done, day by day", () => {
  const points = burnUp(detail, "2026-10-23");
  assert.deepEqual(
    points.map((point) => [point.day, point.scope, point.done]),
    [
      ["2026-10-19", 3, 0],
      ["2026-10-20", 3, 0],
      ["2026-10-21", 3, 1],
      ["2026-10-22", 4, 1],
      ["2026-10-23", 4, 1],
    ],
  );
  // Before it starts: nothing; once closed: every day of it.
  assert.deepEqual(burnUp(detail, "2026-10-10"), []);
  assert.equal(burnUp({ ...detail, cycle: { ...cycle, state: "closed" } }, "2026-12-01").length, 14);
  // Past its last day, never further.
  assert.equal(burnUp(detail, "2026-11-20").length, 14);
});

test("the stage strip reads each work item as the board does, done once finished in the cycle", () => {
  const now = Date.parse("2026-12-30T00:00:00Z");
  assert.deepEqual(stageCounts(detail, now), { next: 0, progress: 2, review: 1, landing: 0, done: 1 });
  assert.equal(cycleStageOf(items[3]!, members[3], cycle, now), "progress");
  // Carried out of it: the next cycle's, not this one's.
  assert.equal(cycleStageOf(item(9, { cycle: 15 }), member(9), cycle, now), null);
});

test("each person's and each agent's share counts what the cycle holds", () => {
  assert.deepEqual(byPerson(detail), [
    { name: "ana", done: 1, total: 2 },
    { name: "bo", done: 0, total: 2 },
    { name: "Unassigned", done: 0, total: 1 },
  ]);
  assert.deepEqual(byAgent(detail), [{ name: "claude-code", done: 1, total: 2 }]);
});

test("the report groups finished, carried, open and added work", () => {
  const closed = {
    cycle: { ...cycle, state: "closed" as const },
    items: [...items.slice(0, 1), item(2, { cycle: 15 }), item(3, { cycle: 15 })],
    members: [members[0]!, member(2, { carriedOut: true }), member(3, { carriedOut: true, added: true })],
  };
  const report = cycleReport(closed);
  assert.deepEqual(
    report.finished.map((one) => one.number),
    [1],
  );
  assert.deepEqual(
    report.carried.map((one) => one.number),
    [2, 3],
  );
  assert.deepEqual(
    report.added.map((one) => one.number),
    [3],
  );
  assert.deepEqual(report.open, []);
});

test("a cycle's days read in a few words", () => {
  assert.equal(daysLeftText(cycle, "2026-10-29"), "4 days left");
  assert.equal(daysLeftText(cycle, "2026-11-01"), "Last day");
  assert.equal(daysLeftText(cycle, "2026-10-17"), "Starts Mon, Oct 19");
  assert.equal(daysLeftText({ ...cycle, state: "closed" }, "2026-11-02"), "Ended Sun, Nov 1");
  assert.deepEqual(sidebarCycle(cycle, "2026-10-29"), { number: 14, left: "4 days left", done: 2, scope: 5, state: "running" });
  assert.equal(sidebarCycle(null, "2026-10-29"), null);
  assert.equal(cyclePath("Acme"), "/acme/-/work/cycle");
  assert.equal(cyclePath("acme", 13), "/acme/-/work/cycles/13");
});

test("days count from the epoch, as the work service counts them", () => {
  assert.equal(dayNumber("1970-01-01"), 0);
  assert.equal(dayOf(dayNumber("2026-10-21")), "2026-10-21");
  assert.equal(dayOf(dayNumber("2026-12-31") + 1), "2027-01-01");
  assert.ok(Number.isNaN(dayNumber("soon")));
  assert.equal(weekdayName(1), "Monday");
  assert.equal(weekdayName(8), "");
  assert.equal(cycleDaysLeft(cycle, "2026-10-29"), 4);
  assert.equal(cycleDaysLeft(cycle, "2026-11-02"), 0);
  assert.equal(cycleDaysLeft(cycle, "2026-10-01"), 14);
  assert.equal(cycleDays(cycle), "Oct 19 – Nov 1");
  assert.equal(cycleDays({ startsOn: "2026-12-28", endsOn: "2027-01-10" }), "Dec 28, 2026 – Jan 10, 2027");
});

test("the first cycle runs from the latest start day on or before today", async () => {
  const { firstCycle } = await import("./cycles.ts");
  assert.deepEqual(firstCycle("2026-10-21", 1, 14), { startsOn: "2026-10-19", endsOn: "2026-11-01" });
  assert.deepEqual(firstCycle("2026-10-19", 1, 7), { startsOn: "2026-10-19", endsOn: "2026-10-25" });
  assert.deepEqual(firstCycle("2026-10-21", 4, 14), { startsOn: "2026-10-15", endsOn: "2026-10-28" });
});
