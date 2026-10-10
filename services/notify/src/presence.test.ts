import assert from "node:assert/strict";
import { test } from "node:test";

import { decide } from "./prefs.ts";
import {
  MAX_STATUS_TEXT,
  NOTHING_KEPT,
  applyChange,
  cleanStatus,
  cleanWorkspaces,
  current,
  dndOn,
  entryOf,
  liveEntry,
  nextExpiry,
  onlyPeople,
  presenceOf,
  readKept,
  sameEntry,
} from "./presence.ts";

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

test("presence comes from the tabs: none is offline, all idle is away, one in use is active", () => {
  assert.equal(presenceOf([], false), "offline");
  assert.equal(presenceOf([], true), "offline");
  assert.equal(presenceOf([{ idle: true }, { idle: true }], false), "away");
  assert.equal(presenceOf([{ idle: true }, { idle: false }], false), "active");
  // Away by hand holds while tabs are in use.
  assert.equal(presenceOf([{ idle: false }], true), "away");
});

test("a status is an emoji and a few words, trimmed, and clears at a time in the future", () => {
  const status = cleanStatus({ emoji: " 🗓️ ", text: "  In a   meeting ", clear_at: iso(NOW + 30 * MIN) }, NOW)!;
  assert.equal(status.emoji, "🗓️");
  assert.equal(status.text, "In a meeting");
  assert.equal(status.clear_at, iso(NOW + 30 * MIN));
  assert.equal(status.source, "manual");
  assert.equal(status.set_at, iso(NOW));
  assert.equal(cleanStatus({ text: "x".repeat(300) }, NOW)!.text.length, MAX_STATUS_TEXT);
  // Nothing said, or a time already past, is no status.
  assert.equal(cleanStatus({ emoji: "", text: "  " }, NOW), null);
  assert.equal(cleanStatus({ text: "Lunch", clear_at: iso(NOW - MIN) }, NOW), null);
  assert.equal(cleanStatus({ text: "Lunch", clear_at: "soon" }, NOW), null);
  // Without a time it is kept until changed.
  assert.equal(cleanStatus({ text: "On vacation" }, NOW)!.clear_at, null);
  // An emoji alone is enough.
  assert.equal(cleanStatus({ emoji: "🌴", text: "" }, NOW)!.text, "");
});

test("a status and Do Not Disturb are gone once their time passes", () => {
  const kept = applyChange(NOTHING_KEPT, { status: { emoji: "🍔", text: "Lunch", clear_at: iso(NOW + 30 * MIN) }, dnd_until: iso(NOW + 60 * MIN) }, NOW);
  assert.ok(kept.status);
  assert.ok(dndOn(kept.dnd_until, NOW));
  assert.equal(nextExpiry(kept, NOW), NOW + 30 * MIN);
  const later = current(kept, NOW + 45 * MIN);
  assert.equal(later.status, null);
  assert.equal(later.dnd_until, kept.dnd_until);
  assert.equal(nextExpiry(later, NOW + 45 * MIN), NOW + 60 * MIN);
  const after = current(kept, NOW + 61 * MIN);
  assert.equal(after.dnd_until, null);
  assert.equal(nextExpiry(after, NOW + 61 * MIN), null);
});

test("Do Not Disturb resumes with null, and refuses a time in the past", () => {
  const on = applyChange(NOTHING_KEPT, { dnd_until: iso(NOW + MIN) }, NOW);
  assert.ok(dndOn(on.dnd_until, NOW));
  assert.equal(applyChange(on, { dnd_until: null }, NOW).dnd_until, null);
  assert.equal(applyChange(NOTHING_KEPT, { dnd_until: iso(NOW - MIN) }, NOW).dnd_until, null);
  // A change that does not mention it leaves it.
  assert.equal(applyChange(on, { away: true }, NOW).dnd_until, on.dnd_until);
});

