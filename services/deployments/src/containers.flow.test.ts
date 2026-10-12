/**
 * A container build through the whole service, on Node: a D1 made of
 * node:sqlite with the service's migrations, the other services as fakes,
 * and Cloudflare's API (and its registry) as a recorded fetch. Run with
 * `--experimental-transform-types` (see package.json).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";

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
const { default: worker } = await import("./index.ts");

function d1(db: DatabaseSync) {
  const value = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...args: unknown[]) => statement(sql, args.map(value)),
    async first<T>() {
      return (db.prepare(sql).get(...(params as never[])) as T) ?? null;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...(params as never[])) as T[], success: true };
    },
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: ReturnType<typeof statement>[]) {
      return statements.map((s) => ({ results: db.prepare(s.sql).all(...(s.params as never[])) }));
    },
  };
}

const PROJECT = "prj_web";
const SCRIPT = "web-acme";
const TOKEN = "build-token";
const DIGEST = "b".repeat(64);
const IMAGE = `registry.cloudflare.com/acct/g1t-${SCRIPT}@sha256:${DIGEST}`;

function world(containers: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const project = {
    id: PROJECT,
    workspace: "acme",
    slug: "web",
    name: "web",
    primary: true,
    source: { kind: "hosted", repoId: "rep_web", repo: { namespace: "acme", name: "web" }, defaultBranch: "main", rootDir: null },
  };
  const ok = (value: unknown) => ({ ok: true, value });
  const service = (answer: (method: string, args: any) => unknown) => ({
    async fetch(input: string | Request, init?: RequestInit) {
      const url = typeof input === "string" ? input : input.url;
      const method = new URL(url).pathname.split("/").pop()!;
      const args = init?.body ? JSON.parse(String(init.body)) : {};
      return Response.json((await answer(method, args)) ?? ok(null));
    },
  });
  const state = { sqlite, charged: [] as any[], pending: [] as any[] };
  const env = {
    DB: d1(sqlite),
    CLOUDFLARE_API_TOKEN: "test",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "g1t-deployments",
    SITE: "https://g1t.sh",
    CONTAINERS: containers,
    REPOS: service(() => ok({ isPrivate: true })),
    PROJECTS: service((method) => (method === "by_repo" ? [project] : ok(project))),
    IDENTITY: service(() => ok(null)),
    BILLING: service((method, args) => {
      if (method === "prices") return { prices: [] };
      if (method === "charge_feature") state.charged.push(args);
      if (method === "note_pending") state.pending.push(args);
      return ok(true);
    }),
    WORK: service(() => ok(null)),
    ACTIONS: service(() => ({ secrets: { DATABASE_URL: "postgres://db" }, variables: { NODE_ENV: "production" } })),
    RUNNER: service(() => ok(true)),
  };
  return { state, env };
}

let w: ReturnType<typeof world>;
let calls: string[] = [];
let uploads: Record<string, any>[] = [];
let applications: { id: string; name: string }[] = [];
let registryHas = true;
const realFetch = globalThis.fetch;

function setUp(containers: string) {
  w = world(containers);
  calls = [];
  uploads = [];
  applications = [];
  registryHas = true;
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.host === "api.cloudflare.com" ? url.pathname.replace("/client/v4/accounts/acct", "") : url.host + url.pathname}`);
    const result = (value: unknown) => Response.json({ success: true, result: value });
    if (url.host === "registry.cloudflare.com") return new Response(null, { status: registryHas ? 200 : 404 });
    if (url.pathname.endsWith("/credentials")) return result({ username: "v1", password: "push-secret", registry_host: "registry.cloudflare.com" });
    if (method === "PUT" && url.pathname.includes("/scripts/")) {
      const form = init?.body as FormData;
      uploads.push(JSON.parse(String(form.get("metadata"))));
      return result({});
    }
    if (url.pathname.endsWith("/durable_objects/namespaces")) {
      return result([{ id: "ns1", class: "G1tApp", script: SCRIPT, dispatch_namespace: "g1t-deployments" }]);
    }
    if (url.pathname.endsWith("/containers/applications") && method === "GET") return result(applications);
    if (url.pathname.endsWith("/containers/applications") && method === "POST") {
      applications.push({ id: "app1", name: JSON.parse(String(init?.body)).name });
      return result({ id: "app1" });
    }
    if (url.pathname.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{}] } } });
    return result([]);
  }) as typeof fetch;
  const db = w.state.sqlite;
  db.prepare(
    `INSERT INTO settings (project_id, repo_id, workspace, slug, enabled, previews, production, idle_days, updated_at, build_as, instance_type)
     VALUES (?, 'rep_web', 'acme', 'web', 1, 1, 1, 7, '2026-10-12T00:00:00Z', 'docker', 'basic')`,
  ).run(PROJECT);
  open("dpl_1");
}

/** A build under way, as `open` leaves it. */
function open(id: string) {
  w.state.sqlite
    .prepare(
      `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, commit_sha, script, status, token_hash,
         trusted, created_by, created_at)
       VALUES (?, ?, 'acme', 'web', 'rep_web', 'acme/web', 'production', 'abc1234', ?, 'building', ?, 1, 'g1t', ?)`,
    )
    .run(id, PROJECT, SCRIPT, createHash("sha256").update(TOKEN).digest("hex"), new Date().toISOString());
}

