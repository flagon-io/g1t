import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCredit, parseEmail, parseSlugList, parseTerms } from "./forms.ts";

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
