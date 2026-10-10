import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSession, MeterLine, PriceBook, UsageReport } from "@g1t/contracts";

import { agentMicros, agentRateLabel, agentSpendHref, attributionSlices, daySeries, markupLabel, percentLabel, pricingOf, readPeriod, readScope, receiptOf, spanFor, tokenCount } from "./spend.ts";

const OCT_8 = new Date("2026-10-08T15:00:00Z");

test("a period's days match the agents service's, both ends included", () => {
  assert.deepEqual(spanFor("month", OCT_8), { from: "2026-10-01", until: "2026-10-08" });
  assert.deepEqual(spanFor("last_month", OCT_8), { from: "2026-09-01", until: "2026-09-30" });
  assert.deepEqual(spanFor("last_month", new Date("2026-01-15T00:00:00Z")), { from: "2025-12-01", until: "2025-12-31" });
  assert.deepEqual(spanFor("7d", OCT_8), { from: "2026-10-02", until: "2026-10-08" });
  assert.deepEqual(spanFor("30d", OCT_8), { from: "2026-09-09", until: "2026-10-08" });
});

test("only someone who may see the workspace's spend gets it; anything else is their own", () => {
  assert.equal(readScope(null, true), "workspace");
  assert.equal(readScope("me", true), "me");
  assert.equal(readScope("workspace", false), "me");
  assert.equal(readPeriod("7d"), "7d");
  assert.equal(readPeriod("year"), "month");
});

test("a day series has every day, products added together, zeros where nothing was spent", () => {
  const days = daySeries("2026-10-01", "2026-10-03", [
    { day: "2026-10-01", micros: 5 },
    { day: "2026-10-01", micros: 7 },
    { day: "2026-10-03", micros: 1 },
  ]);
  assert.deepEqual(days, [
    { day: "2026-10-01", micros: 12 },
    { day: "2026-10-02", micros: 0 },
    { day: "2026-10-03", micros: 1 },
  ]);
});

test("pricing comes from the price book: models at the provider's price, what g1t runs at its markup", () => {
  const book = {
    modelMarginPercent: 0,
    changes: [],
    prices: [
      { meter: "sandbox_second", costMicros: 10, markupPercent: 20, priceMicros: 12 },
      { meter: "build_second", costMicros: 10, markupPercent: 20, priceMicros: 12 },
      { meter: "agent_models", costMicros: 1_000_000, markupPercent: 0, priceMicros: 1_000_000 },
      { meter: "gateway_models", costMicros: 1_000_000, markupPercent: 0, priceMicros: 1_000_000 },
      { meter: "card_fee_percent", costMicros: 29_000, markupPercent: 0, priceMicros: 29_000 },
      { meter: "agent_token_weight_input", costMicros: 1_000_000, markupPercent: 0, priceMicros: 1_000_000 },
      { meter: "agent_tokens", costMicros: 0, markupPercent: 0, priceMicros: 0 },
      { meter: "agent_tokens_own", costMicros: 0, markupPercent: 0, priceMicros: 0 },
    ],
  } as unknown as PriceBook;
  (book as { changes: unknown[] }).changes = [{ meter: "agent_tokens", newCostMicros: 250_000, effectiveAt: "2026-10-22T00:00:00Z" }];
  const pricing = pricingOf(book);
  assert.equal(pricing.modelMarkupPercent, 0);
  // Models, the gateway, card fees and weights are not things g1t runs: the markup is one figure.
  assert.deepEqual(pricing.markup, { min: 20, max: 20 });
  assert.equal(markupLabel(pricing.markup!), "20%");
  assert.equal(markupLabel({ min: 15, max: 20 }), "15–20%");
  // The agent rate, $0 until its dated version starts.
  assert.equal(pricing.agentRateMicros, 0);
  assert.deepEqual(pricing.agentRateComing, { micros: 250_000, from: "2026-10-22" });
  const dollars = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
  assert.equal(agentRateLabel(pricing, dollars), "$0.25 per million tokens from 2026-10-22");
  assert.equal(agentRateLabel({ agentRateMicros: 250_000, agentRateComing: null }, dollars), "$0.25 per million tokens");
});

const session = (over: Partial<AgentSession>): AgentSession =>
  ({ id: "s", parent_id: null, root_id: "r", charged_micros: 0, cost_micros: 0, input_tokens: 0, output_tokens: 0, steps: 0, tool_calls: 0, created_at: "2026-10-08T00:00:00Z", ...over }) as AgentSession;

