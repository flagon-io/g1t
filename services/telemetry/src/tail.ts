/**
 * Tail events from g1t.page, as rows. Two Workers name this service as
 * their Tail Worker, and each tells half of a request:
 *
 * - **The dispatcher** (`services/pages`), in front of every app: it
 *   writes one `g1t-request` line per request (`REQUEST_MARK`) with the
 *   request's id, the app's script and the trace it began or continued,
 *   and its tail event has the status, the time taken, the method, the
 *   address and where in the world it was served. Every request is here,
 *   including those a site's files answered without running its code.
 * - **The app itself**, when its code ran: the logs it wrote, the
 *   exceptions it threw, its CPU time and outcome, and its tags
 *   (`TELEMETRY_TAG`: the project and the deployment). The dispatcher
 *   handed it the request's id (`x-g1t-request-id`) and a `traceparent`,
 *   which is how the halves meet, and how spans an OpenTelemetry SDK in
 *   the app sends join the request's trace.
 *
 * Halves arrive apart, in either order; the project's store merges them
 * by id (./store.ts). The dispatcher's half names the project the
 * deployments service noted for the app's hostname; when it had none yet,
 * the service looks the script up itself (./index.ts).
 */
import { TELEMETRY_TAG, type Attributes, type TelemetryLog, type TelemetryRequest } from "@g1t/contracts/telemetry";

import { emptyBatch, type Batch } from "./batch.ts";
import { clip, hostPath, randomId, route, severityNumber, severityOf, text } from "./shape.ts";

/** The first argument of the dispatcher's line for each request. */
export const REQUEST_MARK = "g1t-request";
/** The header the dispatcher hands each app with the request's id. */
export const REQUEST_ID_HEADER = "x-g1t-request-id";

/**
 * What the dispatcher's line says: the request, its app, and what the
 * deployments service noted for the app's hostname (`AppTelemetry` there),
 * when the dispatcher had it.
 */
export type RequestMark = {
  id: string;
  script: string;
  trace_id: string;
  app?: { project: string; deployment: string | null; environment: string | null; service: string; commit: string | null } | null;
};

/** A request's half, merged with the other half by id in the store. */
export type RequestHalf = Partial<TelemetryRequest> & { id: string; half: "edge" | "app" };

/** Rows for one project, or for one script whose project is not known yet. */
export type TailGroup = { project_id: string | null; script: string; batch: Batch; halves: RequestHalf[] };

/** What a tail event is about: its project and deployment from its tags. */
function tagged(tags: readonly string[] | undefined): { project_id: string | null; deployment_id: string | null; environment: string | null; service: string } {
  let service = "";
  let project_id: string | null = null;
  let deployment_id: string | null = null;
  let environment: string | null = null;
  for (const tag of tags ?? []) {
    if (tag.startsWith(TELEMETRY_TAG.project)) project_id = tag.slice(TELEMETRY_TAG.project.length);
    else if (tag.startsWith(TELEMETRY_TAG.deployment)) deployment_id = tag.slice(TELEMETRY_TAG.deployment.length);
    else if (tag === "production" || tag === "preview") environment = tag;
    // `project:<workspace>/<slug>`: the service is the project's name.
    else if (tag.startsWith("project:")) service = tag.slice(tag.indexOf("/") + 1);
  }
  return { project_id, deployment_id, environment, service };
}

function markOf(item: TraceItem): RequestMark | null {
  for (const log of item.logs) {
    const message = log.message as unknown;
    if (!Array.isArray(message) || message[0] !== REQUEST_MARK) continue;
    const mark = message[1] as Partial<RequestMark> | undefined;
    if (mark && typeof mark.id === "string" && typeof mark.script === "string") {
      const app = mark.app && typeof mark.app.project === "string" ? mark.app : null;
      return { id: mark.id, script: mark.script, trace_id: typeof mark.trace_id === "string" ? mark.trace_id : "", app };
    }
  }
  return null;
}

function fetchInfo(item: TraceItem): TraceItemFetchEventInfo | null {
  const event = item.event as TraceItemFetchEventInfo | null;
  return event && typeof event === "object" && "request" in event ? event : null;
}

function triggerOf(item: TraceItem): string {
  const event = item.event as Record<string, unknown> | null;
  if (!event) return "other";
  if ("request" in event) return "fetch";
  if ("cron" in event) return "scheduled";
  if ("queue" in event) return "queue";
  if ("mailFrom" in event) return "email";
  if ("rpcMethod" in event) return "rpc";
  if ("scheduledTime" in event) return "alarm";
  return "other";
}

/** The `traceparent` header's trace id, if it is a valid one. */
export function traceIdOf(traceparent: string | undefined | null): string | null {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec((traceparent ?? "").trim().toLowerCase());
  return m && !/^0+$/.test(m[1]) ? m[1] : null;
}

/** The status code of an event that failed before answering: what the visitor got. */
function failedStatus(outcome: string): number | null {
  if (outcome === "ok" || outcome === "canceled" || outcome === "responseStreamDisconnected") return null;
  return outcome === "exceededCpu" || outcome === "exceededMemory" ? 503 : 500;
}

