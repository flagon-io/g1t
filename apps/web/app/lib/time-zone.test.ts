import assert from "node:assert/strict";
import { test } from "node:test";

import { knownTimeZone, localTime, timeZoneLabel, timeZoneNames, utcOffset } from "./time-zone.ts";

// 2026-10-08 21:42 UTC: 3:42 PM in Denver (MDT), the next morning in Tokyo.
const NOW = Date.UTC(2026, 9, 8, 21, 42);

test("a profile's local time is the time of day in its zone", () => {
  // ICU puts a narrow no-break space before AM/PM in some versions.
  const at = (zone: string) => localTime(zone, NOW, "en-US")?.replace(/\s/gu, " ");
  assert.equal(at("America/Denver"), "3:42 PM");
  assert.equal(at("Asia/Tokyo"), "6:42 AM");
  assert.equal(at("UTC"), "9:42 PM");
});

test("no zone, or one the runtime does not know, shows no time", () => {
  assert.equal(localTime(null, NOW, "en-US"), null);
  assert.equal(localTime("", NOW, "en-US"), null);
  assert.equal(localTime("Mars/Olympus_Mons", NOW, "en-US"), null);
  assert.ok(!knownTimeZone("Mars/Olympus_Mons"));
  assert.ok(knownTimeZone("Europe/Berlin"));
});

test("the zones to pick from are sorted, with UTC and a saved one always there", () => {
  const names = timeZoneNames("Mars/Olympus_Mons");
  assert.ok(names.includes("UTC"));
  assert.ok(names.includes("America/Denver"));
  assert.ok(names.includes("Mars/Olympus_Mons"));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("zones read as places, with their offset", () => {
  assert.equal(timeZoneLabel("America/Port_of_Spain"), "America/Port of Spain");
  assert.equal(utcOffset("America/Denver", NOW), "UTC−06:00");
  assert.equal(utcOffset("Asia/Kolkata", NOW), "UTC+05:30");
  assert.equal(utcOffset("UTC", NOW), "UTC+00:00");
});
