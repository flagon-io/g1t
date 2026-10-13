/**
 * Container apps: a project built as a Docker image (crates/runner
 * deploy/container.rs) runs on Cloudflare Containers behind a Worker of
 * g1t's own, one per app, in the same Workers for Platforms namespace as
 * every other app, so the `*.g1t.page` dispatcher (services/pages) and
 * custom domains reach it by its script's name as they reach any app.
 *
 * Each app's Worker is `APP_WORKER` below, never the project's code: its
 * Durable Object class `G1tApp` has the app's container (a Container
 * application with the default scheduling policy, the app's image and
 * instance type, at most one instance), starts it on the first request
 * with the project's variables and secrets as its environment and `PORT`,
 * waits for it to answer on its port, proxies requests to it, and stops it
 * after `CONTAINER_SLEEP_MINUTES` without a request. While it runs it
 * meters itself by the started minute, and reports to g1t with a token of
 * its own (`POST /deployments/apps/<script>/meter`), which billing charges
 * at cost plus the margin.
 *
 * The build's sandbox pushes the image with a login this service mints
 * from Cloudflare's registry API: push only, for 15 minutes. Cloudflare's
 * registry credentials cannot be held to one repository, so g1t holds the
 * build to its app's: it names the repository, deploys only an image by
 * digest in that repository, and checks the digest is there before it
 * does. The login can never pull, so no build can read another app's image.
 * Once a deploy is live, the app's older images are deleted, keeping the
 * one it replaced; an app taken down takes its images with it.
 *
 * Pure, with no Workers imports, so it can be tested under Node.
 */

import { TAIL_CONSUMERS } from "./telemetry";
import {
  APP_INSTANCES,
  CONTAINER_SLEEP_MINUTES,
  DEFAULT_APP_INSTANCE,
  appInstance,
  containerSecondMicros,
  type ContainerCosts,
  type ContainerOffer,
} from "@g1t/contracts";

/** Cloudflare's container registry, which Containers pulls from. */
export const REGISTRY_HOST = "registry.cloudflare.com";

/** The Durable Object class of every container app's Worker. */
export const APP_CLASS = "G1tApp";

/** How long a build's push login lasts. */
export const PUSH_LOGIN_MINUTES = 15;

/**
 * What Cloudflare Containers holds of an account's images, in all. Each
 * app keeps only the image it runs and the one before it
 * (`Cloudflare.pruneImages`), and none once it is taken down.
 */
export const IMAGE_STORAGE_GB = 50;

/** The repository an app's images are pushed to: `<account>/g1t-<script>`. */
export function repositoryFor(account: string, script: string): string {
  return `${account}/g1t-${script}`;
}

/** What `POST /accounts/{id}/containers/registries/{domain}/credentials` is asked for: a push-only login, for minutes. */
export function pushLoginRequest(): { permissions: ["push"]; expiration_minutes: number } {
  return { permissions: ["push"], expiration_minutes: PUSH_LOGIN_MINUTES };
}

/** The most an image may weigh to run on `instanceType`: its disk, as Cloudflare limits it. */
export function maxImageBytes(instanceType: string): number {
  return appInstance(instanceType).diskGb * 1_000_000_000;
}

/** An instance type the project may choose, or the default. */
export function instanceTypeOf(value: unknown): string {
  return typeof value === "string" && APP_INSTANCES.some((instance) => instance.type === value) ? value : DEFAULT_APP_INSTANCE;
}

/**
 * What a build reported it pushed, if it is an image this build may run:
 * a digest in its app's own repository and nothing else, with the port
 * it listens on.
 */
export function pushedImage(
  value: unknown,
  repository: string,
): { image: string; digest: string; port: number; sizeBytes: number } | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  const image = typeof report.image === "string" ? report.image : "";
  const match = image.match(/^([a-z0-9.-]+)\/(.+)@(sha256:[0-9a-f]{64})$/);
  if (!match || match[1] !== REGISTRY_HOST || match[2] !== repository) return null;
  const port = Number(report.port);
  return {
    image,
    digest: match[3],
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8080,
    sizeBytes: Math.max(0, Number(report.sizeBytes) || 0),
  };
}

/** The settings an app's Worker reads, besides the project's variables and secrets. */
export type AppWorkerSettings = {
  mode: "serve" | "paused" | "down" | "redirect";
  /** For `redirect`: the hostname to send visitors to. */
  redirect?: string;
  port: number;
  instanceType: string;
  /** Where it reports what it ran, with `meterToken`. */
  meterUrl: string;
  meterToken: string;
};

