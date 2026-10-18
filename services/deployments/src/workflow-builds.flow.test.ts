/**
 * The whole service, on Node, opening builds for g1t Actions jobs
 * (`start_from_workflow`): a D1 made of node:sqlite with the service's
 * migrations, the other services as fakes that answer by method, and
 * Cloudflare's API as a recorded fetch. See moves.flow.test.ts.
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

const REPO = "rep_web";
const PROJECT = "prj_web";
const SHA = "4b8d0f2a6c1e3579bd02468ace13579bdf02468a";

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const state = {
    sqlite,
    run: { id: "run_1", event: "push", ref: "refs/heads/main", sha: SHA, pull: null as number | null, status: "in_progress", actor: "ada" },
    jobStatus: "in_progress",
    approval: null as null | { state: string },
    pull: { status: "open", headCommit: SHA, branch: "feature" as string | null, fork: null as null | { namespace: string; name: string } },
    collaborator: "write",
    plan: true,
    limit: "ok",
    /** Billing does not take charges (it is down, say). */
    chargeFails: false,
    /** What other services were asked, as `SERVICE method`. */
    calls: [] as string[],
    /** What `resolve_settings` was asked for. */
    resolved: [] as { environment: string; trusted: boolean }[],
  };
  const project = () => ({
    id: PROJECT,
    workspace: "acme",
    slug: "web",
    name: "web",
    primary: true,
    source: { kind: "hosted", repoId: REPO, repo: { namespace: "acme", name: "web" }, defaultBranch: "main", rootDir: "site" },
  });
  const ok = (value: unknown) => ({ ok: true, value });
  const service = (name: string, answer: (method: string, args: any) => unknown) => ({
    async fetch(input: string | Request, init?: RequestInit) {
      const url = typeof input === "string" ? input : input.url;
      const method = new URL(url).pathname.split("/").pop()!;
      state.calls.push(`${name} ${method}`);
      const args = init?.body ? JSON.parse(String(init.body)) : {};
      return Response.json((await answer(method, args)) ?? ok(null));
    },
  });
  const env = {
    DB: d1(sqlite),
    CLOUDFLARE_API_TOKEN: "test",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "g1t-deployments",
    SITE: "https://g1t.sh",
    REPOS: service("REPOS", (method) => {
      if (method === "get") return ok({ id: REPO, namespace: "acme", name: "web", isPrivate: true, defaultBranch: "main" });
      return ok([]);
    }),
    PROJECTS: service("PROJECTS", (method) => (method === "by_repo" ? [project()] : ok(project()))),
    IDENTITY: service("IDENTITY", (method, args) => {
      if (method === "get_workspace") return { id: `wsp_${args.slug}`, slug: args.slug };
      if (method === "collaborator_permission") return ok({ role: state.collaborator });
      return ok(null);
    }),
    BILLING: service("BILLING", (method) => {
      if (method === "has_feature")
        return state.plan ? ok(true) : { ok: false, error: { code: "payment_required", message: "Deployments need the Team plan." } };
      if (method === "check_limit") return ok({ state: state.limit, message: state.limit === "stopped" ? "The workspace reached its spend limit." : null });
      if (method === "prices") return { prices: [] };
      if (method === "charge_feature" && state.chargeFails) return { ok: false, error: { code: "unavailable", message: "billing is down" } };
      return ok(null);
    }),
    WORK: service("WORK", (method) => {
      if (method === "get_pull") return ok({ pull: { ...state.pull, number: 9, author: { username: "eve", kind: "user" } } });
      return ok(null);
    }),
    ACTIONS: service("ACTIONS", (method, args) => {
      if (method === "run") {
        return ok({ run: state.run, jobs: [{ id: "job_1", status: state.jobStatus }], notes: [], approval: state.approval });
      }
      if (method === "resolve_settings") {
        state.resolved.push({ environment: args.environment, trusted: args.trusted });
        return { secrets: { API_KEY: "s3cret-value" }, variables: { PUBLIC_URL: "https://example.com" } };
      }
      return ok(null);
    }),
    RUNNER: service("RUNNER", () => ok(true)),
  };
  return { state, env };
}

