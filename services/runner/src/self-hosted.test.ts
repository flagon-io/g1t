import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelTask, enqueueTask, handedOverStep, selfHostedRoute, taskEnv, taskRepo } from "./self-hosted.ts";

/** An actions service that answers each method with what `answers` says. */
function actions(answers: Record<string, unknown>, calls: { method: string; body: unknown }[] = []) {
  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const method = new URL(url).pathname.replace("/rpc/", "");
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      if (!(method in answers)) return new Response("no", { status: 500 });
      return Response.json(answers[method]);
    },
  };
}

const repo = { namespace: "Acme", name: "web" };

test("work goes to self-hosted runners only when the workspace says so", async () => {
  const calls: { method: string; body: unknown }[] = [];
  assert.deepEqual(await selfHostedRoute(actions({ runner_route: ["self-hosted", "linux"] }, calls), repo), ["self-hosted", "linux"]);
  assert.deepEqual(calls[0], { method: "runner_route", body: { workspace: "acme", repo } });
  assert.equal(await selfHostedRoute(actions({ runner_route: null }), repo), null);
  assert.equal(await selfHostedRoute(actions({ runner_route: [] }), repo), null);
  // The actions service cannot say: a sandbox, as before.
  assert.equal(await selfHostedRoute(actions({}), repo), null);
});

test("a task carries the sandbox's environment, without what only a sandbox has", () => {
  const env = taskEnv({
    MODE: "checks",
    G1T_TOKEN: "g1t_x",
    HTTPS_PROXY: "http://proxy",
    NODE_EXTRA_CA_CERTS: "/etc/ca.crt",
    GUARDRAILS: "{}",
  });
  assert.equal(env.MODE, "checks");
  assert.equal(env.G1T_TOKEN, "g1t_x");
  assert.equal(env.GUARDRAILS, "{}");
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(env.G1T_ABUSE, "off");
  assert.equal(env.G1T_SELF_HOSTED, "1");
});

test("handing over and withdrawing a task", async () => {
  const calls: { method: string; body: unknown }[] = [];
  const service = actions({ enqueue_task: { ok: true, value: "rtk_1" }, cancel_task: { ok: true, value: true } }, calls);
  const id = await enqueueTask(service, {
    sandbox: "do_1",
    repo,
    kind: "checks",
    title: "Checks on acme/web#3",
    labels: ["self-hosted"],
    env: { MODE: "checks" },
    timeoutMinutes: 45,
    runId: "run_9",
  });
  assert.equal(id, "rtk_1");
  assert.equal((calls[0]!.body as { workspace: string }).workspace, "acme");
  // The agent run it is goes as run_id, for the Runners page's links.
  assert.equal((calls[0]!.body as { run_id: string }).run_id, "run_9");
  await cancelTask(service, "do_1", "Stopped.");
  assert.deepEqual(calls[1], { method: "cancel_task", body: { sandbox: "do_1", reason: "Stopped." } });
  await assert.rejects(
    enqueueTask(actions({ enqueue_task: { ok: false, error: { message: "no key" } } }), {
      sandbox: "do_2",
      repo,
      kind: "agent",
      title: "x",
      labels: ["self-hosted"],
      env: {},
      timeoutMinutes: 1,
    }),
    /no key/,
  );
  // Never throws.
  await cancelTask(actions({}), "do_3", null);
});

test("the run says where it went and what is not enforced there", () => {
  assert.match(handedOverStep(["self-hosted", "linux"]), /self-hosted, linux.*guardrails are not enforced/);
});

test("a task's repository comes from what the sandbox was started with", () => {
  assert.deepEqual(taskRepo({ repo }, undefined, undefined), repo);
  assert.deepEqual(taskRepo(undefined, { repo: "acme/api" }, undefined), { namespace: "acme", name: "api" });
  assert.deepEqual(taskRepo(undefined, undefined, { repo: "acme/docs" }), { namespace: "acme", name: "docs" });
  assert.equal(taskRepo(undefined, undefined, undefined), null);
});
