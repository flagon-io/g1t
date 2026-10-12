/**
 * Who may open a build from a workflow, what a run builds, and whether it
 * is trusted. `@g1t/contracts` imports its modules without extensions, so
 * a resolve hook adds them (as in moves.flow.test.ts).
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import type { User } from "@g1t/contracts";

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
const { commitOf, jobOf, projectNamed, readOnlyAllowed, runTrusted, targetOf } = await import("./workflow-builds.ts");

const repo = { namespace: "acme", name: "web" };
const jobToken = (token: Partial<NonNullable<User["token"]>>): User =>
  ({
    id: "wsp_acme",
    username: "acme",
    kind: "workspace",
    verified: true,
    workspaces: [{ slug: "acme", role: "member" }],
    token: { token_id: "tok_1", repo: "acme/web", job: { run_id: "run_1", job_id: "job_1" }, scopes: ["deployments:write"], ...token },
  }) as User;

test("only a workflow job's token for the repository, with deployments: write, opens a build", () => {
  assert.deepEqual(jobOf(jobToken({}), repo), { runId: "run_1", jobId: "job_1", writes: true });
  // write-all, and contents with deployments.
  assert.ok(!("error" in jobOf(jobToken({ scopes: ["contents:read", "deployments:write"] }), repo)));
  // A person's token, however wide, is not a job's.
  const person = { id: "usr_1", username: "ada", kind: "user", verified: true, token: { token_id: "tok_2", scopes: null } } as User;
  assert.match((jobOf(person, repo) as { error: string }).error, /g1t Actions job's token/);
  assert.match((jobOf(null, repo) as { error: string }).error, /g1t Actions job's token/);
  // Read only: what a pull request from outside gets. Its job is named,
  // and only a managed workflow's preview lets it through.
  assert.deepEqual(jobOf(jobToken({ scopes: ["deployments:read", "contents:read"] }), repo), { runId: "run_1", jobId: "job_1", writes: false });
  // Another repository's job.
  assert.match((jobOf(jobToken({ repo: "acme/api" }), repo) as { error: string }).error, /acme\/api, not acme\/web/);
  // Case does not matter in names.
  assert.ok(!("error" in jobOf(jobToken({ repo: "Acme/Web" }), repo)));
});

test("a run on the production branch builds production; another branch, its preview; a pull request, its own", () => {
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.deepEqual(targetOf({ event, ref: "refs/heads/main", pull: null }, "main"), { kind: "production" });
  }
  assert.deepEqual(targetOf({ event: "push", ref: "refs/heads/feature/x", pull: null }, "main"), { kind: "branch", branch: "feature/x" });
  assert.deepEqual(targetOf({ event: "push", ref: "main", pull: null }, "main"), { kind: "production" });
  assert.deepEqual(targetOf({ event: "pull_request", ref: "refs/pull/9/merge", pull: 9 }, "main"), { kind: "pull", number: 9 });
  assert.deepEqual(targetOf({ event: "pull_request_target", ref: "refs/heads/main", pull: 9 }, "main"), { kind: "pull", number: 9 });
  // The production branch is the project's, whatever it is called.
  assert.deepEqual(targetOf({ event: "push", ref: "refs/heads/main", pull: null }, "trunk"), { kind: "branch", branch: "main" });
  // A tag deploys nothing.
  assert.match((targetOf({ event: "push", ref: "refs/tags/v1.0.0", pull: null }, "main") as { error: string }).error, /refs\/tags\/v1.0.0/);
});

test("a run from a fork, from someone who cannot push, or one that needed approval gets no secrets", () => {
  assert.equal(runTrusted({ approval: null, pull: null, insider: true }), true);
  assert.equal(runTrusted({ approval: null, pull: { fork: null }, insider: true }), true);
  assert.equal(runTrusted({ approval: null, pull: { fork: { namespace: "eve", name: "web" } }, insider: true }), false);
  assert.equal(runTrusted({ approval: null, pull: { fork: null }, insider: false }), false);
  assert.equal(runTrusted({ approval: { state: "approved" }, pull: { fork: null }, insider: true }), false);
  assert.equal(runTrusted({ approval: { state: "required" }, pull: null, insider: true }), false);
});

test("the commit is the run's unless one is given", () => {
  const run = { sha: "4b8d0f2a6c1e3579bd02468ace13579bdf02468a" };
  assert.equal(commitOf(undefined, run), run.sha);
  assert.equal(commitOf("", run), run.sha);
  assert.equal(commitOf(" ABCDEF1 ", run), "abcdef1");
  assert.ok(typeof commitOf("main", run) === "object");
  assert.ok(typeof commitOf(7, run) === "object");
});

test("the project is the one named, or the only one with Deployments on", () => {
  const web = { slug: "web", on: true };
  const docs = { slug: "docs", on: false };
  const api = { slug: "api", on: true };
  const on = (p: { on: boolean }) => p.on;
  assert.equal(projectNamed([web, docs], on, null), web);
  assert.equal(projectNamed([web, docs], on, "Docs"), docs);
  assert.deepEqual(projectNamed([web, docs], on, "nope"), { error: "This repository has no project nope.", code: "not_found" });
  assert.deepEqual(projectNamed([docs], on, undefined), { error: "No project of this repository has Deployments on.", code: "conflict" });
  assert.deepEqual(projectNamed([web, api], on, ""), { error: "Name the project to build: web, api.", code: "invalid" });
});

test("a read-only token opens only a preview, and only from the deploy workflow g1t manages", () => {
  const managed = { path: "managed/deploy-web.yml" };
  const own = { path: ".g1t/workflows/deploy.yml" };
  assert.ok(readOnlyAllowed(managed, { kind: "pull", number: 4 }));
  assert.ok(readOnlyAllowed(managed, { kind: "branch", branch: "fix" }));
  assert.ok(!readOnlyAllowed(managed, { kind: "production" }));
  assert.ok(!readOnlyAllowed(own, { kind: "pull", number: 4 }));
  assert.ok(!readOnlyAllowed(managed, { error: "a tag" }));
});
