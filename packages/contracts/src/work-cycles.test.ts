import assert from "node:assert/strict";
import { test } from "node:test";

import { cycleDays, cycleDaysLeft, dayNumber, dayOf, weekdayName } from "./work.ts";

test("days count from the epoch, as the work service counts them", () => {
  assert.equal(dayNumber("1970-01-01"), 0);
  assert.equal(dayOf(dayNumber("2026-10-21")), "2026-10-21");
  assert.equal(dayOf(dayNumber("2026-12-31") + 1), "2027-01-01");
  assert.ok(Number.isNaN(dayNumber("soon")));
  assert.equal(weekdayName(1), "Monday");
  assert.equal(weekdayName(7), "Sunday");
  assert.equal(weekdayName(8), "");
});

test("days left count today, and a cycle not started has all of them", () => {
  const cycle = { startsOn: "2026-10-19", endsOn: "2026-11-01" };
  assert.equal(cycleDaysLeft(cycle, "2026-10-29"), 4);
  assert.equal(cycleDaysLeft(cycle, "2026-11-01"), 1);
  assert.equal(cycleDaysLeft(cycle, "2026-11-02"), 0);
  assert.equal(cycleDaysLeft(cycle, "2026-10-01"), 14);
});

test("a cycle's days read short, with the year only across a new year", () => {
  assert.equal(cycleDays({ startsOn: "2026-10-19", endsOn: "2026-11-01" }), "Oct 19 – Nov 1");
  assert.equal(cycleDays({ startsOn: "2026-12-28", endsOn: "2027-01-10" }), "Dec 28, 2026 – Jan 10, 2027");
});
