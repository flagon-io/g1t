// node --test "scripts/deploy/*.test.mjs"   (npm run test:deploy)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { announceDeploy, withDeployWindow } from "./status-window.mjs";
import { ROOT } from "./stack.mjs";

/** A fetch that keeps what it was asked, and answers `status`. */
function recorder(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response("{}", { status });
  };
  return { calls, fetchImpl };
}

test("a deploy is announced to status.g1t.sh with the token, and without one nothing is sent", async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal(await announceDeploy("started", { id: "abc123", env: { STATUS_DEPLOY_TOKEN: " t0k " }, fetchImpl }), true);
  assert.deepEqual(calls, [{ url: "https://status.g1t.sh/deploys", auth: "Bearer t0k", body: { phase: "started", id: "abc123" } }]);
  await announceDeploy("finished", { env: { STATUS_DEPLOY_TOKEN: "t", STATUS_URL: "http://localhost:8787/" }, fetchImpl });
  assert.deepEqual(calls[1], { url: "http://localhost:8787/deploys", auth: "Bearer t", body: { phase: "finished" } });
  const none = recorder();
  assert.equal(await announceDeploy("started", { id: "abc", env: {}, fetchImpl: none.fetchImpl }), false);
  assert.equal(none.calls.length, 0, "no token: silently nothing");
});

test("an announcement that fails is a warning, never a failed deploy", async () => {
  const lines = [];
  const refused = recorder(401);
  assert.equal(await announceDeploy("started", { env: { STATUS_DEPLOY_TOKEN: "t" }, fetchImpl: refused.fetchImpl, log: (l) => lines.push(l) }), false);
  const broken = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await announceDeploy("finished", { env: { STATUS_DEPLOY_TOKEN: "t" }, fetchImpl: broken, log: (l) => lines.push(l) }), false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /401/);
  assert.match(lines[1], /fetch failed/);
});

test("the stages run inside the window: started before, finished after, even when they throw; a dry run says nothing", async () => {
  const said = [];
  const announce = async (phase, { id }) => void said.push(`${phase} ${id}`);
  const order = [];
  const value = await withDeployWindow(
    async () => {
      order.push(said.length);
      return 42;
    },
    { id: "abc", announce },
  );
  assert.equal(value, 42);
  assert.deepEqual(said, ["started abc", "finished abc"]);
  assert.deepEqual(order, [1], "the work ran after started, before finished");

  said.length = 0;
  await assert.rejects(withDeployWindow(async () => Promise.reject(new Error("wrangler failed")), { id: "def", announce }), /wrangler failed/);
  assert.deepEqual(said, ["started def", "finished def"]);

  said.length = 0;
  await withDeployWindow(async () => 1, { id: "ghi", dryRun: true, announce });
  assert.deepEqual(said, []);
});

test("deploy.mjs announces every deploy, and the workflow passes it the token", () => {
  const tool = readFileSync(join(ROOT, "scripts", "deploy.mjs"), "utf8");
  assert.match(tool, /import \{ withDeployWindow \} from "\.\/deploy\/status-window\.mjs"/);
  assert.match(tool, /await withDeployWindow\(/);
  const workflow = readFileSync(join(ROOT, ".g1t", "workflows", "deploy.yml"), "utf8");
  // Every step that runs `deploy.mjs deploy` has the secret in its env.
  const steps = workflow.split(/\n\s+- name: /).filter((s) => /node scripts\/deploy\.mjs deploy /.test(s));
  assert.ok(steps.length >= 1);
  for (const s of steps) assert.match(s, /STATUS_DEPLOY_TOKEN: \$\{\{ secrets\.STATUS_DEPLOY_TOKEN \}\}/);
});
