/**
 * OTLP export requests (in their JSON shape, which ./proto.ts also gives
 * for protobuf) as rows for a project's store.
 *
 * Each record is filed by its resource: `service.name` names the service,
 * `deployment.environment.name` (or the older `deployment.environment`)
 * the environment, `g1t.deployment.id` the deployment on g1t.page, and
 * `vcs.ref.head.revision` the commit. Every server span is also a request,
 * so software hosted anywhere gets the same request numbers apps on
 * g1t.page get from their tail events; exceptions recorded on spans (the
 * `exception` event) and in logs (`exception.*` attributes) are errors.
 */
import type { AttributeValue, Attributes, SpanKind, SpanStatus, TelemetryOrigin, TelemetrySource } from "@g1t/contracts/telemetry";

import { emptyBatch, type Batch, type MetricPoint } from "../batch.ts";
import { MAX_VALUE, clip, hexId, hostPath, nanosToMicros, randomId, route, severityNumber, severityOf } from "../shape.ts";
import type {
  AnyValueJson,
  HistogramPointJson,
  KeyValueJson,
  LogsRequestJson,
  MetricJson,
  MetricsRequestJson,
  NumberPointJson,
  ResourceJson,
  SummaryPointJson,
  TracesRequestJson,
} from "./proto.ts";

/** What the door the records came through says about them, over what they say themselves. */
export type Door = {
  source: TelemetrySource;
  /**
   * For Cloudflare's own export: the app's deployment, found from its
   * script name. `undefined` keeps what the resource says; `null` skips
   * the resource (another project's).
   */
  origin?: (resource: Attributes) => Partial<TelemetryOrigin> | null | undefined;
  /** Whether server spans count as requests: not when the tail event already counted them. */
  countRequests: boolean;
};

export const OTLP_DOOR: Door = { source: "otlp", countRequests: true };

const MAX_ATTRIBUTES = 128;

/** An OTLP value as a plain one. Integers beyond a double's range keep their digits as a string. */
export function value(v: AnyValueJson | undefined): AttributeValue {
  if (!v) return null;
  if ("stringValue" in v) return clip(String(v.stringValue), MAX_VALUE);
  if ("boolValue" in v) return Boolean(v.boolValue);
  if ("intValue" in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).slice(0, 64).map(value);
  if ("kvlistValue" in v) return attributes(v.kvlistValue?.values);
  if ("bytesValue" in v) return String(v.bytesValue);
  return null;
}

export function attributes(list: KeyValueJson[] | undefined): Attributes {
  const out: Attributes = {};
  for (const kv of (list ?? []).slice(0, MAX_ATTRIBUTES)) if (kv?.key) out[kv.key] = value(kv.value);
  return out;
}

