/**
 * Sending a project's telemetry on, as it arrives, to any OTLP/HTTP
 * endpoint it names (a collector, or a vendor that takes OTLP): rows back
 * into OTLP/JSON. Requests go as server spans (and their logs as log
 * records), so wherever they land shows them as it shows any service.
 */
import { TELEMETRY_OTLP_ENDPOINT, type AttributeValue, type Attributes, type TelemetryExport, type TelemetryLog, type TelemetryOrigin, type TelemetryRequest, type TelemetrySpan } from "@g1t/contracts/telemetry";

import type { Batch, MetricPoint } from "./batch.ts";

type KeyValue = { key: string; value: unknown };

function anyValue(v: AttributeValue): unknown {
  if (v === null) return {};
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { kvlistValue: { values: kvs(v) } };
}

function kvs(a: Attributes): KeyValue[] {
  return Object.entries(a).map(([key, value]) => ({ key, value: anyValue(value) }));
}

const nanos = (us: number) => `${Math.round(us)}000`;

function resourceOf(o: TelemetryOrigin): { attributes: KeyValue[] } {
  const a: Attributes = { "service.name": o.service || "unknown_service", "g1t.source": o.source };
  if (o.environment) a["deployment.environment.name"] = o.environment;
  if (o.deployment_id) a["g1t.deployment.id"] = o.deployment_id;
  if (o.commit_sha) a["vcs.ref.head.revision"] = o.commit_sha;
  return { attributes: kvs(a) };
}

const originKey = (o: TelemetryOrigin) => [o.service, o.environment, o.deployment_id, o.commit_sha, o.source].join("\u0000");

