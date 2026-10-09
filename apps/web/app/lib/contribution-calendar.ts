/**
 * The contribution calendar on a profile, laid out: the last year as
 * columns of weeks (Sunday at the top), each day shaded by how much was
 * done that day, with the months named above the week each one starts in.
 * Pure, so the page and its tests agree; every date is UTC, as the work
 * service counts them (services/work/src/contributions.rs).
 */

/** How many weeks the calendar shows: enough for a whole year and the current week. */
export const CALENDAR_WEEKS = 53;

/** The shades a day can take: 0 is nothing, 4 the busiest. */
export type Level = 0 | 1 | 2 | 3 | 4;

/** One square: a day of the year, or null outside it (before it starts, after today). */
export type CalendarDay = { date: string; count: number; commits: number; level: Level } | null;

export type Calendar = {
  /** `CALENDAR_WEEKS` columns of seven days, Sunday first. */
  weeks: CalendarDay[][];
  /** Each month's name, over the first column it starts in. */
  months: { label: string; week: number }[];
  /** The most on any one day. */
  max: number;
};

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as milliseconds at its UTC midnight, or NaN. */
function parse(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The shade for `count` on a calendar whose busiest day had `max`: quarters of it. */
export function levelOf(count: number, max: number): Level {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as Level;
}

/**
 * The calendar ending with the week of `today` (`YYYY-MM-DD`). Days before
 * `from`, when given, and after `today` are left blank; days with nothing
 * in `days` are zero.
 */
export function buildCalendar(days: readonly { date: string; count: number; commits?: number }[], today: string, from?: string): Calendar {
  const end = parse(today);
  if (Number.isNaN(end)) return { weeks: [], months: [], max: 0 };
  const first = from && !Number.isNaN(parse(from)) ? parse(from) : end - 364 * DAY_MS;
  const counts = new Map<string, number>();
  const commits = new Map<string, number>();
  for (const day of days) {
    counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
    if (day.commits) commits.set(day.date, (commits.get(day.date) ?? 0) + day.commits);
  }
  let max = 0;
  for (const [date, count] of counts) {
    const at = parse(date);
    if (at >= first && at <= end) max = Math.max(max, count);
  }
  // The Sunday that starts the first column.
  const start = end - new Date(end).getUTCDay() * DAY_MS - (CALENDAR_WEEKS - 1) * 7 * DAY_MS;
  const weeks: CalendarDay[][] = [];
  const months: Calendar["months"] = [];
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    const column: CalendarDay[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const at = start + (week * 7 + weekday) * DAY_MS;
      if (at < first || at > end) {
        column.push(null);
        continue;
      }
      const date = format(at);
      const count = counts.get(date) ?? 0;
      column.push({ date, count, commits: commits.get(date) ?? 0, level: levelOf(count, max) });
    }
    weeks.push(column);
    // A month is named over the first column holding its first day, or over
    // the first column at all when the year starts partway through it.
    const named = column.find((day) => day?.date.endsWith("-01")) ?? (months.length === 0 ? column.find((day) => day != null) : null);
    if (named) months.push({ label: MONTHS[Number(named.date.slice(5, 7)) - 1]!, week });
  }
  // A label squeezed in before the next one (too few columns to fit) goes.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  return { weeks, months, max };
}

/**
 * What a day's hint says: "3 contributions on Oct 4, 2026", and how many
 * of them were commits when some were: "5 contributions on Oct 4, 2026,
 * 3 of them commits", or "3 commits on Oct 4, 2026" when all were.
 */
export function dayLabel(count: number, date: string, commits = 0): string {
  const at = parse(date);
  const when = Number.isNaN(at)
    ? date
    : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (count === 0) return `No contributions on ${when}`;
  if (commits > 0 && commits >= count) return `${count.toLocaleString("en-US")} ${count === 1 ? "commit" : "commits"} on ${when}`;
  const all = `${count.toLocaleString("en-US")} ${count === 1 ? "contribution" : "contributions"} on ${when}`;
  if (commits <= 0) return all;
  return `${all}, ${commits.toLocaleString("en-US")} of them ${commits === 1 ? "a commit" : "commits"}`;
}

/** The heading: "1,204 contributions in the last year". */
export function totalLabel(total: number): string {
  return `${total.toLocaleString("en-US")} ${total === 1 ? "contribution" : "contributions"} in the last year`;
}

/** The day `from` (`YYYY-MM-DD`) plus 364: the last day of a year counted from it. */
export function lastDay(from: string): string | null {
  const at = parse(from);
  return Number.isNaN(at) ? null : format(at + 364 * DAY_MS);
}
