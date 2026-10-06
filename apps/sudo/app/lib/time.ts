/**
 * Times in the staff member's own zone, on every page (components/ui.tsx
 * `When`) and in the forms that take a time. sudo ships no script, so the
 * zone comes from the request: the `sudo_tz` cookie when someone chose one
 * (/timezone), else Cloudflare's guess (`request.cf.timezone`), else UTC.
 * Every time shown says its zone's abbreviation, and `<time datetime>`
 * plus the hover title keep the UTC instant. No Workers or React imports,
 * so it is tested under Node.
 */

export const ZONE_COOKIE = "sudo_tz";

/** Whether `tz` is a time zone this runtime knows. */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A cookie's value from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The zone a request's pages use, and where it came from. */
export function readZone(cookieHeader: string | null | undefined, cfTimezone: unknown): { zone: string; chosen: boolean } {
  const chosen = readCookie(cookieHeader, ZONE_COOKIE);
  if (validZone(chosen)) return { zone: chosen, chosen: true };
  return { zone: validZone(cfTimezone) ? cfTimezone : "UTC", chosen: false };
}

/** The zone's short name at that moment: "PDT", "CEST", "BST", or "UTC+9" where there is no common one. */
export function zoneAbbr(date: Date, tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC" || tz === "Etc/GMT") return "UTC";
  let offset = "";
  for (const locale of ["en-US", "en-GB"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
    if (name && !/^(GMT|UTC)[+-−]/.test(name)) return name;
    offset ||= name;
  }
  return offset.replace(/^GMT/, "UTC") || "UTC";
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string, time: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${time}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", time ? { dateStyle: "medium", timeStyle: "short", timeZone: tz } : { dateStyle: "medium", timeZone: tz });
    formats.set(key, f);
  }
  return f;
}

/**
 * A moment for a page: "Oct 6, 2026, 12:27 AM" and "PDT" (shown apart, the
 * zone quieter), or just the day. `utc` is the same moment in UTC, for the
 * hover title.
 */
export function when(at: Date, tz: string, time: boolean): { text: string; zone: string | null; utc: string } {
  const zone = validZone(tz) ? tz : "UTC";
  return {
    text: format(zone, time).format(at),
    zone: time ? zoneAbbr(at, zone) : null,
    utc: `${format("UTC", true).format(at)} UTC`,
  };
}

/** Minutes the zone is ahead of UTC at that moment. */
function offsetMinutes(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * A `datetime-local` value (`2026-10-05T14:00`), read as a wall-clock time
 * in `tz`; an ISO time with its own offset is taken as it is. UTC ISO, or
 * null when it is not a time.
 */
export function fromLocalInput(raw: string, tz = "UTC"): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/Z$|[+-]\d\d:\d\d$/.test(value)) return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  const zone = validZone(tz) ? tz : "UTC";
  // The offset at the guess, then again at the answer: right across a change of clocks.
  let at = wall - offsetMinutes(wall, zone) * 60_000;
  at = wall - offsetMinutes(at, zone) * 60_000;
  return new Date(at).toISOString();
}

/** A moment as a `datetime-local` value in `tz`: `2026-10-05T07:00`. */
export function toLocalInput(at: Date | string, tz = "UTC"): string {
  const ms = new Date(at).getTime();
  const zone = validZone(tz) ? tz : "UTC";
  return new Date(ms + offsetMinutes(ms, zone) * 60_000).toISOString().slice(0, 16);
}
