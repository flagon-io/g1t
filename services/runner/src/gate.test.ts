import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ComputeEntitlements,
  type ComputeKind,
  type PlanMemory,
  ComputeGate,
  MODEL_ESTIMATE_MICROS,
  WAITING_PREFIX,
  actualMicros,
  agentEstimateMicros,
  alwaysPasses,
  embeddingEstimateMicros,
  isWaiting,
  issueCapReached,
  localRefusal,
  lowerCap,
  onBillingError,
  readEntitlements,
  refusalCode,
  refusalMessage,
  runBudgetUsd,
  runMinutes,
  sandboxEstimateMicros,
  slotFree,
  waitingMessage,
} from "../../../packages/contracts/src/compute.ts";
import { BUILD_HOSTS, buildHosts, withPlanLimits } from "./egress.ts";
import { WAITING, handleMention } from "./mentions.ts";

const repo = { namespace: "acme", name: "web" };

function ent(change: Partial<ComputeEntitlements> = {}): ComputeEntitlements {
  return {
    plan: "paid",
    compute: true,
    trialMicrosLeft: 0,
    trialVerified: true,
    firstMonth: false,
    maxConcurrentAgents: 10,
    maxRunMinutes: 0,
    runCapMicros: 2_000_000,
    issueCapMicros: 10_000_000,
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
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("agent"));
  assert.equal(admitted.ok, true);
  assert.deepEqual(admitted.ok && admitted.reservation, { id: "rsv_1", paidBy: "credit" });
  const reserve = asked.find((call) => call.method === "reserve")!;
  assert.deepEqual(reserve.body, { workspace: "acme", repo, public: false, kind: "agent", estimateMicros: 100_000 });
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
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("agent"));
  assert.equal(!admitted.ok && admitted.message, refusalMessage("not_paid", "acme", "agent"));
  assert.match(refusalMessage("not_paid", "acme", "agent"), /^Agents need a paid workspace\. Start the \$20 plan or try it with \$5 of free usage after a card check: \/acme\/-\/billing$/);
});

test("a paused workspace starts nothing, and billing is not asked to reserve", async () => {
  const { binding, asked } = billing({ entitlements: wire(ent({ paused: "A spend spike is waiting for an owner." })) });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("workflow"));
  assert.equal(!admitted.ok && admitted.code, "paused");
  assert.match(!admitted.ok ? admitted.message : "", /A spend spike is waiting for an owner/);
  assert.equal(asked.some((call) => call.method === "reserve"), false);
});

test("internal and enterprise plans pass even when billing refuses", async () => {
  for (const plan of ["internal", "enterprise"] as const) {
    const { binding } = billing({
      entitlements: wire(ent({ plan })),
      reserve: { ok: false, error: { code: "limit", message: "Over." } },
    });
    const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("agent"));
    assert.equal(admitted.ok, true, plan);
  }
  assert.equal(alwaysPasses("internal") && alwaysPasses("enterprise") && !alwaysPasses("paid"), true);
});

test("a pause from billing holds for every plan: g1t's own budget and its daily breaker", async () => {
  for (const plan of ["internal", "enterprise", "paid"] as const) {
    const message = "flagon-io's monthly budget for g1t's own agents is used up ($150.00 of $150.00 this month at cost), so new runs wait.";
    const { binding, asked } = billing({ entitlements: wire(ent({ plan })), reserve: { ok: false, error: { code: "paused", message } } });
    const admitted = await new ComputeGate(binding, memory(), quiet).admit({ ...request("agent"), hostedModel: true });
    assert.equal(!admitted.ok && admitted.code, "paused", plan);
    assert.equal(!admitted.ok && admitted.message, message);
    // Billing hears whether the run is on g1t's hosted models.
    assert.equal(asked.find((call) => call.method === "reserve")!.body.hostedModel, true);
  }
  // Billing's pause reason reads cleanly inside g1t's sentence.
  assert.equal(
    refusalMessage("paused", "acme", "agent", "Its budget is used up."),
    "g1t paused compute for this workspace: Its budget is used up. Contact support@g1t.sh to have it looked at.",
  );
});

