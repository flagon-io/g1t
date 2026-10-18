/**
 * The telemetry service: observability for projects. What a project's
 * running software did, as requests, logs, traces and metrics, kept in
 * one store per project (src/store.ts) and read on the project's
 * Observability page, the API and MCP.
 *
 * Doors in:
 * - `tail`: the Tail Worker of every app on g1t.page and of the
 *   dispatcher in front of them (src/tail.ts). Nothing to set up.
 * - `POST https://otel.g1t.sh/v1/{traces,logs,metrics}`: OTLP over HTTP,
 *   JSON or protobuf, gzipped or not, with a project's ingest token
 *   (`Authorization: Bearer g1to_…`). From g1t's own apps (their SDKs get
 *   the endpoint and a token as `OTEL_EXPORTER_OTLP_*`) and from software
 *   hosted anywhere else.
 * - `POST /cloudflare/v1/{traces,logs}`: Cloudflare's own OpenTelemetry
 *   export of the apps on g1t.page (automatic spans for every fetch,
 *   KV, D1 and the rest), once a destination on the account points here
 *   with `CLOUDFLARE_EXPORT_KEY`. Off without the key.
 *
 * Reached by the site and the API through service bindings:
 * `POST /rpc/<method>` (snake_case, `telemetryClient` in @g1t/contracts),
 * called once they have checked the viewer may read (or manage) the
 * project; and `GET /live?project_id=…`, a project's live tail.
 */
import { type RateLimitBinding, clientAddress, isLimited } from "@g1t/contracts/rate-limits";
import { type Standing, capOf, dailyCap, freeMonthlyBytes, overCapMessage } from "./quota.ts";
import type { WorkspaceMeter } from "./meter.ts";
import { TELEMETRY_TOKEN_PREFIX, type ErrorGroup } from "@g1t/contracts/telemetry";

import { emptyBatch, type Batch } from "./batch.ts";
import { IngestError, accepted, projectOfToken, readOtlp, refused, tokenOf, type Signal } from "./otlp/ingest.ts";
import { OTLP_DOOR, type Door } from "./otlp/normalize.ts";
import type { Store } from "./store.ts";
import { readTail, type RequestHalf } from "./tail.ts";

export { TelemetryMeter, TelemetryStore } from "./durable.ts";

type Env = {
  STORES: DurableObjectNamespace;
  /** One meter per workspace, by slug (./meter.ts): its daily share, month total and last known plan. */
  METERS?: DurableObjectNamespace;
  /** Hostname to app, written by the deployments service (as the dispatcher reads it). */
  DOMAINS?: KVNamespace;
  /** The secret Cloudflare's OpenTelemetry export sends, as `x-g1t-export-key`. */
  CLOUDFLARE_EXPORT_KEY?: string;
  /** OTLP requests per client address (RATE_LIMITS in packages/contracts). Fails open without it. */
  TELEMETRY_INGEST_LIMIT?: RateLimitBinding;
  /**
   * Whether a project's workspace has the plan, for the free cap
   * (./quota.ts), and where the plan's month total goes. Without it, no cap.
   */
  BILLING?: { fetch: typeof fetch };
  /** What a workspace's projects send free a month between them, in bytes (./quota.ts); 0 is no cap. */
  FREE_TELEMETRY_BYTES_PER_MONTH?: string;
};

/** A project's workspace and its daily cap (null: none). */
type Quota = { workspace: string | null; cap: number | null };

/** Each project's quota, kept ten minutes in this isolate. */
const caps = new Map<string, { at: number; quota: Quota }>();
const CAP_TTL_MS = 10 * 60_000;

/**
 * A project's workspace (as the site last told its store) and the day's
 * share the workspace's projects may send between them: none on the plan,
 * a thirtieth of the free amount on the free plan, and 0 for a workspace
 * g1t staff put a hold on (or suspended). When billing does not answer,
 * the plan it last said holds (the workspace's meter keeps it), and a
 * workspace it never said anything about is free. A project whose
 * workspace is not known yet is neither capped nor metered; deployed apps'
 * stores learn theirs from the deployments service.
 */
