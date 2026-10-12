import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ComputeEntitlements,
  type ComputeKind,
  type PlanMemory,
  ComputeGate,
  actualMicros,
  alwaysPasses,
  entitlementsKeptSeconds,
  localRefusal,
  onBillingError,
  readEntitlements,
  refusalCode,
  refusalMessage,
  sandboxEstimateMicros,
} from "../../../packages/contracts/src/compute.ts";
import { BUILD_HOSTS, buildHosts, dockerFor, withPlanLimits } from "./egress.ts";

const repo = { namespace: "acme", name: "web" };

function ent(change: Partial<ComputeEntitlements> = {}): ComputeEntitlements {
  return {
    plan: "paid",
    compute: true,
    trialMicrosLeft: 0,
    trialVerified: true,
    firstMonth: false,
    maxRunMinutes: 0,
    runCapMicros: 2_000_000,
    ceilingMicros: 100_000_000,
    exposureMicros: 0,
    paused: null,
    ...change,
  };
}

/** A billing service that answers as told, and records what it was asked. */
function billing(answers: {
  entitlements?: unknown;
  reserve?: unknown;
  fail?: Set<string>;
}) {
  const asked: { method: string; body: Record<string, unknown> }[] = [];
  const binding = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const method = url.split("/rpc/")[1];
      asked.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      if (answers.fail?.has(method)) return new Response("down", { status: 503 });
      if (method === "entitlements") return Response.json(answers.entitlements ?? null);
      if (method === "reserve") return Response.json(answers.reserve ?? { ok: true, value: { id: "rsv_1", paidBy: "credit" } });
      if (method === "settle") return Response.json({ ok: true, value: true });
      if (method === "prices") return Response.json({ prices: [{ meter: "sandbox_second", costMicros: 20 }] });
      return new Response("not found", { status: 404 });
    },
  };
  return { binding, asked };
}

/** A plan memory that remembers nothing unless told. */
function memory(plan: ComputeEntitlements["plan"] | null = null): PlanMemory {
  return { get: async () => plan, put: async () => undefined };
}

const quiet = () => undefined;

function wire(e: ComputeEntitlements) {
  // As billing serialises it: camelCase.
  return { workspace: "acme", ...e };
}

const request = (kind: ComputeKind, isPublic = false) => ({
  workspace: "acme",
  repo,
  public: isPublic,
  kind,
  estimateMicros: 100_000,
});

// ---- Gating decisions ---------------------------------------------------------------

test("a paid workspace's start is reserved and goes ahead", async () => {
  const { binding, asked } = billing({ entitlements: wire(ent()) });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("deploy"));
  assert.equal(admitted.ok, true);
  assert.deepEqual(admitted.ok && admitted.reservation, { id: "rsv_1", paidBy: "credit" });
  const reserve = asked.find((call) => call.method === "reserve")!;
  assert.deepEqual(reserve.body, { workspace: "acme", repo, public: false, kind: "deploy", estimateMicros: 100_000 });
});

test("billing's refusal is shown in its own words", async () => {
  for (const code of ["not_paid", "trial_used", "limit", "oss_pool_empty"] as const) {
    const { binding } = billing({
      entitlements: wire(ent({ plan: "free", compute: false })),
      reserve: { ok: false, error: { code, message: `Refused: ${code}. /acme/-/billing` } },
    });
    const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("check", true));
    assert.equal(admitted.ok, false, code);
    assert.equal(!admitted.ok && admitted.code, code);
    assert.equal(!admitted.ok && admitted.message, `Refused: ${code}. /acme/-/billing`);
  }
});

test("a refusal without words gets g1t's, with what to do and where", async () => {
  const { binding } = billing({
    entitlements: wire(ent({ plan: "free", compute: false })),
    reserve: { ok: false, error: { code: "not_paid", message: "" } },
  });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("deploy"));
  assert.equal(!admitted.ok && admitted.message, refusalMessage("not_paid", "acme", "deploy"));
  assert.match(refusalMessage("not_paid", "acme", "deploy"), /^Deployments need a paid workspace\. Start the \$20 plan or try it with \$5 of free usage after a card check: \/acme\/-\/billing$/);
});

