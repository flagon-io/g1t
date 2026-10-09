import assert from "node:assert/strict";
import { test } from "node:test";

import { CALENDAR_WEEKS, buildCalendar, dayLabel, lastDay, levelOf, totalLabel } from "./contribution-calendar.ts";

test("the calendar is 53 weeks of seven days, ending with today's week", () => {
  // 2026-10-08 is a Thursday.
  const calendar = buildCalendar([], "2026-10-08", "2025-10-09");
  assert.equal(calendar.weeks.length, CALENDAR_WEEKS);
  for (const week of calendar.weeks) assert.equal(week.length, 7);
  const last = calendar.weeks.at(-1)!;
  assert.equal(last[4]?.date, "2026-10-08");
  // Friday and Saturday are still to come.
  assert.equal(last[5], null);
  assert.equal(last[6], null);
  // Sunday at the top of every column.
  assert.equal(new Date(`${last[0]!.date}T00:00:00Z`).getUTCDay(), 0);
  // Days before the year starts are blank; the year has 365 days in it.
  const shown = calendar.weeks.flat().filter((day) => day != null);
  assert.equal(shown.length, 365);
  assert.equal(shown[0]!.date, "2025-10-09");
  assert.equal(calendar.max, 0);
  assert.ok(shown.every((day) => day.count === 0 && day.level === 0));
});

test("each day is shaded in quarters of the busiest", () => {
  assert.equal(levelOf(0, 10), 0);
  assert.equal(levelOf(1, 10), 1);
  assert.equal(levelOf(3, 10), 2);
  assert.equal(levelOf(6, 10), 3);
  assert.equal(levelOf(10, 10), 4);
  assert.equal(levelOf(5, 0), 0);
  const calendar = buildCalendar(
    [
      { date: "2026-10-01", count: 8 },
      { date: "2026-10-02", count: 1 },
      // Outside the year: neither shown nor the busiest.
      { date: "2024-01-01", count: 99 },
    ],
    "2026-10-08",
    "2025-10-09",
  );
  assert.equal(calendar.max, 8);
  const days = calendar.weeks.flat();
  assert.deepEqual(days.find((day) => day?.date === "2026-10-01"), { date: "2026-10-01", count: 8, commits: 0, level: 4 });
  assert.equal(days.find((day) => day?.date === "2026-10-02")?.level, 1);
});

test("months are named over the week they start in", () => {
  const { months, weeks } = buildCalendar([], "2026-10-08", "2025-10-09");
  // The year starts partway through October, which still gets its name:
  // November is three weeks on, room enough for both.
  assert.deepEqual(months[0], { label: "Oct", week: 0 });
  assert.deepEqual(
    months.map((month) => month.label),
    ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"],
  );
  for (const { label, week } of months.slice(1)) {
    assert.ok(weeks[week]!.some((day) => day?.date.endsWith("-01")), label);
  }
  // Increasing, and never two in one column.
  for (let i = 1; i < months.length; i++) assert.ok(months[i]!.week > months[i - 1]!.week);
});

test("a month that starts too close to the first column takes its place", () => {
  // From Tue 2025-10-21: October's column is the one before November's,
  // too narrow for its name.
  const squeezed = buildCalendar([], "2026-10-20", "2025-10-21");
  assert.deepEqual(squeezed.months[0], { label: "Nov", week: 1 });
});

test("a year that starts early in a month keeps its first label", () => {
  // From Jan 2: January has room before February.
  const { months } = buildCalendar([], "2027-01-01", "2026-01-02");
  assert.equal(months[0]!.label, "Jan");
  assert.equal(months[1]!.label, "Feb");
});

test("a bad date draws nothing", () => {
  assert.deepEqual(buildCalendar([], "not a date"), { weeks: [], months: [], max: 0 });
});

test("hints and the heading read as sentences", () => {
  assert.equal(dayLabel(3, "2026-10-04"), "3 contributions on Oct 4, 2026");
  assert.equal(dayLabel(1, "2026-10-04"), "1 contribution on Oct 4, 2026");
  assert.equal(dayLabel(0, "2026-01-01"), "No contributions on Jan 1, 2026");
  assert.equal(dayLabel(5, "2026-10-04", 3), "5 contributions on Oct 4, 2026, 3 of them commits");
  assert.equal(dayLabel(2, "2026-10-04", 1), "2 contributions on Oct 4, 2026, 1 of them a commit");
  assert.equal(dayLabel(3, "2026-10-04", 3), "3 commits on Oct 4, 2026");
  assert.equal(dayLabel(1, "2026-10-04", 1), "1 commit on Oct 4, 2026");
  assert.equal(totalLabel(0), "0 contributions in the last year");
  assert.equal(totalLabel(1), "1 contribution in the last year");
  assert.equal(totalLabel(1204), "1,204 contributions in the last year");
  assert.equal(lastDay("2025-10-09"), "2026-10-08");
  assert.equal(lastDay("nope"), null);
});
