/**
 * Observability: what a project's running software did, as requests, logs,
 * traces and metrics. The telemetry service (`services/telemetry`) keeps
 * one store per project (a Durable Object with its own SQLite), filled from
 * two doors:
 *
 * - **Deployments on g1t.page**, with nothing to set up: every app the
 *   deployments service uploads names the telemetry service as its Tail
 *   Worker, so each request it answers arrives with its logs, exceptions,
 *   status, CPU and wall time. Its tags (`TELEMETRY_TAG`) say which project
 *   and deployment it belongs to.
 * - **OpenTelemetry (OTLP over HTTP)** from anywhere, in JSON or protobuf:
 *   `https://otel.g1t.sh/v1/{traces,logs,metrics}` with a project's ingest
 *   token. Apps on g1t.page get the endpoint and a token as
 *   `OTEL_EXPORTER_OTLP_*` variables, so an OpenTelemetry SDK in them sends
 *   spans without configuration; software hosted anywhere else sends the
 *   same way.
 *
 * Wire shapes are snake_case end to end. Times are microseconds since the
 * Unix epoch (`*_us`): exact enough for spans, and safe in a JSON number.
 */
import type { ServiceBinding } from "./clients";

/** Where telemetry is sent from outside: OTLP's base, under which SDKs add `/v1/traces` and so on. */
export const TELEMETRY_OTLP_ENDPOINT = "https://otel.g1t.sh";

/** The prefix of a project's ingest token, so a leaked one is recognisable. */
export const TELEMETRY_TOKEN_PREFIX = "g1to_";

/**
 * The tags each app on g1t.page carries for its telemetry (script tags in
 * the dispatch namespace; they arrive with every tail event):
 * `g1t-p:<project id>` and `g1t-d:<deployment id>`. The environment is
 * the tag `production` or `preview` the app already has.
 */
export const TELEMETRY_TAG = { project: "g1t-p:", deployment: "g1t-d:" } as const;

/** Where a record came from: an app on g1t.page, or OTLP from an SDK or a collector. */
export type TelemetrySource = "cloudflare" | "otlp";

/** Log levels, as OpenTelemetry's severity numbers group them. */
export type LogSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export const LOG_SEVERITIES: readonly LogSeverity[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** An attribute's value, as OpenTelemetry allows: arrays and maps flattened to JSON where they nest. */
export type AttributeValue = string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue };
export type Attributes = Record<string, AttributeValue>;

/**
 * What every record is filed under: which software sent it (`service`,
 * OpenTelemetry's `service.name`; an app on g1t.page is its project's
 * name), where it ran (`environment`: production, preview, or what
 * `deployment.environment.name` said) and, on g1t.page, which deployment.
 */
export type TelemetryOrigin = {
  service: string;
  environment: string | null;
  deployment_id: string | null;
  /** The commit it was built from, when known (`vcs.ref.head.revision` or the deployment's). */
  commit_sha: string | null;
  source: TelemetrySource;
};

/**
 * One request (or other invocation) an app on g1t.page answered: the tail
 * event, with the logs it wrote under it. Also made from each server span
 * sent over OTLP that has no parent here, so software hosted elsewhere
 * shows the same numbers.
 */
export type TelemetryRequest = TelemetryOrigin & {
  id: string;
  time_us: number;
  duration_us: number;
  /** fetch, scheduled, queue, alarm, email, rpc or other. */
  trigger: string;
  method: string | null;
  /** Host and path, without the query. */
  url: string | null;
  /** The path with ids taken out (`/users/:id`), what the numbers group by. */
  route: string | null;
  status: number | null;
  /** ok, exception, exceededCpu, canceled and the rest, as Cloudflare says; ok or error over OTLP. */
  outcome: string;
  cpu_ms: number | null;
  /** Where it ran: Cloudflare's colo, or `cloud.region`. */
  region: string | null;
  country: string | null;
  trace_id: string | null;
  /** How many log lines it wrote; `logs` fills them in on the request's own page. */
  log_count: number;
  error: { name: string; message: string } | null;
};

export type TelemetryLog = TelemetryOrigin & {
  id: string;
  time_us: number;
  severity: LogSeverity;
  /** OpenTelemetry's 1–24. */
  severity_number: number;
  body: string;
  trace_id: string | null;
  span_id: string | null;
  /** The request it was written under, for an app on g1t.page. */
  request_id: string | null;
  attributes: Attributes;
};

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

export type TelemetrySpan = TelemetryOrigin & {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_us: number;
  duration_us: number;
  status: SpanStatus;
  status_message: string | null;
  attributes: Attributes;
  resource: Attributes;
  events: { time_us: number; name: string; attributes: Attributes }[];
  links: { trace_id: string; span_id: string }[];
};

/** A trace in a list: its root (or earliest) span, and what the rest add up to. */
export type TraceSummary = TelemetryOrigin & {
  trace_id: string;
  name: string;
  start_us: number;
  duration_us: number;
  span_count: number;
  error_count: number;
  services: string[];
  status: number | null;
};

