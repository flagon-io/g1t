import assert from "node:assert/strict";
import { test } from "node:test";
import { declared, drift, report } from "./cloudflare-drift.mjs";
import { loadStack } from "../deploy/stack.mjs";

const configs = [
  {
    name: "g1t-work",
    routes: [
      { pattern: "api.example.com", custom_domain: true },
      { pattern: "example.com/*", zone_name: "example.com" },
    ],
    d1_databases: [{ binding: "DB", database_name: "g1t-work", database_id: "db-work" }],
    queues: { producers: [{ binding: "EVENTS", queue: "g1t-events" }], consumers: [{ queue: "g1t-events-work", dead_letter_queue: "g1t-events-dlq" }] },
  },
  {
    name: "g1t-runner",
    r2_buckets: [{ binding: "CACHE", bucket_name: "g1t-cache" }],
    kv_namespaces: [{ binding: "KV", id: "kv-1" }],
    vectorize: [{ binding: "V", index_name: "g1t-index" }],
    dispatch_namespaces: [{ binding: "APPS", namespace: "g1t-deployments" }],
    env: { staging: { name: "g1t-runner-staging" } },
  },
];

const clean = {
  workers: [{ id: "g1t-work" }, { id: "g1t-runner" }, { id: "g1t-runner-staging" }],
  domains: [{ hostname: "api.example.com", service: "g1t-work" }],
  d1: [{ name: "g1t-work", uuid: "db-work" }],
  r2: [{ name: "g1t-cache" }],
  kv: [{ id: "kv-1", title: "kv" }],
  queues: [{ queue_name: "g1t-events" }, { queue_name: "g1t-events-work" }, { queue_name: "g1t-events-dlq" }],
  vectorize: [{ name: "g1t-index" }],
  dispatchNamespaces: [{ namespace_name: "g1t-deployments", script_count: 1 }],
  durableObjects: [
    { script: "g1t-runner", class: "Sandbox" },
    { script: "todo-acme", class: "G1tApp", dispatch_namespace: "g1t-deployments" },
  ],
  containers: [{ name: "g1t-runner-sandbox" }, { name: "g1t-todo-acme" }],
  dispatchScripts: ["todo-acme"],
};

test("an account holding only what the configs declare, and the apps of their dispatch namespace, has no drift", () => {
  assert.deepEqual(drift(clean, declared(configs)), []);
  assert.match(report([], []), /Everything on the account is declared/);
});

test("what a deleted service left behind is each named", () => {
  const account = {
    ...clean,
    workers: [...clean.workers, { id: "g1t-agents", modified_on: "2026-10-12T00:00:00Z" }],
    domains: [...clean.domains, { hostname: "models.example.com", service: "g1t-models" }],
    d1: [...clean.d1, { name: "g1t-agents", uuid: "db-agents", created_at: "2026-10-09T00:00:00Z" }],
    r2: [...clean.r2, { name: "g1t-agent-homes" }],
    kv: [...clean.kv, { id: "kv-2", title: "g1t-old" }],
    queues: [...clean.queues, { queue_name: "g1t-events-agents" }],
    vectorize: [...clean.vectorize, { name: "g1t-context" }],
    dispatchNamespaces: [...clean.dispatchNamespaces, { namespace_name: "g1t-old-apps", script_count: 0 }],
    durableObjects: [...clean.durableObjects, { script: "g1t-agents", class: "Desk" }, { script: "x", class: "G1tApp", dispatch_namespace: "g1t-old-apps" }],
    containers: [...clean.containers, { name: "g1t-gone-app", instances: 1 }],
  };
  const found = drift(account, declared(configs));
  assert.deepEqual(
    found.map((f) => `${f.kind}: ${f.name}`),
    [
      "Worker: g1t-agents",
      "Custom domain: models.example.com",
      "D1 database: g1t-agents",
      "R2 bucket: g1t-agent-homes",
      "KV namespace: g1t-old",
      "Queue: g1t-events-agents",
      "Vectorize index: g1t-context",
      "Dispatch namespace: g1t-old-apps",
      "Durable Object namespace: g1t-agents.Desk",
      "Durable Object namespace: x.G1tApp",
      "Container application: g1t-gone-app",
    ],
  );
  const text = report(found, []);
  assert.match(text, /11 on the account/);
  assert.match(text, /\| Worker \| `g1t-agents` \| last deployed 2026-10-12 \|/);
});

test("a listing that failed is said, so the report is never read as clean", () => {
  const text = report([], ['Vectorize: 403 ["Authentication error"]']);
  assert.match(text, /not complete/);
  assert.match(text, /Vectorize: 403/);
});

test("every unit's config declares what it binds", () => {
  const d = declared(
    loadStack()
      .units.map((unit) => unit.config)
      .filter(Boolean),
  );
  for (const name of ["g1t", "g1t-api", "g1t-runner", "g1t-deployments"]) assert.ok(d.workers.has(name), name);
  assert.ok(d.dispatch.has("g1t-deployments"));
  assert.ok(d.domains.has("g1t.sh"));
});