async function quotaFor(env: Env, projectId: string): Promise<Quota> {
  const cached = caps.get(projectId);
  if (cached && Date.now() - cached.at < CAP_TTL_MS) return cached.quota;
  let quota: Quota = { workspace: null, cap: null };
  const workspace = await store(env, projectId)
    .workspaceOf()
    .catch((error: unknown) => {
      console.error("could not read the project's workspace", projectId, error);
      return null;
    });
  // Without billing (self-hosted without it) there is no plan, and no cap.
  if (workspace && env.BILLING) {
    const meter = env.METERS ? meterOf(env, workspace) : null;
    let standing: Standing | null = null;
    try {
      const { billingClient } = await import("@g1t/contracts");
      const entitlements = await billingClient(env.BILLING as never).entitlements(workspace);
      standing = entitlements.held ? "held" : entitlements.plan === "free" ? "free" : "paid";
      await meter?.setStanding(standing).catch((error: unknown) => console.error("could not remember the workspace's plan", workspace, error));
    } catch (error) {
      console.error("could not tell whether the project's workspace is free; keeping the plan it was last on", projectId, error);
      standing = (await meter?.standing().catch(() => null)) ?? null;
    }
    quota = { workspace, cap: capOf(standing, dailyCap(freeMonthlyBytes(env.FREE_TELEMETRY_BYTES_PER_MONTH))) };
  } else if (workspace) {
    quota = { workspace, cap: null };
  }
  caps.set(projectId, { at: Date.now(), quota });
  if (caps.size > 5000) caps.delete(caps.keys().next().value!);
  return quota;
}

/** Whether the workspace's projects are past today's share with `adding` more. Never over without a cap. */
async function overQuota(env: Env, quota: Quota, adding: number): Promise<boolean> {
  if (!quota.workspace || quota.cap == null) return false;
  // A held workspace takes nothing, whatever its meter says.
  if (quota.cap === 0) return true;
  if (!env.METERS) return adding > quota.cap;
  return meterOf(env, quota.workspace)
    .over(adding, quota.cap)
    .catch((error: unknown) => {
      // The meter could not say: the cap still holds, on this request alone.
      console.error("could not read the workspace's meter", quota.workspace, error);
      return adding > (quota.cap ?? 0);
    });
}

/** Counts what a project kept on its workspace's meter. */
async function meterKept(env: Env, quota: Quota, bytes: number | undefined): Promise<void> {
  if (!quota.workspace || !env.METERS || !bytes) return;
  await meterOf(env, quota.workspace)
    .add(quota.workspace, bytes)
    .catch((error: unknown) => console.error("could not meter the workspace's telemetry", quota.workspace, bytes, error));
}

