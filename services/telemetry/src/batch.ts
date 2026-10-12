/**
 * What one delivery adds to a project's store: rows already in the shape
 * they are kept in, whichever door they came through (./tail.ts for apps
 * on g1t.page, ./otlp/normalize.ts for OTLP).
 */
import type { Attributes, MetricKind, TelemetryLog, TelemetryOrigin, TelemetryRequest, TelemetrySpan } from "@g1t/contracts/telemetry";

export type MetricPoint = TelemetryOrigin & {
  name: string;
  kind: MetricKind;
  unit: string;
  description: string;
  time_us: number;
  /** A gauge's or a sum's value; a histogram's or a summary's mean. */
  value: number | null;
  count: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  /** A histogram's buckets: `bounds.length + 1` counts. */
  bounds: number[] | null;
  counts: number[] | null;
  /** A summary's quantiles. */
  quantiles: { q: number; v: number }[] | null;
  /** Cumulative sums are kept as sent and turned into rates when read. */
  monotonic: boolean;
  attributes: Attributes;
};

/** One exception seen, before it is grouped (./errors.ts). */
export type ErrorSeen = TelemetryOrigin & {
  time_us: number;
  name: string;
  message: string;
  stack: string | null;
  request_id: string | null;
  trace_id: string | null;
};

export type Batch = {
  requests: TelemetryRequest[];
  logs: TelemetryLog[];
  spans: TelemetrySpan[];
  metrics: MetricPoint[];
  errors: ErrorSeen[];
  /** What it weighed on arrival, for metering. */
  bytes: number;
};

export function emptyBatch(): Batch {
  return { requests: [], logs: [], spans: [], metrics: [], errors: [], bytes: 0 };
}

export function batchSize(batch: Batch): number {
  return batch.requests.length + batch.logs.length + batch.spans.length + batch.metrics.length;
}
