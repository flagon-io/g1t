/**
 * The whole service, on Node, following a repository transfer: a D1 made
 * of node:sqlite with the service's migrations, the other services as
 * fakes that answer by method, and Cloudflare's API as a recorded fetch.
 *
 * Run with `--experimental-transform-types` (see package.json): the
 * service's own modules import without extensions, so a resolve hook adds
 * them.
 */

import assert from "node:assert/strict";
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

// ---- D1, on node:sqlite ------------------------------------------------

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
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => ({ results: db.prepare(s.sql).all(...(s.params as never[])) }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// ---- The world ------------------------------------------------------------

const API = "rep_api";
const PROJECT = "prj_api";

type World = ReturnType<typeof world>;

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const state = {
    sqlite,
    /** Where the repository is now. */
    path: { namespace: "flagon-io", name: "lab-api" },
    /** Where the projects service has the project now. */
    projectWorkspace: "flagon-io",
    /** Each workspace's usage limit state. */
    limits: new Map<string, string>([["syntaqx", "stopped"]]),
    runnerUp: true,
    /** Builds the runner was asked for: deploy id and token. */
    builds: [] as { deployId: string; token: string; workspace: string }[],
    /** Cloudflare API calls, as `METHOD path`. */
    cloudflare: [] as string[],
    kv: new Map<string, { value: string; expiration?: number }>(),
  };
  const project = () => ({
    id: PROJECT,
    workspace: state.projectWorkspace,
    slug: "lab-api",
    name: "lab-api",
    primary: true,
    source: { kind: "hosted", repoId: API, repo: { ...state.path }, defaultBranch: "main", rootDir: null },
  });
  const ok = (value: unknown) => ({ ok: true, value });
  const service = (answer: (method: string, args: any) => unknown) => ({
    async fetch(input: string | Request, init?: RequestInit) {
      const url = typeof input === "string" ? input : input.url;
      const method = new URL(url).pathname.split("/").pop()!;
      const args = init?.body ? JSON.parse(String(init.body)) : {};
      const answered = await answer(method, args);
      if (answered instanceof Response) return answered;
      return Response.json(answered ?? ok(null));
    },
  });
  const env = {
    DB: d1(sqlite),
    CLOUDFLARE_API_TOKEN: "test",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "g1t-deployments",
    SITE: "https://g1t.sh",
    DOMAINS: {
      async get(key: string) {
        const found = state.kv.get(key);
        return found ? JSON.parse(found.value) : null;
      },
      async put(key: string, value: string, options?: { expiration?: number }) {
        state.kv.set(key, { value, expiration: options?.expiration });
      },
      async delete(key: string) {
        state.kv.delete(key);
      },
    },
    REPOS: service((method) => {
      if (method === "path_by_id") return state.path;
      if (method === "get") return ok({ isPrivate: true });
      return ok([]);
    }),
    PROJECTS: service((method) => {
      if (method === "by_repo") return [project()];
      if (method === "graph") return { dependsOn: [], usedBy: [] };
      return ok(project());
    }),
    IDENTITY: service((method, args) => {
      if (method === "get_workspace") return { id: `wsp_${args.slug}`, slug: args.slug };
      if (method === "collaborator_permission") return ok({ role: "write" });
      return ok(null);
    }),
    BILLING: service((method, args) => {
      if (method === "has_feature") return ok(true);
      if (method === "check_limit") return ok({ state: state.limits.get(args.workspace) ?? "ok" });
      if (method === "entitlements") return ok({ plan: "paid" });
      if (method === "reserve") return ok({ id: "res_1", paidBy: "credit" });
      if (method === "prices") return { prices: [] };
      return ok(null);
    }),
    WORK: service((method) => {
      if (method === "get_pull") {
        return ok({ pull: { status: "open", headCommit: "pr1head", branch: "v2", author: { username: "syntaqx", kind: "user" } } });
      }
      return ok(null);
    }),
    ACTIONS: service(() => ({ secrets: {}, variables: {} })),
    RUNNER: service((method, args) => {
      if (!state.runnerUp) return new Response("unavailable", { status: 503 });
      if (method === "start_deploy") state.builds.push({ deployId: args.deployId, token: args.token, workspace: args.workspace });
      return ok(true);
    }),
  };
  return { state, env };
}

let w: World;
const realFetch = globalThis.fetch;

