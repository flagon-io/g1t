/**
 * `@g1t/contracts` imports its modules without extensions, so a resolve
 * hook adds them, as in moves.flow.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { DEPLOYMENT_COSTS } = await import("@g1t/contracts");
const {
  APP_WORKER,
  appWorkerMetadata,
  applicationRequest,
  containerCost,
  containerOffer,
  maxImageBytes,
  meterReport,
  pushLoginRequest,
  pushedImage,
  repositoryFor,
  rolloutRequest,
} = await import("./containers.ts");

const COSTS = DEPLOYMENT_COSTS.container;
const DIGEST = "a".repeat(64);

test("a build gets a push-only login, for minutes, and pushes to its app's repository", () => {
  assert.deepEqual(pushLoginRequest(), { permissions: ["push"], expiration_minutes: 15 });
  assert.equal(repositoryFor("acc", "web-acme"), "acc/g1t-web-acme");
  assert.equal(maxImageBytes("lite"), 2_000_000_000);
  assert.equal(maxImageBytes("standard-4"), 20_000_000_000);
  assert.equal(maxImageBytes("huge"), 2_000_000_000, "an unknown size is the smallest");
});

test("only an image by digest in the app's own repository is run", () => {
  const repo = "acc/g1t-web-acme";
  const ok = pushedImage({ image: `registry.cloudflare.com/${repo}@sha256:${DIGEST}`, port: 3000, sizeBytes: 12 }, repo);
  assert.deepEqual(ok, { image: `registry.cloudflare.com/${repo}@sha256:${DIGEST}`, digest: `sha256:${DIGEST}`, port: 3000, sizeBytes: 12 });
  // Another app's repository, another registry, a tag, or no report.
  assert.equal(pushedImage({ image: `registry.cloudflare.com/acc/g1t-other@sha256:${DIGEST}` }, repo), null);
  assert.equal(pushedImage({ image: `docker.io/${repo}@sha256:${DIGEST}` }, repo), null);
  assert.equal(pushedImage({ image: `registry.cloudflare.com/${repo}:latest` }, repo), null);
  assert.equal(pushedImage(null, repo), null);
  assert.equal(pushedImage({ image: `registry.cloudflare.com/${repo}@sha256:${DIGEST}`, port: 0 }, repo)?.port, 8080);
});

test("the app's Worker is g1t's, with its settings and the project's entries as bindings", () => {
  const metadata = appWorkerMetadata(
    { mode: "serve", port: 3000, instanceType: "basic", meterUrl: "https://api.g1t.sh/deployments/apps/web/meter", meterToken: "t0ken" },
    { secrets: { DATABASE_URL: "postgres://x", G1T_MODE: "sneaky" }, variables: { NODE_ENV: "production", DATABASE_URL: "shadowed" } },
    ["workspace:acme"],
  );
  const bindings = metadata.bindings as { type: string; name: string; text?: string; class_name?: string }[];
  const named = (name: string) => bindings.filter((b) => b.name === name);
  assert.deepEqual(named("APP"), [{ type: "durable_object_namespace", name: "APP", class_name: "G1tApp" }]);
  assert.deepEqual(named("G1T_MODE"), [{ type: "plain_text", name: "G1T_MODE", text: "serve" }], "a project's entry never replaces g1t's");
  assert.deepEqual(named("G1T_METER_TOKEN"), [{ type: "secret_text", name: "G1T_METER_TOKEN", text: "t0ken" }]);
  assert.deepEqual(named("DATABASE_URL"), [{ type: "secret_text", name: "DATABASE_URL", text: "postgres://x" }], "a secret wins over a variable");
  assert.deepEqual(named("NODE_ENV"), [{ type: "plain_text", name: "NODE_ENV", text: "production" }]);
  assert.deepEqual(metadata.exports, { G1tApp: { type: "durable-object", storage: "sqlite" } });
  assert.deepEqual(metadata.containers, [{ class_name: "G1tApp" }]);
});

test("the container application runs one instance of the app's image at its size", () => {
  const image = `registry.cloudflare.com/acc/g1t-web@sha256:${DIGEST}`;
  assert.deepEqual(applicationRequest("g1t-web", image, "basic", "ns1"), {
    name: "g1t-web",
    scheduling_policy: "default",
    configuration: { image, instance_type: "basic", observability: { logs: { enabled: true } } },
    instances: 0,
    max_instances: 1,
    durable_objects: { namespace_id: "ns1" },
  });
  const rollout = rolloutRequest(image, "nonsense", "dpl_1");
  assert.deepEqual(rollout.target_configuration, { image, instance_type: "lite", observability: { logs: { enabled: true } } });
  assert.equal(rollout.step_percentage, 100);
});

test("an app's reports are read strictly", () => {
  const good = { token: "t", epoch: "0b8f2c4e-1", month: "2026-10", awakeSeconds: 61.2, egressBytes: 10, instanceType: "basic" };
  assert.deepEqual(meterReport(good), { ...good, awakeSeconds: 62 });
  assert.equal(meterReport({ ...good, month: "October" }), null);
  assert.equal(meterReport({ ...good, awakeSeconds: -1 }), null);
  assert.equal(meterReport({ ...good, awakeSeconds: 40 * 24 * 3600 }), null);
  assert.equal(meterReport({ ...good, epoch: "x" }), null);
  assert.equal(meterReport({ ...good, instanceType: "huge" })?.instanceType, "lite");
});

test("container time costs what Cloudflare charges at most, and the margin goes on top", () => {
  // lite: 1/16 vCPU, 0.25 GiB, 2 GB, and the Durable Object, a second.
  const second = (1 / 16) * 20 + 0.25 * 2.5 + 2 * 0.07 + 1.5625;
  const hour = containerCost([{ instance_type: "lite", awake_seconds: 3600, egress_bytes: 0 }], COSTS);
  assert.equal(hour.micros, Math.ceil(second * 3600));
  assert.equal(hour.detail, "1 container hours and 0 GB sent");
  const sent = containerCost([{ instance_type: "standard-1", awake_seconds: 0, egress_bytes: 2_000_000_000 }], COSTS);
  assert.equal(sent.micros, 100_000, "2 GB at $0.05");
  assert.deepEqual(containerCost([], COSTS), { micros: 0, seconds: 0, detail: null });
  const offer = containerOffer(COSTS, 20, false);
  assert.equal(offer.available, false);
  assert.equal(offer.prices[0].type, "lite");
  assert.equal(offer.prices[0].hourlyMicros, Math.ceil(second * 3600 * 1.2));
  assert.equal(offer.egressGbMicros, 60_000);
  // Larger sizes cost more, every one.
  for (let i = 1; i < offer.prices.length; i++) assert.ok(offer.prices[i].hourlyMicros > offer.prices[i - 1].hourlyMicros);
});

/** The app's Worker, loaded with a stand-in for the Workers runtime. */
async function appWorker() {
  const code = APP_WORKER.replace(
    'import { DurableObject } from "cloudflare:workers";',
    "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  );
  return (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
    G1tApp: new (ctx: unknown, env: unknown) => { fetch(r: Request): Promise<Response>; alarm(): Promise<void> };
  };
}

function runtime() {
  const stored = new Map<string, unknown>();
  const container = {
    running: false,
    started: null as null | { env: Record<string, string>; enableInternet: boolean },
    destroyed: 0,
    start(options: { env: Record<string, string>; enableInternet: boolean }) {
      this.running = true;
      this.started = options;
    },
    async destroy() {
      this.running = false;
      this.destroyed++;
    },
    async setInactivityTimeout() {},
    getTcpPort(port: number) {
      return { fetch: async () => new Response(`hello from ${port}`) };
    },
  };
  const ctx = {
    container,
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
      setAlarm: async (at: number) => void stored.set("alarm", at),
    },
  };
  return { ctx, container, stored };
}