let w: ReturnType<typeof world>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  w = world();
  globalThis.fetch = (async (input: string | Request) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    w.state.calls.push(`CLOUDFLARE ${url.pathname}`);
    if (url.pathname.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{}] } } });
    return Response.json({ success: true, result: { jwt: "done", buckets: [] }, result_info: { total_pages: 1 } });
  }) as typeof fetch;
  w.state.sqlite
    .prepare(
      `INSERT INTO settings (project_id, repo_id, workspace, slug, enabled, previews, production, idle_days, updated_at)
       VALUES (?, ?, 'acme', 'web', 1, 1, 1, 7, '2026-10-05T00:00:00Z')`,
    )
    .run(PROJECT, REPO);
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});

const jobActor = (scopes: string[] = ["contents:read", "deployments:write"]) => ({
  id: "wsp_acme",
  username: "acme",
  kind: "workspace",
  verified: true,
  workspaces: [{ slug: "acme", role: "member" }],
  token: { token_id: "tok_job", repo: "acme/web", job: { run_id: "run_1", job_id: "job_1" }, scopes },
});

async function post(path: string, body: unknown): Promise<any> {
  const response = await worker.fetch(new Request(`https://deployments${path}`, { method: "POST", body: JSON.stringify(body) }), w.env as never, {} as never);
  return response.json();
}

const open = (body: Record<string, unknown> = {}) => post("/rpc/start_from_workflow", { actor: jobActor(), repo: { namespace: "acme", name: "web" }, ...body });

const rows = (sql: string, ...params: unknown[]) => (w.state.sqlite.prepare(sql).all(...(params as never[])) as any[]).map((row) => ({ ...row }));

test("a push to the production branch opens a production build the job runs, with no sandbox and nothing reserved", async () => {
  const answer = await open();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const build = answer.value;
  assert.equal(build.kind, "production");
  assert.equal(build.project, "web");
  assert.equal(build.commit, SHA);
  assert.equal(build.url, "https://web-acme.g1t.page");
  assert.equal(build.trusted, true);
  assert.equal(build.root_dir, "site");
  assert.deepEqual(build.build_secrets, { API_KEY: "s3cret-value" });
  assert.deepEqual(build.build_env, { PUBLIC_URL: "https://example.com" });
  assert.match(build.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows("SELECT kind, status, run_id, job_id, created_by, trusted FROM deployments"), [
    { kind: "production", status: "queued", run_id: "run_1", job_id: "job_1", created_by: "ada", trusted: 1 },
  ]);
  // The job runs it: no sandbox, and no compute reserved for it.
  assert.ok(!w.state.calls.includes("RUNNER start_deploy"));
  assert.ok(!w.state.calls.some((call) => call === "BILLING reserve" || call === "BILLING entitlements"));
  // The commit's status says it is building.
  assert.ok(w.state.calls.includes("WORK set_commit_status"));
});

