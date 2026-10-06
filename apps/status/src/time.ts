/**
 * Times in the reader's own zone. The zone comes from Cloudflare's guess
 * for the request (`request.cf.timezone`), or a `g1t_tz` cookie when the
 * reader has one; anything unknown is UTC. Every time shown carries its
 * zone's abbreviation, and `<time datetime>` keeps the UTC instant. No
 * Workers imports, so it is tested under Node.
 */

export const ZONE_COOKIE = "g1t_tz";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function cookie(header: string | null | undefined, name: string): string | null {
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

/** The reader's zone: their cookie, else Cloudflare's guess, else UTC. */
export function readZone(cookieHeader: string | null | undefined, cfTimezone: unknown): string {
  const chosen = cookie(cookieHeader, ZONE_COOKIE);
  if (validZone(chosen)) return chosen;
  return validZone(cfTimezone) ? cfTimezone : "UTC";
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

/** The wall-clock parts of a moment in a zone. */
function parts(date: Date, tz: string) {
  const got = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(got.year), month: Number(got.month), day: Number(got.day), hh: String(got.hour).padStart(2, "0"), mm: got.minute };
}

/** "6 Oct 2026, 00:25 PDT". */
export function timeIn(at: string | Date, tz = "UTC"): string {
  const date = new Date(at);
  const p = parts(date, tz);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${p.hh}:${p.mm} ${zoneAbbr(date, tz)}`;
}

/** "6 Oct 00:25 PDT": shorter, for lines that already say the year. */
export function stampIn(at: string | Date, tz = "UTC"): string {
  const date = new Date(at);
  const p = parts(date, tz);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.hh}:${p.mm} ${zoneAbbr(date, tz)}`;
}