beforeEach(() => setUp("on"));

process.on("exit", () => {
  globalThis.fetch = realFetch;
});

async function post(path: string, body: unknown): Promise<any> {
  const response = await worker.fetch(
    new Request(`https://deployments${path}`, { method: "POST", body: JSON.stringify(body) }),
    w.env as never,
    {} as never,
  );
  return { status: response.status, ...(await response.json()) };
}

const rows = (sql: string, ...params: unknown[]) =>
  (w.state.sqlite.prepare(sql).all(...(params as never[])) as any[]).map((row) => ({ ...row }));

const finish = (container: unknown) =>
  post("/jobs/dpl_1/finish", { token: TOKEN, worker: {}, detected: "container", framework: "node", container, buildSeconds: 20 });

test("while containers are off, the registry step says so in its own words", async () => {
  setUp("off");
  const answer = await post("/jobs/dpl_1/registry", { token: TOKEN });
  assert.equal(answer.status, 409);
  assert.equal(answer.error.code, "not_enabled");
  assert.ok(!calls.some((call) => call.includes("credentials")), "no login is minted");
});

test("a build gets a push-only login for its app's repository, held to its size", async () => {
  const answer = await post("/jobs/dpl_1/registry", { token: TOKEN });
  assert.deepEqual(answer.value, {
    registry: "registry.cloudflare.com",
    repository: `acct/g1t-${SCRIPT}`,
    tag: "dpl_1",
    username: "v1",
    password: "push-secret",
    maxImageBytes: 4_000_000_000,
    instanceType: "basic",
  });
  // Another build's token gets nothing.
  assert.equal((await post("/jobs/dpl_1/registry", { token: "nope" })).status, 404);
});

test("an image outside the app's repository, or not in the registry, is never run", async () => {
  const other = await finish({ image: `registry.cloudflare.com/acct/g1t-other@sha256:${DIGEST}`, port: 3000 });
  assert.deepEqual(other.value, false);
  assert.match(rows("SELECT error FROM deployments WHERE id = 'dpl_1'")[0].error, /did not report an image by digest/);
  assert.equal(uploads.length, 0);
  open("dpl_2");
  registryHas = false;
  const missing = await post("/jobs/dpl_2/finish", { token: TOKEN, detected: "container", container: { image: IMAGE } });
  assert.deepEqual(missing.value, false);
  assert.match(rows("SELECT error FROM deployments WHERE id = 'dpl_2'")[0].error, /is not in the registry/);
});