/** Names the app's Worker keeps for itself: never passed to the container. */
export const INTERNAL_BINDINGS = ["APP", "G1T_MODE", "G1T_REDIRECT", "G1T_PORT", "G1T_SLEEP_MS", "G1T_METER_URL", "G1T_METER_TOKEN", "G1T_INSTANCE"];

/**
 * The upload's metadata for a container app's Worker: `APP_WORKER` as its
 * one module, its Durable Object class with a container, g1t's settings,
 * and the project's variables and secrets, which the Worker passes to the
 * container as its environment. A variable named like one of g1t's own is
 * left out.
 */
export function appWorkerMetadata(
  settings: AppWorkerSettings,
  runtime: { secrets: Record<string, string>; variables: Record<string, string> },
  tags: string[],
): Record<string, unknown> {
  const own = new Set(INTERNAL_BINDINGS);
  const bindings: object[] = [{ type: "durable_object_namespace", name: "APP", class_name: APP_CLASS }];
  const plain: Record<string, string> = {
    G1T_MODE: settings.mode,
    G1T_PORT: String(settings.port),
    G1T_SLEEP_MS: String(CONTAINER_SLEEP_MINUTES * 60 * 1000),
    G1T_METER_URL: settings.meterUrl,
    G1T_INSTANCE: settings.instanceType,
  };
  if (settings.redirect) plain.G1T_REDIRECT = settings.redirect;
  for (const [name, text] of Object.entries(plain)) bindings.push({ type: "plain_text", name, text });
  bindings.push({ type: "secret_text", name: "G1T_METER_TOKEN", text: settings.meterToken });
  for (const [name, text] of Object.entries(runtime.variables)) {
    if (!own.has(name) && !(name in runtime.secrets)) bindings.push({ type: "plain_text", name, text });
  }
  for (const [name, text] of Object.entries(runtime.secrets)) {
    if (!own.has(name)) bindings.push({ type: "secret_text", name, text });
  }
  return {
    main_module: "index.js",
    compatibility_date: "2026-09-26",
    compatibility_flags: [],
    bindings,
    tags,
    tail_consumers: TAIL_CONSUMERS,
    // Declared, so uploading it again changes nothing about the class.
    exports: { [APP_CLASS]: { type: "durable-object", storage: "sqlite" } },
    containers: [{ class_name: APP_CLASS }],
  };
}

/** A container's output, kept in Workers Logs. */
const CONTAINER_LOGS = { logs: { enabled: true } };

/** `POST /accounts/{id}/containers/applications`: the app's container, for its Durable Object namespace. */
export function applicationRequest(name: string, image: string, instanceType: string, namespaceId: string): Record<string, unknown> {
  return {
    name,
    scheduling_policy: "default",
    // Its output goes to Workers Logs on g1t's account, where it can be read.
    configuration: { image, instance_type: instanceTypeOf(instanceType), observability: CONTAINER_LOGS },
    instances: 0,
    // One instance per app: its Durable Object is named `app`.
    max_instances: 1,
    durable_objects: { namespace_id: namespaceId },
  };
}

/** `POST /accounts/{id}/containers/applications/{app}/rollouts`: a new image or size, all at once. */
export function rolloutRequest(image: string, instanceType: string, description: string): Record<string, unknown> {
  return {
    description,
    strategy: "rolling",
    kind: "full_auto",
    step_percentage: 100,
    target_configuration: { image, instance_type: instanceTypeOf(instanceType), observability: CONTAINER_LOGS },
  };
}

/** The name of an app's Container application. */
export function applicationName(script: string): string {
  return `g1t-${script}`;
}

/** What an app's Worker reports: how long its container has run this month, and what it sent. */
export type MeterReport = {
  token: string;
  /** The Durable Object's own counter: a fresh one starts again at zero. */
  epoch: string;
  month: string;
  awakeSeconds: number;
  egressBytes: number;
  instanceType: string;
};

/** A report from an app's Worker, if it is one. */
export function meterReport(body: unknown): MeterReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const awake = Number(b.awakeSeconds);
  const egress = Number(b.egressBytes ?? 0);
  if (typeof b.token !== "string" || typeof b.epoch !== "string" || !/^[\w-]{8,64}$/.test(b.epoch)) return null;
  if (typeof b.month !== "string" || !/^\d{4}-\d{2}$/.test(b.month)) return null;
  if (!Number.isFinite(awake) || awake < 0 || !Number.isFinite(egress) || egress < 0) return null;
  // No month has more seconds than this.
  if (awake > 31 * 24 * 60 * 60) return null;
  return {
    token: b.token,
    epoch: b.epoch,
    month: b.month,
    awakeSeconds: Math.ceil(awake),
    egressBytes: Math.ceil(egress),
    instanceType: instanceTypeOf(b.instanceType),
  };
}

