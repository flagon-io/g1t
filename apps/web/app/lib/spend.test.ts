import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderPersonCosts, ProviderPersonDay, SpendRow } from "@g1t/contracts";

import { landedShare, providerComparisons, spendBy, spendDays, spendSpan, unitAmount, usdMicros } from "./spend.ts";

const row = (over: Partial<SpendRow>): SpendRow => ({
  day: "2026-10-20",
  repo: "acme/web",
  item: 7,
  harness: "claude_code",
  model: "opus",
  landed: false,
  sessions: 1,
  costUsd: 1,
  ...over,
});

test("the span is two days in order, else a span of days ending today, else the last 30", () => {
  const at = (query: string) => spendSpan(new URLSearchParams(query), "2026-10-22");
  assert.deepEqual(at(""), { days: 30, since: "2026-09-23", until: "2026-10-22" });
  assert.deepEqual(at("days=7"), { days: 7, since: "2026-10-16", until: "2026-10-22" });
  assert.deepEqual(at("days=90"), { days: 90, since: "2026-07-25", until: "2026-10-22" });
  // Days the page doesn't offer fall back to 30.
  assert.equal(at("days=12").days, 30);
  assert.deepEqual(at("since=2026-10-01&until=2026-10-05"), { days: null, since: "2026-10-01", until: "2026-10-05" });
  // `since` alone runs to today; out of order or not a day is the default.
  assert.deepEqual(at("since=2026-10-10"), { days: null, since: "2026-10-10", until: "2026-10-22" });
  assert.equal(at("since=2026-10-05&until=2026-10-01").days, 30);
  assert.equal(at("since=yesterday&days=7").days, 7);
});

test("every day of the span is there, split into landed and not", () => {
  const days = spendDays("2026-10-19", "2026-10-21", [
    row({ day: "2026-10-20", costUsd: 2, landed: true }),
    row({ day: "2026-10-20", costUsd: 1 }),
    row({ day: "2026-10-21", costUsd: 0.5 }),
    // Outside the span: left out.
    row({ day: "2026-10-01", costUsd: 9 }),
  ]);
  assert.deepEqual(days, [
    { day: "2026-10-19", costUsd: 0, landedUsd: 0 },
    { day: "2026-10-20", costUsd: 3, landedUsd: 2 },
    { day: "2026-10-21", costUsd: 0.5, landedUsd: 0 },
  ]);
  assert.equal(spendDays("2026-10-31", "2026-11-01", []).length, 2);
});

test("rows sum by what they went into, the costliest first and none last among equals", () => {
  const rows = [
    row({ item: 7, costUsd: 1, landed: true }),
    row({ item: 7, costUsd: 2, day: "2026-10-21" }),
    row({ item: null, repo: null, costUsd: 4 }),
    row({ item: 9, costUsd: 0.5, repo: "acme/api", harness: "codex", model: null }),
  ];
  assert.deepEqual(spendBy(rows, "item"), [
    { key: null, costUsd: 4, landedUsd: 0 },
    { key: 7, costUsd: 3, landedUsd: 1 },
    { key: 9, costUsd: 0.5, landedUsd: 0 },
  ]);
  assert.deepEqual(
    spendBy(rows, "repo").map((group) => group.key),
    [null, "acme/web", "acme/api"],
  );
  assert.deepEqual(spendBy(rows, "harness"), [
    { key: "claude_code", costUsd: 7, landedUsd: 1 },
    { key: "codex", costUsd: 0.5, landedUsd: 0 },
  ]);
  // Equal costs: by name, none last.
  assert.deepEqual(
    spendBy([row({ model: null }), row({ model: "sonnet" }), row({ model: "haiku" })], "model").map((group) => group.key),
    ["haiku", "sonnet", null],
  );
  assert.deepEqual(spendBy([], "repo"), []);
  // Only sessions of no known cost: nothing to show.
  assert.deepEqual(
    spendBy([row({ item: 3, costUsd: 0 }), row({ item: 4, costUsd: 0.004 }), row({ item: 5, costUsd: 0.01 })], "item").map((group) => group.key),
    [5],
  );
});