beforeEach(() => {
  w = world();
  // Cloudflare's API: every call succeeds, and none lists anything.
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    w.state.cloudflare.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{}] } } });
    return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
  }) as typeof fetch;
  // As production was on 2026-10-06: the project's rows still in syntaqx,
  // its apps paused there by syntaqx's limit, minutes before the transfer.
  const db = w.state.sqlite;
  db.prepare(
    `INSERT INTO settings (project_id, repo_id, workspace, slug, enabled, previews, production, idle_days, updated_at)
     VALUES (?, ?, 'syntaqx', 'lab-api', 1, 1, 1, 7, '2026-10-05T00:00:00Z')`,
  ).run(PROJECT, API);
  const app = db.prepare(
    `INSERT INTO apps (script, project_id, workspace, slug, kind, branch, number, commit_sha, deployed_at, created_at, paused_at)
     VALUES (?, ?, 'syntaqx', 'lab-api', ?, ?, ?, ?, '2026-10-05T00:26:29Z', '2026-10-05T00:26:29Z', '2026-10-06T01:20:54Z')`,
  );
  app.run("lab-api-syntaqx", PROJECT, "production", null, null, "8e500b1");
  app.run("lab-api-git-v2-syntaqx", PROJECT, "preview", "v2", 1, "d2ca224");
  const deployment = db.prepare(
    `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, branch, number, commit_sha, script, status,
       trusted, created_by, created_at, finished_at)
     VALUES (?, ?, 'syntaqx', 'lab-api', ?, 'syntaqx/lab-api', ?, ?, ?, ?, ?, 'ready', 1, 'g1t', '2026-10-05T00:26:00Z', '2026-10-05T00:26:29Z')`,
  );
  deployment.run("dpl_prod", PROJECT, API, "production", null, null, "8e500b1", "lab-api-syntaqx");
  deployment.run("dpl_prev", PROJECT, API, "preview", "v2", 1, "d2ca224", "lab-api-git-v2-syntaqx");
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});

const transferred = {
  id: "evt_1",
  type: "repo.transferred",
  source: "repos",
  time: "2026-10-06T01:23:38Z",
  repoId: API,
  actor: "usr_1",
  data: { from: "syntaqx", name: "lab-api", repoId: API, to: "flagon-io" },
};

/** Delivers the event as the queue would; whether it was acked. */
async function deliver(event: unknown, attempts = 1): Promise<boolean> {
  let acked = false;
  let retried = false;
  const message = { body: event, attempts, ack: () => (acked = true), retry: () => (retried = true) };
  await worker.queue({ messages: [message] } as never, w.env as never);
  assert.notEqual(acked, retried);
  return acked;
}

const rows = (sql: string, ...params: unknown[]) =>
  (w.state.sqlite.prepare(sql).all(...(params as never[])) as any[]).map((row) => ({ ...row }));

test("a transfer rebuilds every app under the new workspace, paused ones too", async () => {
  assert.equal(await deliver(transferred), true);
  assert.deepEqual(rows("SELECT workspace FROM settings"), [{ workspace: "flagon-io" }]);
  const queued = rows("SELECT script, kind, commit_sha FROM deployments WHERE status = 'queued' ORDER BY script");
  assert.deepEqual(queued, [
    { script: "lab-api-flagon-io", kind: "production", commit_sha: "8e500b1" },
    { script: "lab-api-git-v2-flagon-io", kind: "preview", commit_sha: "pr1head" },
  ]);
  assert.equal(w.state.builds.length, 2);
  assert.ok(w.state.builds.every((b) => b.workspace === "flagon-io"));
});

test("a second delivery builds nothing more", async () => {
  await deliver(transferred);
  assert.equal(await deliver(transferred, 2), true);
  assert.equal(w.state.builds.length, 2);
  assert.equal(rows("SELECT id FROM deployments WHERE status = 'queued'").length, 2);
});

test("a rebuild that could not be queued is not acked, and the next delivery queues it", async () => {
  w.state.runnerUp = false;
  assert.equal(await deliver(transferred), false);
  // The rows moved, but nothing is building.
  assert.deepEqual(rows("SELECT workspace FROM settings"), [{ workspace: "flagon-io" }]);
  assert.equal(rows("SELECT id FROM deployments WHERE status IN ('queued', 'building')").length, 0);
  w.state.runnerUp = true;
  assert.equal(await deliver(transferred, 2), true);
  assert.deepEqual(
    rows("SELECT script FROM deployments WHERE status = 'queued' ORDER BY script").map((r) => r.script),
    ["lab-api-flagon-io", "lab-api-git-v2-flagon-io"],
  );
});