test("a receipt gives the root its own share, children under their parents, and the tree's totals", () => {
  const tree = [
    session({ id: "r", charged_micros: 1_840_000, cost_micros: 1_000_000, input_tokens: 400_000, output_tokens: 30_000, steps: 6, tool_calls: 20 }),
    session({ id: "c1", parent_id: "r", charged_micros: 300_000, cost_micros: 200_000, input_tokens: 10_000, steps: 2, created_at: "2026-10-08T00:01:00Z" }),
    session({ id: "g1", parent_id: "c1", charged_micros: 40_000, cost_micros: 30_000, steps: 1, created_at: "2026-10-08T00:02:00Z" }),
  ];
  const receipt = receiptOf(tree, "r")!;
  assert.deepEqual(
    receipt.lines.map((l) => [l.session.id, l.depth, l.ownMicros]),
    [
      ["r", 0, 1_500_000],
      ["c1", 1, 300_000],
      ["g1", 2, 40_000],
    ],
  );
  assert.equal(receipt.chargedMicros, 1_840_000);
  assert.equal(receipt.providerMicros, 1_230_000);
  assert.equal(receipt.steps, 9);
  assert.equal(receiptOf([], "r"), null);
});

test("token counts and percents read short", () => {
  assert.equal(tokenCount(830), "830");
  assert.equal(tokenCount(1_200), "1.2K");
  assert.equal(tokenCount(412_000), "412K");
  assert.equal(tokenCount(1_250_000), "1.3M");
  assert.equal(percentLabel(62, 100), "62%");
  assert.equal(percentLabel(62, null), "");
});

/** A usage report as billing answers it for a comped workspace in October: every line discounted in full, attributed to its agent. */
function octoberReport(): Pick<UsageReport, "totals" | "products" | "byAgent" | "byPerson"> {
  const meter = (key: string, product: string, micros: number): MeterLine => ({ key, label: key, product, unit: "entries", quantity: 1, micros, daily: [micros], byProject: [] });
  const products = [
    { key: "agent", label: "Agent", micros: 2_544_000, meters: [meter("agent_models", "agent", 1_900_000), meter("agent_rate", "agent", 400_000), meter("agent_sandbox", "agent", 244_000)] },
    { key: "sandboxes", label: "Sandboxes", micros: 3_360_000, meters: [meter("sandbox", "sandboxes", 3_360_000)] },
    { key: "deployments", label: "Deployments", micros: 4_480_000, meters: [meter("requests", "deployments", 4_480_000)] },
  ];
  return {
    totals: { priceMicros: 10_384_000, discountMicros: 10_384_000, includedMicros: 0, creditsMicros: 0, chargedMicros: 0, pendingMicros: 0, costMicros: 8_650_000 },
    products,
    byAgent: [
      { key: "g1t", label: "@g1t", micros: 2_520_000, count: 9 },
      { key: "mike", label: "@mike", micros: 20_000, count: 2 },
      { key: "margo", label: "@margo", micros: 4_000, count: 1 },
    ],
    byPerson: [
      { key: "chase", label: "@chase", micros: 2_540_000, count: 11 },
      { key: "", label: "No one asked", micros: 4_000, count: 1 },
    ],
  };
}

test("Home's Spent, Spend's tiles and the top bar's Agents reconcile on the one ledger", () => {
  const report = octoberReport();
  // Spent: every product at price, which is the report's total.
  const spent = report.products.reduce((n, p) => n + p.micros, 0);
  assert.equal(spent, report.totals.priceMicros);
  // Agents: the agent product, part of Spent, and what the agents by handle add up to.
  assert.equal(agentMicros(report), 2_544_000);
  assert.ok(agentMicros(report) <= spent);
  const slices = attributionSlices(report);
  assert.ok(slices);
  assert.equal(
    slices.agent.reduce((n, s) => n + s.micros, 0),
    agentMicros(report),
  );
  assert.equal(
    slices.person.reduce((n, s) => n + s.micros, 0),
    agentMicros(report),
  );
  assert.ok(slices.agent.every((s) => s.micros <= agentMicros(report)));
  // Charged: nothing, on a 100% discount, however much was spent.
  assert.equal(report.totals.chargedMicros, 0);
  assert.equal(report.totals.priceMicros - report.totals.discountMicros - report.totals.includedMicros - report.totals.creditsMicros, 0);
});

test("an agent's slice opens its own Spend tab; work attributed to no one opens nothing", () => {
  const slices = attributionSlices(octoberReport());
  assert.ok(slices);
  assert.equal(agentSpendHref("flagon-io", slices.agent[0]), "/flagon-io/-/agents/g1t/spend");
  assert.equal(agentSpendHref("flagon-io", slices.person[1]), null);
  assert.deepEqual(slices.agent[1], { key: "mike", label: "@mike", micros: 20_000, count: 2 });
  // A report from before attribution has no slices: the caller falls back.
  assert.equal(attributionSlices({ byAgent: undefined, byPerson: undefined }), null);
  assert.equal(attributionSlices(null), null);
  assert.equal(agentMicros({ products: [] }), 0);
});
