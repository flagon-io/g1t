import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  type AgentRouting,
  type ChangeSize,
  DEFAULT_ROUTING,
  canReachModel,
  changeSize,
  chooseTier,
  failuresInARow,
  gatewaySession,
  lastAttemptFailed,
  leftLowConfidence,
  modelEnv,
  outcomesOf,
  parseRouting,
  route,
  taskOf,
  tierOfModel,
} from "./model-env.ts";

const routes: AgentRouting = {
  ...DEFAULT_ROUTING,
  tiers: {
    small: { modelName: "Claude Haiku 4.5", model: "claude-haiku-4-5-20251001" },
    large: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
    frontier: { modelName: "Claude Opus 5.5", model: "claude-opus-5-5" },
  },
};
const tags = { repo: "acme/site", pull: 12 };
const direct = { ANTHROPIC_API_KEY: "sk-test", AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "acct" };

/** `ANTHROPIC_CUSTOM_HEADERS` as the harness reads it: one header per line. */
function customHeaders(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    vars.ANTHROPIC_CUSTOM_HEADERS.split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

const small: ChangeSize = { files: 3, lines: 80, sensitive: [] };

test("Auto starts each kind of job on its tier: fast for catching up and answering, standard for changes, most capable for plans", () => {
  assert.equal(chooseTier("update", {}, routes), "small");
  assert.equal(chooseTier("answer", {}, routes), "small");
  assert.equal(chooseTier("implement", {}, routes), "large");
  assert.equal(chooseTier("revise", {}, routes), "large");
  assert.equal(chooseTier("implement", { change: small }, routes), "large");
  assert.equal(chooseTier("plan", {}, routes), "frontier");
});

test("revising and answering go to the workspace's implement route and bill", () => {
  assert.equal(taskOf("revise"), "implement");
  assert.equal(taskOf("answer"), "implement");
  assert.equal(taskOf("review"), "review");
  assert.equal(taskOf("plan"), "plan");
});

test("a review is sized by its change: fast when small and safe, most capable when large", () => {
  assert.equal(chooseTier("review", { change: small }, routes), "small");
  assert.equal(chooseTier("review", { change: { ...small, lines: 200, files: 10 } }, routes), "small");
  assert.equal(chooseTier("review", { change: { ...small, lines: 201 } }, routes), "large");
  assert.equal(chooseTier("review", { change: { ...small, files: 11 } }, routes), "large");
  assert.equal(chooseTier("review", { change: { ...small, sensitive: ["CI workflows"] } }, routes), "large");
  assert.equal(chooseTier("review", { change: small, labels: ["Security"] }, routes), "large");
  assert.equal(chooseTier("review", { change: small, labels: ["docs"] }, routes), "small");
  assert.equal(chooseTier("review", { change: { ...small, files: 61 } }, routes), "frontier");
  assert.equal(chooseTier("review", { change: { ...small, lines: 3001 } }, routes), "frontier");
});

test("a review of a change g1t cannot size runs on the standard tier", () => {
  assert.equal(chooseTier("review", {}, routes), "large");
  assert.equal(chooseTier("review", { change: null }, routes), "large");
  assert.equal(chooseTier("review", { change: { files: 0, lines: 0, sensitive: [] } }, routes), "large");
});

test("labels move work: architecture to the most capable, documentation to the fast tier", () => {
  assert.equal(chooseTier("implement", { labels: ["Architecture"] }, routes), "frontier");
  assert.equal(chooseTier("review", { change: small, labels: ["architecture"] }, routes), "frontier");
  assert.equal(chooseTier("implement", { labels: ["docs"] }, routes), "small");
  assert.equal(chooseTier("answer", { labels: ["typo"] }, routes), "small");
  // A small label never takes a review or a plan down.
  assert.equal(chooseTier("plan", { labels: ["docs"] }, routes), "frontier");
  // Security outranks documentation.
  assert.equal(chooseTier("implement", { labels: ["docs", "security"] }, routes), "large");
});

test("a failed attempt goes one tier up, and repeated failures to the most capable", () => {
  assert.equal(chooseTier("update", { retry: true }, routes), "large");
  assert.equal(chooseTier("review", { change: small, retry: true }, routes), "large");
  assert.equal(chooseTier("implement", { failures: 1 }, routes), "frontier");
  assert.equal(chooseTier("update", { failures: 2 }, routes), "frontier");
  assert.equal(chooseTier("plan", { failures: 1 }, routes), "frontier");
  const why = route("update", { failures: 2 }, routes).reason;
  assert.equal(why, "Used the most capable model (Claude Opus 5.5): the last 2 attempts at this work failed.");
});

test("a change left at low confidence sends the next attempt one tier up", () => {
  assert.equal(chooseTier("revise", { lowConfidence: true }, routes), "frontier");
  assert.equal(chooseTier("update", { lowConfidence: true }, routes), "large");
});

test("a tier the workspace chose wins over Auto", () => {
  const chosen = route("review", { change: small, failures: 3, chosen: "large" }, routes);
  assert.equal(chosen.tier, "large");
  assert.equal(chosen.reason, "Used the standard model (Claude Sonnet 5.5): the workspace chose the standard model for this work.");
});

const ok = (tier: "small" | "large" | "frontier", n: number) => Array.from({ length: n }, () => ({ tier, ok: true }));
const bad = (tier: "small" | "large" | "frontier", n: number) => Array.from({ length: n }, () => ({ tier, ok: false }));

test("a repository whose fast runs finish nearly always steps the work down", () => {
  const history = [...ok("small", 9), ...bad("small", 1)];
  const routed = route("implement", { history }, routes);
  assert.equal(routed.tier, "small");
  assert.equal(routed.reason, "Used a fast model (Claude Haiku 4.5): it finished 9 of its last 10 runs like this here.");
  // Too few runs to tell, or not quite enough of them finished: no change.
  assert.equal(chooseTier("implement", { history: ok("small", 4) }, routes), "large");
  assert.equal(chooseTier("implement", { history: [...ok("small", 8), ...bad("small", 2)] }, routes), "large");
  // Plans step down from the most capable model the same way.
  assert.equal(chooseTier("plan", { history: ok("large", 6) }, routes), "large");
});

test("learning never steps down sensitive or labelled work, nor a retry", () => {
  const history = ok("small", 10);
  assert.equal(chooseTier("review", { change: { ...small, files: 20, sensitive: ["secrets"] }, history }, routes), "large");
  assert.equal(chooseTier("implement", { labels: ["security"], history }, routes), "large");
  assert.equal(chooseTier("implement", { failures: 1, history }, routes), "frontier");
});

test("a tier that fails half its runs in a repository hands the work up", () => {
  const history = [...bad("large", 3), ...ok("large", 2)];
  const routed = route("implement", { history }, routes);
  assert.equal(routed.tier, "frontier");
  assert.equal(routed.reason, "Used the most capable model (Claude Opus 5.5): the standard model failed 3 of its last 5 runs like this here.");
});

test("past runs are read by the tier they ran on and whether they did the work", () => {
  const runs = [
    { status: "running", model: "Claude Haiku 4.5" },
    { status: "succeeded", model: "Claude Haiku 4.5" },
    { status: "succeeded", model: "Claude Sonnet 5.5", confidence: { level: "low" } },
    { status: "failed", model: "Claude Opus 5.5" },
    { status: "stopped", halted: null, model: "Claude Haiku 4.5" },
    { status: "stopped", halted: "budget", model: "claude-haiku-4-5-20251001" },
    { status: "succeeded", model: "Claude Sonnet 5.5, through Acme" },
  ];
  assert.deepEqual(outcomesOf(runs, routes), [
    { tier: "small", ok: true },
    { tier: "large", ok: false },
    { tier: "frontier", ok: false },
    { tier: "small", ok: false },
    { tier: null, ok: true },
  ]);
  assert.equal(tierOfModel("Claude Opus 5.5", routes), "frontier");
  assert.equal(tierOfModel(null, routes), null);
});

test("failures are counted in a row, newest first, and confidence is read from the last finished one", () => {
  assert.equal(failuresInARow([]), 0);
  assert.equal(failuresInARow([{ status: "failed" }, { status: "failed" }, { status: "succeeded" }, { status: "failed" }]), 2);
  assert.equal(failuresInARow([{ status: "stopped", halted: "time" }, { status: "failed" }]), 2);
  assert.equal(failuresInARow([{ status: "stopped", halted: null }, { status: "failed" }]), 0);
  assert.equal(failuresInARow([{ status: "failed", title: "Add search" }, { status: "failed", title: "Other" }], "Add search"), 1);
  assert.equal(leftLowConfidence([{ status: "succeeded", confidence: { level: "low" } }]), true);
  assert.equal(leftLowConfidence([{ status: "succeeded", confidence: { level: "medium" } }]), false);
  assert.equal(leftLowConfidence([]), false);
});

test("a retry is the same work again after its latest attempt failed", () => {
  assert.equal(lastAttemptFailed([]), false);
  assert.equal(lastAttemptFailed([{ status: "failed" }, { status: "succeeded" }]), true);
  assert.equal(lastAttemptFailed([{ status: "succeeded" }, { status: "failed" }]), false);
  assert.equal(lastAttemptFailed([{ status: "stopped", halted: "budget" }]), true);
  assert.equal(lastAttemptFailed([{ status: "stopped", halted: null }]), false);
  assert.equal(lastAttemptFailed([{ status: "running" }]), false);
  assert.equal(lastAttemptFailed([{ status: "failed", title: "Add search" }], "Add search "), true);
  assert.equal(lastAttemptFailed([{ status: "failed", title: "Add search" }], "Add billing"), false);
});

test("the configuration decides the catalogue, the rules and the limits", () => {
  const parsed = parseRouting(
    JSON.stringify({
      tiers: { small: { modelName: "Small", model: "small-1" }, frontier: { model: "" } },
      tasks: { update: "large", plan: "huge", answer: "change" },
      smallChange: { lines: 50 },
      frontierLabels: ["hard"],
      learning: { minRuns: 3 },
    }),
  );
  assert.deepEqual(parsed.tiers.small, { modelName: "Small", model: "small-1" });
  assert.deepEqual(parsed.tiers.large, DEFAULT_ROUTING.tiers.large);
  // A tier with no model keeps the default.
  assert.deepEqual(parsed.tiers.frontier, DEFAULT_ROUTING.tiers.frontier);
  assert.equal(chooseTier("update", {}, parsed), "large");
  // A rule that names no tier keeps the default.
  assert.equal(chooseTier("plan", {}, parsed), "frontier");
  assert.equal(parsed.tasks.answer, "change");
  assert.equal(chooseTier("review", { change: { ...small, lines: 51 } }, parsed), "large");
  assert.equal(chooseTier("review", { change: { ...small, files: 10, lines: 50 } }, parsed), "small");
  assert.equal(chooseTier("implement", { labels: ["hard"] }, parsed), "frontier");
  assert.equal(parsed.learning.minRuns, 3);
  assert.equal(parsed.learning.window, DEFAULT_ROUTING.learning.window);
  assert.deepEqual(parseRouting(undefined), DEFAULT_ROUTING);
  assert.deepEqual(parseRouting("not json"), DEFAULT_ROUTING);
  assert.deepEqual(parseRouting("[1]"), DEFAULT_ROUTING);
});

test("the routing the runner ships with is the default, written as configuration", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const line = config.split("\n").find((l) => l.trim().startsWith('"AGENT_ROUTING"'));
  assert.ok(line, "wrangler.jsonc sets AGENT_ROUTING");
  const value = JSON.parse(line.trim().replace(/^"AGENT_ROUTING":\s*/, "").replace(/,$/, ""));
  assert.deepEqual(parseRouting(value), DEFAULT_ROUTING);
});

