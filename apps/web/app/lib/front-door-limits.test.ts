import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LIMIT_PERIOD_SECONDS,
  RATE_LIMITS,
  type RateLimitBinding,
  checkLimit,
  isLimited,
  secretKey,
} from "@g1t/contracts/rate-limits";

import { gitLimited, heavy, pageLimited, sessionCookie, unlimited, usercontentLimited } from "./front-door-limits.ts";

/** A binding that lets `allow` requests through per key, recording each key it was asked. */
function binding(allow: number): RateLimitBinding & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= allow };
    },
  };
}

const broken: RateLimitBinding = {
  async limit() {
    throw new Error("the binding is down");
  },
};

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://g1t.sh${path}`, { headers: { "cf-connecting-ip": "203.0.113.9", ...headers } });
}

test("a limit lets requests through until it is reached", async () => {
  const limit = binding(2);
  assert.equal(await checkLimit(limit, "ip:1"), "allowed");
  assert.equal(await checkLimit(limit, "ip:1"), "allowed");
  assert.equal(await checkLimit(limit, "ip:1"), "limited");
  assert.equal(await checkLimit(limit, "ip:2"), "allowed", "each key counts apart");
});

test("a missing or failing binding fails open", async () => {
  const logged = console.error;
  console.error = () => {};
  try {
    assert.equal(await checkLimit(undefined, "ip:1"), "unavailable");
    assert.equal(await checkLimit(broken, "ip:1"), "unavailable");
    assert.equal(await isLimited(broken, "ip:1"), false);
    assert.equal(await gitLimited({ GIT_ANONYMOUS_LIMIT: broken }, request("/acme/rocket.git/info/refs")), null);
    assert.equal(await pageLimited({ WEB_ADDRESS_LIMIT: broken, WEB_ANONYMOUS_LIMIT: broken }, request("/acme/rocket"), "/acme/rocket"), null);
  } finally {
    console.error = logged;
  }
});

test("secrets are keyed by a short hash, never as they are", async () => {
  const key = await secretKey("session", "s3cret-session");
  assert.match(key, /^session:[0-9a-f]{16}$/);
  assert.equal(await secretKey("session", "s3cret-session"), key);
  assert.notEqual(await secretKey("session", "another"), key);
});

