import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountName,
  accountPath,
  actionLabel,
  auditHref,
  invoiceTotals,
  invoicesHref,
  olderBefore,
  parseAction,
  parseBefore,
  parseBy,
  parseInvoiceStatus,
  parseMonth,
  safeUrl,
} from "./ledgers.ts";

const M = 1_000_000;

test("invoice filters are checked", () => {
  assert.equal(parseInvoiceStatus("overdue"), "overdue");
  assert.equal(parseInvoiceStatus("late"), null);
  assert.equal(parseInvoiceStatus(null), null);
  assert.equal(parseMonth("2026-10"), "2026-10");
  assert.equal(parseMonth("2026-13"), null);
  assert.equal(parseMonth("2026-1"), null);
  assert.equal(parseMonth(""), null);
});

test("totals: void counts for nothing; open, overdue and failed are outstanding", () => {
  const totals = invoiceTotals([
    { amountMicros: 100 * M, status: "paid" },
    { amountMicros: 50 * M, status: "open" },
    { amountMicros: 20 * M, status: "failed" },
    { amountMicros: 5 * M, status: "overdue" },
    { amountMicros: 999 * M, status: "void" },
  ]);
  assert.deepEqual(totals, { count: 5, amountMicros: 175 * M, paidMicros: 100 * M, outstandingMicros: 75 * M, outstanding: 3 });
  assert.deepEqual(invoiceTotals([]), { count: 0, amountMicros: 0, paidMicros: 0, outstandingMicros: 0, outstanding: 0 });
});

test("links keep only the filters that are set", () => {
  assert.equal(invoicesHref({}), "/invoices");
  assert.equal(invoicesHref({ status: "open", month: "2026-10" }), "/invoices?status=open&month=2026-10");
  assert.equal(auditHref({}), "/audit");
  assert.equal(auditHref({ by: "me@g1t.sh", before: "2026-10-01T00:00:00Z" }), "/audit?by=me%40g1t.sh&before=2026-10-01T00%3A00%3A00Z");
});

test("only https links are followed", () => {
  assert.equal(safeUrl("https://invoice.stripe.com/i/x"), "https://invoice.stripe.com/i/x");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("http://invoice.stripe.com"), null);
  assert.equal(safeUrl(null), null);
});

test("account ids link to their pages; anything else does not", () => {
  assert.equal(accountPath("ws_acme"), "/workspaces/acme");
  assert.equal(accountPath("ent_bigco"), "/enterprises/ent_bigco");
  assert.equal(accountPath("stripe"), null);
  // Shared invite links are filed under `ws_invites`: a reserved name, never a workspace.
  assert.equal(accountPath("ws_invites"), "/invites?tab=shared");
  assert.equal(accountName("ws_invites"), "Shared invite links");
  assert.equal(accountPath("acme"), null);
  assert.equal(accountPath("ws_-bad"), null);
  assert.equal(accountPath(""), null);
  assert.equal(accountPath(null), null);
});

test("accounts are named by slug, or the enterprise's name when known", () => {
  assert.equal(accountName("ws_acme"), "acme");
  assert.equal(accountName("ent_bigco", new Map([["ent_bigco", "BigCo Inc"]])), "BigCo Inc");
  assert.equal(accountName("ent_bigco"), "an enterprise");
  assert.equal(accountName("stripe"), "stripe");
});

test("actions read plainly, known or not", () => {
  assert.equal(actionLabel("credit"), "Credit issued");
  assert.equal(actionLabel("stripe"), "From Stripe");
  assert.equal(actionLabel("webhook"), "Stripe webhook registered");
  assert.equal(actionLabel("price_change"), "Price change");
});

test("an older page only when this one was full", () => {
  const page = Array.from({ length: 100 }, (_, index) => ({ createdAt: `2026-10-01T00:00:${String(index % 60).padStart(2, "0")}Z` }));
  assert.equal(olderBefore(page), page[99].createdAt);
  assert.equal(olderBefore(page.slice(0, 99)), null);
  assert.equal(olderBefore([]), null);
});

test("audit filters are checked", () => {
  assert.equal(parseBy(" Me@G1t.sh "), "me@g1t.sh");
  assert.equal(parseBy("two words"), null);
  assert.equal(parseBy(""), null);
  assert.equal(parseAction("billing_link"), "billing_link");
  assert.equal(parseAction("drop table"), null);
  assert.equal(parseBefore("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00Z");
  assert.equal(parseBefore("yesterday"), null);
});
