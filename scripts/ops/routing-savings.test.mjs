import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_ROUTING } from "../../services/runner/src/model-env.ts";
import { autoNext, compare, configuredRouting, costOn, play, previousNext, previousTier, tasksFromBilling } from "./routing-savings.mjs";

const routing = DEFAULT_ROUTING;
// The arithmetic below runs on fixed prices, so a new model in a tier
// (Haiku 5.5 replaced Haiku 4.5 on the fast tier) doesn't change it.
const priced = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
const fixed = {
  ...DEFAULT_ROUTING,
  tasks: { ...DEFAULT_ROUTING.tasks, plan: "large" },
  tiers: {
    small: { modelName: "Fast", model: "fast", price: priced(1, 5, 0.1, 1.25) },
    large: { modelName: "Standard", model: "standard", price: priced(2, 10, 0.2, 2.5) },
    frontier: { modelName: "Most capable", model: "capable", price: priced(4, 20, 0.2, 5) },
  },
};
const million = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

test("tokens are priced at each tier's list price, the fast tier's scaled for extra turns", () => {
  assert.equal(costOn("small", million, fixed), 1);
  assert.equal(costOn("large", million, fixed), 2);
  assert.equal(costOn("frontier", million, fixed), 4);
  assert.equal(costOn("small", million, fixed, 1.5), 1.5);
  assert.equal(costOn("large", million, fixed, 1.5), 2);
  const mixed = { input: 0, output: 1_000_000, cacheRead: 10_000_000, cacheWrite: 1_000_000 };
  // $10 of output, $2 of cache reads, $2.50 of cache writes.
  assert.equal(costOn("large", mixed, fixed), 14.5);
  const unpriced = { ...fixed, tiers: { ...fixed.tiers, large: { modelName: "X", model: "x" } } };
  assert.equal(costOn("large", million, unpriced), null);
});

test("a failed attempt is paid for, and Auto retries one tier up until the most capable", () => {
  const task = { id: "t", kind: "implement", failsOn: ["small", "large"], tokens: million };
  assert.deepEqual(play(task, "small", autoNext(fixed), fixed, 1), { attempts: ["small", "large", "frontier"], cost: 7, done: true });
  // Routing before Auto stayed on the large tier and asked a person after two failures.
  assert.deepEqual(play(task, "large", previousNext, fixed, 1), { attempts: ["large", "large"], cost: 4, done: false });
  // Nothing past the most capable model.
  const hopeless = { ...task, failsOn: ["small", "large", "frontier"] };
  assert.equal(play(hopeless, "small", autoNext(fixed), fixed, 1).done, false);
});

test("routing before Auto is replayed as it was", () => {
  assert.equal(previousTier({ kind: "plan" }), "small");
  assert.equal(previousTier({ kind: "update" }), "small");
  assert.equal(previousTier({ kind: "answer" }), "large");
  assert.equal(previousTier({ kind: "review", change: { files: 3, lines: 80, sensitive: [] } }), "small");
  assert.equal(previousTier({ kind: "review", change: { files: 3, lines: 80, sensitive: [] }, labels: ["Security"] }), "large");
  assert.equal(previousTier({ kind: "review" }), "large");
});

test("the comparison totals each policy and its cost per merged change", () => {
  const tasks = [
    { id: "a", kind: "update", tokens: million, merged: false },
    { id: "b", kind: "implement", labels: ["docs"], tokens: million, merged: true },
  ];
  const { totals, savings, rows } = compare(tasks, fixed, { smallTurns: 1 });
  // Auto: both fast. Before: catching up fast, the change standard.
  assert.equal(totals.auto.cost, 2);
  assert.equal(totals.before.cost, 3);
  assert.equal(totals.frontier.cost, 8);
  assert.equal(totals.auto.perMerged, 2);
  assert.ok(Math.abs(savings.vsBefore - 1 / 3) < 1e-9);
  assert.equal(savings.vsFrontier, 0.75);
  assert.match(rows[1].reason, /labelled docs/);
});

test("the sample is well formed and every task is priced", () => {
  const sample = JSON.parse(readFileSync(new URL("./routing-savings.sample.json", import.meta.url), "utf8"));
  assert.ok(sample.tasks.length >= 10);
  for (const task of sample.tasks) {
    assert.ok(["implement", "revise", "answer", "review", "update", "plan"].includes(task.kind), task.id);
    assert.ok(costOn("large", task.tokens, routing) > 0, task.id);
  }
  const { totals } = compare(sample.tasks, routing);
  assert.ok(totals.auto.cost > 0 && totals.before.cost > 0 && totals.frontier.cost > 0);
});

test("billing's runs become tasks; reviews keep the tier they ran on", () => {
  const tasks = tasksFromBilling([
    { id: "run_1", task: "review", tier: "small", input: 10, output: 5, cache_read: 0, cache_write: 0 },
    { id: "run_2", task: "implement", tier: "large", input: 0, output: 0, cache_read: 0, cache_write: 0 },
    { id: "run_3", task: "plan", tier: null, input: 1, output: 1, cache_read: 1, cache_write: 1 },
  ]);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.kind, t.keepTier]),
    [
      ["run_1", "review", "small"],
      ["run_3", "plan", null],
    ],
  );
});

test("the routing estimated is the runner's configuration", () => {
  const text = readFileSync(new URL("../../services/runner/wrangler.jsonc", import.meta.url), "utf8");
  assert.deepEqual(configuredRouting(text), DEFAULT_ROUTING);
  assert.deepEqual(configuredRouting("not jsonc {"), DEFAULT_ROUTING);
});
