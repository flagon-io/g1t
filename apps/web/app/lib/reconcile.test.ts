/**
 * One month, one number: Home's "this month so far" and Usage's "This
 * range" show the same figure for the same month, formatted the same way. Each surface's arithmetic is the
 * pure function its loader or component calls; the loaders only fetch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Statement, UsageReport } from "@g1t/contracts";

import { spendIn } from "./home.ts";
import { money } from "./money.ts";
import { monthSpan, pendingSentence, receipt, resolveRange } from "./usage.ts";

const NOW = new Date("2026-10-10T18:30:00Z");

/** A comped workspace in October: $10.401 on the ledger, $0.009 of storage metered and not yet closed, a 100% discount. */
const report = {
  from: "2026-10-01",
  until: "2026-10-10",
  totals: {
    priceMicros: 10_410_000,
    discountMicros: 10_410_000,
    includedMicros: 0,
    creditsMicros: 0,
    chargedMicros: 0,
    pendingMicros: 9_000,
    pendingChargedMicros: 0,
    costMicros: 8_670_000,
  },
  days: [],
  products: [],
  projects: [],
  discountPercent: 100,
  aiCreditMicros: 0,
  creditMicros: 0,
  plan: "paid",
  free: false,
} satisfies UsageReport;

/** The same month's statement: the ledger's lines only, which is why Home no longer reads its total for the month. */
const statement = {
  groups: [{ key: "2026-10-09", label: "", chargedMicros: 0, lines: [{ kind: "Sandboxes", count: 3, chargedMicros: 0, costMicros: 8_670_000, priceMicros: 10_401_000 }] }],
  totals: { chargedMicros: 0, paidMicros: 0, costMicros: 8_670_000, entries: 3, priceMicros: 10_401_000 },
} satisfies Pick<Statement, "groups" | "totals">;

test("every page asks billing for the same month", () => {
  const month = monthSpan(NOW);
  assert.deepEqual(month, { from: "2026-10-01", until: "2026-10-10" });
  // Home (lib/home.server.ts `loadSpend`) and Usage (routes/workspace/usage.tsx `readFilters`).
  const { from, until } = resolveRange("cycle", {}, NOW);
  assert.deepEqual({ from, until }, month);
});

test("Home and Usage show one figure for the month", () => {
  // Home's "this month so far" (lib/home.server.ts `loadSpend` hands `spendIn` the report's usage at price; components/home.tsx `SpendCard`).
  const home = spendIn([statement], { from: Date.parse("2026-10-09T00:00:00Z"), now: NOW.getTime() }, report.totals.priceMicros);
  const homeMonth = money(home.monthMicros!);
  // Usage's "This range", first line (components/usage.tsx `IncludedAndCredit`: `receipt`, then `money(line.micros)`).
  const lines = receipt(report.totals, report.discountPercent);
  const usage = money(lines[0]!.micros);

  assert.equal(homeMonth, "$10.41");
  assert.equal(usage, homeMonth);

  // The statement alone, which Home used to show, is the $0.009 short that read as a rounding difference.
  assert.equal(money(statement.totals.priceMicros), "$10.40");

  // The rest of Usage's receipt for the same report, as the page writes each line.
  assert.deepEqual(
    lines.map((line) => `${line.label} ${line.minus ? "−" : ""}${money(line.micros)}`),
    ["Usage at price $10.41", "Discount (100%) −$10.41", "Charged $0.00"],
  );
  assert.equal(
    pendingSentence(report.totals),
    "$0.009 of it is metered this month and not yet closed; nothing will be charged when the month closes, after your discount and included usage.",
  );
});
