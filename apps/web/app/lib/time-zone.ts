/**
 * Time zones on a profile: the IANA names a person picks from in their
 * settings, and the local time the card over their name shows. Pure, so it
 * is tested on its own.
 */

/** Whether the runtime knows `zone` as a time zone. */
export function knownTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every IANA zone the runtime knows, sorted, with `current` kept in the
 * list even when the runtime does not know it, so a saved choice is never
 * dropped. UTC is always there.
 */
export function timeZoneNames(current?: string | null): string[] {
  let names: string[] = [];
  try {
    names = Intl.supportedValuesOf("timeZone");
  } catch {
    names = [];
  }
  const all = new Set(names);
  all.add("UTC");
  if (current) all.add(current);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** A zone's name as a person reads it: `America/Port_of_Spain` as `America/Port of Spain`. */
export function timeZoneLabel(zone: string): string {
  return zone.replaceAll("_", " ");
}

/** The zone's offset from UTC at `now`, such as `UTC−06:00`; null when unknown. */
export function utcOffset(zone: string, now: number): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((one) => one.type === "timeZoneName")?.value;
    if (!part) return null;
    // "GMT-06:00", or plain "GMT" at UTC itself.
    const offset = part.replace(/^GMT/, "") || "+00:00";
    return `UTC${offset.replace("-", "−")}`;
  } catch {
    return null;
  }
}

/**
 * The time of day at `now` in `zone`, such as `3:42 PM`, in `locale` (the
 * viewer's own when left out); null when there is no zone or the runtime
 * does not know it.
 */
export function localTime(zone: string | null | undefined, now: number, locale?: string): string | null {
  if (!knownTimeZone(zone)) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(now);
}

/** The browser's own zone, or null where it cannot say (on the server, say). */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return knownTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}