function str(a: Attributes, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = a[key];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function num(a: Attributes, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = a[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Where a resource's records are filed. */
export function originOf(resource: ResourceJson | undefined, door: Door): { origin: TelemetryOrigin; resource: Attributes } | null {
  const r = attributes(resource?.attributes);
  const origin: TelemetryOrigin = {
    service: str(r, "service.name") ?? "unknown_service",
    environment: str(r, "deployment.environment.name", "deployment.environment"),
    deployment_id: str(r, "g1t.deployment.id"),
    commit_sha: str(r, "vcs.ref.head.revision", "g1t.commit.sha"),
    source: door.source,
  };
  const over = door.origin ? door.origin(r) : undefined;
  if (over === null) return null;
  return { origin: { ...origin, ...(over ?? {}) }, resource: r };
}

const KINDS: SpanKind[] = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const STATUSES: SpanStatus[] = ["unset", "ok", "error"];

function kindOf(kind: number | string | undefined): SpanKind {
  if (typeof kind === "string") {
    const name = kind.replace(/^SPAN_KIND_/, "").toLowerCase() as SpanKind;
    return KINDS.includes(name) ? name : "unspecified";
  }
  return KINDS[kind ?? 0] ?? "unspecified";
}

function statusOf(code: number | string | undefined): SpanStatus {
  if (typeof code === "string") {
    const name = code.replace(/^STATUS_CODE_/, "").toLowerCase() as SpanStatus;
    return STATUSES.includes(name) ? name : "unset";
  }
  return STATUSES[code ?? 0] ?? "unset";
}

export function readTraces(body: TracesRequestJson, door: Door, bytes: number): Batch {
  const batch = emptyBatch();
  batch.bytes = bytes;
  for (const rs of body.resourceSpans ?? []) {
    const found = originOf(rs.resource, door);
    if (!found) continue;
    const { origin, resource } = found;
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const traceId = hexId(s.traceId, 32);
        const spanId = hexId(s.spanId, 16);
        const start = nanosToMicros(s.startTimeUnixNano);
        if (!traceId || !spanId || start === null) continue;
        const end = nanosToMicros(s.endTimeUnixNano) ?? start;
        const attrs = attributes(s.attributes);
        const kind = kindOf(s.kind);
        const status = statusOf(s.status?.code);
        const events = (s.events ?? []).slice(0, 128).map((e) => ({
          time_us: nanosToMicros(e.timeUnixNano) ?? start,
          name: e.name ?? "",
          attributes: attributes(e.attributes),
        }));
        const span = {
          ...origin,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: hexId(s.parentSpanId, 16),
          name: clip(s.name || "(unnamed)", 512),
          kind,
          start_us: start,
          duration_us: Math.max(0, end - start),
          status,
          status_message: s.status?.message ? clip(s.status.message, 2048) : null,
          attributes: attrs,
          resource,
          events,
          links: (s.links ?? []).flatMap((l) => {
            const t = hexId(l.traceId, 32);
            const p = hexId(l.spanId, 16);
            return t && p ? [{ trace_id: t, span_id: p }] : [];
          }),
        };
        batch.spans.push(span);

        for (const e of events) {
          if (e.name !== "exception") continue;
          batch.errors.push({
            ...origin,
            time_us: e.time_us,
            name: str(e.attributes, "exception.type") ?? "Error",
            message: str(e.attributes, "exception.message") ?? span.status_message ?? "",
            stack: str(e.attributes, "exception.stacktrace"),
            request_id: kind === "server" ? spanId : null,
            trace_id: traceId,
          });
        }

        // An app on g1t.page has its requests counted from its tail events.
        if (door.countRequests && kind === "server" && !origin.deployment_id) {
          const status = num(attrs, "http.response.status_code", "http.status_code");
          const full = str(attrs, "url.full", "http.url");
          const where = full ? hostPath(full) : null;
          const path = str(attrs, "url.path", "http.target") ?? where?.path ?? null;
          const host = str(attrs, "server.address", "http.host", "net.host.name");
          const failed = span.status === "error" || (status !== null && status >= 500);
          batch.requests.push({
            ...origin,
            id: spanId,
            time_us: start,
            duration_us: span.duration_us,
            trigger: str(attrs, "faas.trigger") ?? (path || status !== null ? "fetch" : "other"),
            method: str(attrs, "http.request.method", "http.method"),
            url: where?.url ?? (path ? `${host ?? ""}${path.split("?")[0]}` : null),
            route: str(attrs, "http.route") ?? (path ? route(path) : span.name),
            status: status === null ? null : Math.trunc(status),
            outcome: failed ? "error" : "ok",
            cpu_ms: null,
            region: str(resource, "cloud.region") ?? str(attrs, "cloud.region"),
            country: null,
            trace_id: traceId,
            log_count: 0,
            error: failed ? { name: str(attrs, "error.type") ?? "Error", message: span.status_message ?? (status ? `HTTP ${status}` : "") } : null,
          });
        }
      }
    }
  }
  return batch;
}

export function readLogs(body: LogsRequestJson, door: Door, bytes: number): Batch {
  const batch = emptyBatch();
  batch.bytes = bytes;
  for (const rl of body.resourceLogs ?? []) {
    const found = originOf(rl.resource, door);
    if (!found) continue;
    const { origin } = found;
    for (const sl of rl.scopeLogs ?? []) {
      for (const r of sl.logRecords ?? []) {
        const time = nanosToMicros(r.timeUnixNano) ?? nanosToMicros(r.observedTimeUnixNano) ?? Date.now() * 1000;
        const attrs = attributes(r.attributes);
        const number = r.severityNumber && r.severityNumber > 0 ? r.severityNumber : severityNumber(r.severityText);
        const raw = value(r.body);
        const body = typeof raw === "string" ? raw : raw === null ? (r.eventName ?? "") : JSON.stringify(raw);
        const traceId = hexId(r.traceId, 32);
        const spanId = hexId(r.spanId, 16);
        batch.logs.push({
          ...origin,
          id: randomId(),
          time_us: time,
          severity: severityOf(number),
          severity_number: number,
          body: clip(body),
          trace_id: traceId,
          span_id: spanId,
          request_id: null,
          attributes: attrs,
        });
        const type = str(attrs, "exception.type");
        const message = str(attrs, "exception.message");
        if (type || message) {
          batch.errors.push({
            ...origin,
            time_us: time,
            name: type ?? "Error",
            message: message ?? body,
            stack: str(attrs, "exception.stacktrace"),
            request_id: null,
            trace_id: traceId,
          });
        }
      }
    }
  }
  return batch;
}

export function readMetrics(body: MetricsRequestJson, door: Door, bytes: number): Batch {
  const batch = emptyBatch();
  batch.bytes = bytes;
  for (const rm of body.resourceMetrics ?? []) {
    const found = originOf(rm.resource, door);
    if (!found) continue;
    const { origin } = found;
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) batch.metrics.push(...points(m, origin));
    }
  }
  return batch;
}

