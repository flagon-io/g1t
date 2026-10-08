import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogueModel } from "@g1t/contracts";

import { choicesFor, describeDefault, impact, parseApproval, parseDefault, parsePerMillion, perMillion, tokens } from "./models.ts";

function model(id: string, name: string, typical: number, extra: Partial<CatalogueModel> = {}): CatalogueModel {
  return {
    model: id,
    name,
    provider: "anthropic",
    kind: "chat",
    inputMicros: 1_000_000,
    outputMicros: 5_000_000,
    cacheReadMicros: 100_000,
    cacheWriteMicros: 1_250_000,
    aliases: [],
    family: "haiku",
    tierHint: "small",
    contextWindow: 0,
    maxOutput: 0,
    capabilities: [],
    dimensions: 0,
    status: "available",
    priced: true,
    source: "staff",
    firstSeenAt: null,
    lastSeenAt: null,
    missingSince: null,
    approvedBy: null,
    approvedAt: null,
    note: "",
    typicalRunMicros: typical,
    ...extra,
  };
}

const catalogue = [
  model("claude-haiku-5-5", "Claude Haiku 5.5", 76_000),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_340_000, { tierHint: "large" }),
  model("claude-haiku-6", "Claude Haiku 6", 0, { status: "new", priced: false }),
  model("@cf/openai/gpt-oss-120b", "gpt-oss-120b", 30_000, { provider: "workers-ai" }),
  model("claude-haiku-4-5", "Claude Haiku 4.5", 600_000, { status: "retired" }),
];

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

test("prices per million are typed in dollars to a millionth", () => {
  assert.equal(parsePerMillion("0.125"), 125_000);
  assert.equal(parsePerMillion("$2"), 2_000_000);
  assert.equal(parsePerMillion("12.50"), 12_500_000);
  assert.equal(parsePerMillion("0.000001"), 1);
  assert.equal(parsePerMillion(""), 0);
  assert.equal(parsePerMillion("-1"), null);
  assert.equal(parsePerMillion("0.0000001"), null);
  assert.equal(parsePerMillion("abc"), null);
  assert.equal(perMillion(125_000), "0.125");
  assert.equal(perMillion(100_000), "0.10");
  assert.equal(perMillion(2_000_000), "2");
});

test("approving a model takes its name, tier, prices and why", () => {
  const approved = parseApproval(
    form({ name: "Claude Haiku 6", tier_hint: "small", input: "0.08", output: "0.40", cache_read: "0.008", cache_write: "0.10", reason: "Anthropic's price page" }),
    "chat",
  );
  assert.ok(approved.ok);
  assert.equal(approved.value.prices.inputMicros, 80_000);
  assert.equal(approved.value.prices.outputMicros, 400_000);
  // No hour-long price: what a five-minute write costs.
  assert.equal(approved.value.prices.cacheWrite1hMicros, 100_000);
  assert.equal(approved.value.prices.threshold, 0);
  assert.equal(parseApproval(form({ name: "X", input: "1", output: "", reason: "r" }), "chat").ok, false);
  assert.equal(parseApproval(form({ name: "X", input: "0.012", reason: "r" }), "embeddings").ok, true);
  assert.deepEqual(parseApproval(form({ name: "X", input: "1", output: "5", reason: "" }), "chat"), { ok: false, error: "Say why, for whoever looks next." });
  assert.equal(parseApproval(form({ name: "X", input: "1", output: "5", over_input: "2", reason: "r" }), "chat").ok, false);
  const long = parseApproval(form({ name: "X", input: "1", output: "5", threshold: "200,000", over_input: "2", over_output: "10", reason: "r" }), "chat");
  assert.ok(long.ok);
  assert.equal(long.value.prices.threshold, 200_000);
  assert.equal(parseApproval(form({ name: "X", tier_hint: "huge", input: "1", output: "5", reason: "r" }), "chat").ok, false);
  assert.equal(parseApproval(form({ name: "", input: "1", output: "5", reason: "r" }), "chat").ok, false);
});

test("a model purpose takes only an available, priced Claude", () => {
  const choices = choicesFor(catalogue);
  assert.deepEqual(choices.map((m) => m.model), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  const set = parseDefault(form({ purpose: "tier_small", model: "claude-sonnet-5-5", reason: "testing" }), choices);
  assert.deepEqual(set, { ok: true, value: { purpose: "tier_small", model: "claude-sonnet-5-5", tier: null, effort: null, reason: "testing" } });
  assert.equal(parseDefault(form({ purpose: "tier_small", model: "claude-haiku-6", reason: "x" }), choices).ok, false);
  assert.equal(parseDefault(form({ purpose: "background", model: "@cf/openai/gpt-oss-120b", reason: "x" }), choices).ok, false);
  assert.equal(parseDefault(form({ purpose: "tier_small", model: "claude-haiku-5-5", reason: "" }), choices).ok, false);
  assert.equal(parseDefault(form({ purpose: "nonsense", model: "claude-haiku-5-5", reason: "x" }), choices).ok, false);
});

test("a job takes a tier and an effort, or the harness's own", () => {
  const choices = choicesFor(catalogue);
  assert.deepEqual(parseDefault(form({ purpose: "job_plan", tier: "small", effort: "xhigh", reason: "x" }), choices), {
    ok: true,
    value: { purpose: "job_plan", model: null, tier: "small", effort: "xhigh", reason: "x" },
  });
  const own = parseDefault(form({ purpose: "job_update", tier: "small", effort: "", reason: "x" }), choices);
  assert.ok(own.ok);
  assert.equal(own.value.effort, null);
  // Only a review is sized by the change.
  assert.equal(parseDefault(form({ purpose: "job_review", tier: "change", reason: "x" }), choices).ok, true);
  assert.equal(parseDefault(form({ purpose: "job_plan", tier: "change", reason: "x" }), choices).ok, false);
  assert.equal(parseDefault(form({ purpose: "job_plan", tier: "small", effort: "huge", reason: "x" }), choices).ok, false);
});

test("a change shows what a typical run would cost before it is saved", () => {
  const before = { purpose: "tier_small", chosen: "claude-haiku-5-5", model: catalogue[0], capabilities: [], note: null };
  assert.equal(
    impact(before, catalogue[1], catalogue),
    "A typical run: about $1.34 on Claude Sonnet 5.5, 17.6 times $0.076 on Claude Haiku 5.5.",
  );
  assert.equal(impact({ ...before, model: catalogue[1] }, catalogue[0], catalogue), "A typical run: about $0.076 on Claude Haiku 5.5, 94% less than $1.34 on Claude Sonnet 5.5.");
  assert.equal(impact(before, catalogue[0], catalogue), "No change: Claude Haiku 5.5 already runs it, at about $0.076 a typical run.");
  assert.equal(impact(undefined, catalogue[1], catalogue), "A typical run would cost about $1.34 on Claude Sonnet 5.5.");
  assert.equal(impact(before, undefined, catalogue), null);
});

test("defaults and sizes read plainly", () => {
  assert.equal(describeDefault({ model: "claude-haiku-5-5", tier: null, effort: null }, catalogue), "Claude Haiku 5.5");
  assert.equal(describeDefault({ model: null, tier: "small", effort: "high" }, catalogue), "Fast, high effort");
  assert.equal(describeDefault({ model: null, tier: "change", effort: null }, catalogue), "By the change's size, the harness's own effort");
  assert.equal(tokens(1_000_000), "1M");
  assert.equal(tokens(200_000), "200k");
  assert.equal(tokens(0), "—");
});
