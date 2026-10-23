// g1t's machine image copied to g1t.sh (hosted-image.mjs): what it copies
// where, that it copies nothing already there, and that an inexact copy
// fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BASE_LOCK, HOSTED_REPOSITORY, copyArgs, g1tCredentials, publish, readBase, refsFor, registryHas } from "./hosted-image.mjs";

const DIGEST = "sha256:" + "d5".repeat(32);
const LOCK = JSON.stringify({
  image: "registry.cloudflare.com/acct/g1t-runner:base-20261021-ac4b2283607a",
  digest: DIGEST,
  pushed: true,
  size_bytes: 5636544756,
});

test("the base is copied by digest under its own tag", () => {
  const base = readBase(LOCK);
  assert.deepEqual(base, { host: "registry.cloudflare.com", name: "acct/g1t-runner", tag: "base-20261021-ac4b2283607a", digest: DIGEST, size: 5636544756 });
  assert.deepEqual(refsFor(base), {
    source: `registry.cloudflare.com/acct/g1t-runner@${DIGEST}`,
    tagged: "g1t.sh/flagon-io/g1t-hosted:base-20261021-ac4b2283607a",
    pinned: `g1t.sh/flagon-io/g1t-hosted@${DIGEST}`,
  });
  assert.deepEqual(copyArgs("a@sha256:1", "b:t"), ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", "b:t", "a@sha256:1"]);
});

test("base.json as committed names a base that can be published", () => {
  const base = readBase(readFileSync(BASE_LOCK, "utf8"));
  assert.match(refsFor(base).pinned, new RegExp(`^${HOSTED_REPOSITORY}@sha256:[0-9a-f]{64}$`));
  assert.ok(base.size > 1e9, "its size, which the docs and the runner's log say");
});

test("a base never pushed, or with no digest, is refused", () => {
  assert.throws(() => readBase(JSON.stringify({ ...JSON.parse(LOCK), pushed: false })), /never pushed/);
  assert.throws(() => readBase(JSON.stringify({ ...JSON.parse(LOCK), digest: null })), /no digest/);
});

/** A run of publish against a g1t.sh that has `there`, copying exactly unless told. */
function harness({ there = new Set(), exact = true, oldBuildx = false } = {}) {
  const calls = [];
  return {
    calls,
    has: async (ref) => there.has(ref),
    login: async () => calls.push("login"),
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (oldBuildx && args.includes("--prefer-index=false")) return { code: 1, out: "unknown flag: --prefer-index\n" };
      if (exact) there.add(`${HOSTED_REPOSITORY}@${DIGEST}`);
      return { code: 0, out: "" };
    },
  };
}

test("a digest g1t.sh has already is not copied again", async () => {
  const run = harness({ there: new Set([`${HOSTED_REPOSITORY}@${DIGEST}`]) });
  assert.deepEqual(await publish({ base: readBase(LOCK), ...run }), { ref: `${HOSTED_REPOSITORY}@${DIGEST}`, copied: false });
  assert.deepEqual(run.calls, [], "neither logs in nor copies");
});

test("a digest g1t.sh lacks is copied registry to registry, after logging in", async () => {
  const run = harness();
  assert.deepEqual(await publish({ base: readBase(LOCK), ...run }), { ref: `${HOSTED_REPOSITORY}@${DIGEST}`, copied: true });
  assert.equal(run.calls[0], "login");
  assert.match(
    run.calls[1],
    /^docker buildx imagetools create --prefer-index=false --tag g1t\.sh\/flagon-io\/g1t-hosted:base-20261021-ac4b2283607a registry\.cloudflare\.com\/acct\/g1t-runner@sha256:/,
  );
  assert.ok(!run.calls.some((call) => / pull | push /.test(` ${call} `)), "nothing is pulled or pushed through the machine");
});

test("a g1t.sh that won't say whether it has it (a repository not made yet) is copied to", async () => {
  const run = harness();
  const has = run.has;
  let first = true;
  run.has = async (ref) => {
    if (first) {
      first = false;
      throw new Error("the registry answered 401");
    }
    return has(ref);
  };
  assert.equal((await publish({ base: readBase(LOCK), ...run })).copied, true);
});

test("a buildx without --prefer-index copies without it", async () => {
  const run = harness({ oldBuildx: true });
  assert.equal((await publish({ base: readBase(LOCK), ...run })).copied, true);
  assert.ok(!run.calls[2].includes("--prefer-index"));
});

test("a copy g1t.sh keeps under another digest fails", async () => {
  await assert.rejects(publish({ base: readBase(LOCK), ...harness({ exact: false }) }), /not exact/);
  const failing = { ...harness(), run: async () => ({ code: 1, out: "denied: requested access to the resource is denied\n" }) };
  await assert.rejects(publish({ base: readBase(LOCK), ...failing }), /denied/);
});

test("g1t.sh is asked by digest, with G1T_TOKEN when there is one", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([init.method, url, init.headers.authorization ?? null]);
    return { status: 404, ok: false, headers: new Headers() };
  };
  assert.equal(await registryHas(`${HOSTED_REPOSITORY}@${DIGEST}`, { fetchImpl, credentials: g1tCredentials({ G1T_TOKEN: "tok" }) }), false);
  assert.deepEqual(asked, [["HEAD", `https://g1t.sh/v2/flagon-io/g1t-hosted/manifests/${DIGEST}`, `Basic ${Buffer.from("g1t:tok").toString("base64")}`]]);
  assert.equal(await g1tCredentials({})(), null);
});