test("a paused workspace starts nothing, and billing is not asked to reserve", async () => {
  const { binding, asked } = billing({ entitlements: wire(ent({ paused: "A spend spike is waiting for an owner." })) });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("workflow"));
  assert.equal(!admitted.ok && admitted.code, "paused");
  assert.match(!admitted.ok ? admitted.message : "", /A spend spike is waiting for an owner/);
  assert.equal(asked.some((call) => call.method === "reserve"), false);
});

test("an answer that holds compute back is kept seconds, one that lets it through half a minute", () => {
  assert.equal(entitlementsKeptSeconds(ent()), 30);
  assert.equal(entitlementsKeptSeconds(ent({ paused: "A spend spike is waiting for an owner." })), 3);
  assert.equal(entitlementsKeptSeconds(ent({ plan: "free", compute: false })), 3);
  // A free workspace with compute (its trial) runs, so it is kept as long.
  assert.equal(entitlementsKeptSeconds(ent({ plan: "free", compute: true })), 30);
});

test("internal and enterprise plans pass even when billing refuses", async () => {
  for (const plan of ["internal", "enterprise"] as const) {
    const { binding } = billing({
      entitlements: wire(ent({ plan })),
      reserve: { ok: false, error: { code: "limit", message: "Over." } },
    });
    const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("deploy"));
    assert.equal(admitted.ok, true, plan);
  }
  assert.equal(alwaysPasses("internal") && alwaysPasses("enterprise") && !alwaysPasses("paid"), true);
});

test("a pause from billing holds for every plan: g1t's own budget and its daily breaker", async () => {
  for (const plan of ["internal", "enterprise", "paid"] as const) {
    const message = "flagon-io's monthly budget is used up ($150.00 of $150.00 this month at cost), so new runs wait.";
    const { binding } = billing({ entitlements: wire(ent({ plan })), reserve: { ok: false, error: { code: "paused", message } } });
    const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("workflow"));
    assert.equal(!admitted.ok && admitted.code, "paused", plan);
    assert.equal(!admitted.ok && admitted.message, message);
  }
  // Billing's pause reason reads cleanly inside g1t's sentence.
  assert.equal(
    refusalMessage("paused", "acme", "workflow", "Its budget is used up."),
    "g1t paused compute for this workspace: Its budget is used up. Contact support@g1t.sh to have it looked at.",
  );
});

test("billing down: free workspaces fail closed, paying ones go on", async () => {
  const down = new Set(["entitlements", "reserve"]);
  // Nothing known about the workspace: treated as free.
  let gate = new ComputeGate(billing({ fail: down }).binding, memory(null), quiet);
  let admitted = await gate.admit(request("deploy"));
  assert.equal(!admitted.ok && admitted.code, "billing_unavailable");
  // Last seen paid: goes ahead, without a reservation.
  gate = new ComputeGate(billing({ fail: down }).binding, memory("paid"), quiet);
  admitted = await gate.admit(request("deploy"));
  assert.deepEqual(admitted, { ok: true, reservation: null, entitlements: null });
  // Entitlements answer, reserve errors: the plan decides.
  gate = new ComputeGate(billing({ entitlements: wire(ent({ plan: "free", compute: false, trialMicrosLeft: 5_000_000 })), fail: new Set(["reserve"]) }).binding, memory(), quiet);
  admitted = await gate.admit(request("deploy"));
  assert.equal(admitted.ok, false);
  gate = new ComputeGate(billing({ entitlements: wire(ent()), fail: new Set(["reserve"]) }).binding, memory(), quiet);
  assert.equal((await gate.admit(request("deploy"))).ok, true);
  assert.equal(onBillingError("free"), "refuse");
  assert.equal(onBillingError(null), "refuse");
  assert.equal(onBillingError("paid"), "allow");
});

test("an answer that is not a refusal counts as billing being down", async () => {
  const { binding } = billing({
    entitlements: wire(ent({ plan: "free", compute: false })),
    reserve: { ok: false, error: { code: "invalid", message: "Unknown method" } },
  });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("deploy"));
  assert.equal(!admitted.ok && admitted.code, "billing_unavailable");
  assert.equal(refusalCode({ code: "payment_required" }), "not_paid");
  assert.equal(refusalCode({ code: "conflict", reason: "trial_used" }), "trial_used");
  assert.equal(refusalCode({ code: "invalid" }), null);
});