/** One app's container time in a month, as the `container_meters` table keeps it. */
export type ContainerMeter = { instance_type: string; awake_seconds: number; egress_bytes: number };

/** What a month of container time cost g1t, in millionths of a dollar, rounded up, and in words. */
export function containerCost(rows: ContainerMeter[], costs: ContainerCosts): { micros: number; seconds: number; detail: string | null } {
  let micros = 0;
  let seconds = 0;
  let bytes = 0;
  for (const row of rows) {
    const awake = Math.max(0, row.awake_seconds);
    micros += awake * containerSecondMicros(appInstance(row.instance_type), costs);
    micros += (Math.max(0, row.egress_bytes) / 1_000_000_000) * costs.egressGb;
    seconds += awake;
    bytes += Math.max(0, row.egress_bytes);
  }
  const hours = Math.round((seconds / 3600) * 10) / 10;
  const detail = seconds || bytes ? `${hours.toLocaleString("en-US")} container hours and ${(Math.round(bytes / 1e7) / 100).toLocaleString("en-US")} GB sent` : null;
  return { micros: Math.ceil(micros), seconds, detail };
}

/** What each size costs an hour awake, at most, with `marginPercent` on top: for Settings, Deployments and the docs. */
export function containerOffer(costs: ContainerCosts, marginPercent: number, available: boolean): ContainerOffer {
  const withMargin = (micros: number) => Math.ceil(micros * (1 + marginPercent / 100));
  return {
    available,
    prices: APP_INSTANCES.map((instance) => ({ ...instance, hourlyMicros: withMargin(containerSecondMicros(instance, costs) * 3600) })),
    egressGbMicros: withMargin(costs.egressGb),
    sleepMinutes: CONTAINER_SLEEP_MINUTES,
  };
}

/**
 * The Worker every container app runs as, g1t's own. `G1tApp` holds the
 * container: it starts it with the project's variables and secrets and
 * `PORT`, waits up to 90 seconds for it to answer on its port, proxies to
 * it, and stops it once no request has come for `G1T_SLEEP_MS`. Every
 * minute it is up is metered from its start, ahead (a minute begun is a
 * minute charged), with the bytes it sent back, and reported to g1t.
 */
