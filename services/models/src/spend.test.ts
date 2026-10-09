import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayModel } from "@g1t/contracts";

import {
  BACKSTOP_CAP_MICROS,
  FRONTIER_PRICES,
  HOLD_MS,
  MAX_IN_FLIGHT,
  STANDARD_PRICES,
  SpendTally,
  capOf,
  capReached,
  ceilingMicros,
  chargeFor,
  costMicros,
  pricesFor,
  tooBusy,
} from "./spend.ts";
import { NO_TOKENS } from "./usage.ts";

function model(fields: Partial<GatewayModel> & { model: string }): GatewayModel {
  return { name: fields.model, provider: "anthropic", inputMicros: 0, outputMicros: 0, cacheReadMicros: 0, cacheWriteMicros: 0, ...fields };
}

const sonnet = model({ model: "claude-sonnet-5-5", inputMicros: 3_000_000, outputMicros: 15_000_000, cacheReadMicros: 300_000, cacheWriteMicros: 3_750_000, cacheWrite1hMicros: 6_000_000 });
const haiku = model({ model: "claude-haiku-5", inputMicros: 1_000_000, outputMicros: 5_000_000, cacheReadMicros: 100_000, cacheWriteMicros: 1_250_000 });
const embed = model({ model: "@cf/baai/bge-m3", provider: "workers-ai", kind: "embeddings", inputMicros: 12_000, outputMicros: 900_000_000 });
const offered = [haiku, sonnet, embed];

test("a run's cap is the one its sandbox set, else the most any run may cost", () => {
  assert.equal(capOf({ capMicros: 2_000_000 }), 2_000_000);
  assert.equal(capOf({ capMicros: null }), BACKSTOP_CAP_MICROS);
  assert.equal(capOf({}), BACKSTOP_CAP_MICROS);
  assert.equal(capOf({ capMicros: 0 }), BACKSTOP_CAP_MICROS);
});

test("an answer is priced by its model in the catalogue, dated ids and provider prefixes included", () => {
  assert.equal(pricesFor("claude-sonnet-5-5", "g1t", offered), sonnet);
  assert.equal(pricesFor("claude-sonnet-5-5-20260901", "g1t", offered), sonnet);
  assert.equal(pricesFor("anthropic/claude-haiku-5", "anthropic", offered), haiku);
});

test("a model missing from the catalogue is priced high on g1t's models, at standard prices on the workspace's own", () => {
  assert.equal(pricesFor("mystery", "g1t", offered), FRONTIER_PRICES);
  assert.equal(pricesFor(null, "g1t", []), FRONTIER_PRICES);
  const dearer = model({ model: "claude-opus-9", inputMicros: 20_000_000, outputMicros: 100_000_000 });
  assert.equal(pricesFor("mystery", "g1t", [...offered, dearer]), dearer);
  assert.equal(pricesFor("llama-local", "endpoint", offered), STANDARD_PRICES);
});

test("cost is billing's sum: each kind of token at its price, rounded up", () => {
  // 1,000 in at $3, 500 out at $15, 10,000 cache reads at $0.30, 2,000 writes (500 of them hour-long).
  const tokens = { input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000, cacheWrite1h: 500 };
  assert.equal(costMicros(sonnet, tokens), 3_000 + 7_500 + 3_000 + 5_625 + 3_000);
  assert.equal(costMicros(sonnet, { ...NO_TOKENS, input: 1 }), 3);
  assert.equal(costMicros(haiku, { ...NO_TOKENS, input: 1 }), 1);
  // No hour-long price: those writes cost what five-minute ones do.
  assert.equal(costMicros(haiku, { ...NO_TOKENS, cacheWrite: 1_000, cacheWrite1h: 1_000 }), 1_250);
});

test("a prompt past the model's threshold puts the whole request at the higher prices", () => {
  const long = model({ model: "long", inputMicros: 1_000_000, outputMicros: 2_000_000, threshold: 100, overInputMicros: 2_000_000, overOutputMicros: 4_000_000 });
  assert.equal(costMicros(long, { ...NO_TOKENS, input: 100, output: 1_000 }), 100 + 2_000);
  assert.equal(costMicros(long, { ...NO_TOKENS, input: 101, output: 1_000 }), 202 + 4_000);
});

test("an answer is charged its cost, nothing when refused, and its ceiling when its usage could not be read", () => {
  const ceiling = ceilingMicros(sonnet, 4_000, 1_000);
  assert.equal(ceiling, 3_000 + 15_000);
  assert.equal(ceilingMicros(sonnet, 0, undefined), 32_000 * 15);
  assert.equal(chargeFor(sonnet, { ...NO_TOKENS, output: 100 }, true, ceiling), 1_500);
  assert.equal(chargeFor(sonnet, NO_TOKENS, true, ceiling), ceiling);
  assert.equal(chargeFor(sonnet, NO_TOKENS, false, ceiling), 0);
});

test("a run under its cap is admitted, and refused once it has spent it", () => {
  const tally = new SpendTally();
  const first = tally.admit(10_000, 0);
  assert.ok(first.ok);
  assert.equal(tally.settle(first.ticket, 9_999), 9_999);
  const second = tally.admit(10_000, 1);
  assert.ok(second.ok);
  // The answer in flight takes it past; the next is refused.
  tally.settle(second.ticket, 5_000);
  assert.deepEqual(tally.admit(10_000, 2), { ok: false, reason: "cap", spent: 14_999 });
});

test("many requests at once are bounded, and an answer never settled gives its place back in time", () => {
  const tally = new SpendTally();
  const tickets: string[] = [];
  for (let i = 0; i < MAX_IN_FLIGHT; i++) {
    const admitted = tally.admit(1_000_000, 0);
    assert.ok(admitted.ok);
    tickets.push(admitted.ticket);
  }
  assert.deepEqual(tally.admit(1_000_000, 0), { ok: false, reason: "busy", spent: 0 });
  tally.settle(tickets[0], 0);
  assert.ok(tally.admit(1_000_000, 1).ok);
  assert.equal(tally.admit(1_000_000, 1).ok, false);
  assert.ok(tally.admit(1_000_000, HOLD_MS + 1).ok);
  // Those from the start have lapsed; the one from a moment later has not.
  assert.equal(tally.inFlight, 2);
});

test("a tally resumes from what was stored, and settling twice or with nonsense adds nothing", () => {
  const tally = new SpendTally(500);
  const admitted = tally.admit(1_000, 0);
  assert.ok(admitted.ok);
  tally.settle(admitted.ticket, Number.NaN);
  tally.settle(admitted.ticket, -5);
  assert.equal(tally.spent, 500);
  assert.equal(new SpendTally(-1).spent, 0);
});

test("a run past its cap is told so in Anthropic's error shape, with a code", async () => {
  const response = capReached(2_000_000, 2_031_000);
  assert.equal(response.status, 402);
  const body = (await response.json()) as { type: string; error: { type: string; code: string; message: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "billing_error");
  assert.equal(body.error.code, "run_cap_reached");
  assert.match(body.error.message, /cost cap of \$2\.00 \(it has spent \$2\.03/);
  const busy = tooBusy();
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "2");
});
