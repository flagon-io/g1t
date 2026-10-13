/**
 * How long ago something happened, in a few characters, as `TimeAgo`
 * shows it: "just now", "5m ago", "3h ago", "yesterday", "4d ago",
 * "3w ago", then the date itself, "Sep 30" this year and "Sep 30, 2023"
 * before, since "1176d ago" says less than the date does. Only plain
 * functions, so it is tested on its own.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A moment as a number, from an RFC 3339 string or (for a few older ones) a number. */
function timeOf(at: string | number): number {
  return typeof at === "number" ? at : Date.parse(at);
}

export function timeAgo(at: string | number, now: number = Date.now(), timeZone?: string): string {
  const time = timeOf(at);
  if (!Number.isFinite(time)) return "";
  // A moment slightly ahead is a clock that differs, not the future.
  const elapsed = Math.max(0, now - time);
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < 28 * DAY) return `${Math.floor(elapsed / (7 * DAY))}w ago`;
  const sameYear = yearIn(time, timeZone) === yearIn(now, timeZone);
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  });
}

/** The moment in full, for the hint over a `TimeAgo`: "Oct 13, 2026, 3:04 PM". */
export function exactTime(at: string | number, timeZone?: string): string {
  const time = timeOf(at);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}

function yearIn(time: number, timeZone?: string): string {
  return new Date(time).toLocaleDateString("en-US", { year: "numeric", timeZone });
}