export type TraceDetail = {
  trace_id: string;
  spans: TelemetrySpan[];
  logs: TelemetryLog[];
};

export type MetricKind = "gauge" | "sum" | "histogram" | "summary";

export type MetricInfo = {
  name: string;
  kind: MetricKind;
  unit: string;
  description: string;
  services: string[];
  last_us: number;
};

/** A metric over time: one value per step, by the attribute it was grouped by. */
export type MetricSeries = {
  name: string;
  unit: string;
  step_s: number;
  series: { group: string | null; points: { time_us: number; value: number | null }[] }[];
};

/** The latency (and CPU) percentiles of a set of requests, in milliseconds. */
export type Percentiles = { p50: number | null; p75: number | null; p95: number | null; p99: number | null };

/** One step of the overview's charts. */
export type TelemetryPoint = {
  time_us: number;
  requests: number;
  errors: number;
  status_2xx: number;
  status_3xx: number;
  status_4xx: number;
  status_5xx: number;
  latency: Percentiles;
  cpu: Percentiles;
};

/** Numbers for a period, and the same for the one before it, to compare. */
export type TelemetryTotals = {
  requests: number;
  errors: number;
  error_rate: number;
  latency: Percentiles;
  cpu: Percentiles;
};

export type TelemetryOverview = {
  from_us: number;
  to_us: number;
  step_s: number;
  totals: TelemetryTotals;
  previous: TelemetryTotals;
  points: TelemetryPoint[];
  routes: { route: string; method: string | null; requests: number; errors: number; latency: Percentiles }[];
  /** Each deployment's numbers over the period, newest first: a regression points at the deployment it began with. */
  deployments: { deployment_id: string; environment: string | null; commit_sha: string | null; first_us: number; requests: number; errors: number; latency: Percentiles }[];
  services: { service: string; source: TelemetrySource; requests: number; errors: number; last_us: number }[];
  regions: { region: string; requests: number }[];
};

/**
 * Errors, grouped: the same exception (name, message with its numbers and
 * ids taken out, and the top frame of its stack) is one group.
 */
export type ErrorGroup = {
  fingerprint: string;
  name: string;
  message: string;
  stack: string | null;
  service: string;
  environment: string | null;
  first_us: number;
  last_us: number;
  count: number;
  /** The deployment it was first seen on: what likely brought it in. */
  first_deployment_id: string | null;
  last_request_id: string | null;
  last_trace_id: string | null;
  /** resolved, ignored or open. A resolved group that happens again opens again. */
  state: "open" | "resolved" | "ignored";
  /** The issue made for it, so an agent can take it. */
  issue_number: number | null;
};

/** What every list query can narrow by. */
export type TelemetryFilter = {
  from_us?: number | null;
  to_us?: number | null;
  services?: string[] | null;
  environments?: string[] | null;
  deployment_id?: string | null;
  source?: TelemetrySource | null;
};

export type LogQuery = TelemetryFilter & {
  /** Words to find in the body (all of them), or a phrase in quotes. */
  text?: string | null;
  severities?: LogSeverity[] | null;
  trace_id?: string | null;
  request_id?: string | null;
  /** Where to carry on from: the last page's `next`. */
  cursor?: string | null;
  limit?: number | null;
};

export type RequestQuery = TelemetryFilter & {
  text?: string | null;
  /** 2xx, 3xx, 4xx, 5xx, or a status. */
  status?: string[] | null;
  /** Only those that failed: a 5xx, or an outcome other than ok. */
  errors_only?: boolean | null;
  route?: string | null;
  min_duration_ms?: number | null;
  cursor?: string | null;
  limit?: number | null;
};

export type TraceQuery = TelemetryFilter & {
  text?: string | null;
  errors_only?: boolean | null;
  min_duration_ms?: number | null;
  cursor?: string | null;
  limit?: number | null;
};

export type Page<T> = { items: T[]; next: string | null };

/** A project's ingest token, as listed: the secret itself is shown once, when made. */
export type IngestToken = {
  id: string;
  name: string;
  /** The first characters, to tell tokens apart. */
  hint: string;
  created_by: string | null;
  created_us: number;
  last_used_us: number | null;
  /** Made by g1t for its deployments; replaced on its own, not by people. */
  managed: boolean;
};

/**
 * Where a project's telemetry is also sent, as it arrives: any OTLP/HTTP
 * endpoint (a collector, or a vendor that takes OTLP), with the headers it
 * needs. Header values are secrets: written, never read back.
 */
export type TelemetryExport = {
  id: string;
  name: string;
  endpoint: string;
  /** Which signals go: traces, logs (with requests as log records) and metrics. */
  signals: ("traces" | "logs" | "metrics")[];
  header_names: string[];
  enabled: boolean;
  last_error: string | null;
  last_sent_us: number | null;
};

