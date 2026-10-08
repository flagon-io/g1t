import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_ROUTING, type StoredDefaults, effortFor, route, routingReader, tierVars, withDefaults } from "./model-env.ts";

const stored = (): StoredDefaults => ({
  models: [
    {
      purpose: "tier_small",
      model: { model: "claude-haiku-6", name: "Claude Haiku 6", inputMicros: 80_000, outputMicros: 400_000, cacheReadMicros: 8_000, cacheWriteMicros: 100_000 },
      capabilities: ["effort", "thinking", "tools"],
      note: null,
    },
    {
      purpose: "tier_frontier",
      model: { model: "claude-opus-5-5", name: "Claude Opus 5.5", inputMicros: 4_000_000, outputMicros: 20_000_000, cacheReadMicros: 200_000, cacheWriteMicros: 5_000_000 },
      capabilities: ["effort"],
      note: "Claude Fable 6 is retired; using Claude Opus 5.5 instead.",
    },
    {
      purpose: "background",
      model: { model: "claude-haiku-4-5", name: "Claude Haiku 4.5", inputMicros: 1_000_000, outputMicros: 5_000_000, cacheReadMicros: 100_000, cacheWriteMicros: 1_250_000 },
      capabilities: ["thinking", "tools"],
      note: null,
    },
    // Nothing suited: the configured tier stays.
    { purpose: "tier_large", model: null, capabilities: [], note: "Claude Sonnet 6 is retired, and no other model suits it." },
  ],
  jobs: [
    { kind: "implement", tier: "frontier", effort: "xhigh" },
    { kind: "plan", tier: "large", effort: null },
    { kind: "update", tier: "change", effort: "low" },
    { kind: "nonsense", tier: "small", effort: "low" },
  ],
});

test("staff's defaults from the catalogue replace each tier's model, named as the catalogue names it", () => {
  const routing = withDefaults(DEFAULT_ROUTING, stored());
  assert.equal(routing.tiers.small.model, "claude-haiku-6");
  assert.deepEqual(routing.tiers.small.price, { input: 0.08, output: 0.4, cacheRead: 0.008, cacheWrite: 0.1 });
  assert.equal(routing.tiers.large.model, DEFAULT_ROUTING.tiers.large.model);
  // The run's line uses the catalogue's name.
  assert.equal(route("update", {}, routing).reason, "Used a fast model (Claude Haiku 6): catching up with the base branch.");
  // A tier that fell back says so.
  assert.equal(
    route("plan", { labels: ["architecture"] }, routing).reason,
    "Used the most capable model (Claude Opus 5.5): the issue is labelled architecture. Claude Fable 6 is retired; using Claude Opus 5.5 instead.",
  );
});

test("staff's defaults set each job's tier and effort, and the background model", () => {
  const routing = withDefaults(DEFAULT_ROUTING, stored());
  assert.equal(routing.tasks.implement, "frontier");
  assert.equal(routing.effort.implement, "xhigh");
  // No effort: the harness's own.
  assert.equal(routing.tasks.plan, "large");
  assert.equal(routing.effort.plan, undefined);
  // Only a review is sized by its change.
  assert.equal(routing.tasks.update, DEFAULT_ROUTING.tasks.update);
  const vars = tierVars(routing, "large");
  assert.equal(vars.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5");
  assert.equal(vars.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5");
  // Without a background model, the fast tier's.
  assert.equal(tierVars(DEFAULT_ROUTING, "large").ANTHROPIC_SMALL_FAST_MODEL, DEFAULT_ROUTING.tiers.small.model);
});

test("effort is left to the harness on a model that takes none", () => {
  const routing = withDefaults(DEFAULT_ROUTING, stored());
  assert.equal(effortFor(routing, "update", "small"), "low");
  const noEffort = { ...routing, tiers: { ...routing.tiers, small: { ...routing.tiers.small, capabilities: ["tools"] } } };
  assert.equal(effortFor(noEffort, "update", "small"), undefined);
  // A route from configuration says nothing about capabilities: effort is sent.
  assert.equal(effortFor(DEFAULT_ROUTING, "plan", "small"), "high");
});

test("routing reads billing's defaults once a minute, and AGENT_ROUTING alone when billing cannot be read", async () => {
  const now = routingReader(60_000, 10_000);
  let reads = 0;
  const read = async () => {
    reads += 1;
    return stored();
  };
  assert.equal((await now(undefined, read, 0)).tiers.small.model, "claude-haiku-6");
  assert.equal((await now(undefined, read, 59_000)).tiers.small.model, "claude-haiku-6");
  assert.equal(reads, 1);
  await now(undefined, read, 60_000);
  assert.equal(reads, 2);

  const failing = routingReader(60_000, 10_000);
  const broken = async (): Promise<StoredDefaults> => {
    reads += 1;
    throw new Error("billing is down");
  };
  const configured = JSON.stringify({ tiers: { small: { modelName: "Claude Haiku 4.5", model: "claude-haiku-4-5" } } });
  const fallback = await failing(configured, broken, 0);
  assert.equal(fallback.tiers.small.model, "claude-haiku-4-5");
  assert.equal(fallback.tiers.large.model, DEFAULT_ROUTING.tiers.large.model);
  // Asked again after ten seconds, not on every run.
  const before = reads;
  await failing(configured, broken, 5_000);
  assert.equal(reads, before);
  assert.equal((await failing(configured, read, 10_000)).tiers.small.model, "claude-haiku-6");
});
