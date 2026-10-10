import assert from "node:assert/strict";
import { test } from "node:test";

import type { PresenceEntry } from "@g1t/contracts";

import {
  IDLE_MS,
  STATUS_PRESETS,
  clearAtFor,
  customEmojiName,
  isIdle,
  liveStatus,
  localInputValue,
  mergePeople,
  pauseUntil,
  shownAs,
  statusWords,
  untilLabel,
} from "./presence.ts";

// A Wednesday, 14:20 local time.
const NOW = new Date(2026, 9, 7, 14, 20, 0, 0);
const MIN = 60_000;

test("clear after: minutes and hours from now, the end of today, the end of the week, or never", () => {
  assert.equal(clearAtFor("30m", NOW), new Date(NOW.getTime() + 30 * MIN).toISOString());
  assert.equal(clearAtFor("1h", NOW), new Date(NOW.getTime() + 60 * MIN).toISOString());
  assert.equal(clearAtFor("4h", NOW), new Date(NOW.getTime() + 240 * MIN).toISOString());
  assert.equal(clearAtFor("today", NOW), new Date(2026, 9, 8, 0, 0, 0, 0).toISOString());
  // The coming Monday's midnight: the end of Sunday.
  assert.equal(clearAtFor("week", NOW), new Date(2026, 9, 12, 0, 0, 0, 0).toISOString());
  // On a Monday it is the next one.
  assert.equal(clearAtFor("week", new Date(2026, 9, 12, 10, 0)), new Date(2026, 9, 19, 0, 0, 0, 0).toISOString());
  assert.equal(clearAtFor("never", NOW), null);
});

test("a custom time is the viewer's own, and only one still ahead counts", () => {
  assert.equal(clearAtFor("custom", NOW, "2026-10-07T17:45"), new Date(2026, 9, 7, 17, 45).toISOString());
  assert.equal(clearAtFor("custom", NOW, "2026-10-07T09:00"), null);
  assert.equal(clearAtFor("custom", NOW, ""), null);
  assert.equal(clearAtFor("custom", NOW, "nonsense"), null);
  assert.equal(localInputValue(new Date(2026, 0, 5, 7, 3)), "2026-01-05T07:03");
});

test("pausing notifications: half an hour, an hour, or until nine tomorrow morning", () => {
  assert.equal(pauseUntil("30m", NOW), new Date(NOW.getTime() + 30 * MIN).toISOString());
  assert.equal(pauseUntil("1h", NOW), new Date(NOW.getTime() + 60 * MIN).toISOString());
  assert.equal(pauseUntil("2h", NOW), new Date(NOW.getTime() + 120 * MIN).toISOString());
  assert.equal(pauseUntil("tomorrow", NOW), new Date(2026, 9, 8, 9, 0).toISOString());
  // Just after midnight, tomorrow is still the next day's morning.
  assert.equal(pauseUntil("tomorrow", new Date(2026, 9, 8, 0, 30)), new Date(2026, 9, 9, 9, 0).toISOString());
});

test("every preset says something and clears sensibly", () => {
  const texts = STATUS_PRESETS.map((preset) => preset.text);
  for (const wanted of ["In a meeting", "Commuting", "Out sick", "On vacation", "Focusing"]) assert.ok(texts.includes(wanted), wanted);
  assert.equal(STATUS_PRESETS.find((preset) => preset.text === "On vacation")!.clear, "never");
});

test("how someone shows: offline, away, active, and Do Not Disturb over either", () => {
  const now = NOW.getTime();
  const entry = (over: Partial<PresenceEntry>): PresenceEntry => ({ user_id: "usr_1", username: "ana", presence: "active", dnd_until: null, status: null, at: 1, ...over });
  assert.equal(shownAs(null, now), "offline");
  assert.equal(shownAs(entry({ presence: "offline", dnd_until: new Date(now + MIN).toISOString() }), now), "offline");
  assert.equal(shownAs(entry({ presence: "away" }), now), "away");
  assert.equal(shownAs(entry({}), now), "active");
  assert.equal(shownAs(entry({ dnd_until: new Date(now + MIN).toISOString() }), now), "dnd");
  assert.equal(shownAs(entry({ dnd_until: new Date(now - MIN).toISOString() }), now), "active");
});

test("a status past its time is gone, even before the feed says so", () => {
  const status = { emoji: "🍔", text: "Lunch", clear_at: new Date(NOW.getTime() + MIN).toISOString(), source: "manual" as const, set_at: NOW.toISOString() };
  assert.equal(liveStatus(status, NOW.getTime()), status);
  assert.equal(liveStatus(status, NOW.getTime() + 2 * MIN), null);
  assert.equal(liveStatus({ ...status, clear_at: null }, NOW.getTime() + 999 * MIN)?.text, "Lunch");
});

test("when something ends, in a few words", () => {
  const at = (d: Date) => untilLabel(d.toISOString(), NOW, "en-US");
  assert.equal(at(new Date(2026, 9, 7, 15, 30)), "until 3:30 PM");
  assert.equal(at(new Date(2026, 9, 8, 0, 0)), "until the end of today");
  assert.equal(at(new Date(2026, 9, 8, 9, 0)), "until tomorrow 9:00 AM");
  assert.equal(at(new Date(2026, 9, 12, 0, 0)), "until the end of Sunday");
  assert.equal(at(new Date(2026, 9, 10, 9, 0)), "until Sat 9:00 AM");
  assert.equal(at(new Date(2026, 10, 2, 9, 0)), "until Nov 2");
  const status = { emoji: "🗓️", text: "In a meeting", clear_at: new Date(2026, 9, 7, 15, 0).toISOString(), source: "manual" as const, set_at: "" };
  assert.equal(statusWords(status, NOW, "en-US"), "🗓️ In a meeting, until 3:00 PM");
  assert.equal(statusWords({ ...status, clear_at: null }, NOW, "en-US"), "🗓️ In a meeting");
});

test("a tab is idle after ten minutes without input", () => {
  assert.ok(!isIdle(0, IDLE_MS - 1));
  assert.ok(isIdle(0, IDLE_MS));
});

test("custom emoji are named; ordinary emoji are not", () => {
  assert.equal(customEmojiName(":party-parrot:"), "party-parrot");
  assert.equal(customEmojiName("🎉"), null);
  assert.equal(customEmojiName(null), null);
});

test("people merge by id, and a later word wins", () => {
  const a: PresenceEntry = { user_id: "usr_1", username: "ana", presence: "active", dnd_until: null, status: null, at: 10 };
  const people = mergePeople({}, [a], true);
  assert.equal(people.usr_1, a);
  const older = mergePeople(people, [{ ...a, presence: "away", at: 5 }], false);
  assert.equal(older, people);
  const newer = mergePeople(people, [{ ...a, presence: "away", at: 20 }], false);
  assert.equal(newer.usr_1!.presence, "away");
});
