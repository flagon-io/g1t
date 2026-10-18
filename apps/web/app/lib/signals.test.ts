import assert from "node:assert/strict";
import { test } from "node:test";

import type { SignalAuthor, SignalPull, SignalWeek, Usage, WorkspaceSignals } from "@g1t/contracts";

import {
  type SignalContext,
  type WeekTotals,
  agentStep,
  blockedSignal,
  dayList,
  emptySignals,
  findings,
  mergeSignals,
  newGround,
  newHabits,
  pulse,
  quarterStart,
  quietHeadline,
  reviewSignal,
  reworkSignal,
  rhythm,
  shippedSignal,
  short,
  signalsRange,
  silos,
  spendFlow,
  spendSignal,
  spoken,
  stalledSignal,
  weekStarts,
  weekTotals,
  weeklySpend,
} from "./signals.ts";

const NOW = Date.parse("2026-10-18T15:00:00Z");
const DAY = 86_400_000;
const repos = { r1: { namespace: "acme", name: "web" }, r2: { namespace: "acme", name: "tax" } };

function week(start: string, fields: Partial<WeekTotals> = {}): WeekTotals {
  return { start, merged: 0, agentMerged: 0, agentReworked: 0, agentDrafted: 0, agentDraftSeconds: 0, reviewed: 0, reviewSeconds: 0, stalled: 0, ...fields };
}

function usage(fields: Partial<Usage> = {}): Usage {
  return {
    since: "",
    spentMicros: 0,
    costMicros: 0,
    providerMicros: 0,
    usedMicros: 0,
    free: false,
    runs: 0,
    byDay: [],
    byTask: [],
    byRepo: [],
    byPull: [],
    byModel: [],
    addedMicros: 0,
    ...fields,
  };
}

function ctx(fields: Partial<SignalContext> = {}): SignalContext {
  return { slug: "acme", now: NOW, repos, signals: emptySignals(), weeks: [], quarterUsage: null, quarter: "2026-10-01", ...fields };
}

function pull(fields: Partial<SignalPull>): SignalPull {
  return {
    repoId: "r1",
    number: 1,
    title: "A change",
    status: "merged",
    agent: false,
    ownerId: "u1",
    ownerName: "ana",
    createdAt: "2026-10-05T00:00:00Z",
    mergedAt: "2026-10-06T00:00:00Z",
    item: null,
    milestone: null,
    ...fields,
  };
}

function author(fields: Partial<SignalAuthor>): SignalAuthor {
  return {
    repoId: "r1",
    ownerId: "u1",
    ownerName: "ana",
    firstMergedAt: "2026-01-01T00:00:00Z",
    lastMergedAt: "2026-10-10T00:00:00Z",
    merged: 10,
    recent: 10,
    ...fields,
  };
}