test("git without credentials is limited by address, with a message git shows", async () => {
  const env = { GIT_ANONYMOUS_LIMIT: binding(1), GIT_SIGNED_LIMIT: binding(1) };
  const clone = () => request("/acme/rocket.git/info/refs");
  assert.equal(await gitLimited(env, clone()), null);
  const refused = await gitLimited(env, clone());
  assert.equal(refused?.status, 429);
  assert.equal(refused?.headers.get("retry-after"), String(LIMIT_PERIOD_SECONDS));
  assert.match(refused?.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match((await refused?.text()) ?? "", /Too many git requests/);
  assert.deepEqual(env.GIT_ANONYMOUS_LIMIT.keys, ["ip:203.0.113.9", "ip:203.0.113.9"]);
});

test("git with credentials counts by a hash of them, apart from the address", async () => {
  const env = { GIT_ANONYMOUS_LIMIT: binding(0), GIT_SIGNED_LIMIT: binding(5) };
  const authorization = `Basic ${btoa("ada:g1t_token")}`;
  assert.equal(await gitLimited(env, request("/acme/rocket.git/git-upload-pack", { authorization })), null);
  assert.equal(env.GIT_ANONYMOUS_LIMIT.keys.length, 0);
  assert.match(env.GIT_SIGNED_LIMIT.keys[0]!, /^git:[0-9a-f]{16}$/);
  assert.ok(!env.GIT_SIGNED_LIMIT.keys[0]!.includes("g1t_token"));
});

test("signed-out pages count by address, and costly ones against a tighter limit too", async () => {
  const env = { WEB_ADDRESS_LIMIT: binding(100), WEB_ANONYMOUS_LIMIT: binding(100), WEB_HEAVY_LIMIT: binding(1) };
  assert.equal(await pageLimited(env, request("/acme/rocket"), "/acme/rocket"), null);
  assert.equal(env.WEB_HEAVY_LIMIT.keys.length, 0);
  const archive = "/acme/rocket/archive/main.zip";
  assert.equal(await pageLimited(env, request(archive), archive), null);
  const refused = await pageLimited(env, request(archive), archive);
  assert.equal(refused?.status, 429);
  assert.match((await refused?.text()) ?? "", /Signed-in accounts have a higher limit/);
  assert.equal(await pageLimited(env, request("/acme/rocket/issues"), "/acme/rocket/issues"), null, "other pages go on");
});

test("signed-in requests count by session, and every request by address", async () => {
  const env = { WEB_ADDRESS_LIMIT: binding(1), WEB_SESSION_LIMIT: binding(100), WEB_ANONYMOUS_LIMIT: binding(0) };
  const signedIn = () => request("/acme/rocket/archive/main.zip", { cookie: "theme=dark; g1t_session=abc123" });
  assert.equal(await pageLimited(env, signedIn(), "/acme/rocket/archive/main.zip"), null);
  assert.equal(env.WEB_ANONYMOUS_LIMIT.keys.length, 0);
  assert.match(env.WEB_SESSION_LIMIT.keys[0]!, /^session:[0-9a-f]{16}$/);
  // Made-up cookies still meet the ceiling per address.
  const refused = await pageLimited(env, request("/", { cookie: "g1t_session=made-up" }), "/");
  assert.equal(refused?.status, 429);
});

test("files the Worker serves itself are never limited", async () => {
  const env = { WEB_ADDRESS_LIMIT: binding(0), WEB_ANONYMOUS_LIMIT: binding(0) };
  for (const path of ["/assets/app-1a2b.js", "/fonts/hanken.woff2", "/favicon.ico", "/robots.txt", "/llms.txt", "/sitemap.xml"]) {
    assert.ok(unlimited(path), path);
    assert.equal(await pageLimited(env, request(path), path), null, path);
  }
  assert.ok(!unlimited("/acme/rocket/blob/main/logo.png"), "a file in a repository is a page");
});

test("costly pages are recognised", () => {
  for (const path of [
    "/search",
    "/search.data",
    "/acme/rocket/archive/main.zip",
    "/acme/rocket/actions/runs/run_1",
    "/acme/rocket/actions/runs/run_1.data",
    "/acme/rocket/actions/runs/run_1/logs.zip",
    "/acme/rocket/actions/runs/run_1/artifacts/dist",
    "/acme/rocket/actions/jobs/job_1/log.txt",
  ]) {
    assert.ok(heavy(path), path);
  }
  for (const path of ["/", "/acme/rocket", "/acme/rocket/actions", "/acme/rocket/issues/1", "/acme/search"]) {
    assert.ok(!heavy(path), path);
  }
});

test("the session cookie is read from among others", () => {
  assert.equal(sessionCookie("theme=dark; g1t_session=abc; x=1"), "abc");
  assert.equal(sessionCookie("g1t_session=abc"), "abc");
  assert.equal(sessionCookie("not_g1t_session=abc"), null);
  assert.equal(sessionCookie(null), null);
});

/** A wrangler.jsonc as JSON: comments and trailing commas out, strings kept. */
function readJsonc(path: string): { ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[] } {
  const text = readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string: string | undefined) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

test("every wrangler.jsonc declares the rate limits RATE_LIMITS lists, and only those", () => {
  const ids = new Set<number>();
  const workers = new Set(Object.values(RATE_LIMITS).map((spec) => spec.worker));
  for (const worker of workers) {
    const declared = readJsonc(`../../../../${worker}/wrangler.jsonc`).ratelimits ?? [];
    const listed = Object.entries(RATE_LIMITS).filter(([, spec]) => spec.worker === worker);
    assert.deepEqual(
      declared.map((binding) => binding.name).sort(),
      listed.map(([name]) => name).sort(),
      `${worker}'s bindings`,
    );
    for (const [name, spec] of listed) {
      const binding = declared.find((b) => b.name === name)!;
      assert.equal(Number(binding.namespace_id), spec.namespaceId, `${name}'s namespace id`);
      assert.equal(binding.simple.limit, spec.limit, `${name}'s limit`);
      assert.equal(binding.simple.period, LIMIT_PERIOD_SECONDS, `${name}'s period`);
    }
  }
  for (const spec of Object.values(RATE_LIMITS)) {
    assert.ok(!ids.has(spec.namespaceId), `namespace id ${spec.namespaceId} is used once`);
    ids.add(spec.namespaceId);
  }
});

test("repository files on the usercontent origin count per address; avatars do not", async () => {
  const env = { WEB_ANONYMOUS_LIMIT: binding(1) };
  const raw = "/acme/rocket/raw/main/logo.png";
  assert.equal(await usercontentLimited(env, request(raw), raw), null);
  assert.equal((await usercontentLimited(env, request(raw), raw))?.status, 429);
  assert.equal(await usercontentLimited(env, request("/avatars/" + "a".repeat(64)), "/avatars/" + "a".repeat(64)), null);
  assert.deepEqual(env.WEB_ANONYMOUS_LIMIT.keys, ["ip:203.0.113.9", "ip:203.0.113.9"]);
});
