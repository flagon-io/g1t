import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAllowances,
  parseCredit,
  parseDecision,
  parseEmail,
  parseGoodwill,
  parsePayment,
  parseSales,
  parseSalesNote,
  parseSlugList,
  parseTerms,
} from "./forms.ts";

const NOW = new Date("2026-10-04T12:00:00Z");

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}

test("comped terms keep a ceiling and an end date, and name who set them", () => {
  const result = parseTerms(form({ kind: "comped", note: "g1t's own", ceiling: "500", until: "2026-12-31", discount: "40" }), "owner@g1t.sh", NOW);
  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "comped",
      discountPercent: 0,
      ceilingMicros: 500_000_000,
      note: "g1t's own",
      until: "2026-12-31T23:59:59Z",
      setBy: "owner@g1t.sh",
      setAt: NOW.toISOString(),
    },
  });
});

test("standard terms clear everything but the note", () => {
  const result = parseTerms(form({ kind: "standard", note: "back to normal", ceiling: "5", until: "2027-01-01" }), "a@g1t.sh", NOW);
  assert.ok(result.ok);
  assert.equal(result.value.ceilingMicros, null);
  assert.equal(result.value.until, null);
});

test("terms are refused without a note, with a bad discount, or ending in the past", () => {
  assert.equal(parseTerms(form({ kind: "comped", note: "" }), "a", NOW).ok, false);
  assert.equal(parseTerms(form({ kind: "custom", note: "x", discount: "101" }), "a", NOW).ok, false);
  assert.equal(parseTerms(form({ kind: "custom", note: "x" }), "a", NOW).ok, false);
  assert.equal(parseTerms(form({ kind: "custom", note: "x", discount: "20", until: "2026-10-01" }), "a", NOW).ok, false);
  assert.equal(parseTerms(form({ kind: "custom", note: "x", discount: "20", until: "2026-02-30" }), "a", NOW).ok, false);
  assert.equal(parseTerms(form({ kind: "free", note: "x" }), "a", NOW).ok, false);
});

test("workspace lists take commas, spaces and lines, once each", () => {
  assert.deepEqual(parseSlugList("acme, Acme-labs\nbeta  beta"), { ok: true, value: ["acme", "acme-labs", "beta"] });
  assert.equal(parseSlugList("acme, bad--slug").ok, false);
  assert.equal(parseSlugList("../etc").ok, false);
});

test("invoice emails are one address", () => {
  assert.deepEqual(parseEmail(" Billing@Acme.com "), { ok: true, value: "billing@acme.com" });
  assert.equal(parseEmail("a@b").ok, false);
  assert.equal(parseEmail("a@b.com, c@d.com").ok, false);
  assert.equal(parseEmail("a@@b.com").ok, false);
  assert.equal(parseEmail("").ok, false);
});

test("credits are positive and capped", () => {
  assert.deepEqual(parseCredit("25.50"), { ok: true, value: 25_500_000 });
  assert.equal(parseCredit("0").ok, false);
  assert.equal(parseCredit("10000.01").ok, false);
});

test("a sales record: a stage, an owner's email or nobody, a next step and its day", () => {
  assert.deepEqual(parseSales(form({ stage: "contacted", owner: " Me@G1t.sh ", nextStep: "Call  about\n terms", nextAt: "2026-10-09" })), {
    ok: true,
    value: { stage: "contacted", owner: "me@g1t.sh", nextStep: "Call about terms", nextAt: "2026-10-09" },
  });
  assert.deepEqual(parseSales(form({ stage: "none", owner: "", nextStep: "", nextAt: "" })), {
    ok: true,
    value: { stage: "none", owner: null, nextStep: null, nextAt: null },
  });
  assert.equal(parseSales(form({ stage: "closed" })).ok, false);
  assert.equal(parseSales(form({ stage: "lead", owner: "not an email" })).ok, false);
  assert.equal(parseSales(form({ stage: "lead", nextStep: "x".repeat(201) })).ok, false);
  assert.equal(parseSales(form({ stage: "lead", nextStep: "Call", nextAt: "2026-02-30" })).ok, false);
  assert.equal(parseSales(form({ stage: "lead", nextStep: "Call", nextAt: "next week" })).ok, false);
  // A date needs a step to go with it.
  assert.equal(parseSales(form({ stage: "lead", nextAt: "2026-10-09" })).ok, false);
});

test("a sales note is required, and not endless", () => {
  assert.deepEqual(parseSalesNote("Spoke to Ana; wants an enterprise quote."), { ok: true, value: "Spoke to Ana; wants an enterprise quote." });
  assert.equal(parseSalesNote("").ok, false);
  assert.equal(parseSalesNote("x".repeat(2001)).ok, false);
});


