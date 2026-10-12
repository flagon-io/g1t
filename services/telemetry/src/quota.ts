/**
 * What a project of a workspace without the g1t plan may send:
 * `FREE_TELEMETRY_BYTES_PER_MONTH` (1 GiB, a wrangler var; `0` is no cap),
 * held a day at a time as a thirtieth of it, so a burst cannot spend the
 * month in an hour. Past a day's share, OTLP is answered `429` until
 * midnight UTC, and Cloudflare's tail events of the project's apps keep
 * their requests (what the charts are counted from) without their logs.
 *
 * Bytes are what arrived: an OTLP body once unzipped, and a tail event's
 * rows as they are kept.
 */

export const DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH = 1024 * 1024 * 1024;
const DAYS_PER_MONTH = 30;

/** The monthly allowance from its var: the default when unset or not a whole number; 0 is none. */
export function freeMonthlyBytes(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  const value = Number(text);
  return text !== "" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH;
}

/** A day's share of a monthly allowance; null for none. */
export function dailyCap(monthly: number): number | null {
  return monthly > 0 ? Math.ceil(monthly / DAYS_PER_MONTH) : null;
}

/**
 * Whether `adding` more bytes today would go past `cap`. A cap of 0 takes
 * nothing: a workspace g1t staff put a hold on (or suspended).
 */
export function overCap(today: number, adding: number, cap: number | null | undefined): boolean {
  return cap != null && cap >= 0 && today + adding > cap;
}

/** The size of a row as it is kept: its JSON. */
export function sizeOf(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** What OTLP past the day's share is told; with a cap of 0, that the workspace is held. */
export function overCapMessage(cap: number): string {
  if (cap === 0) return "g1t staff put a hold on this project's workspace, so its telemetry is not taken. Write to hey@flagon.io if you think this is a mistake.";
  const mb = Math.round(cap / (1024 * 1024));
  return `This project has sent its ${mb} MB for today, a workspace on the free plan's daily share of its monthly observability. Send less, or start the g1t plan; more is taken from 00:00 UTC.`;
}
