import assert from "node:assert/strict";
import { test } from "node:test";

import { dollarsField, parseDollars, usd } from "./money.ts";

test("dollars read to the cent, and small amounts keep their fractions", () => {
  assert.equal(usd(1_250_500_000), "$1,250.50");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(12_345), "$0.0123");
  assert.equal(usd(-5_000_000), "−$5.00");
  assert.equal(usd(5_000_000, { signed: true }), "+$5.00");
  assert.equal(usd(null), "—");
});

test("typed amounts become micros exactly", () => {
  assert.equal(parseDollars("25"), 25_000_000);
  assert.equal(parseDollars("$1,250.5"), 1_250_500_000);
  assert.equal(parseDollars("0.07"), 70_000);
  for (const bad of ["", "-5", "1.234", "abc", "1e3", "12345678"]) assert.equal(parseDollars(bad), null, bad);
  assert.equal(dollarsField(1_250_500_000), "1250.50");
  assert.equal(dollarsField(null), "");
});