test("the landed share is a whole percent of something spent", () => {
  assert.equal(landedShare(0, 0), null);
  assert.equal(landedShare(3, 1), 33);
  assert.equal(landedShare(2, 2), 100);
  assert.equal(usdMicros(1.2345675), 1_234_568);
});

const reported = (days: Partial<ProviderPersonDay>[], over: Partial<ProviderPersonCosts> = {}): ProviderPersonCosts => ({
  connected: true,
  days: days.map((day) => ({ day: "2026-10-20", provider: "anthropic", harness: "claude_code", model: "claude-opus-5-5", micros: 0, sessions: 1, ...day })),
  unlinkedActors: 0,
  complete: true,
  ...over,
});

test("the provider's figure for a person's Claude Code sits beside what g1t's sessions of it saw", () => {
  const rows = [row({ costUsd: 6 }), row({ costUsd: 2, day: "2026-10-21" }), row({ harness: "codex", costUsd: 50 })];
  const [claude] = providerComparisons(reported([{ micros: 7_000_000 }, { micros: 3_000_000, model: "claude-sonnet-5" }]), rows);
  assert.deepEqual(claude, {
    provider: "anthropic",
    harness: "claude_code",
    unit: "usd",
    listPrice: false,
    reportedMicros: 10_000_000,
    sawMicros: 8_000_000,
    share: 80,
    complete: true,
  });
  // Saw more than was reported: no percent over 100.
  assert.equal(providerComparisons(reported([{ micros: 5_000_000 }]), rows)[0]?.share, null);
  // Saw nothing of it.
  assert.equal(providerComparisons(reported([{ micros: 5_000_000 }]), [])[0]?.share, 0);
  assert.equal(providerComparisons(reported([{ micros: 5_000_000 }], { complete: false }), rows)[0]?.complete, false);
  // Not connected, nothing reported, or no answer: no line.
  assert.deepEqual(providerComparisons(reported([{ micros: 5_000_000 }], { connected: false }), rows), []);
  assert.deepEqual(providerComparisons(reported([]), rows), []);
  assert.deepEqual(providerComparisons(null, rows), []);
});

test("each provider's figure is per harness: compared where g1t records it, in its own unit where it isn't dollars", () => {
  const rows = [row({ harness: "cursor", costUsd: 3 }), row({ harness: "codex", costUsd: 50 }), row({ costUsd: 1 })];
  const found = providerComparisons(
    reported([
      { provider: "cursor", harness: "cursor", model: "claude-4.5-sonnet", micros: 4_000_000 },
      { provider: "cursor", harness: "cursor", model: "gpt-6-sol", micros: 2_000_000, day: "2026-10-21" },
      // OpenAI's API can't be told apart as Codex: reported, never compared.
      { provider: "openai", harness: "openai", model: "gpt-6-astra", micros: 9_000_000, listPrice: true },
      { provider: "devin", harness: "devin_desktop", model: "", micros: 125_000_000, unit: "credits" },
      { provider: "amp", harness: "amp", model: "", micros: 1_000_000 },
    ]),
    rows,
  );
  assert.deepEqual(
    found.map((c) => [c.provider, c.harness, c.unit, c.reportedMicros, c.sawMicros, c.share, c.listPrice]),
    [
      ["openai", "openai", "usd", 9_000_000, null, null, true],
      ["cursor", "cursor", "usd", 6_000_000, 3_000_000, 50, false],
      ["amp", "amp", "usd", 1_000_000, null, null, false],
      // Credits come last, and are never put beside dollars.
      ["devin", "devin_desktop", "credits", 125_000_000, null, null, false],
    ],
  );
  assert.equal(unitAmount(125_000_000, "credits"), "125 credits");
  assert.equal(unitAmount(1_000_000, "credits"), "1 credit");
  assert.equal(unitAmount(12_345_678, "acus"), "12.35 ACUs");
});
