import assert from "node:assert/strict";
import { test } from "node:test";

import { localValue, utc } from "./incidents.ts";
import { fromLocalInput, readZone, toLocalInput, when, zoneAbbr } from "./time.ts";

const AT = new Date("2026-10-06T07:27:54.222Z");

test("the zone: the staff member's choice, else Cloudflare's guess, else UTC", () => {
  assert.deepEqual(readZone(null, "America/Los_Angeles"), { zone: "America/Los_Angeles", chosen: false });
  assert.deepEqual(readZone("x=1; sudo_tz=Europe%2FBerlin", "America/Los_Angeles"), { zone: "Europe/Berlin", chosen: true });
  assert.deepEqual(readZone("sudo_tz=Mars%2FOlympus", undefined), { zone: "UTC", chosen: false });
  assert.deepEqual(readZone(undefined, 7), { zone: "UTC", chosen: false });
});

test("a time on a page: in the zone, with its abbreviation; UTC on hover", () => {
  assert.deepEqual(when(AT, "America/Los_Angeles", true), { text: "Oct 6, 2026, 12:27 AM", zone: "PDT", utc: "Oct 6, 2026, 7:27 AM UTC" });
  assert.deepEqual(when(AT, "UTC", true), { text: "Oct 6, 2026, 7:27 AM", zone: "UTC", utc: "Oct 6, 2026, 7:27 AM UTC" });
  // A day without a time: the day in the zone, which can differ from UTC's.
  assert.equal(when(new Date("2026-10-06T03:13:00Z"), "America/Los_Angeles", false).text, "Oct 5, 2026");
  assert.equal(when(AT, "Not/AZone", true).zone, "UTC");
  assert.equal(zoneAbbr(AT, "Europe/Berlin"), "CEST");
  assert.equal(zoneAbbr(AT, "Asia/Tokyo"), "UTC+9");
});

test("form times are read and shown in the zone", () => {
  assert.equal(fromLocalInput("2026-10-05T14:00", "America/Los_Angeles"), "2026-10-05T21:00:00.000Z");
  assert.equal(fromLocalInput("2026-12-05T14:00", "America/Los_Angeles"), "2026-12-05T22:00:00.000Z", "standard time in winter");
  assert.equal(fromLocalInput("2026-10-05T14:00", "Asia/Kolkata"), "2026-10-05T08:30:00.000Z");
  assert.equal(fromLocalInput("2026-10-05T14:00"), "2026-10-05T14:00:00.000Z");
  assert.equal(fromLocalInput("2026-10-05T14:00:00Z", "America/Los_Angeles"), "2026-10-05T14:00:00.000Z", "an explicit offset wins");
  assert.equal(fromLocalInput("garbage", "America/Los_Angeles"), null);
  assert.equal(toLocalInput("2026-10-05T21:00:00.000Z", "America/Los_Angeles"), "2026-10-05T14:00");
  assert.equal(toLocalInput("2026-10-05T14:00:00.000Z"), "2026-10-05T14:00");
  // The incidents forms' helpers go through the same.
  assert.equal(utc("2026-10-05T14:00", "Europe/Berlin"), "2026-10-05T12:00:00.000Z");
  assert.equal(localValue("2026-10-05T12:00:00.000Z", "Europe/Berlin"), "2026-10-05T14:00");
  // Round trips either side of the clock changes in Berlin (an hour that happens twice in autumn is ambiguous, and read as the later one).
  for (const at of ["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-10-25T03:30:00.000Z"]) {
    assert.equal(fromLocalInput(toLocalInput(at, "Europe/Berlin"), "Europe/Berlin"), at);
  }
});
