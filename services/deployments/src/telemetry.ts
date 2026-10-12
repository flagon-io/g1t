/**
 * What each app on g1t.page carries for observability (services/telemetry),
 * set as it is uploaded:
 *
 * - the telemetry service as its Tail Worker, so every request it answers
 *   arrives there with its logs and exceptions;
 * - tags naming its project and deployment, which arrive with each event;
 * - OpenTelemetry's standard variables, so an SDK in the app sends spans,
 *   logs and metrics to the project without configuration: the endpoint,
 *   the project's deployments token, the service's name and a resource
 *   naming the environment, deployment and commit. A variable the project
 *   sets itself wins: an app can send elsewhere.
 * - under its hostname in `DOMAINS`, what the dispatcher writes on each
 *   request's line, so requests a site's files answered are filed too.
 */
import { TELEMETRY_OTLP_ENDPOINT, TELEMETRY_TAG } from "@g1t/contracts/telemetry";

/** The telemetry service's Worker, named as each app's Tail Worker. */
export const TELEMETRY_WORKER = "g1t-telemetry";

export const TAIL_CONSUMERS = [{ service: TELEMETRY_WORKER }];

/**
 * Cloudflare's own tracing of an app (a span for each fetch, KV, D1 and
 * other call it makes), sent to the Workers Observability destination
 * named `destination`, which points at the telemetry service's
 * `/cloudflare/v1/traces`. Traces only: the app's logs already arrive
 * through its Tail Worker, and nothing is kept in Cloudflare's own
 * storage. Nothing at all without a destination.
 */
export function observabilityMetadata(destination: string | null | undefined): Record<string, unknown> {
  if (!destination) return {};
  return {
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: false, invocation_logs: false },
      traces: { enabled: true, destinations: [destination], head_sampling_rate: 1, persist: false },
    },
  };
}

export function telemetryTags(projectId: string, deploymentId: string): string[] {
  return [`${TELEMETRY_TAG.project}${projectId}`, `${TELEMETRY_TAG.deployment}${deploymentId}`];
}

export type AppTelemetry = {
  project: string;
  deployment: string;
  environment: string;
  service: string;
  commit: string | null;
};

type Runtime = { secrets: Record<string, string>; variables: Record<string, string> };

/** OpenTelemetry's resource attributes, written as its variable takes them. */
export function resourceAttributes(app: AppTelemetry): string {
  const pairs: [string, string][] = [
    ["deployment.environment.name", app.environment],
    ["g1t.deployment.id", app.deployment],
    ["g1t.project.id", app.project],
  ];
  if (app.commit) pairs.push(["vcs.ref.head.revision", app.commit]);
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(",");
}

/** The app's runtime with OpenTelemetry's variables added, where the project set none of its own. */
export function withOtel(runtime: Runtime, app: AppTelemetry, token: string | null): Runtime {
  const has = (name: string) => name in runtime.variables || name in runtime.secrets;
  const variables = { ...runtime.variables };
  const secrets = { ...runtime.secrets };
  // An app the project points elsewhere is left to it, whole.
  if (has("OTEL_EXPORTER_OTLP_ENDPOINT") || !token) return runtime;
  variables.OTEL_EXPORTER_OTLP_ENDPOINT = TELEMETRY_OTLP_ENDPOINT;
  if (!has("OTEL_EXPORTER_OTLP_PROTOCOL")) variables.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  if (!has("OTEL_SERVICE_NAME")) variables.OTEL_SERVICE_NAME = app.service;
  const resource = resourceAttributes(app);
  variables.OTEL_RESOURCE_ATTRIBUTES = runtime.variables.OTEL_RESOURCE_ATTRIBUTES ? `${resource},${runtime.variables.OTEL_RESOURCE_ATTRIBUTES}` : resource;
  if (!has("OTEL_EXPORTER_OTLP_HEADERS")) secrets.OTEL_EXPORTER_OTLP_HEADERS = `authorization=Bearer ${token}`;
  return { variables, secrets };
}