test("a change's size is its files and the lines added and removed", () => {
  assert.deepEqual(
    changeSize([{ additions: 10, deletions: 2 }, { additions: 0, deletions: 5 }], ["secrets"]),
    { files: 2, lines: 17, sensitive: ["secrets"] },
  );
});

test("the tier decides the model, and the harness's small tasks use the small tier", () => {
  const large = modelEnv(direct, routes, "implement", "large", tags);
  assert.equal(large.ANTHROPIC_MODEL, "claude-sonnet-5-5");
  assert.equal(large.AGENT_MODEL_NAME, "Claude Sonnet 5.5");
  assert.equal(large.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(large.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5-20251001");
  const review = modelEnv(direct, routes, "review", "small", tags);
  assert.equal(review.ANTHROPIC_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(review.AGENT_MODEL_NAME, "Claude Haiku 4.5");
});

test("without a gateway, requests go to the provider directly", () => {
  const vars = modelEnv(direct, routes, "implement", "large", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, undefined);
  assert.equal(vars.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("with a gateway, requests go through it and say what they are for", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, routes, "review", "large", tags);
  assert.equal(vars.ANTHROPIC_BASE_URL, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic");
  assert.deepEqual(customHeaders(vars), {
    "cf-aig-metadata": '{"task":"review","tier":"large","repo":"acme/site","pull":12}',
  });
});

test("a run straight to the gateway carries its session, so billing can settle it", () => {
  const session = gatewaySession();
  assert.match(session, /^rs_[0-9a-f]{24}$/);
  assert.notEqual(gatewaySession(), session);
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t" }, routes, "implement", "small", { ...tags, session });
  const metadata = JSON.parse(customHeaders(vars)["cf-aig-metadata"]);
  assert.equal(metadata.session, session);
  // The gateway keeps at most five metadata entries.
  assert.ok(Object.keys(metadata).length <= 5);
});

test("an authenticated gateway is sent its token", () => {
  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", "large", tags);
  assert.equal(customHeaders(vars)["cf-aig-authorization"], "Bearer tok");
  assert.equal(vars.ANTHROPIC_API_KEY, "sk-test");
});

test("when the gateway holds the provider's key, the sandbox never gets it", () => {
  const gatewayOnly = { AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" };
  assert.equal(canReachModel(gatewayOnly), true);
  assert.equal(modelEnv(gatewayOnly, routes, "implement", "large", tags).ANTHROPIC_API_KEY, "tok");
  assert.equal(canReachModel({ AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct" }), false);
  assert.equal(canReachModel(direct), true);
});

// A stand-in for the gateway: what a sandbox's agent sends, given these
// variables, arrives at the gateway's path with both credentials.
test("a request built from these variables reaches a gateway as expected", async () => {
  const seen: { url?: string; key?: string; gateway?: string; metadata?: string; model?: string } = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.url = request.url;
      seen.key = request.headers["x-api-key"] as string;
      seen.gateway = request.headers["cf-aig-authorization"] as string;
      seen.metadata = request.headers["cf-aig-metadata"] as string;
      seen.model = JSON.parse(body).model;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ type: "message", content: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  const vars = modelEnv({ ...direct, AI_GATEWAY_ID: "g1t", AI_GATEWAY_TOKEN: "tok" }, routes, "implement", "large", tags);
  // Same path as the real gateway, on the stand-in's address.
  const base = vars.ANTHROPIC_BASE_URL.replace("https://gateway.ai.cloudflare.com", `http://localhost:${port}`);
  await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": vars.ANTHROPIC_API_KEY, ...customHeaders(vars), "content-type": "application/json" },
    body: JSON.stringify({ model: vars.ANTHROPIC_MODEL, max_tokens: 1, messages: [] }),
  });
  server.close();

  assert.deepEqual(seen, {
    url: "/v1/acct/g1t/anthropic/v1/messages",
    key: "sk-test",
    gateway: "Bearer tok",
    metadata: '{"task":"implement","tier":"large","repo":"acme/site","pull":12}',
    model: "claude-sonnet-5-5",
  });
});