test("the job reports with the build's token, and its seconds are not charged again", async () => {
  const { value: build } = await open();
  assert.equal((await post(`/jobs/${build.deploy_id}/started`, { token: build.token })).ok, true);
  const finished = await post(`/jobs/${build.deploy_id}/finish`, {
    token: build.token,
    worker: { compatibilityDate: "2026-09-26", vars: {}, notFoundHandling: "single-page-application" },
    completionJwt: "done",
    buildSeconds: 42,
    detected: "static",
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(rows("SELECT error FROM deployments")[0].error, null);
  assert.deepEqual(rows("SELECT status, build_seconds, detected FROM deployments"), [{ status: "ready", build_seconds: 42, detected: "static" }]);
  assert.deepEqual(rows("SELECT script, kind FROM apps"), [{ script: "web-acme", kind: "production" }]);
  assert.ok(!w.state.calls.includes("BILLING charge_feature"));
  assert.deepEqual(rows("SELECT build_seconds FROM meters WHERE build_seconds > 0"), []);
  // The token was for that build alone, until it finished.
  assert.equal((await post(`/jobs/${build.deploy_id}/started`, { token: build.token })).ok, false);
});

test("a sandbox's build is still charged by the second; a workflow job's never is", async () => {
  // A classic build: what a push opens, built by g1t's sandbox.
  const { createHash } = await import("node:crypto");
  const token = "f".repeat(64);
  w.state.sqlite
    .prepare(
      `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, branch, number, commit_sha, script, status,
         token_hash, trusted, created_by, created_at)
       VALUES ('dpl_sandbox', ?, 'acme', 'web', ?, 'acme/web', 'preview', 'other', NULL, ?, 'web-git-other-acme', 'building', ?, 1, 'g1t', '2026-10-12T00:00:00Z')`,
    )
    .run(PROJECT, REPO, SHA, createHash("sha256").update(token).digest("hex"));
  const finish = { worker: { compatibilityDate: "2026-09-26", vars: {} }, completionJwt: "done", buildSeconds: 30 };
  assert.equal((await post("/jobs/dpl_sandbox/finish", { token, ...finish })).ok, true);
  assert.equal(w.state.calls.filter((call) => call === "BILLING charge_feature").length, 1);
  assert.deepEqual(rows("SELECT build_seconds FROM meters"), [{ build_seconds: 30 }]);
  // A workflow job's build of the same project, finished and then failed: not charged.
  const { value: done } = await open();
  assert.equal((await post(`/jobs/${done.deploy_id}/finish`, { token: done.token, ...finish })).ok, true);
  const { value: failed } = await open();
  await post(`/jobs/${failed.deploy_id}/fail`, { token: failed.token, message: "npm run build failed", buildSeconds: 99 });
  assert.equal(w.state.calls.filter((call) => call === "BILLING charge_feature").length, 1);
  assert.deepEqual(rows("SELECT build_seconds FROM meters"), [{ build_seconds: 30 }]);
  // What runs after the build is the same app as any: in apps, which the sweep meters.
  assert.deepEqual(rows("SELECT script, kind FROM apps ORDER BY script"), [
    { script: "web-acme", kind: "production" },
    { script: "web-git-other-acme", kind: "preview" },
  ]);
});

test("a build billing cannot charge still goes live and is announced; the sweep charges it once, later", async () => {
  const { createHash } = await import("node:crypto");
  const token = "e".repeat(64);
  w.state.sqlite
    .prepare(
      `INSERT INTO deployments (id, project_id, workspace, slug, repo_id, repo, kind, branch, number, commit_sha, script, status,
         token_hash, trusted, created_by, created_at)
       VALUES ('dpl_owed', ?, 'acme', 'web', ?, 'acme/web', 'preview', 'other', NULL, ?, 'web-git-other-acme', 'building', ?, 1, 'g1t', '2026-10-12T00:00:00Z')`,
    )
    .run(PROJECT, REPO, SHA, createHash("sha256").update(token).digest("hex"));
  w.state.chargeFails = true;
  const finished = await post("/jobs/dpl_owed/finish", {
    token,
    worker: { compatibilityDate: "2026-09-26", vars: {} },
    completionJwt: "done",
    buildSeconds: 30,
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  // Live and said so, though billing refused the charge.
  assert.deepEqual(rows("SELECT status, build_seconds, build_charged_at FROM deployments"), [{ status: "ready", build_seconds: 30, build_charged_at: null }]);
  assert.ok(w.state.calls.includes("WORK set_commit_status"));
  assert.deepEqual(rows("SELECT build_seconds FROM meters WHERE build_seconds > 0"), []);
  // Still down: the sweep tries and keeps it.
  await worker.scheduled({} as never, w.env as never);
  assert.equal(rows("SELECT build_charged_at FROM deployments")[0].build_charged_at, null);
  // Back: charged once, counted once, and never again.
  w.state.chargeFails = false;
  const before = w.state.calls.filter((call) => call === "BILLING charge_feature").length;
  await worker.scheduled({} as never, w.env as never);
  await worker.scheduled({} as never, w.env as never);
  assert.equal(w.state.calls.filter((call) => call === "BILLING charge_feature").length, before + 1);
  assert.notEqual(rows("SELECT build_charged_at FROM deployments")[0].build_charged_at, null);
  assert.deepEqual(rows("SELECT build_seconds FROM meters WHERE build_seconds > 0"), [{ build_seconds: 30 }]);
});

test("another branch builds its preview; a pull request's run builds the pull request's", async () => {
  w.state.run = { ...w.state.run, ref: "refs/heads/feature/x" };
  const branch = (await open()).value;
  assert.deepEqual([branch.kind, branch.branch, branch.number], ["preview", "feature/x", null]);
  w.state.run = { ...w.state.run, event: "pull_request", ref: "refs/pull/9/merge", pull: 9 };
  const pull = (await open()).value;
  assert.deepEqual([pull.kind, pull.branch, pull.number, pull.trusted], ["preview", "feature", 9, true]);
  assert.deepEqual(
    w.state.resolved.map((r) => r.environment),
    ["preview", "preview"],
  );
});

test("a pull request from a fork, or one that had to be approved, gets no build secrets", async () => {
  w.state.run = { ...w.state.run, event: "pull_request", ref: "refs/pull/9/merge", pull: 9 };
  w.state.pull = { ...w.state.pull, branch: null, fork: { namespace: "eve", name: "web" } };
  const fork = (await open()).value;
  assert.deepEqual([fork.branch, fork.trusted, fork.build_secrets], ["pr-9", false, {}]);
  w.state.pull = { ...w.state.pull, branch: "feature", fork: null };
  w.state.approval = { state: "approved" };
  const approved = (await open()).value;
  assert.deepEqual([approved.trusted, approved.build_secrets], [false, {}]);
  assert.deepEqual(
    w.state.resolved.map((r) => r.trusted),
    [false, false],
  );
});

test("it is refused without a job's write token, after the job, without the plan, or with previews off", async () => {
  const refused = async (body: Record<string, unknown>) => (await open(body)).error?.code;
  assert.equal(await refused({ actor: jobActor(["deployments:read"]) }), "forbidden");
  assert.equal(await refused({ actor: { ...jobActor(), token: { token_id: "tok_person", scopes: null } } }), "forbidden");
  assert.equal(await refused({ repo: { namespace: "acme", name: "api" } }), "forbidden");
  assert.equal(await refused({ project: "docs" }), "not_found");
  w.state.jobStatus = "completed";
  assert.equal(await refused({}), "conflict");
  w.state.jobStatus = "in_progress";
  w.state.run = { ...w.state.run, ref: "refs/tags/v1.0.0" };
  assert.equal(await refused({}), "invalid");
  w.state.run = { ...w.state.run, ref: "refs/heads/main" };
  w.state.plan = false;
  const unpaid = await open();
  assert.deepEqual([unpaid.ok, unpaid.error.code], [false, "payment_required"]);
  assert.deepEqual(rows("SELECT status FROM deployments"), [{ status: "skipped" }]);
  w.state.plan = true;
  w.state.limit = "stopped";
  const stopped = await open();
  assert.deepEqual([stopped.ok, stopped.error.code, stopped.error.message], [false, "payment_required", "The workspace reached its spend limit."]);
  w.state.limit = "ok";
  w.state.sqlite.prepare("UPDATE settings SET previews = 0").run();
  w.state.run = { ...w.state.run, ref: "refs/heads/feature" };
  assert.equal(await refused({}), "conflict");
  assert.ok(!w.state.calls.includes("RUNNER start_deploy"));
});

test("a job that ends without finishing its build fails the build at once, and leaves a finished one be", async () => {
  const build = (await open()).value;
  const ended = await post("/rpc/workflow_job_ended", { jobId: "job_1", conclusion: "cancelled" });
  assert.deepEqual(ended, { ok: true, value: 1 });
  assert.deepEqual(rows("SELECT id, status, error FROM deployments"), [
    { id: build.deploy_id, status: "failed", error: "The workflow job was cancelled before the build finished." },
  ]);
  // Another job's build, and one that is no longer open, are left alone.
  w.state.sqlite.prepare("UPDATE deployments SET job_id = 'job_2', status = 'building', error = NULL").run();
  assert.deepEqual(await post("/rpc/workflow_job_ended", { jobId: "job_1", conclusion: "success" }), { ok: true, value: 0 });
  assert.deepEqual(rows("SELECT status FROM deployments"), [{ status: "building" }]);
  w.state.sqlite.prepare("UPDATE deployments SET status = 'ready'").run();
  assert.deepEqual(await post("/rpc/workflow_job_ended", { jobId: "job_2", conclusion: "success" }), { ok: true, value: 0 });
  assert.deepEqual(rows("SELECT status FROM deployments"), [{ status: "ready" }]);
  assert.equal((await post("/rpc/workflow_job_ended", {})).error.code, "invalid");
});
