import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMemory } from "@g1t/contracts";

import {
  isLive,
  kindLabel,
  memoryGroups,
  meterTone,
  monthDays,
  reposFrom,
  routineInWords,
  scheduleFrom,
  scheduleInWords,
  sessionRows,
  sessionStatus,
  shareOf,
  timeField,
  topSlices,
  untilLabel,
  versionChanges,
  whereLabel,
} from "./agents/format.ts";

test("a session's status reads as its card in chat does", () => {
  assert.deepEqual(sessionStatus("working"), { label: "Working", tone: "accent", moving: true });
  assert.deepEqual(sessionStatus("waiting"), { label: "Waiting on helpers", tone: "info", moving: true });
  assert.equal(sessionStatus("needs_approval").label, "Needs approval");
  assert.equal(sessionStatus("failed").tone, "danger");
  assert.equal(sessionStatus("something new").label, "something new");
  assert.ok(isLive("needs_approval"));
  assert.ok(!isLive("done"));
});

test("kinds and places read in words", () => {
  assert.equal(kindLabel("helper"), "Helper");
  assert.equal(kindLabel("subagent"), "Subagent");
  assert.equal(whereLabel({ channel_kind: "channel", channel_name: "releases" }), "#releases");
  assert.equal(whereLabel({ channel_kind: "dm", channel_name: null }), "A direct message");
});

test("spend against a cap warns at 75% and stops at 100%", () => {
  assert.equal(shareOf(5, null), null);
  assert.equal(shareOf(5, 0), null);
  assert.equal(shareOf(50, 100), 0.5);
  assert.equal(meterTone(null), "accent");
  assert.equal(meterTone(0.5), "accent");
  assert.equal(meterTone(0.75), "warn");
  assert.equal(meterTone(1.2), "danger");
});

test("a tree of sessions puts each child under its parent, oldest first", () => {
  const s = (id: string, parent: string | null, at: string) => ({ id, parent_id: parent, created_at: at });
  const rows = sessionRows([s("root", null, "1"), s("b", "root", "3"), s("a", "root", "2"), s("a1", "a", "4"), s("orphan", "gone", "5")]);
  assert.deepEqual(
    rows.map((r) => `${r.session.id}:${r.depth}`),
    ["root:0", "a:1", "a1:2", "b:1", "orphan:0"],
  );
  // A cycle still shows each once.
  const cycle = sessionRows([s("x", "y", "1"), s("y", "x", "2")]);
  assert.equal(cycle.length, 2);
});

test("a schedule reads as a sentence", () => {
  assert.equal(scheduleInWords({ every: "weekday", hour: 9, minute: 0, weekday: 1 }), "Every weekday at 09:00 UTC");
  assert.equal(scheduleInWords({ every: "week", hour: 17, minute: 30, weekday: 1 }), "Every Monday at 17:30 UTC");
  assert.equal(scheduleInWords({ every: "hour", hour: 0, minute: 15, weekday: 0 }), "Every hour at :15");
  assert.equal(scheduleInWords({ every: "hour", hour: 0, minute: 0, weekday: 0 }), "Every hour, on the hour");
  assert.equal(scheduleInWords({ every: "day", hour: 7, minute: 5, weekday: 0 }), "Every day at 07:05 UTC");
});

test("a routine reads as its schedule, its events and its repositories", () => {
  const labels = { pull_ready: "A pull request is ready for review", pull_merged: "A pull request is merged" };
  assert.equal(
    routineInWords({ schedule: null, events: ["pull_ready"], repos: ["acme/web"] }, labels),
    "When a pull request is ready for review · acme/web",
  );
  assert.equal(
    routineInWords({ schedule: { every: "day", hour: 9, minute: 0, weekday: 0 }, events: ["pull_ready", "pull_merged"], repos: [] }, labels),
    "Every day at 09:00 UTC · When a pull request is ready for review, or a pull request is merged · Any repository",
  );
  assert.equal(routineInWords({ schedule: null, events: [], repos: [] }, labels), "Never: it has no schedule or events");
});

test("the routine dialog's fields become a schedule and back", () => {
  assert.deepEqual(scheduleFrom("week", "17:30", "5"), { every: "week", hour: 17, minute: 30, weekday: 5 });
  assert.deepEqual(scheduleFrom("day", "", ""), { every: "day", hour: 9, minute: 0, weekday: 1 });
  assert.equal(scheduleFrom("never", "09:00", "1"), null);
  assert.equal(scheduleFrom("day", "25:00", "1"), null);
  assert.equal(timeField({ hour: 7, minute: 5 }), "07:05");
});

test("repositories are typed as a list", () => {
  assert.deepEqual(reposFrom("Acme/Web, acme/api acme/web"), ["acme/web", "acme/api"]);
  assert.deepEqual(reposFrom("  "), []);
  assert.equal(reposFrom("web"), null);
});

test("memories group by scope, pinned first", () => {
  const m = (id: string, scope: AgentMemory["scope"], pinned: boolean, at: string) =>
    ({ id, scope, pinned, updated_at: at }) as AgentMemory;
  const groups = memoryGroups([m("a", "person", false, "2"), m("b", "workspace", false, "3"), m("c", "workspace", true, "1"), m("d", "person", false, "4")]);
  assert.deepEqual(
    groups.map((g) => [g.scope, g.memories.map((x) => x.id)]),
    [
      ["workspace", ["c", "b"]],
      ["person", ["d", "a"]],
    ],
  );
});

test("a month's days run to today, with spend or 0", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  assert.deepEqual(monthDays("2026-10", [{ day: "2026-10-02", micros: 5 }], now), [
    { day: "2026-10-01", micros: 0 },
    { day: "2026-10-02", micros: 5 },
    { day: "2026-10-03", micros: 0 },
    { day: "2026-10-04", micros: 0 },
  ]);
  assert.equal(monthDays("2026-09", [], now).length, 30);
});

test("past five, the rest fold into one", () => {
  const slices = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, micros: 10 - i, count: 1 }));
  const top = topSlices(slices, 5);
  assert.equal(top.length, 6);
  assert.deepEqual(top[5], { key: "__rest", label: "3 more", micros: 5 + 4 + 3, count: 3 });
  assert.equal(topSlices(slices.slice(0, 6), 5).length, 6);
});

test("until reads short", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.equal(untilLabel("2026-10-04T12:00:30Z", now), "now");
  assert.equal(untilLabel("2026-10-04T12:20:00Z", now), "in 20m");
  assert.equal(untilLabel("2026-10-04T15:00:00Z", now), "in 3h");
  assert.equal(untilLabel("2026-10-06T12:00:00Z", now), "in 2d");
});

test("a version says what changed from the one before", () => {
  assert.equal(versionChanges(null, { instructions: "a" }), "Created");
  assert.equal(versionChanges({ instructions: "a", budget: { monthly_micros: 1 } }, { instructions: "b", budget: { monthly_micros: 1 } }), "Changed job");
  assert.equal(
    versionChanges({ personality_preset: "crisp", personality: "", routing: {} }, { personality_preset: "terse", personality: "x", routing: { floor: "fast" } }),
    "Changed personality, models",
  );
  assert.equal(versionChanges({ capacity: 3 }, { capacity: 3 }), "Saved with no changes");
});
