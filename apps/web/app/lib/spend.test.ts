import assert from "node:assert/strict";
import test from "node:test";

import type { SpendRow } from "@g1t/contracts";

import { landedShare, spendBy, spendDays, spendSpan, usdMicros } from "./spend.ts";

const row = (over: Partial<SpendRow>): SpendRow => ({
  day: "2026-10-20",
  repo: "acme/web",
  item: 7,
  harness: "claude-code",
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
    { key: "claude-code", costUsd: 7, landedUsd: 1 },
    { key: "codex", costUsd: 0.5, landedUsd: 0 },
  ]);
  // Equal costs: by name, none last.
  assert.deepEqual(
    spendBy([row({ model: null }), row({ model: "sonnet" }), row({ model: "haiku" })], "model").map((group) => group.key),
    ["haiku", "sonnet", null],
  );
  assert.deepEqual(spendBy([], "repo"), []);
});

test("the landed share is a whole percent of something spent", () => {
  assert.equal(landedShare(0, 0), null);
  assert.equal(landedShare(3, 1), 33);
  assert.equal(landedShare(2, 2), 100);
  assert.equal(usdMicros(1.2345675), 1_234_568);
});
