/**
 * What a workspace's projects may send, and what past it costs.
 *
 * Every workspace has `FREE_TELEMETRY_BYTES_PER_MONTH` (1 GiB, a wrangler
 * var; `0` is no cap) a month across all its projects, counted by the
 * workspace's meter (./meter.ts). A workspace without the g1t plan is held
 * to it a day at a time, as a thirtieth of it, so a burst cannot spend the
 * month in an hour. Past a day's share, OTLP is answered `429` until
 * midnight UTC, and Cloudflare's tail events of its apps keep their
 * requests (what the charts are counted from) without their logs. When
 * billing cannot say which plan the workspace is on, the plan it last
 * said holds, and a workspace it never said anything about is free.
 *
 * A workspace on the plan is never refused: what all its projects send
 * past the free amount is charged by the GB (the price book's
 * `telemetry_gb`), reported to billing through the month (`note_pending`,
 * source `telemetry`) and charged once the month is over.
 *
 * Bytes are what arrived: an OTLP body once unzipped, and a tail event's
 * rows as they are kept.
 */

export const DEFAULT_FREE_TELEMETRY_BYTES_PER_MONTH = 1024 * 1024 * 1024;
const DAYS_PER_MONTH = 30;

/** A gigabyte, as Cloudflare bills and the price book prices `telemetry_gb`. */
export const GB = 1_000_000_000;

/**
 * What a GB past the free amount costs g1t when the price book cannot be
 * read: $8.50 (services/billing migration 0059 says how it is made up).
 */
export const TELEMETRY_MICROS_PER_GB = 8_500_000;

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

/** Which plan a workspace is on, as far as the cap goes. */
export type Standing = "free" | "paid" | "held";

/**
 * A workspace's daily cap: a held workspace takes nothing (0), a free one
 * its day's share, one on the plan none. Unknown is free.
 */
export function capOf(standing: Standing | null, daily: number | null): number | null {
  if (standing === "held") return 0;
  if (standing === "paid") return null;
  return daily;
}

/**
 * Whether `adding` more bytes today would go past `cap`. A cap of 0 takes
 * nothing: a workspace g1t staff put a hold on (or suspended).
 */
export function overCap(today: number, adding: number, cap: number | null | undefined): boolean {
  return cap != null && cap >= 0 && today + adding > cap;
}

/** What a month's `bytes` cost g1t past the free amount, at `microsPerGb`, rounded up. */
export function telemetryCost(bytes: number, freeBytes: number, microsPerGb: number): number {
  const past = Math.max(0, bytes - Math.max(0, freeBytes));
  return Math.ceil((past / GB) * microsPerGb);
}

/** How much was sent, for the Billing page: `2.40 GB sent, 1.07 GB free`. */
export function telemetryDetail(bytes: number, freeBytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB sent, ${(freeBytes / GB).toFixed(2)} GB free`;
}

/** The size of a row as it is kept: its JSON. */
export function sizeOf(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** What OTLP past the day's share is told; with a cap of 0, that the workspace is held. */
export function overCapMessage(cap: number): string {
  if (cap === 0)
    return "g1t staff put a hold on this project's workspace, so its telemetry is not taken. Write to hey@flagon.io if you think this is a mistake.";
  const mb = Math.round(cap / (1024 * 1024));
  return `This project's workspace has sent its ${mb} MB for today across its projects, a workspace on the free plan's daily share of its monthly observability. Send less, or start the g1t plan; more is taken from 00:00 UTC.`;
}
