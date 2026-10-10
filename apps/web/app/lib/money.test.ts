import assert from "node:assert/strict";
import { test } from "node:test";

import { microsOf, money, plainDollars, wholeDollars } from "./money.ts";

test("money rounds half up at the cent on whole micros, never on a float", () => {
  assert.equal(money(2_760_000), "$2.76");
  assert.equal(money(10_404_999), "$10.40");
  assert.equal(money(10_405_000), "$10.41");
  assert.equal(money(10_410_000), "$10.41");
  assert.equal(money(1_005_000), "$1.01");
  assert.equal(money(1_004_999), "$1.00");
  // 1.005 as a float rounds down with toFixed; on micros it is exactly half, so up.
  assert.equal(money(1.005 * 1_000_000), "$1.01");
  assert.equal(money(999_995_000), "$1,000.00");
  assert.equal(money(1_234_567_890_000), "$1,234,567.89");
});

test("a fraction of a cent reads <$0.01, and exactly nothing reads $0.00", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(1), "<$0.01");
  assert.equal(money(3), "<$0.01");
  assert.equal(money(4_000), "<$0.01");
  assert.equal(money(9_000), "<$0.01");
  assert.equal(money(9_999), "<$0.01");
  assert.equal(money(10_000), "$0.01");
  assert.equal(money(-9_000), "<−$0.01");
});

test("negatives lead with a minus sign", () => {
  assert.equal(money(-1_250_000), "−$1.25");
  assert.equal(money(-10_405_000), "−$10.41");
  assert.equal(money(-1_000_000_000), "−$1,000.00");
});

test("precise shows up to four places, trimmed down to two", () => {
  assert.equal(money(9_000, { precise: true }), "$0.009");
  assert.equal(money(6_300, { precise: true }), "$0.0063");
  assert.equal(money(250, { precise: true }), "$0.0003");
  assert.equal(money(249, { precise: true }), "$0.0002");
  assert.equal(money(250_000, { precise: true }), "$0.25");
  assert.equal(money(2_760_000, { precise: true }), "$2.76");
  assert.equal(money(24_000, { precise: true }), "$0.024");
  assert.equal(money(1_234_567_890, { precise: true }), "$1,234.5679");
  assert.equal(money(0, { precise: true }), "$0.00");
  assert.equal(money(49, { precise: true }), "<$0.0001");
  assert.equal(money(50, { precise: true }), "$0.0001");
  assert.equal(money(-6_300, { precise: true }), "−$0.0063");
});

test("compact is an axis label", () => {
  assert.equal(money(0, { compact: true }), "$0");
  assert.equal(money(2_000_000, { compact: true }), "$2");
  assert.equal(money(500_000, { compact: true }), "$0.50");
  assert.equal(money(1_000, { compact: true }), "$0.001");
  assert.equal(money(1_500_000_000, { compact: true }), "$1.5K");
  assert.equal(money(1_000_000_000, { compact: true }), "$1K");
  assert.equal(money(12_340_000_000, { compact: true }), "$12.3K");
  assert.equal(money(2_500_000_000_000, { compact: true }), "$2.5M");
});

test("whole dollars drop the cents only when there are none", () => {
  assert.equal(wholeDollars(1_000_000_000), "$1,000");
  assert.equal(wholeDollars(100_000), "$0.10");
  assert.equal(wholeDollars(-5_000_000), "−$5");
});

test("form fields read plain dollars, rounded the same way", () => {
  assert.equal(plainDollars(12_500_000), "12.50");
  assert.equal(plainDollars(20_000_000), "20.00");
  assert.equal(plainDollars(20_000_000, { whole: true }), "20");
  assert.equal(plainDollars(20_125_000, { whole: true }), "20.13");
  assert.equal(plainDollars(20_124_999, { whole: true }), "20.12");
  assert.equal(plainDollars(0, { whole: true }), "0");
  assert.equal(plainDollars(1_200_000_000), "1200.00");
});

test("dollars from a service that counts in dollars become whole micros", () => {
  assert.equal(microsOf(0.123456789), 123_457);
  assert.equal(microsOf(2.5), 2_500_000);
  assert.equal(money(microsOf(0.004)), "<$0.01");
});
