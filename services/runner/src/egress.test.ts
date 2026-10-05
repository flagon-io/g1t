import assert from "node:assert/strict";
import { test } from "node:test";

import { allows, blockedStep, harnessEnv, newlyBlocked, normalizeHost, refusal, sandboxHosts, timeCapMessage } from "./egress.ts";

const policy = ["g1t.sh", "api.g1t.sh", "registry.npmjs.org", "*.example.com"];

test("listed hosts are allowed and nothing else is", () => {
  assert.equal(allows(policy, "registry.npmjs.org"), true);
  assert.equal(allows(policy, "api.g1t.sh"), true);
  assert.equal(allows(policy, "evil.com"), false);
  assert.equal(allows(policy, "registry.npmjs.org.evil.com"), false);
  assert.equal(allows(policy, "npmjs.org"), false);
  assert.equal(allows(policy, ""), false);
  assert.equal(allows([], "api.g1t.sh"), false);
});

test("hosts are compared without case, port or trailing dot", () => {
  assert.equal(allows(policy, "Registry.NPMJS.org:443"), true);
  assert.equal(allows(policy, "registry.npmjs.org."), true);
  assert.equal(normalizeHost("[::1]:8080"), "[::1]");
});

test("a wildcard covers subdomains at any depth, not the domain itself", () => {
  assert.equal(allows(policy, "api.example.com"), true);
  assert.equal(allows(policy, "a.b.example.com"), true);
  assert.equal(allows(policy, "example.com"), false);
  assert.equal(allows(policy, "badexample.com"), false);
});

test("the model and g1t's tools are always reachable", () => {
  const hosts = sandboxHosts(
    ["registry.npmjs.org"],
    { MODELS_URL: "https://models.g1t.sh" },
    { G1T_API: "https://api.g1t.sh", GIT_REMOTE: "https://g1t.sh/acme/site.git", ANTHROPIC_BASE_URL: "https://models.g1t.sh/anthropic" },
  );
  for (const host of ["registry.npmjs.org", "models.g1t.sh", "api.g1t.sh", "g1t.sh"]) {
    assert.ok(hosts.includes(host), host);
  }
  assert.ok(!hosts.includes("gateway.ai.cloudflare.com"));
});

test("without the model proxy, the gateway or the provider is added", () => {
  assert.ok(sandboxHosts([], { AI_GATEWAY_ID: "g1t" }, {}).includes("gateway.ai.cloudflare.com"));
  assert.ok(sandboxHosts([], { ANTHROPIC_API_KEY: "k" }, {}).includes("api.anthropic.com"));
  assert.deepEqual(sandboxHosts([], {}, { G1T_API: "not a url" }), []);
});

test("a refusal says why and how to allow it", async () => {
  const response = refusal("Evil.com:443");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("x-g1t-guardrails"), "blocked");
  const text = await response.text();
  assert.match(text, /evil\.com is not on this project's allowed domains/);
  assert.match(text, /Settings, Guardrails/);
  assert.equal(blockedStep("Evil.com"), "Blocked: evil.com (not an allowed domain)");
});

test("the harness is told the run's rules, caps and branch", () => {
  const guard = {
    policy: {
      restrictNetwork: true,
      registries: [],
      domains: [],
      hosts: [],
      rules: { sudo: true },
      deny: ["Bash(kubectl:*)"],
      budgetUsd: 5,
      minutes: { implement: 90 },
    },
    minutes: 90,
  };
  const restricted = harnessEnv(guard, { UPSTREAM_BRANCH: "trunk" }, true);
  assert.deepEqual(JSON.parse(restricted.GUARDRAILS), {
    rules: { sudo: true },
    deny: ["Bash(kubectl:*)"],
    budgetUsd: 5,
    minutes: 90,
    restrictNetwork: true,
    defaultBranch: "trunk",
  });
  assert.equal(restricted.NODE_EXTRA_CA_CERTS, "/etc/cloudflare/certs/cloudflare-containers-ca.crt");
  // Open, as the operator's switch makes it: no certificate to trust.
  const open = harnessEnv(guard, {}, false);
  assert.equal(JSON.parse(open.GUARDRAILS).restrictNetwork, false);
  assert.equal(open.NODE_EXTRA_CA_CERTS, undefined);
});

test("each refused host is one step, up to a limit", () => {
  const first = newlyBlocked([], "evil.com");
  assert.deepEqual(first, { step: "Blocked: evil.com (not an allowed domain)", seen: ["Blocked: evil.com (not an allowed domain)"] });
  assert.equal(newlyBlocked(first!.seen, "EVIL.com:443"), null);
  const full = Array.from({ length: 25 }, (_, i) => `Blocked: h${i}.com (not an allowed domain)`);
  assert.equal(newlyBlocked(full, "another.com"), null);
  assert.equal(timeCapMessage(1), "Stopped: it reached its time cap of 1 minute.");
});