test("allowances: the plan without its price, pool shares, and staff's overrides", () => {
  assert.deepEqual(parseAllowances(form({})), {
    ok: true,
    value: {
      plan: false,
      ossRepoMicros: null,
      trialMicros: null,
      maxConcurrentAgents: null,
      runCapMicros: null,
      issueCapMicros: null,
      auditRetentionDays: null,
      hold: null,
    },
  });
  assert.deepEqual(
    parseAllowances(form({ plan: "on", oss: "5", trial: "2.50", agents: "20", runCap: "25", issueCap: "500", auditDays: "365", hold: "  Card  disputed;\nwaiting on the bank " })),
    {
      ok: true,
      value: {
        plan: true,
        ossRepoMicros: 5_000_000,
        trialMicros: 2_500_000,
        maxConcurrentAgents: 20,
        runCapMicros: 25_000_000,
        issueCapMicros: 500_000_000,
        auditRetentionDays: 365,
        hold: "Card disputed; waiting on the bank",
      },
    },
  );
  assert.equal(parseAllowances(form({ oss: "lots" })).ok, false);
  assert.equal(parseAllowances(form({ trial: "5000" })).ok, false);
  assert.equal(parseAllowances(form({ agents: "0" })).ok, false);
  assert.equal(parseAllowances(form({ agents: "101" })).ok, false);
  assert.equal(parseAllowances(form({ agents: "2.5" })).ok, false);
  assert.equal(parseAllowances(form({ runCap: "0.05" })).ok, false);
  assert.equal(parseAllowances(form({ runCap: "1000.01" })).ok, false);
  assert.equal(parseAllowances(form({ issueCap: "10000.01" })).ok, false);
  // Audit log days: shorter or longer than the plan's, up to 400.
  assert.equal((parseAllowances(form({ auditDays: "3" })) as { value: { auditRetentionDays: number } }).value.auditRetentionDays, 3);
  assert.equal((parseAllowances(form({ auditDays: "400" })) as { value: { auditRetentionDays: number } }).value.auditRetentionDays, 400);
  assert.equal(parseAllowances(form({ auditDays: "0" })).ok, false);
  assert.equal(parseAllowances(form({ auditDays: "401" })).ok, false);
  assert.equal(parseAllowances(form({ auditDays: "30.5" })).ok, false);
  assert.equal(parseAllowances(form({ auditDays: "a year" })).ok, false);
  assert.equal(parseAllowances(form({ hold: "x".repeat(201) })).ok, false);
});

test("a bank transfer: an amount, its reference, a note, and the slug typed out", () => {
  const ok = { amount: "1,500", reference: " TRX 0042 ", note: "Invoice INV-7, by wire", confirmation: "acme" };
  assert.deepEqual(parsePayment(form(ok), "acme"), { ok: true, value: { amountMicros: 1_500_000_000, reference: "TRX 0042", note: "Invoice INV-7, by wire" } });
  assert.equal(parsePayment(form({ ...ok, amount: "0" }), "acme").ok, false);
  assert.equal(parsePayment(form({ ...ok, amount: "100000.01" }), "acme").ok, false);
  assert.equal(parsePayment(form({ ...ok, reference: "" }), "acme").ok, false);
  assert.equal(parsePayment(form({ ...ok, note: "" }), "acme").ok, false);
  assert.equal(parsePayment(form({ ...ok, confirmation: "Acme" }), "acme").ok, false);
});

test("a decision: approve as asked or at another amount; decline needs a note", () => {
  assert.deepEqual(parseDecision(form({ id: "lr_1", decision: "approve" })), {
    ok: true,
    value: { id: "lr_1", decision: "approve", amountMicros: null, note: "" },
  });
  assert.deepEqual(parseDecision(form({ id: "lr_1", decision: "approve", amount: "750", note: "Half now." })), {
    ok: true,
    value: { id: "lr_1", decision: "approve", amountMicros: 750_000_000, note: "Half now." },
  });
  assert.equal(parseDecision(form({ id: "lr_1", decision: "approve", amount: "0.50" })).ok, false);
  assert.equal(parseDecision(form({ id: "lr_1", decision: "approve", amount: "1000000.01" })).ok, false);
  assert.equal(parseDecision(form({ id: "lr_1", decision: "decline" })).ok, false);
  assert.deepEqual(parseDecision(form({ id: "lr_1", decision: "decline", note: "After a month of payments.", amount: "5" })), {
    ok: true,
    value: { id: "lr_1", decision: "decline", amountMicros: null, note: "After a month of payments." },
  });
  assert.equal(parseDecision(form({ id: "../x", decision: "approve" })).ok, false);
  assert.equal(parseDecision(form({ id: "lr_1", decision: "maybe" })).ok, false);
});

test("goodwill: no amount is the one-click credit; a reason when one is needed; a day not in the future", () => {
  const never = () => false;
  const always = () => true;
  assert.deepEqual(parseGoodwill(form({}), never, NOW), { ok: true, value: { amountMicros: null, reason: "", day: null } });
  assert.deepEqual(parseGoodwill(form({ amount: "60", reason: "Looping agent on #12, owner caught it late.", day: "2026-10-03" }), always, NOW), {
    ok: true,
    value: { amountMicros: 60_000_000, reason: "Looping agent on #12, owner caught it late.", day: "2026-10-03" },
  });
  assert.equal(parseGoodwill(form({ amount: "60", reason: "oops" }), always, NOW).ok, false);
  assert.equal(parseGoodwill(form({ amount: "0" }), never, NOW).ok, false);
  assert.equal(parseGoodwill(form({ amount: "10000.01" }), never, NOW).ok, false);
  assert.equal(parseGoodwill(form({ day: "2026-10-05" }), never, NOW).ok, false);
  assert.equal(parseGoodwill(form({ day: "2026-02-30" }), never, NOW).ok, false);
  // The check is given the amount typed, or null for the one-click credit.
  const seen: (number | null)[] = [];
  parseGoodwill(form({ amount: "12.50" }), (amount) => (seen.push(amount), false), NOW);
  parseGoodwill(form({}), (amount) => (seen.push(amount), false), NOW);
  assert.deepEqual(seen, [12_500_000, null]);
});
