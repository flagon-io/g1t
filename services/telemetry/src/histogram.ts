/**
 * Durations kept as counts in fixed buckets, so a minute's latency (or
 * CPU) is a short list of numbers that adds to any other minute's, and
 * percentiles over any period come from the sum. Each bucket is read back
 * as a point between its bounds, which keeps a percentile within the
 * bucket's width of the true one: a few percent here, as bounds go up in
 * steps of about 1.5×.
 */
import type { Percentiles } from "@g1t/contracts/telemetry";

/** Upper bounds, in milliseconds; the last bucket holds everything above the last bound. */
export const BOUNDS_MS = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 30000, 60000,
];

export const BUCKETS = BOUNDS_MS.length + 1;

export function bucketOf(ms: number): number {
  let i = 0;
  while (i < BOUNDS_MS.length && ms > BOUNDS_MS[i]) i++;
  return i;
}

export function emptyHistogram(): number[] {
  return new Array(BUCKETS).fill(0);
}

export function addInto(into: number[], from: readonly number[]): number[] {
  for (let i = 0; i < BUCKETS; i++) into[i] = (into[i] ?? 0) + (from[i] ?? 0);
  return into;
}

/** A histogram as stored: counts joined by commas, trailing zeros dropped. */
export function encode(counts: readonly number[]): string {
  let end = counts.length;
  while (end > 0 && !counts[end - 1]) end--;
  return counts.slice(0, end).join(",");
}

export function decode(text: string | null | undefined): number[] {
  const out = emptyHistogram();
  if (!text) return out;
  text.split(",").forEach((n, i) => {
    if (i < BUCKETS) out[i] = Number(n) || 0;
  });
  return out;
}

/** The value at quantile `q` (0–1), interpolated within its bucket. */
export function quantile(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const n = counts[i] ?? 0;
    if (!n) continue;
    if (seen + n >= rank) {
      const low = i === 0 ? 0 : BOUNDS_MS[i - 1];
      const high = i < BOUNDS_MS.length ? BOUNDS_MS[i] : BOUNDS_MS[BOUNDS_MS.length - 1] * 2;
      const within = n === 0 ? 0 : (rank - seen) / n;
      return Math.round((low + (high - low) * within) * 100) / 100;
    }
    seen += n;
  }
  return BOUNDS_MS[BOUNDS_MS.length - 1];
}

export function percentiles(counts: readonly number[]): Percentiles {
  return { p50: quantile(counts, 0.5), p75: quantile(counts, 0.75), p95: quantile(counts, 0.95), p99: quantile(counts, 0.99) };
}
