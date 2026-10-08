import assert from "node:assert/strict";
import { test } from "node:test";

import { fullDiscount, percentOff, termsLabel } from "./terms.ts";

test("terms read as a discount; comped from before discounts is 100%", () => {
  assert.equal(percentOff({ kind: "comped", discountPercent: 0 }), 100);
  assert.equal(percentOff({ kind: "custom", discountPercent: 30 }), 30);
  assert.equal(percentOff({ kind: "standard", discountPercent: 30 }), 0);
  assert.ok(fullDiscount({ kind: "custom", discountPercent: 100 }));
  assert.ok(!fullDiscount({ kind: "custom", discountPercent: 99 }));
  assert.equal(termsLabel({ kind: "custom", discountPercent: 100 }), "100% discount");
  assert.equal(termsLabel({ kind: "comped", discountPercent: 0 }), "100% discount");
  assert.equal(termsLabel({ kind: "custom", discountPercent: 30 }), "30% off");
  assert.equal(termsLabel({ kind: "custom", discountPercent: 0 }), "Custom limit");
  assert.equal(termsLabel({ kind: "standard", discountPercent: 0 }), "Standard");
});