type MeterStub = {
  [K in keyof WorkspaceMeter as WorkspaceMeter[K] extends (...args: any[]) => any ? K : never]: WorkspaceMeter[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

function meterOf(env: Env, workspace: string): MeterStub {
  if (!env.METERS) throw new Error("No METERS binding.");
  return env.METERS.get(env.METERS.idFromName(workspace)) as unknown as MeterStub;
}

const DEPLOYMENTS_DOMAIN = "g1t.page";

/**
 * A project's store. Its methods are called over Durable Object RPC; the
 * stub is typed by hand, as the generated type of so many methods is more
 * than the compiler will work out.
 */
type StoreStub = {
  [K in keyof Store as Store[K] extends (...args: any[]) => any ? K : never]: Store[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

function store(env: Env, projectId: string): StoreStub {
  return env.STORES.get(env.STORES.idFromName(projectId)) as unknown as StoreStub;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, content-encoding, x-g1t-token",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

// ---- Apps on g1t.page, by script ------------------------------------------

type AppEntry = { project: string; deployment: string | null; environment: string | null; service: string; commit: string | null };

/** What the deployments service noted for each script, kept a minute in this isolate. */
const apps = new Map<string, { at: number; app: AppEntry | null }>();

async function appOf(env: Env, script: string): Promise<AppEntry | null> {
  const cached = apps.get(script);
  if (cached && Date.now() - cached.at < 60_000) return cached.app;
  let app: AppEntry | null = null;
  try {
    const entry = (await env.DOMAINS?.get(`${script}.${DEPLOYMENTS_DOMAIN}`, { type: "json", cacheTtl: 60 })) as { telemetry?: AppEntry } | null;
    if (entry?.telemetry && typeof entry.telemetry.project === "string") app = entry.telemetry;
  } catch (error) {
    console.error("could not look up app", script, error);
  }
  apps.set(script, { at: Date.now(), app });
  if (apps.size > 5000) apps.delete(apps.keys().next().value!);
  return app;
}

/** Tail events, into each project's store. */
async function onTail(events: readonly TraceItem[], env: Env): Promise<void> {
  const byProject = new Map<string, { batch: Batch; halves: RequestHalf[] }>();
  for (const group of readTail(events)) {
    let project = group.project_id;
    let halves = group.halves;
    if (!project) {
      // The dispatcher's half of a request to an app it had no note for yet.
      const app = await appOf(env, group.script);
      if (!app) continue;
      project = app.project;
      halves = halves.map((h) => ({ ...h, service: app.service, environment: app.environment, deployment_id: app.deployment, commit_sha: app.commit, source: "cloudflare" }));
    }
    const into = byProject.get(project) ?? { batch: emptyBatch(), halves: [] };
    merge(into.batch, group.batch);
    into.halves.push(...halves);
    byProject.set(project, into);
  }
  await Promise.all(
    [...byProject].map(async ([project, { batch, halves }]) => {
      const quota = await quotaFor(env, project);
      const done = await store(env, project)
        .ingest(batch, halves, undefined, await overQuota(env, quota, batch.bytes))
        .catch((error: unknown) => {
          console.error("could not keep tail events", project, error);
          return null;
        });
      if (done?.accepted) await meterKept(env, quota, done.bytes);
    }),
  );
}

function merge(into: Batch, from: Batch) {
  into.requests.push(...from.requests);
  into.logs.push(...from.logs);
  into.spans.push(...from.spans);
  into.metrics.push(...from.metrics);
  into.errors.push(...from.errors);
  into.bytes += from.bytes;
}

// ---- OTLP -----------------------------------------------------------------

async function otlp(request: Request, env: Env, signal: Signal): Promise<Response> {
  const token = tokenOf(request);
  if (!token) return refused(401, `No token: send the project's ingest token as "Authorization: Bearer ${TELEMETRY_TOKEN_PREFIX}…". Make one under the project's Observability settings.`);
  const project = projectOfToken(token);
  if (!project) return refused(401, "That is not a g1t ingest token.");
  // Counted before the body is read or the project's store is woken, so a
  // flood of requests (with made-up tokens or real ones) costs little.
  if (await isLimited(env.TELEMETRY_INGEST_LIMIT, `ip:${clientAddress(request)}`)) {
    return refused(429, "Too many requests from this address. Batch more per request, and wait a minute: https://docs.g1t.sh/reference/rate-limits/");
  }
  let read: { batch: Batch; protobuf: boolean };
  try {
    read = await readOtlp(request, signal, OTLP_DOOR);
  } catch (error) {
    if (error instanceof IngestError) return refused(error.status, error.message);
    throw error;
  }
  const quota = await quotaFor(env, project);
  const done = await store(env, project).ingest(read.batch, [], token, await overQuota(env, quota, read.batch.bytes));
  if (!done.accepted && done.reason === "quota") return refused(429, overCapMessage(quota.cap ?? 0));
  if (!done.accepted) return refused(401, "That token is not one of the project's, or it was revoked.");
  await meterKept(env, quota, done.bytes);
  return accepted(read.protobuf);
}

/**
 * Cloudflare's own export of an app on g1t.page: its resource names the
 * Worker (`cloudflare.script_name`, or the service's name), which is
 * filed under the app's project and deployment.
 */
async function cloudflareExport(request: Request, env: Env, signal: Signal): Promise<Response> {
  if (!env.CLOUDFLARE_EXPORT_KEY) return refused(404, "Cloudflare's export is not set up here.");
  if (request.headers.get("x-g1t-export-key") !== env.CLOUDFLARE_EXPORT_KEY) return refused(401, "Wrong export key.");
  if (signal === "metrics") return accepted(false);
  // Resources are read twice: first to find the scripts, then filed.
  const body = await request.clone().json().catch(() => null) as { resourceSpans?: { resource?: { attributes?: { key: string; value?: { stringValue?: string } }[] } }[]; resourceLogs?: { resource?: { attributes?: { key: string; value?: { stringValue?: string } }[] } }[] } | null;
  const scripts = new Set<string>();
  for (const r of [...(body?.resourceSpans ?? []), ...(body?.resourceLogs ?? [])]) {
    const attrs = r.resource?.attributes ?? [];
    const script = attrs.find((a) => a.key === "cloudflare.script_name")?.value?.stringValue ?? attrs.find((a) => a.key === "service.name")?.value?.stringValue;
    if (script) scripts.add(script);
  }
  const known = new Map<string, AppEntry>();
  for (const script of scripts) {
    const app = await appOf(env, script);
    if (app) known.set(script, app);
  }
  if (!known.size) return accepted(false);
  for (const [script, app] of known) {
    const door: Door = {
      source: "cloudflare",
      // Cloudflare's spans of a request are under the request the tail
      // events already counted: they are not counted again.
      countRequests: false,
      origin: (resource) =>
        (resource["cloudflare.script_name"] ?? resource["service.name"]) === script
          ? { service: app.service, environment: app.environment, deployment_id: app.deployment, commit_sha: app.commit, source: "cloudflare" }
          : null,
    };
    const read = await readOtlp(request.clone(), signal, door);
    // Not capped (Cloudflare sends it whatever g1t answers), but counted
    // on the workspace's meter like everything kept.
    const done = await store(env, app.project).ingest({ ...read.batch, requests: [], metrics: [], bytes: Math.round(read.batch.bytes / known.size) }, []);
    if (done.accepted) await meterKept(env, await quotaFor(env, app.project), done.bytes);
  }
  return accepted(false);
}

// ---- RPC ------------------------------------------------------------------

/** `POST /rpc/<method>`: each is one project's, named by `project_id`. */
async function rpc(env: Env, method: string, args: Record<string, any>): Promise<unknown> {
  const projectId = String(args.project_id ?? "");
  if (!projectId) throw new IngestError(400, "No project_id.");
  const s = store(env, projectId);
  // The site says which workspace the project is in when it shows its
  // settings and makes a token, and the deployments service when it deploys
  // one of its apps: the store keeps it, for the workspace's cap and meter.
  const tellsWorkspace = ["settings", "create_token", "usage", "deployment_token"].includes(method);
  if (typeof args.workspace === "string" && tellsWorkspace) {
    await s.setWorkspace(args.workspace);
    caps.delete(projectId);
  }
  switch (method) {
    case "overview":
      return s.overview(args);
    case "requests":
      return s.requests(args);
    case "request":
      return s.request(String(args.id));
    case "logs":
      return s.logs(args);
    case "traces":
      return s.traces(args);
    case "trace":
      return s.trace(String(args.trace_id));
    case "errors":
      return s.errors(args);
    case "set_error":
      return s.setError(String(args.fingerprint), { state: args.state as ErrorGroup["state"] | undefined, item: args.item });
    case "metrics":
      return s.metrics();
    case "metric":
      return s.metric({ ...args, name: String(args.name) });
    case "facets":
      return s.facets();
    case "settings":
      return s.settings();
    case "set_settings":
      return s.setSettings(args);
    case "tokens":
      return s.tokens();
    case "create_token":
      return s.createToken(projectId, String(args.name ?? ""), args.created_by ?? null);
    case "revoke_token":
      return s.revokeToken(String(args.id));
    case "deployment_token":
      return s.deploymentToken(projectId);
    case "exports":
      return s.exports();
    case "put_export":
      return s.putExport(args as never);
    case "delete_export":
      return s.deleteExport(String(args.id));
    case "usage":
      return s.usage();
    case "purge":
      return s.purge();
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const otlpPath = /^\/v1\/(traces|logs|metrics)\/?$/.exec(url.pathname);
    if (otlpPath) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method !== "POST") return withCors(refused(405, "OTLP is sent with POST."));
      return withCors(await otlp(request, env, otlpPath[1] as Signal));
    }
    const cfPath = /^\/cloudflare\/v1\/(traces|logs|metrics)\/?$/.exec(url.pathname);
    if (cfPath && request.method === "POST") return cloudflareExport(request, env, cfPath[1] as Signal);

    // A project's live tail: the site checked the viewer may read it.
    if (url.pathname === "/live" && request.method === "GET") {
      const project = url.searchParams.get("project_id");
      if (!project) return new Response("No project_id.\n", { status: 400 });
      return env.STORES.get(env.STORES.idFromName(project)).fetch(request);
    }

    const rpcPath = /^\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpcPath && request.method === "POST") {
      const args = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      try {
        const result = await rpc(env, rpcPath[1], args);
        return result === undefined ? new Response("Unknown method\n", { status: 404 }) : Response.json(result);
      } catch (error) {
        const status = error instanceof IngestError ? error.status : 400;
        return new Response(String(error).replace(/^Error: /, ""), { status });
      }
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "g1t's OpenTelemetry endpoint. Send OTLP over HTTP to /v1/traces, /v1/logs and /v1/metrics with a project's ingest token.\nhttps://docs.g1t.sh/guides/observability/\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response("Not found\n", { status: 404 });
  },

  async tail(events: TraceItem[], env: Env): Promise<void> {
    await onTail(events, env);
  },
} satisfies ExportedHandler<Env>;
