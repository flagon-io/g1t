import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceDetach } from "@g1t/contracts";

import { detachChanges, parseExclude } from "./test-detach.ts";

const nothing: WorkspaceDetach = {
  workspace: "acme",
  done: false,
  customer: false,
  card: null,
  card_cached: false,
  subscriptions: 0,
  card_checks: 0,
  checkouts: 0,
  ai_reload: false,
  autopay_cleared: false,
  invoices_voided: 0,
  months_skipped: [],
  credit_grants_closed: 0,
  credit_closed_micros: 0,
  payments_reversed_micros: 0,
  plan_payments_reversed_micros: 0,
  written_off_micros: 0,
  balance_before_micros: 0,
  balance_after_micros: 0,
  stripe_canceled: 0,
  stripe_errors: [],
  pending_months_marked: 0,
  pending_marked_micros: 0,
  pending_baselined: 0,
  pending_baselined_micros: 0,
  plan_credit_cleared_micros: 0,
  dispute_owed_cleared_micros: 0,
  disputes_closed: 0,
};

test("the exclusion list reads commas, spaces and case alike, once each", () => {
  assert.deepEqual(parseExclude(" Syntaqx, flagon-io  syntaqx\nacme "), ["syntaqx", "flagon-io", "acme"]);
  assert.deepEqual(parseExclude(""), []);
});

test("a detach says each change it makes, and nothing when there is none", () => {
  assert.deepEqual(detachChanges(nothing), []);
  const lines = detachChanges({
    ...nothing,
    customer: true,
    card: "visa 4242",
    card_cached: true,
    subscriptions: 1,
    card_checks: 1,
    months_skipped: ["2026-08", "2026-09"],
    credit_grants_closed: 1,
    credit_closed_micros: 15_000_000,
    payments_reversed_micros: 55_000_000,
    written_off_micros: 35_000_000,
    stripe_errors: ["sub_1: no such subscription"],
  });
  assert.deepEqual(lines, [
    "Customer and card visa 4242 forgotten",
    "1 plan canceled",
    "1 card check removed (trial kept)",
    "2026-08, 2026-09 closed as skipped",
    "1 AI credit grant closed ($15.00 unused)",
    "$55.00 of test payments reversed",
    "$35.00 owed written off as goodwill",
    "Stripe refused: sub_1: no such subscription",
  ]);
});

test("a detach says what metered usage, included usage and test disputes it let go", () => {
  const lines = detachChanges({
    ...nothing,
    pending_months_marked: 2,
    pending_marked_micros: 1_200_000,
    pending_baselined: 1,
    pending_baselined_micros: 300_000,
    plan_credit_cleared_micros: 4_000_000,
    dispute_owed_cleared_micros: 46_400_000,
    disputes_closed: 1,
  });
  assert.deepEqual(lines, [
    "2 metered figures of past months never charged ($1.20)",
    "This month's 1 metered figure so far never charged ($0.30)",
    "$4.00 of this month's included usage restored",
    "$46.40 owed for lost test disputes cleared",
    "1 open test dispute closed",
  ]);
});
