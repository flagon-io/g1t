// The namespace report, from configuration and table rows as the repos
// database holds them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "../deploy/stack.mjs";
import { LIMIT_PER_MINUTE, configured, namespaceOf, standings, table } from "./artifacts-namespaces.mjs";

const sharded = {
  artifacts: [
    { binding: "ARTIFACTS", namespace: "g1t" },
    { binding: "ARTIFACTS_1", namespace: "g1t-us-1" },
    { binding: "ARTIFACTS_EU", namespace: "g1t-eu" },
  ],
  vars: {
    ARTIFACTS_NAMESPACES: JSON.stringify({ ARTIFACTS: "g1t", ARTIFACTS_1: "g1t-us-1", ARTIFACTS_EU: "g1t-eu", ARTIFACTS_2: "g1t-us-2" }),
    ARTIFACTS_NEW_REPOS: "g1t,g1t-us-1,g1t-us-2",
    ARTIFACTS_EU_NAMESPACE: "g1t-eu",
    ARTIFACTS_NAMESPACE_LIMITS: JSON.stringify({ "g1t": { max_repos: 100 } }),
  },
};

test("today's configuration is one namespace that takes nothing new by name", () => {
  const today = parseJsonc(readFileSync(fileURLToPath(new URL("../../services/repos/wrangler.jsonc", import.meta.url)), "utf8"));
  const config = configured(today);
  assert.equal(config.length, 1);
  assert.deepEqual(
    { namespace: config[0].namespace, bound: config[0].bound, default: config[0].default, takes: config[0].takes_new_repos, eu: config[0].eu },
    { namespace: "g1t", bound: true, default: true, takes: false, eu: false },
  );
});

test("each namespace's binding, jurisdiction and part in placing are read from the configuration", () => {
  const config = configured(sharded);
  const by = Object.fromEntries(config.map((one) => [one.namespace, one]));
  // A binding never says its namespace's jurisdiction; Cloudflare does.
  assert.equal(by["g1t-eu"].jurisdiction, null);
  assert.ok(by["g1t-eu"].eu && !by["g1t-eu"].takes_new_repos);
  assert.ok(by["g1t-us-1"].bound && by["g1t-us-1"].takes_new_repos);
  // Named, but no binding for it: not bound.
  assert.equal(by["g1t-us-2"].bound, false);
  assert.equal(by.g1t.max_repos, 100);
  assert.equal(namespaceOf("acme--rocket"), "g1t");
  assert.equal(namespaceOf("g1t-us-1/acme--rocket"), "g1t-us-1");
  assert.equal(namespaceOf(null, "main"), "main");
});

test("standings add up holdings and health, and warn about what needs doing", () => {
  const held = [
    { ns: "", repos: 90, forks: 10, stored_bytes: 2e9 },
    { ns: "g1t", repos: 10, forks: 0, stored_bytes: 1e9 },
    { ns: "g1t-us-1", repos: 3, forks: 1, stored_bytes: 5e8 },
  ];
  const health = [
    { window: "day", store: "g1t", peak: LIMIT_PER_MINUTE * 0.8, calls: 900_000, errors: 4, rate_limited: 2, rejected: 0 },
    { window: "hour", store: "g1t", peak: 100, calls: 5_000, errors: 0, rate_limited: 2, rejected: 0 },
    { window: "hour", store: "g1t-us-1@fallback", peak: 3, calls: 40, errors: 0, rate_limited: 0, rejected: 0 },
  ];
  const rows = standings(configured(sharded), held, health, [{ namespace: "g1t", count: 7 }, { namespace: "g1t-eu", count: 1 }]);
  const by = Object.fromEntries(rows.map((row) => [row.namespace, row]));
  assert.equal(by.g1t.repos, 100);
  assert.equal(by.g1t.stored_bytes, 3e9);
  assert.equal(by.g1t.cloudflare_events, 7);
  assert.ok(by.g1t.warnings.some((w) => /80% of the limit/.test(w)));
  assert.ok(by.g1t.warnings.some((w) => /max_repos/.test(w)));
  assert.ok(by.g1t.warnings.some((w) => /rate limited/.test(w)));
  assert.ok(by["g1t-us-1"].warnings.some((w) => /fallback/.test(w)));
  assert.ok(by["g1t-us-2"].warnings.some((w) => /not bound/.test(w)));
  assert.deepEqual(by["g1t-eu"].warnings, []);
  const text = table(rows);
  assert.match(text, /^namespace/);
  assert.match(text, /g1t \*/);
  assert.match(text, /g1t-us-2 .*\(not bound\)/);
});

test("what Cloudflare has is checked against what is bound", () => {
  const made = [
    { namespace: "g1t", jurisdiction: null },
    { namespace: "g1t-us-1", jurisdiction: null },
    { namespace: "g1t-eu", jurisdiction: null },
  ];
  const rows = standings(configured(sharded), [], [], [], made);
  const by = Object.fromEntries(rows.map((row) => [row.namespace, row]));
  // Made without the EU jurisdiction: it cannot be changed, so it is said.
  assert.ok(by["g1t-eu"].warnings.some((w) => /jurisdiction is unrestricted/.test(w)));
  assert.equal(by.g1t.jurisdiction, "any");
  // Named and bound nowhere, and not made: both said.
  assert.ok(by["g1t-us-2"].warnings.some((w) => /no namespace of this name/.test(w)));
  const right = standings(configured(sharded), [], [], [], made.map((one) => (one.namespace === "g1t-eu" ? { ...one, jurisdiction: "eu" } : one)));
  assert.deepEqual(right.find((row) => row.namespace === "g1t-eu").warnings, []);
  assert.equal(right.find((row) => row.namespace === "g1t-eu").jurisdiction, "eu");
});