test("billing down: free workspaces fail closed, paying ones go on", async () => {
  const down = new Set(["entitlements", "reserve"]);
  // Nothing known about the workspace: treated as free.
  let gate = new ComputeGate(billing({ fail: down }).binding, memory(null), quiet);
  let admitted = await gate.admit(request("agent"));
  assert.equal(!admitted.ok && admitted.code, "billing_unavailable");
  // Last seen paid: goes ahead, without a reservation.
  gate = new ComputeGate(billing({ fail: down }).binding, memory("paid"), quiet);
  admitted = await gate.admit(request("agent"));
  assert.deepEqual(admitted, { ok: true, reservation: null, entitlements: null });
  // Entitlements answer, reserve errors: the plan decides.
  gate = new ComputeGate(billing({ entitlements: wire(ent({ plan: "free", compute: false, trialMicrosLeft: 5_000_000 })), fail: new Set(["reserve"]) }).binding, memory(), quiet);
  admitted = await gate.admit(request("agent"));
  assert.equal(admitted.ok, false);
  gate = new ComputeGate(billing({ entitlements: wire(ent()), fail: new Set(["reserve"]) }).binding, memory(), quiet);
  assert.equal((await gate.admit(request("agent"))).ok, true);
  assert.equal(onBillingError("free"), "refuse");
  assert.equal(onBillingError(null), "refuse");
  assert.equal(onBillingError("paid"), "allow");
});

test("an answer that is not a refusal counts as billing being down", async () => {
  const { binding } = billing({
    entitlements: wire(ent({ plan: "free", compute: false })),
    reserve: { ok: false, error: { code: "invalid", message: "Unknown method" } },
  });
  const admitted = await new ComputeGate(binding, memory(), quiet).admit(request("agent"));
  assert.equal(!admitted.ok && admitted.code, "billing_unavailable");
  assert.equal(refusalCode({ code: "payment_required" }), "not_paid");
  assert.equal(refusalCode({ code: "conflict", reason: "trial_used" }), "trial_used");
  assert.equal(refusalCode({ code: "invalid" }), null);
});

test("entitlements read in either case, and not at all without a plan", () => {
  const snake = readEntitlements({ plan: "free", trial_micros_left: 5, trial_verified: true, max_concurrent_agents: 2, paused: "" });
  assert.equal(snake?.trialMicrosLeft, 5);
  assert.equal(snake?.maxConcurrentAgents, 2);
  assert.equal(snake?.paused, null);
  assert.equal(readEntitlements({ team: true })?.plan, undefined);
  assert.equal(readEntitlements({ ok: true, value: { plan: "paid" } })?.plan, "paid");
});

test("before they try: what a free workspace can start, by kind and repository", () => {
  const free = ent({ plan: "free", compute: false, trialVerified: false });
  assert.equal(localRefusal(free, "agent", false), "not_paid");
  assert.equal(localRefusal(free, "check", true), "not_paid", "the pool needs a card check");
  const verified = ent({ plan: "free", compute: false, trialVerified: true, trialMicrosLeft: 0 });
  // The open-source path: public repositories' checks, workflows and queue.
  for (const kind of ["check", "workflow", "queue"] as const) assert.equal(localRefusal(verified, kind, true), null, kind);
  for (const kind of ["agent", "deploy", "embedding"] as const) assert.equal(localRefusal(verified, kind, true), "trial_used", kind);
  assert.equal(localRefusal(verified, "check", false), "trial_used");
  const trial = ent({ plan: "free", compute: true, trialVerified: true, trialMicrosLeft: 4_000_000 });
  assert.equal(localRefusal(trial, "agent", false), null);
  assert.equal(localRefusal(ent(), "deploy", false), null);
  assert.equal(localRefusal(ent({ paused: "Held." }), "agent", false), "paused");
});

// ---- Estimates ------------------------------------------------------------------------

test("an agent's estimate is its model's average plus its sandbox for its time cap", () => {
  assert.equal(sandboxEstimateMicros(60, 25), 90_000);
  assert.equal(agentEstimateMicros("implement", 90, 25), 100_000 + 135_000);
  assert.equal(agentEstimateMicros("review", 30, 25), 70_000 + 45_000);
  assert.equal(agentEstimateMicros("plan", 30, 20), 100_000 + 36_000);
  // The workspace's own provider pays for the model.
  assert.equal(agentEstimateMicros("implement", 90, 25, true), 135_000);
  assert.equal(MODEL_ESTIMATE_MICROS.implement, 100_000);
  assert.equal(embeddingEstimateMicros(1_000_000), 67_000);
  assert.equal(sandboxEstimateMicros(-5, 25), 0);
});

test("what work cost: its seconds, plus its model in dollars", () => {
  assert.equal(actualMicros(600, 20), 12_000);
  assert.equal(actualMicros(600, 20, 0.094), 12_000 + 94_000);
  assert.equal(actualMicros(10, 20, Number.NaN), 200);
});

test("the gate reads the sandbox price from the price book", async () => {
  const gate = new ComputeGate(billing({}).binding, memory(), quiet);
  assert.equal(await gate.microsPerSecond(), 20);
  const down = new ComputeGate(billing({ fail: new Set(["prices"]) }).binding, memory(), quiet);
  assert.equal(await down.microsPerSecond(), 25);
});