export const APP_WORKER = `import { DurableObject } from "cloudflare:workers";

const INTERNAL = new Set(${JSON.stringify(INTERNAL_BINDINGS)});
const TICK_MS = 60000;
const READY_MS = 90000;

function page(status, title, text) {
  return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'><meta name=robots content=noindex><title>" + title + "</title><body style='font:16px system-ui;background:#121214;color:#ececf1;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px'><main style='max-width:32rem'><h1>" + title + "</h1><p style='color:#9a9aa6'>" + text + "</p></main>", { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
}

/** What the app answers while it is not serving: paused, down, or moved. */
function notServing(env, request) {
  if (env.G1T_MODE === "redirect" && env.G1T_REDIRECT) {
    const url = new URL(request.url);
    return new Response(null, { status: 301, headers: { location: "https://" + env.G1T_REDIRECT + url.pathname + url.search, "cache-control": "public, max-age=3600" } });
  }
  if (env.G1T_MODE === "paused") return page(402, "This app is paused", "The workspace it belongs to reached its usage limit on g1t. It comes back by itself once the workspace is under it again.");
  return page(404, "This app is not up", "It was taken down. Deploying it again brings it back.");
}

const monthOf = (at) => new Date(at).toISOString().slice(0, 7);

export class ${APP_CLASS} extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.listening = false;
    this.lastRequest = Date.now();
    this.sent = 0;
  }

  async fetch(request) {
    const env = this.env;
    const container = this.ctx.container;
    if (env.G1T_MODE !== "serve") {
      if (container && container.running) await container.destroy();
      return notServing(env, request);
    }
    this.lastRequest = Date.now();
    const port = Number(env.G1T_PORT) || 8080;
    if (!container.running) {
      const vars = { PORT: String(port) };
      for (const [name, value] of Object.entries(env)) if (!INTERNAL.has(name) && typeof value === "string") vars[name] = value;
      container.start({ env: vars, enableInternet: true });
      this.listening = false;
      // How it ended, if it ends: said on the page of a request it never answered.
      this.exited = null;
      this.why = null;
      if (typeof container.monitor === "function") {
        container.monitor().then(
          () => { this.exited = "0"; },
          (error) => {
            this.exited = error && error.exitCode !== undefined ? String(error.exitCode) : "unknown";
            // Why it ended, when Cloudflare says: in the app's logs and on its page.
            this.why = error && error.message ? String(error.message).slice(0, 300) : null;
            console.error("g1t-container-ended", JSON.stringify({ exitCode: error?.exitCode ?? null, message: this.why }));
          },
        );
      }
      await this.tick();
    }
    // A backstop: g1t stops it itself once it has slept long enough.
    await container.setInactivityTimeout((Number(env.G1T_SLEEP_MS) || 300000) + 2 * TICK_MS).catch(() => undefined);
    if (!(await this.ready(container, port))) {
      const ended = (this.exited === null || this.exited === undefined ? "It is not answering on port " + port + "." : "It stopped (exit code " + this.exited + ") before it answered on port " + port + ".") + (this.why ? " Cloudflare said: " + this.why : "");
      return page(503, "The app did not start", ended + " It must listen on 0.0.0.0 at the port in the PORT environment variable (the one its Dockerfile exposes, else 8080).");
    }
    let response;
    try {
      // To the container over plain HTTP, as the app listens: the visitor's
      // https:// address would have the port asked for TLS, and the app
      // close the connection. The path, query, method, headers and body
      // stay as they came; the original host and scheme go along as
      // X-Forwarded-* headers.
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
      headers.set("x-forwarded-host", url.host);
      const inner = new Request("http://container" + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
      response = await container.getTcpPort(port).fetch(inner);
    } catch (error) {
      return page(502, "The app failed", "It closed the connection before it answered.");
    }
    return this.counted(response);
  }

  /** Whether the container answers on its port, waiting for it to start. */
  async ready(container, port) {
    if (this.listening) return true;
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
      try {
        await container.getTcpPort(port).fetch("http://container/", { method: "HEAD" });
        this.listening = true;
        return true;
      } catch {}
      if (!container.running) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /** The response, with the bytes it sends counted. */
  counted(response) {
    if (!response.body) return response;
    const self = this;
    const count = new TransformStream({
      transform(chunk, controller) {
        self.sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(count), response);
  }

  async meter(now) {
    let meter = await this.ctx.storage.get("meter");
    const instance = this.env.G1T_INSTANCE;
    if (meter && meter.instance !== instance) {
      // A new size is counted apart, since it costs differently.
      await this.report(meter);
      meter = null;
    }
    if (!meter) meter = { epoch: crypto.randomUUID(), instance, month: monthOf(now), awakeMs: 0, egressBytes: 0, billedUntil: 0 };
    if (meter.month !== monthOf(now)) {
      await this.report(meter);
      meter = { ...meter, month: monthOf(now), awakeMs: 0, egressBytes: 0 };
    }
    return meter;
  }

  /** Charges the next minute up (a minute begun is charged), and wakes again at its end. */
  async tick() {
    const now = Date.now();
    const meter = await this.meter(now);
    const until = now + TICK_MS;
    meter.awakeMs += until - Math.max(meter.billedUntil, now);
    meter.billedUntil = until;
    meter.egressBytes += this.sent;
    this.sent = 0;
    await this.ctx.storage.put("meter", meter);
    await this.ctx.storage.setAlarm(until);
    await this.report(meter);
  }

  async alarm() {
    const container = this.ctx.container;
    const sleep = Number(this.env.G1T_SLEEP_MS) || 300000;
    if (container && container.running && this.env.G1T_MODE === "serve" && Date.now() - this.lastRequest < sleep) {
      await this.tick();
      return;
    }
    // Asleep: nothing runs, and nothing more is charged.
    if (container && container.running) await container.destroy();
    const meter = await this.meter(Date.now());
    meter.egressBytes += this.sent;
    this.sent = 0;
    await this.ctx.storage.put("meter", meter);
    await this.report(meter);
  }

  /** Tells g1t what has run this month; a report that fails is caught up by the next. */
  async report(meter) {
    await fetch(this.env.G1T_METER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: this.env.G1T_METER_TOKEN,
        epoch: meter.epoch,
        month: meter.month,
        awakeSeconds: Math.ceil(meter.awakeMs / 1000),
        egressBytes: meter.egressBytes,
        instanceType: meter.instance,
      }),
    }).catch(() => undefined);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (env.G1T_MODE !== "serve") {
      // Its Durable Object stops its container, if it is still up.
      ctx.waitUntil(env.APP.get(env.APP.idFromName("app")).fetch(request).catch(() => undefined));
      return notServing(env, request);
    }
    return env.APP.get(env.APP.idFromName("app")).fetch(request);
  },
};
`;