test("entitlements read in either case, and not at all without a plan", () => {
  const snake = readEntitlements({ plan: "free", trial_micros_left: 5, trial_verified: true, max_run_minutes: 30, paused: "" });
  assert.equal(snake?.trialMicrosLeft, 5);
  assert.equal(snake?.maxRunMinutes, 30);
  assert.equal(snake?.paused, null);
  assert.equal(readEntitlements({ team: true })?.plan, undefined);
  assert.equal(readEntitlements({ ok: true, value: { plan: "paid" } })?.plan, "paid");
});

test("before they try: what a free workspace can start, by kind and repository", () => {
  const free = ent({ plan: "free", compute: false, trialVerified: false });
  assert.equal(localRefusal(free, "deploy", false), "not_paid");
  assert.equal(localRefusal(free, "check", true), "not_paid", "the pool needs a card check");
  const verified = ent({ plan: "free", compute: false, trialVerified: true, trialMicrosLeft: 0 });
  // The open-source path: public repositories' checks, workflows and queue.
  for (const kind of ["check", "workflow", "queue"] as const) assert.equal(localRefusal(verified, kind, true), null, kind);
  assert.equal(localRefusal(verified, "deploy", true), "trial_used");
  assert.equal(localRefusal(verified, "check", false), "trial_used");
  const trial = ent({ plan: "free", compute: true, trialVerified: true, trialMicrosLeft: 4_000_000 });
  assert.equal(localRefusal(trial, "deploy", false), null);
  assert.equal(localRefusal(ent(), "deploy", false), null);
  assert.equal(localRefusal(ent({ paused: "Held." }), "deploy", false), "paused");
});

// ---- Estimates ------------------------------------------------------------------------

test("an estimate is the sandbox for its whole time cap", () => {
  assert.equal(sandboxEstimateMicros(60, 25), 90_000);
  assert.equal(sandboxEstimateMicros(-5, 25), 0);
});

test("what work cost: its seconds at the sandbox price", () => {
  assert.equal(actualMicros(600, 20), 12_000);
  assert.equal(actualMicros(-10, 20), 0);
});

test("the gate reads the sandbox price from the price book", async () => {
  const gate = new ComputeGate(billing({}).binding, memory(), quiet);
  assert.equal(await gate.microsPerSecond(), 20);
  const down = new ComputeGate(billing({ fail: new Set(["prices"]) }).binding, memory(), quiet);
  assert.equal(await down.microsPerSecond(), 25);
});

// ---- Caps -------------------------------------------------------------------------------

test("caps are the lower of the guardrails' and the plan's", () => {
  const guard = { policy: { budgetUsd: 5 } as never, minutes: 90 };
  const limited = withPlanLimits(guard as never, { minutes: 60, budgetUsd: 2 });
  assert.equal(limited.minutes, 60);
  assert.equal((limited.policy as { budgetUsd: number }).budgetUsd, 2);
  const unlimited = withPlanLimits(guard as never, { minutes: null, budgetUsd: null });
  assert.equal(unlimited.minutes, 90);
  assert.equal((unlimited.policy as { budgetUsd: number }).budgetUsd, 5);
});

// ---- Builds' network ---------------------------------------------------------------------

test("builds reach registries and git hosts, and no mining pool", () => {
  for (const host of ["registry.npmjs.org", "codeload.github.com", "nodejs.org", "crates.io"]) {
    assert.ok(BUILD_HOSTS.includes(host), host);
  }
  // A job's Docker Engine pulls from Docker Hub (through its mirror) and Quay.
  for (const host of ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "mirror.gcr.io", "ghcr.io", "quay.io"]) {
    assert.ok(BUILD_HOSTS.includes(host), host);
  }
  assert.ok(buildHosts("deploy").includes("api.cloudflare.com"));
  // A container build pushes its image to Cloudflare's registry, from a sandbox or a job.
  assert.ok(buildHosts("deploy").includes("registry.cloudflare.com"));
  assert.ok(buildHosts("actions").includes("registry.cloudflare.com"));
  assert.ok(!buildHosts("actions").includes("api.cloudflare.com"));
  for (const host of buildHosts("deploy")) {
    assert.doesNotMatch(host, /pool|xmr|monero|nicehash|^\*/, host);
  }
});

test("workflow jobs get Docker unless the operator turns it off", () => {
  assert.equal(dockerFor(undefined), "on");
  assert.equal(dockerFor("on"), "on");
  assert.equal(dockerFor(" OFF "), "off");
});
