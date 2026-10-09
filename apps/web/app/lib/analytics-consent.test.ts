import assert from "node:assert/strict";
import { test } from "node:test";

import { asksFirst, choice, consentRequired } from "./analytics-consent.ts";

test("visitors from the EU, EEA, UK and Switzerland are asked first", () => {
  for (const country of ["DE", "fr", "IE", "NO", "IS", "GB", "CH"]) assert.equal(asksFirst(country), true, country);
});

test("others are not, nor is a visitor whose country is unknown", () => {
  for (const country of ["US", "CA", "AU", "JP", "BR"]) assert.equal(asksFirst(country), false, country);
  assert.equal(asksFirst(null), false);
  assert.equal(asksFirst(""), false);
});

test("on the server nothing is chosen or required", () => {
  assert.equal(choice(), null);
  assert.equal(consentRequired(), false);
});