test("the app's Worker starts its container with the project's entries, meters it and lets it sleep", async (t) => {
  const reports: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    reports.push(JSON.parse(String(init.body)));
    return new Response("{}");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const realNow = Date.now;
  let now = Date.parse("2026-10-12T10:00:00Z");
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  const { G1tApp } = await appWorker();
  const { ctx, container, stored } = runtime();
  const env = {
    G1T_MODE: "serve",
    G1T_PORT: "3000",
    G1T_SLEEP_MS: "300000",
    G1T_METER_URL: "https://api.g1t.sh/deployments/apps/web/meter",
    G1T_METER_TOKEN: "t0ken",
    G1T_INSTANCE: "lite",
    APP: {},
    DATABASE_URL: "postgres://x",
  };
  const app = new G1tApp(ctx, env);
  const response = await app.fetch(new Request("https://web.g1t.page/"));
  assert.equal(await response.text(), "hello from 3000");
  assert.deepEqual(container.started, { env: { PORT: "3000", DATABASE_URL: "postgres://x" }, enableInternet: true });
  // The first minute is charged as it starts.
  assert.equal(reports.at(-1)?.awakeSeconds, 60);
  assert.equal(reports.at(-1)?.token, "t0ken");
  assert.equal(stored.get("alarm"), now + 60_000);
  // A minute on, with a request in it: another minute.
  now += 60_000;
  await app.alarm();
  assert.equal(reports.at(-1)?.awakeSeconds, 120);
  assert.equal(reports.at(-1)?.egressBytes, "hello from 3000".length);
  // Five minutes without a request: it is stopped, and nothing more is charged.
  now += 5 * 60_000;
  await app.alarm();
  assert.equal(container.running, false);
  assert.equal(reports.at(-1)?.awakeSeconds, 120);
  // The next request starts it again, from the minute it starts.
  now += 60 * 60_000;
  await app.fetch(new Request("https://web.g1t.page/"));
  assert.equal(reports.at(-1)?.awakeSeconds, 180);
  // A new month starts again at zero, under the same counter.
  const epoch = reports.at(-1)?.epoch;
  now = Date.parse("2026-11-01T00:00:30Z");
  await app.alarm();
  assert.equal(reports.at(-1)?.month, "2026-11");
  assert.equal(reports.at(-1)?.epoch, epoch);
  assert.equal(reports.at(-2)?.month, "2026-10", "the month that ended is reported first");
});