/** Tail events as rows, grouped by the project (or, for the dispatcher's half, the script) they are of. */
export function readTail(events: readonly TraceItem[]): TailGroup[] {
  const groups = new Map<string, TailGroup>();
  const group = (project_id: string | null, script: string): TailGroup => {
    const key = project_id ?? `script:${script}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { project_id, script, batch: emptyBatch(), halves: [] }));
    return g;
  };

  for (const item of events) {
    const time = (item.eventTimestamp ?? Date.now()) * 1000;
    const info = fetchInfo(item);
    const mark = markOf(item);

    if (mark) {
      // The dispatcher's half: every request, whatever answered it.
      const g = group(mark.app?.project ?? null, mark.script);
      const where = info ? hostPath(info.request.url) : null;
      const cf = (info?.request.cf ?? {}) as { colo?: string; country?: string };
      const status = info?.response?.status ?? failedStatus(item.outcome);
      g.halves.push({
        id: mark.id,
        half: "edge",
        ...(mark.app
          ? { service: mark.app.service, environment: mark.app.environment, deployment_id: mark.app.deployment, commit_sha: mark.app.commit, source: "cloudflare" as const }
          : {}),
        time_us: time,
        duration_us: Math.round(item.wallTime * 1000),
        trigger: "fetch",
        method: info?.request.method ?? null,
        url: where?.url ?? null,
        route: where ? route(where.path) : null,
        status,
        region: cf.colo ?? null,
        country: cf.country ?? null,
        trace_id: mark.trace_id || null,
      });
      g.batch.bytes += 256;
      continue;
    }

    const tags = tagged(item.scriptTags);
    if (!tags.project_id) continue;
    const g = group(tags.project_id, item.scriptName ?? "");
    const headers = info?.request.headers ?? {};
    const id = headers[REQUEST_ID_HEADER] || randomId();
    const trace_id = traceIdOf(headers.traceparent);
    const origin = {
      service: tags.service,
      environment: tags.environment,
      deployment_id: tags.deployment_id,
      commit_sha: null,
      source: "cloudflare" as const,
    };

    const logs: TelemetryLog[] = item.logs.map((log) => {
      const number = severityNumber(log.level);
      return {
        ...origin,
        id: randomId(),
        time_us: log.timestamp * 1000,
        severity: severityOf(number),
        severity_number: number,
        body: clip(text(log.message)),
        trace_id,
        span_id: null,
        request_id: id,
        attributes: (log.level === "log" ? {} : { "log.level": log.level }) as Attributes,
      };
    });
    for (const e of item.exceptions) {
      logs.push({
        ...origin,
        id: randomId(),
        time_us: e.timestamp * 1000,
        severity: "error",
        severity_number: 17,
        body: clip(`${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`),
        trace_id,
        span_id: null,
        request_id: id,
        attributes: { "exception.type": e.name, "exception.message": clip(e.message, 4096) },
      });
      g.batch.errors.push({ ...origin, time_us: e.timestamp * 1000, name: e.name, message: e.message, stack: e.stack ?? null, request_id: id, trace_id });
    }
    if (item.truncated) {
      logs.push({
        ...origin,
        id: randomId(),
        time_us: time,
        severity: "warn",
        severity_number: 13,
        body: "Cloudflare cut this request's logs short: it wrote more than a tail event holds.",
        trace_id,
        span_id: null,
        request_id: id,
        attributes: {},
      });
    }
    g.batch.logs.push(...logs);

    const where = info ? hostPath(info.request.url) : null;
    const status = info?.response?.status ?? failedStatus(item.outcome);
    const first = item.exceptions[0];
    g.halves.push({
      ...origin,
      id,
      half: "app",
      time_us: time,
      duration_us: Math.round(item.wallTime * 1000),
      trigger: triggerOf(item),
      method: info?.request.method ?? null,
      url: where?.url ?? null,
      route: where ? route(where.path) : null,
      status,
      outcome: item.outcome,
      cpu_ms: item.cpuTime,
      trace_id,
      log_count: logs.length,
      error: first ? { name: first.name, message: clip(first.message, 2048) } : item.outcome !== "ok" && item.outcome !== "canceled" ? { name: item.outcome, message: outcomeText(item.outcome) } : null,
    });
    g.batch.bytes += logs.reduce((n, l) => n + l.body.length, 256);
  }
  return [...groups.values()];
}

/** What Cloudflare's outcome means, for the request's error line. */
export function outcomeText(outcome: string): string {
  switch (outcome) {
    case "exception":
      return "The code threw before it answered.";
    case "exceededCpu":
      return "The request used more CPU time than it is allowed.";
    case "exceededMemory":
      return "The isolate ran out of memory.";
    case "exceededWallTime":
      return "The request ran longer than it is allowed.";
    case "scriptNotFound":
      return "No app was there to answer.";
    case "loadShed":
      return "Cloudflare shed the request under load.";
    default:
      return `The request ended with ${outcome}.`;
  }
}