// ---- Caps -------------------------------------------------------------------------------

test("caps are the lower of the guardrails' and the plan's", () => {
  assert.equal(lowerCap(90, 60), 60);
  assert.equal(lowerCap(30, 60), 30);
  assert.equal(lowerCap(null, 60), 60);
  assert.equal(lowerCap(0, 0), null);
  assert.equal(runMinutes(90, ent({ maxRunMinutes: 60 })), 60);
  assert.equal(runMinutes(45, ent({ maxRunMinutes: 0 })), 45);
  assert.equal(runBudgetUsd(5, ent({ runCapMicros: 2_000_000 })), 2);
  assert.equal(runBudgetUsd(1, ent({ runCapMicros: 2_000_000 })), 1);
  assert.equal(runBudgetUsd(null, ent({ runCapMicros: 0 })), null);
  const guard = { policy: { budgetUsd: 5 } as never, minutes: 90 };
  const limited = withPlanLimits(guard as never, { minutes: 60, budgetUsd: 2 });
  assert.equal(limited.minutes, 60);
  assert.equal((limited.policy as { budgetUsd: number }).budgetUsd, 2);
  const unlimited = withPlanLimits(guard as never, { minutes: null, budgetUsd: null });
  assert.equal(unlimited.minutes, 90);
  assert.equal((unlimited.policy as { budgetUsd: number }).budgetUsd, 5);
});

test("agents at once: a run waits for a free slot past the plan's cap", () => {
  const first = ent({ firstMonth: true, maxConcurrentAgents: 2 });
  assert.equal(slotFree(1, first), true);
  assert.equal(slotFree(2, first), false);
  assert.equal(slotFree(50, ent({ plan: "internal", maxConcurrentAgents: 2 })), true);
  assert.equal(slotFree(50, ent({ maxConcurrentAgents: 0 })), true);
  assert.equal(slotFree(50, null), true);
  const said = waitingMessage(2);
  assert.equal(isWaiting(said), true);
  assert.match(said, /runs 2 agents at a time/);
  assert.equal(isWaiting("Agents need a paid workspace."), false);
  // mentions.ts keeps its own copy, to have no runtime imports.
  assert.equal(WAITING, WAITING_PREFIX);
});

test("an issue's agents stop at its cap, with a way to raise it", () => {
  assert.equal(issueCapReached(9_999_999, ent(), 12), null);
  const capped = issueCapReached(10_000_000, ent(), 12);
  assert.match(capped ?? "", /#12 have spent \$10\.00, its cap of \$10\.00/);
  assert.equal(issueCapReached(50_000_000, ent({ issueCapMicros: 0 }), 12), null);
  assert.equal(issueCapReached(50_000_000, ent({ plan: "internal" }), 12), null);
  assert.match(refusalMessage("issue_cap", "acme", "agent", capped), /raise the cap per issue: \/acme\/-\/billing#caps$/);
});

// ---- Builds' network ---------------------------------------------------------------------

test("builds reach registries and git hosts, and no mining pool", () => {
  for (const host of ["registry.npmjs.org", "codeload.github.com", "nodejs.org", "crates.io"]) {
    assert.ok(BUILD_HOSTS.includes(host), host);
  }
  assert.ok(buildHosts("deploy").includes("api.cloudflare.com"));
  assert.ok(!buildHosts("actions").includes("api.cloudflare.com"));
  for (const host of buildHosts("deploy")) {
    assert.doesNotMatch(host, /pool|xmr|monero|nicehash|^\*/, host);
  }
});

// ---- Mentions --------------------------------------------------------------------------------

test("a mention whose run waits for a slot says so, and is not a failure", async () => {
  const replies: string[] = [];
  const recorded: string[] = [];
  const job = {
    commentId: "cmt_1",
    actor: { id: "u1", username: "ana" },
    repo,
    number: 3,
    member: true,
    pull: null,
    intent: "work",
    issueOpen: true,
    workingPull: null,
    body: "@g1t take this",
    defaultBranch: "main",
  } as never;
  await handleMention(job, {
    mentions: { replyMention: async (_id: string, text: string) => (replies.push(text), true) } as never,
    refusal: async () => null,
    assign: async () => ({ ok: false, error: { code: "conflict", message: waitingMessage(2) } }),
    revise: async () => null,
    review: async () => ({ ok: true, value: true }),
    answer: async () => ({ ok: true, value: true }),
    message: async () => ({ ok: true, value: true }),
    record: async (_job, why) => void recorded.push(why),
  });
  assert.equal(recorded.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^@ana, Waiting for a free slot/);
});