export type TelemetrySettings = {
  /** Days requests, logs and spans are kept. Charts are kept longer, as per-minute counts. */
  retention_days: number;
  /** Whether apps on g1t.page send. On by default; off keeps the tokens and history. */
  deployments: boolean;
};

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = { retention_days: 7, deployments: true };

/** Retention a project can choose, in days. */
export const RETENTION_CHOICES = [1, 3, 7, 14, 30] as const;

/** How much a project has stored and sent this month, for the page and for billing. */
export type TelemetryUsage = {
  month: string;
  /** Bytes received, after decoding: what ingest is metered by. */
  ingested_bytes: number;
  requests: number;
  logs: number;
  spans: number;
  metric_points: number;
  stored_bytes: number;
  /** Bytes received today (UTC): a workspace without the plan sends a thirtieth of its monthly observability a day. */
  today_bytes?: number;
};

/** Whom a call is for: the site and the API check access before they ask. */
type ProjectRef = { project_id: string; /** The project's workspace, by slug: the store remembers it, for a free workspace's cap. */ workspace?: string };

export interface TelemetryApi {
  overview(args: ProjectRef & TelemetryFilter & { step_s?: number | null }): Promise<TelemetryOverview>;
  requests(args: ProjectRef & RequestQuery): Promise<Page<TelemetryRequest>>;
  request(args: ProjectRef & { id: string }): Promise<{ request: TelemetryRequest; logs: TelemetryLog[] } | null>;
  logs(args: ProjectRef & LogQuery): Promise<Page<TelemetryLog>>;
  traces(args: ProjectRef & TraceQuery): Promise<Page<TraceSummary>>;
  trace(args: ProjectRef & { trace_id: string }): Promise<TraceDetail | null>;
  errors(args: ProjectRef & TelemetryFilter & { state?: ErrorGroup["state"] | null }): Promise<ErrorGroup[]>;
  setError(args: ProjectRef & { fingerprint: string; state?: ErrorGroup["state"]; issue_number?: number | null }): Promise<ErrorGroup | null>;
  metrics(args: ProjectRef): Promise<MetricInfo[]>;
  metric(args: ProjectRef & TelemetryFilter & { name: string; aggregate?: "avg" | "sum" | "min" | "max" | "p50" | "p95" | "p99" | null; group_by?: string | null; step_s?: number | null }): Promise<MetricSeries>;
  /** What is in the store: services, environments and attribute keys seen, for filters. */
  facets(args: ProjectRef): Promise<{ services: string[]; environments: string[]; attribute_keys: string[] }>;
  settings(args: ProjectRef): Promise<TelemetrySettings>;
  setSettings(args: ProjectRef & Partial<TelemetrySettings>): Promise<TelemetrySettings>;
  tokens(args: ProjectRef): Promise<IngestToken[]>;
  createToken(args: ProjectRef & { name: string; created_by: string }): Promise<{ token: IngestToken; secret: string }>;
  revokeToken(args: ProjectRef & { id: string }): Promise<boolean>;
  /**
   * The token g1t's own deployments of the project send with, made the
   * first time: the deployments service binds it to each app it uploads.
   */
  deploymentToken(args: ProjectRef): Promise<{ secret: string }>;
  exports(args: ProjectRef): Promise<TelemetryExport[]>;
  putExport(args: ProjectRef & { id?: string | null; name: string; endpoint: string; signals: TelemetryExport["signals"]; headers?: Record<string, string> | null; enabled: boolean }): Promise<TelemetryExport>;
  deleteExport(args: ProjectRef & { id: string }): Promise<boolean>;
  usage(args: ProjectRef): Promise<TelemetryUsage>;
  /** Everything kept for a project, gone: when the project is deleted. */
  purge(args: ProjectRef): Promise<boolean>;
}

/**
 * The site's live tail: `GET /live?project_id=…` on the service, a
 * WebSocket the site opens after checking the viewer may read the
 * project. Each message is one `LiveItem`.
 */
export type LiveItem =
  | { type: "request"; request: TelemetryRequest }
  | { type: "log"; log: TelemetryLog }
  | { type: "span"; span: TelemetrySpan };

async function call<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`telemetry ${method} failed with status ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export function telemetryClient(service: ServiceBinding): TelemetryApi {
  const c = <T>(method: string) => (args: object) => call<T>(service, method, args);
  return {
    overview: c("overview"),
    requests: c("requests"),
    request: c("request"),
    logs: c("logs"),
    traces: c("traces"),
    trace: c("trace"),
    errors: c("errors"),
    setError: c("set_error"),
    metrics: c("metrics"),
    metric: c("metric"),
    facets: c("facets"),
    settings: c("settings"),
    setSettings: c("set_settings"),
    tokens: c("tokens"),
    createToken: c("create_token"),
    revokeToken: c("revoke_token"),
    deploymentToken: c("deployment_token"),
    exports: c("exports"),
    putExport: c("put_export"),
    deleteExport: c("delete_export"),
    usage: c("usage"),
    purge: c("purge"),
  };
}