test("a container app runs behind g1t's Worker, is metered by its own token, and comes down whole", async () => {
  const done = await finish({ image: IMAGE, port: 3000, sizeBytes: 123 });
  assert.deepEqual(done.value, true);
  // g1t's Worker, its class, and the project's entries bound to it.
  const [metadata] = uploads;
  assert.deepEqual(metadata.exports, { G1tApp: { type: "durable-object", storage: "sqlite" } });
  const binding = (name: string) => metadata.bindings.find((b: any) => b.name === name);
  assert.equal(binding("G1T_PORT").text, "3000");
  assert.equal(binding("G1T_INSTANCE").text, "basic");
  assert.equal(binding("G1T_METER_URL").text, `https://api.g1t.sh/deployments/apps/${SCRIPT}/meter`);
  assert.deepEqual(binding("DATABASE_URL"), { type: "secret_text", name: "DATABASE_URL", text: "postgres://db" });
  assert.ok(calls.includes("POST /containers/applications"));
  assert.deepEqual(rows("SELECT runtime, container_app_id, instance_type FROM apps"), [{ runtime: "container", container_app_id: "app1", instance_type: "basic" }]);
  assert.deepEqual(rows("SELECT detected, framework, image, status FROM deployments WHERE id = 'dpl_1'"), [
    { detected: "container", framework: "node", image: IMAGE, status: "ready" },
  ]);
  // The next deploy rolls the application out to the new image.
  open("dpl_2");
  await post("/jobs/dpl_2/finish", { token: TOKEN, detected: "container", container: { image: IMAGE, port: 3000 } });
  assert.ok(calls.includes("POST /containers/applications/app1/rollouts"));

  // Its reports: only with the token it was deployed with, each counter only raised.
  const token = uploads.at(-1)!.bindings.find((b: any) => b.name === "G1T_METER_TOKEN").text;
  const month = new Date().toISOString().slice(0, 7);
  const report = { token, epoch: "epoch-0001", month, awakeSeconds: 3600, egressBytes: 1_000_000_000, instanceType: "basic" };
  assert.equal((await post(`/apps/${SCRIPT}/meter`, { ...report, token: "wrong" })).status, 404);
  assert.equal((await post(`/apps/${SCRIPT}/meter`, report)).status, 200);
  await post(`/apps/${SCRIPT}/meter`, { ...report, awakeSeconds: 60 });
  assert.deepEqual(rows("SELECT awake_seconds, egress_bytes FROM container_meters"), [{ awake_seconds: 3600, egress_bytes: 1_000_000_000 }]);

  // It is noted for the spend limit as it runs: basic for an hour, and 1 GB at $0.05.
  w.state.sqlite.exec("INSERT OR IGNORE INTO meters (namespace, month) VALUES ('acme', strftime('%Y-%m', 'now'))");
  await worker.scheduled({} as never, w.env as never);
  const pending = w.state.pending.find((p) => p.workspace === "acme");
  const second = 0.25 * 20 + 1 * 2.5 + 4 * 0.07 + 1.5625;
  assert.equal(pending.costMicros, Math.ceil(second * 3600 + 50_000));
  assert.match(pending.detail, /1 container hours and 1 GB sent/);

  // Taken down: its container first, then its Worker.
  calls = [];
  await post("/rpc/take_down", { actor: { id: "usr_1", username: "a", kind: "user", workspaces: [{ slug: "acme", role: "owner" }] }, project: { workspace: "acme", slug: "web" }, branch: null });
  const deleteApp = calls.indexOf("DELETE /containers/applications/app1");
  const deleteScript = calls.findIndex((call) => call.startsWith("DELETE /workers/dispatch/namespaces/g1t-deployments/scripts/web-acme"));
  assert.ok(deleteApp >= 0 && deleteScript > deleteApp, calls.join("\n"));
});

test("a paused container app keeps its class and stops serving", async () => {
  await finish({ image: IMAGE, port: 3000 });
  uploads = [];
  // Its workspace reached its limit.
  w.env.BILLING = {
    async fetch(input: string | Request, init?: RequestInit) {
      const method = new URL(typeof input === "string" ? input : input.url).pathname.split("/").pop();
      if (method === "check_limit") return Response.json({ ok: true, value: { state: "stopped" } });
      if (method === "prices") return Response.json({ prices: [] });
      return Response.json({ ok: true, value: true, init: !!init });
    },
  } as never;
  await worker.scheduled({} as never, w.env as never);
  const paused = uploads.find((u) => u.bindings.some((b: any) => b.name === "G1T_MODE" && b.text === "paused"));
  assert.ok(paused, "the Worker was put back paused");
  assert.deepEqual(paused.exports, { G1tApp: { type: "durable-object", storage: "sqlite" } });
  assert.ok(!paused.bindings.some((b: any) => b.name === "DATABASE_URL"), "a paused app holds no secrets");
  assert.ok(rows("SELECT paused_at FROM apps")[0].paused_at);
});