function points(m: MetricJson, origin: TelemetryOrigin): MetricPoint[] {
  const name = m.name ?? "";
  if (!name) return [];
  const base = { ...origin, name, unit: m.unit ?? "", description: clip(m.description ?? "", 512) };
  const at = (p: { timeUnixNano?: string }) => nanosToMicros(p.timeUnixNano) ?? Date.now() * 1000;
  const empty = { count: null, sum: null, min: null, max: null, bounds: null, counts: null, quantiles: null };
  const number = (p: NumberPointJson) => (p.asDouble !== undefined ? Number(p.asDouble) : p.asInt !== undefined ? Number(p.asInt) : null);
  if (m.gauge) {
    return (m.gauge.dataPoints ?? []).map((p) => ({
      ...base,
      ...empty,
      kind: "gauge",
      time_us: at(p),
      value: number(p),
      monotonic: false,
      attributes: attributes(p.attributes),
    }));
  }
  if (m.sum) {
    // A delta sum is the amount in its interval; a cumulative one, the
    // total since its start. Both are kept as sent, with which it was.
    const cumulative = m.sum.aggregationTemporality === 2;
    return (m.sum.dataPoints ?? []).map((p) => ({
      ...base,
      ...empty,
      kind: "sum",
      time_us: at(p),
      value: number(p),
      monotonic: cumulative && Boolean(m.sum!.isMonotonic),
      attributes: attributes(p.attributes),
    }));
  }
  const histogram = (p: HistogramPointJson): MetricPoint => {
    const count = p.count !== undefined ? Number(p.count) : null;
    const sum = p.sum ?? null;
    return {
      ...base,
      kind: "histogram",
      time_us: at(p),
      value: count && sum !== null ? sum / count : null,
      count,
      sum,
      min: p.min ?? null,
      max: p.max ?? null,
      bounds: p.explicitBounds?.length ? p.explicitBounds.map(Number) : null,
      counts: p.bucketCounts?.length ? p.bucketCounts.map(Number) : null,
      quantiles: null,
      monotonic: false,
      attributes: attributes(p.attributes),
    };
  };
  if (m.histogram) return (m.histogram.dataPoints ?? []).map(histogram);
  if (m.exponentialHistogram) return (m.exponentialHistogram.dataPoints ?? []).map(histogram);
  if (m.summary) {
    return (m.summary.dataPoints ?? []).map((p: SummaryPointJson) => {
      const count = p.count !== undefined ? Number(p.count) : null;
      const sum = p.sum ?? null;
      return {
        ...base,
        ...empty,
        kind: "summary",
        time_us: at(p),
        value: count && sum !== null ? sum / count : null,
        count,
        sum,
        quantiles: (p.quantileValues ?? []).map((q) => ({ q: Number(q.quantile ?? 0), v: Number(q.value ?? 0) })),
        monotonic: false,
        attributes: attributes(p.attributes),
      };
    });
  }
  return [];
}