test("weeks of seven days end with the last day, and the quarter starts on its first month", () => {
  assert.deepEqual(weekStarts("2026-10-18", 3), ["2026-09-28", "2026-10-05", "2026-10-12"]);
  assert.deepEqual(dayList("2026-10-18", 3), ["2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(quarterStart("2026-10-18"), "2026-10-01");
  assert.equal(quarterStart("2026-03-31"), "2026-01-01");
  assert.equal(quarterStart("2026-08-02"), "2026-07-01");
  // The reach covers a milestone's build even early in a quarter.
  assert.equal(signalsRange(NOW).since, "2026-06-20");
});

test("batches add up per repository, and quiet weeks stay in the line", () => {
  const rows: SignalWeek[] = [
    { repoId: "r1", ...week("2026-10-12", { merged: 2, agentMerged: 1 }) },
    { repoId: "r2", ...week("2026-10-12", { merged: 3, agentMerged: 3, stalled: 1 }) },
    { repoId: "r9", ...week("2026-01-01", { merged: 9 }) },
  ];
  const totals = weekTotals(rows, ["2026-10-05", "2026-10-12"]);
  assert.deepEqual(
    totals.map((w) => [w.start, w.merged, w.agentMerged, w.stalled]),
    [
      ["2026-10-05", 0, 0, 0],
      ["2026-10-12", 5, 4, 1],
    ],
  );
  assert.equal(weekTotals(rows, ["2026-10-12"], new Set(["r1"]))[0]!.merged, 2);
  const a: WorkspaceSignals = {
    ...emptySignals(),
    items: [{ number: 4, title: "Old", state: "open", milestone: null }],
    waiting: [{ repoId: "r1", number: 2, title: "b", createdAt: "2026-10-02", agent: false, draftSeconds: null, item: null, blocks: [] }],
  };
  const b: WorkspaceSignals = {
    ...emptySignals(),
    items: [{ number: 4, title: "Old", state: "open", milestone: null }],
    waiting: [{ repoId: "r2", number: 1, title: "a", createdAt: "2026-10-01", agent: false, draftSeconds: null, item: null, blocks: [] }],
  };
  const merged = mergeSignals([a, b]);
  assert.equal(merged.items.length, 1, "an item named by two batches is one item");
  assert.deepEqual(
    merged.waiting.map((w) => w.number),
    [1, 2],
    "the oldest waits first across batches",
  );
});

test("usage by day falls into its week", () => {
  const spend = weeklySpend(
    usage({
      byDay: [
        { key: "2026-10-12/review", micros: 5, runs: 1 },
        { key: "2026-10-18/run", micros: 7, runs: 1 },
        { key: "2026-10-11/run", micros: 3, runs: 1 },
      ],
    }),
    ["2026-10-05", "2026-10-12"],
  );
  assert.deepEqual(spend, [3, 12]);
  assert.equal(weeklySpend(null, ["2026-10-12"]), null, "usage that did not answer is not zero");
});

test("the pulse says each figure against last week, and whether that is good news", () => {
  const weeks = [
    week("2026-10-05", { merged: 60, agentMerged: 52, agentReworked: 11, stalled: 16 }),
    week("2026-10-12", { merged: 70, agentMerged: 61, agentReworked: 11, stalled: 23 }),
  ];
  const tiles = pulse({ slug: "acme", weeks, spend: [52 * 72_000_000, 61 * 86_000_000] });
  const by = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
  assert.equal(by.merges!.value, "61");
  assert.deepEqual(by.merges!.delta, { text: "+9", tone: "good" });
  assert.equal(by.spend!.value, "$86");
  assert.deepEqual(by.spend!.delta, { text: "+$14", tone: "bad" }, "spend going up is not good news");
  assert.deepEqual(by.stalled!.delta, { text: "+7", tone: "bad" });
  assert.equal(by.rework!.value, "18%");
  assert.equal(by.rework!.delta!.text, "−3.1 pts");
  assert.equal(by.rework!.delta!.tone, "good");
  const unknown = pulse({ slug: "acme", weeks, spend: null });
  assert.equal(unknown.find((tile) => tile.key === "spend")!.value, "—", "no usage, no figure");
  assert.equal(unknown.find((tile) => tile.key === "spend")!.delta, null);
});

test("the change holding up the most work items leads, with what it holds up", () => {
  const signals = {
    ...emptySignals(),
    waiting: [
      { repoId: "r1", number: 7, title: "Small", createdAt: "2026-10-10T00:00:00Z", agent: true, draftSeconds: 600, item: 3, blocks: [4] },
      {
        repoId: "r2",
        number: 4821,
        title: "Nexus threshold configuration",
        createdAt: "2026-10-16T15:00:00Z",
        agent: true,
        draftSeconds: 600,
        item: 5,
        blocks: [8, 9, 10],
      },
      { repoId: "gone", number: 1, title: "Unreadable", createdAt: "2026-10-01T00:00:00Z", agent: false, draftSeconds: null, item: 1, blocks: [2, 3, 4, 5] },
    ],
  };
  const signal = blockedSignal(ctx({ signals }))!;
  assert.equal(signal.headline, "Three work items are waiting on one unreviewed change.");
  assert.deepEqual(signal.facts, ["tax#4821 Nexus threshold configuration", "open 2 days", "holds up #8, #9, #10"]);
  assert.equal(signal.link!.to, "/acme/tax/pull/4821");
  assert.equal(blockedSignal(ctx()), null);
});

test("a quick draft waiting long for review is said with both times; a slowdown alone is said against the weeks before", () => {
  const weeks = [
    week("2026-09-28", { reviewed: 4, reviewSeconds: 4 * 0.8 * 86400 }),
    week("2026-10-05", { reviewed: 4, reviewSeconds: 4 * 1.2 * 86400 }),
    week("2026-10-12", { reviewed: 10, reviewSeconds: 10 * 2.1 * 86400, agentDrafted: 5, agentDraftSeconds: 5 * 48 * 60 }),
  ];
  const gap = reviewSignal(ctx({ weeks }))!;
  assert.equal(gap.headline, "Changes an agent drafts in under an hour are waiting 2.1 days for first review.");
  assert.deepEqual(gap.facts, ["48m to draft", "2.1d to first review", "this week"]);
  assert.equal(gap.trend!.range, "19h → 2.1d over 3 weeks");
  const slower = reviewSignal(ctx({ weeks: weeks.map((w, i) => (i === 2 ? { ...w, agentDrafted: 0, agentDraftSeconds: 0 } : w)) }))!;
  assert.match(slower.headline, /^First reviews are taking 2\.1 days, up from a day in the weeks before\.$/);
  assert.equal(reviewSignal(ctx({ weeks: [week("2026-10-12")] })), null, "no reviews, nothing to say");
});

test("spend that concentrates in one milestone is a finding; spread-out spend is not", () => {
  const signals = {
    ...emptySignals(),
    milestones: [{ number: 1, title: "the Checkout replatform", state: "open", dueOn: null, createdAt: "2026-08-01T00:00:00Z", closedAt: null }],
    items: [{ number: 5, title: "Tax cutover", state: "open", milestone: 1 }],
    pulls: [pull({ number: 1, item: 5, milestone: 1 }), pull({ number: 2 }), pull({ repoId: "r2", number: 3 })],
  };
  const quarterUsage = usage({
    byPull: [
      { key: "acme/web#1", micros: 28_300_000_000, runs: 1 },
      { key: "acme/web#2", micros: 14_000_000_000, runs: 1 },
      { key: "acme/tax#3", micros: 10_100_000_000, runs: 1 },
    ],
  });
  const signal = spendSignal(ctx({ signals, quarterUsage }))!;
  assert.equal(signal.headline, "More than half of this quarter's agent spend is going into the Checkout replatform.");
  assert.deepEqual(signal.facts, ["$28.3K of $52.4K", "quarter to date"]);
  const even = usage({ byPull: quarterUsage.byPull.map((slice) => ({ ...slice, micros: 1_000_000 })) });
  assert.equal(spendSignal(ctx({ signals, quarterUsage: even })), null);
  assert.equal(spendSignal(ctx({ signals, quarterUsage: null })), null);
});

test("a milestone closed this week says when against its due date, and what it took", () => {
  const closedAt = "2026-10-13T18:00:00Z";
  const signals = {
    ...emptySignals(),
    milestones: [{ number: 2, title: "Single sign-on", state: "closed", dueOn: "2026-11-03", createdAt: "2026-07-28T00:00:00Z", closedAt }],
    pulls: [
      pull({ milestone: 2, number: 1 }),
      pull({ milestone: 2, number: 2, repoId: "r2" }),
      pull({ milestone: 2, number: 3, status: "closed", mergedAt: null }),
    ],
  };
  const signal = shippedSignal(ctx({ signals }))!;
  assert.equal(signal.headline, "Single sign-on shipped on Tuesday, three weeks ahead of schedule.");
  assert.deepEqual(signal.facts, ["11 weeks in build", "2 changes", "2 projects"]);
  const old = { ...signals, milestones: [{ ...signals.milestones[0]!, closedAt: "2026-09-01T00:00:00Z" }] };
  assert.equal(shippedSignal(ctx({ signals: old })), null, "only the last week's");
});

test("stalled changes and rework are findings only when they moved", () => {
  assert.equal(
    stalledSignal(ctx({ weeks: [week("a", { stalled: 16 }), week("b", { stalled: 23 })] }))!.headline,
    "23 changes have been open over a week, 7 more than last week.",
  );
  assert.equal(stalledSignal(ctx({ weeks: [week("a", { stalled: 16 }), week("b", { stalled: 17 })] })), null);
  const steady = [1, 2, 3, 4].map((i) => week(`w${i}`, { agentMerged: 10, agentReworked: 1 }));
  assert.match(
    reworkSignal(ctx({ weeks: [...steady, week("now", { agentMerged: 10, agentReworked: 4 })] }))!.headline,
    /^People asked for changes on 40% .* up from 10%\.$/,
  );
  assert.equal(reworkSignal(ctx({ weeks: [...steady, week("now", { agentMerged: 10, agentReworked: 1 })] })), null);
});

test("who works where: new ground, one person carrying a project, and a first agent merge", () => {
  const recent = new Date(NOW - 3 * DAY).toISOString();
  const authors = [
    author({ ownerId: "u1", ownerName: "ana", repoId: "r1", recent: 9, merged: 40 }),
    author({ ownerId: "u2", ownerName: "bo", repoId: "r1", firstMergedAt: recent, recent: 1, merged: 1 }),
    author({ ownerId: "u2", ownerName: "bo", repoId: "r2", firstMergedAt: "2026-02-01T00:00:00Z", merged: 12, recent: 2 }),
  ];
  assert.deepEqual(
    newGround(authors, NOW).map((row) => [row.name, row.repoId, row.elsewhere]),
    [["bo", "r1", 12]],
  );
  const [silo] = silos(authors, NOW);
  assert.equal(silo!.name, "ana");
  assert.equal(silo!.share, 0.9);
  assert.deepEqual(silo!.joining, [{ ownerId: "u2", name: "bo" }]);
  const pulls = [1, 2, 3].map((n) => pull({ number: n, mergedAt: `2026-09-0${n}T00:00:00Z` }));
  const habits = newHabits([...pulls, pull({ number: 9, agent: true, mergedAt: recent })], NOW);
  assert.deepEqual(
    habits.map((row) => [row.name, row.byHand]),
    [["ana", 3]],
  );
  const signal = findings(ctx({ signals: { ...emptySignals(), authors } })).find((s) => s.key === "ground")!;
  assert.equal(signal.headline, "bo is starting to work in web, which ana has carried almost alone.");
});

test("findings come highest first, and a quiet week still says something", () => {
  const signals = {
    ...emptySignals(),
    waiting: [{ repoId: "r1", number: 2, title: "Fix", createdAt: "2026-10-16T00:00:00Z", agent: false, draftSeconds: null, item: 1, blocks: [3, 4] }],
  };
  const found = findings(ctx({ signals, weeks: [week("a", { stalled: 1 }), week("b", { stalled: 10 })] }));
  assert.deepEqual(
    found.map((s) => s.key),
    ["blocked", "stalled"],
  );
  assert.equal(quietHeadline(week("x")), "A quiet week: nothing has merged yet, and nothing is stuck.");
  assert.equal(
    quietHeadline(week("x", { merged: 4, agentMerged: 2 })),
    "Four changes merged this week, 50% of them an agent's, and nothing needs a closer look.",
  );
});

test("waits are said in words and in a few characters", () => {
  assert.equal(spoken(48 * 60), "48 minutes");
  assert.equal(spoken(5 * 3600), "5 hours");
  assert.equal(spoken(2.1 * 86400), "2.1 days");
  assert.equal(short(48 * 60), "48m");
  assert.equal(short(5.5 * 3600), "5.5h");
  assert.equal(short(null), "—");
});

test("the spend flow threads each pull request through its milestone, work item and project", () => {
  const signals = {
    ...emptySignals(),
    milestones: [{ number: 1, title: "Checkout replatform", state: "open", dueOn: null, createdAt: "2026-08-01T00:00:00Z", closedAt: null }],
    items: [{ number: 5, title: "Tax service cutover", state: "open", milestone: 1 }],
    pulls: [
      pull({ number: 1, item: 5, milestone: 1, agent: true, createdAt: "2026-10-02T00:00:00Z" }),
      pull({ number: 2, item: 5, milestone: 1, repoId: "r2", createdAt: "2026-10-03T00:00:00Z" }),
      pull({ number: 3, createdAt: "2026-10-04T00:00:00Z" }),
      pull({ number: 4, createdAt: "2026-05-01T00:00:00Z", mergedAt: "2026-05-02T00:00:00Z" }),
    ],
  };
  const flow = spendFlow({
    slug: "acme",
    repos,
    signals,
    quarter: "2026-10-01",
    quarterUsage: usage({ byPull: [{ key: "acme/web#1", micros: 900, runs: 1 }] }),
  });
  assert.deepEqual(
    flow.map((node) => [node.label, node.pulls, node.agent, node.micros]),
    [
      ["Checkout replatform", 2, 1, 900],
      ["No milestone", 1, 0, 0],
    ],
    "last quarter's work is left out; the costliest comes first",
  );
  const item = flow[0]!.children[0]!;
  assert.equal(item.label, "Tax service cutover");
  assert.deepEqual(
    item.children.map((set) => [set.label, set.list!.map((p) => p.number)]),
    [
      ["web", [1]],
      ["tax", [2]],
    ],
  );
  assert.equal(agentStep(0.71), 3);
  assert.equal(agentStep(0.1), 0);
});

test("the rhythm adds each group's days and leaves out groups with nothing", () => {
  const days = [
    { repoId: "r1", day: "2026-10-17", opened: 2, merged: 1, agentMerged: 1, reworked: 0, reviews: 3, sessions: 4 },
    { repoId: "r2", day: "2026-10-18", opened: 1, merged: 0, agentMerged: 0, reworked: 1, reviews: 0, sessions: 0 },
  ];
  const rows = rhythm(
    days,
    ["2026-10-17", "2026-10-18"],
    [
      { key: "pay", label: "Payments", note: "3 people", to: "/t/pay", repoIds: ["r1", "r2"] },
      { key: "idle", label: "Idle", note: "", to: "/t/idle", repoIds: ["r9"] },
    ],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0]!.days.map((day) => [day.opened, day.reviews, day.sessions, day.reworked]),
    [
      [2, 3, 4, 0],
      [1, 0, 0, 1],
    ],
  );
});