/** Rows grouped by where they came from, as OTLP groups them by resource. */
function byResource<T extends TelemetryOrigin>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = originKey(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

const SCOPE = { name: "g1t", version: "1" };
const KIND = { unspecified: 0, internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;
const STATUS = { unset: 0, ok: 1, error: 2 } as const;

function requestSpan(r: TelemetryRequest) {
  const a: Attributes = { "faas.trigger": r.trigger, "g1t.request.id": r.id };
  if (r.method) a["http.request.method"] = r.method;
  if (r.url) a["url.full"] = `https://${r.url}`;
  if (r.route) a["http.route"] = r.route;
  if (r.status !== null) a["http.response.status_code"] = r.status;
  if (r.cpu_ms !== null) a["cloudflare.cpu_time_ms"] = r.cpu_ms;
  if (r.region) a["cloudflare.colo"] = r.region;
  if (r.country) a["client.geo.country_iso_code"] = r.country;
  a["cloudflare.outcome"] = r.outcome;
  const failed = r.error !== null || (r.status ?? 0) >= 500;
  return {
    traceId: r.trace_id ?? r.id.padStart(32, "0"),
    spanId: r.id,
    name: [r.method, r.route].filter(Boolean).join(" ") || r.trigger,
    kind: KIND.server,
    startTimeUnixNano: nanos(r.time_us),
    endTimeUnixNano: nanos(r.time_us + r.duration_us),
    attributes: kvs(a),
    status: failed ? { code: STATUS.error, message: r.error?.message ?? "" } : { code: STATUS.unset },
  };
}

function span(s: TelemetrySpan) {
  return {
    traceId: s.trace_id,
    spanId: s.span_id,
    parentSpanId: s.parent_span_id ?? undefined,
    name: s.name,
    kind: KIND[s.kind],
    startTimeUnixNano: nanos(s.start_us),
    endTimeUnixNano: nanos(s.start_us + s.duration_us),
    attributes: kvs(s.attributes),
    events: s.events.map((e) => ({ timeUnixNano: nanos(e.time_us), name: e.name, attributes: kvs(e.attributes) })),
    links: s.links.map((l) => ({ traceId: l.trace_id, spanId: l.span_id })),
    status: { code: STATUS[s.status], message: s.status_message ?? undefined },
  };
}

function log(l: TelemetryLog) {
  const a = { ...l.attributes };
  if (l.request_id) a["g1t.request.id"] = l.request_id;
  return {
    timeUnixNano: nanos(l.time_us),
    severityNumber: l.severity_number,
    severityText: l.severity.toUpperCase(),
    body: { stringValue: l.body },
    attributes: kvs(a),
    traceId: l.trace_id ?? undefined,
    spanId: l.span_id ?? undefined,
  };
}

function metric(m: MetricPoint) {
  const point = { attributes: kvs(m.attributes), timeUnixNano: nanos(m.time_us) };
  const base = { name: m.name, unit: m.unit, description: m.description };
  switch (m.kind) {
    case "gauge":
      return { ...base, gauge: { dataPoints: [{ ...point, asDouble: m.value ?? 0 }] } };
    case "sum":
      return { ...base, sum: { dataPoints: [{ ...point, asDouble: m.value ?? 0 }], aggregationTemporality: m.monotonic ? 2 : 1, isMonotonic: m.monotonic } };
    case "histogram":
      return {
        ...base,
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [{ ...point, count: String(m.count ?? 0), sum: m.sum ?? undefined, min: m.min ?? undefined, max: m.max ?? undefined, explicitBounds: m.bounds ?? [], bucketCounts: (m.counts ?? []).map(String) }],
        },
      };
    case "summary":
      return { ...base, summary: { dataPoints: [{ ...point, count: String(m.count ?? 0), sum: m.sum ?? 0, quantileValues: (m.quantiles ?? []).map((q) => ({ quantile: q.q, value: q.v })) }] } };
  }
}

/** The OTLP/JSON bodies a batch makes, by signal; a signal with nothing in it is absent. */
export function otlpBodies(batch: Batch, requests: TelemetryRequest[]): { traces?: object; logs?: object; metrics?: object } {
  const out: { traces?: object; logs?: object; metrics?: object } = {};
  type Traced = (TelemetryOrigin & { span: object });
  const traced: Traced[] = [
    ...requests.map((r) => ({ ...r, span: requestSpan(r) })),
    ...batch.spans.map((s) => ({ ...s, span: span(s) })),
  ];
  if (traced.length) {
    out.traces = { resourceSpans: byResource(traced).map((g) => ({ resource: resourceOf(g[0]), scopeSpans: [{ scope: SCOPE, spans: g.map((t) => t.span) }] })) };
  }
  if (batch.logs.length) {
    out.logs = { resourceLogs: byResource(batch.logs).map((g) => ({ resource: resourceOf(g[0]), scopeLogs: [{ scope: SCOPE, logRecords: g.map(log) }] })) };
  }
  if (batch.metrics.length) {
    out.metrics = { resourceMetrics: byResource(batch.metrics).map((g) => ({ resource: resourceOf(g[0]), scopeMetrics: [{ scope: SCOPE, metrics: g.map(metric) }] })) };
  }
  return out;
}

/**
 * Whether an export's address is one telemetry may be sent to: https, and
 * not g1t's own ingest (which would loop) or an address on a private network.
 */
export function exportEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  const host = url.hostname.toLowerCase();
  if (host === new URL(TELEMETRY_OTLP_ENDPOINT).hostname) return "That is g1t's own endpoint: it would send everything back here.";
  if (host === "localhost" || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".internal") || host.startsWith("[")) {
    return "The address must be reachable on the internet.";
  }
  return null;
}

/** Sends one signal's body to an export; the error, or null. */
export async function send(target: Pick<TelemetryExport, "endpoint"> & { headers: Record<string, string> }, signal: "traces" | "logs" | "metrics", body: object): Promise<string | null> {
  const base = target.endpoint.replace(/\/+$/, "");
  const url = /\/v1\/(traces|logs|metrics)$/.test(base) ? base.replace(/(traces|logs|metrics)$/, signal) : `${base}/v1/${signal}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...target.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return null;
    return `${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  } catch (error) {
    return `${url} could not be reached: ${String(error).replace(/^Error: /, "")}`;
  }
}