test("an app that stops before it answers says how it ended", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { G1tApp } = await appWorker();
  const { ctx, container } = runtime();
  // It exits at once, with an error, and never listens.
  let exit: (error: unknown) => void = () => {};
  Object.assign(container, {
    monitor: () => new Promise((_, reject) => (exit = reject)),
    getTcpPort: () => ({
      fetch: async () => {
        throw new Error("connection refused");
      },
    }),
  });
  const app = new G1tApp(ctx, { G1T_MODE: "serve", G1T_PORT: "3000", G1T_METER_URL: "https://api.g1t.sh/m", APP: {} });
  const answer = app.fetch(new Request("https://web.g1t.page/"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  exit(Object.assign(new Error("exited"), { exitCode: 1 }));
  container.running = false;
  const response = await answer;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /It stopped \(exit code 1\) before it answered on port 3000/);
});

test("a paused app answers with a notice and its container stops", async () => {
  const { G1tApp } = await appWorker();
  const { ctx, container } = runtime();
  container.running = true;
  const app = new G1tApp(ctx, { G1T_MODE: "paused" });
  const response = await app.fetch(new Request("https://web.g1t.page/"));
  assert.equal(response.status, 402);
  assert.equal(container.destroyed, 1);
  const moved = await new G1tApp(ctx, { G1T_MODE: "redirect", G1T_REDIRECT: "new-acme.g1t.page" }).fetch(new Request("https://web.g1t.page/a?b=1"));
  assert.equal(moved.headers.get("location"), "https://new-acme.g1t.page/a?b=1");
});