test("the sweep picks up a move whose deliveries ran out, keyed on the new workspace", async () => {
  w.state.runnerUp = false;
  await deliver(transferred);
  w.state.runnerUp = true;
  // A failed attempt was just made: the sweep waits before trying again.
  await worker.scheduled({} as never, w.env as never);
  assert.equal(rows("SELECT id FROM deployments WHERE status = 'queued'").length, 0);
  w.state.sqlite.exec("UPDATE deployments SET created_at = '2026-10-06T00:00:00Z' WHERE status = 'failed'");
  await worker.scheduled({} as never, w.env as never);
  assert.equal(rows("SELECT id FROM deployments WHERE status = 'queued'").length, 2);
  // syntaqx is over its limit, flagon-io is not: nothing of the project's is
  // paused for syntaqx's sake, and nothing new was paused at all.
  assert.ok(!w.state.cloudflare.some((call) => call.startsWith("PUT") && /scripts\/lab-api-flagon-io/.test(call)));
});

test("a move waits, without refused deployments, while the new workspace is over its limit", async () => {
  w.state.limits.set("flagon-io", "stopped");
  assert.equal(await deliver(transferred), true);
  assert.equal(rows("SELECT id FROM deployments WHERE created_at > '2026-10-06'").length, 0);
  w.state.limits.delete("flagon-io");
  await worker.scheduled({} as never, w.env as never);
  assert.equal(rows("SELECT id FROM deployments WHERE status = 'queued'").length, 2);
});

test("once the new app is live, the old address redirects to it, paused or not", async () => {
  await deliver(transferred);
  const build = w.state.builds.find((b) => rows("SELECT script FROM deployments WHERE id = ?", b.deployId)[0].script === "lab-api-flagon-io")!;
  const finish = await worker.fetch(
    new Request(`https://deployments/jobs/${build.deployId}/finish`, {
      method: "POST",
      body: JSON.stringify({ token: build.token, worker: { mainModule: "index.js", modules: [{ name: "index.js", contentBase64: btoa("export default {}"), contentType: "application/javascript+module" }] }, buildSeconds: 30 }),
    }),
    w.env as never,
    {} as never,
  );
  assert.deepEqual(await finish.json(), { ok: true, value: true });
  assert.deepEqual(
    rows("SELECT script, workspace FROM apps WHERE kind = 'production'"),
    [{ script: "lab-api-flagon-io", workspace: "flagon-io" }],
  );
  const [redirect] = rows("SELECT script, target, workspace FROM redirects");
  assert.deepEqual({ ...redirect }, { script: "lab-api-syntaqx", target: "lab-api-flagon-io.g1t.page", workspace: "flagon-io" });
  // The dispatcher's entry, followed before the old (paused) script runs.
  const entry = w.state.kv.get("lab-api-syntaqx.g1t.page")!;
  assert.deepEqual(JSON.parse(entry.value), { script: "lab-api-syntaqx", redirect: "lab-api-flagon-io.g1t.page" });
  assert.ok(entry.expiration! > Date.now() / 1000 + 89 * 24 * 3600);
  // And the old script itself is the redirect too.
  assert.ok(w.state.cloudflare.some((call) => call === "PUT /client/v4/accounts/acct/workers/dispatch/namespaces/g1t-deployments/scripts/lab-api-syntaqx"));
  // The preview is still to come; the old one stays until it is live.
  assert.equal(rows("SELECT script FROM apps WHERE kind = 'preview'")[0].script, "lab-api-git-v2-syntaqx");
});

test("the sweep never pauses a moved app for its old workspace's limit", async () => {
  // Rows moved (as the event does) but no rebuild yet, and the apps not paused.
  w.state.sqlite.exec("UPDATE settings SET workspace = 'flagon-io'; UPDATE apps SET paused_at = NULL");
  w.state.runnerUp = false;
  await worker.scheduled({} as never, w.env as never);
  assert.deepEqual(rows("SELECT paused_at FROM apps").map((r) => r.paused_at), [null, null]);
  // When the project's own workspace is over its limit, they are paused.
  w.state.limits.set("flagon-io", "stopped");
  await worker.scheduled({} as never, w.env as never);
  assert.ok(rows("SELECT paused_at FROM apps").every((r) => r.paused_at));
});