test("a calendar never replaces a status set by hand, but replaces its own", () => {
  const byHand = applyChange(NOTHING_KEPT, { status: { emoji: "🤒", text: "Out sick" } }, NOW);
  const meeting = applyChange(byHand, { status: { emoji: "🗓️", text: "In a meeting", source: "calendar", clear_at: iso(NOW + 30 * MIN) } }, NOW);
  assert.equal(meeting.status?.text, "Out sick");
  // Nor clears it.
  assert.equal(applyChange(byHand, { status: null }, NOW).status, null);
  assert.equal(applyChange(byHand, { status: { text: "", source: "calendar" } }, NOW).status?.text, "Out sick");

  const fromCalendar = applyChange(NOTHING_KEPT, { status: { emoji: "🗓️", text: "In a meeting", source: "calendar", clear_at: iso(NOW + 30 * MIN) } }, NOW);
  assert.equal(fromCalendar.status?.source, "calendar");
  const next = applyChange(fromCalendar, { status: { text: "Focusing", source: "integration" } }, NOW);
  assert.equal(next.status?.text, "Focusing");
  // The person always can.
  assert.equal(applyChange(fromCalendar, { status: { text: "Commuting" } }, NOW).status?.source, "manual");
});

test("Do Not Disturb silences toasts and pushes; a test still shows", () => {
  const prefs = { level: "all" as const, workspaces: {} };
  const notification = { kind: "dm" as const, workspace: "acme" };
  assert.deepEqual(decide({ prefs, notification, tabs: [], subscriptions: 2, now: NOW, dnd: true }), { toast: false, push: false });
  assert.deepEqual(decide({ prefs, notification, tabs: [], subscriptions: 2, now: NOW, dnd: true, test: true }), { toast: true, push: true });
  assert.deepEqual(decide({ prefs, notification, tabs: [], subscriptions: 2, now: NOW }), { toast: true, push: true });
});

test("entries say how a person shows, and compare without their time", () => {
  const kept = applyChange(NOTHING_KEPT, { status: { emoji: "🎯", text: "Focusing", clear_at: iso(NOW + MIN) } }, NOW);
  const a = entryOf({ user_id: "usr_1", username: "ana" }, "active", kept, NOW);
  const b = entryOf({ user_id: "usr_1", username: "ana" }, "active", kept, NOW + 5);
  assert.ok(sameEntry(a, b));
  assert.ok(!sameEntry(a, { ...b, presence: "away" }));
  assert.ok(!sameEntry(a, null));
  // Read after its status ran out, a kept entry shows without it.
  assert.equal(liveEntry(a, NOW + 2 * MIN).status, null);
  assert.equal(liveEntry(a, NOW), a);
});

test("what is kept reads back, and anything else reads as nothing", () => {
  const kept = applyChange(NOTHING_KEPT, { away: true, status: { text: "Commuting" } }, NOW);
  assert.deepEqual(readKept(JSON.stringify(kept)), kept);
  assert.deepEqual(readKept("not json"), NOTHING_KEPT);
  assert.deepEqual(readKept(null), NOTHING_KEPT);
});

test("a workspace's presence narrows to the people asked about", () => {
  const entry = (user_id: string) => entryOf({ user_id, username: user_id }, "active", NOTHING_KEPT, NOW);
  const everyone = [entry("usr_a"), entry("usr_b"), entry("usr_c")];
  assert.deepEqual(onlyPeople(everyone, ["usr_c", "usr_a", 7]).map((e) => e.user_id), ["usr_a", "usr_c"]);
  assert.equal(onlyPeople(everyone, null).length, 3);
  assert.deepEqual(onlyPeople(everyone, []), []);
});

test("workspaces are slugs, lowercased and distinct", () => {
  assert.deepEqual(cleanWorkspaces(["Acme", "acme", " web-team ", "-bad", 3, "a".repeat(60)]), ["acme", "web-team"]);
  assert.deepEqual(cleanWorkspaces("acme"), []);
});
