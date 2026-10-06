import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTACT, POLICIES, copyright, copyrightYear, listed, longDate, securityTxt } from "./legal.ts";

test("the copyright year is computed, in UTC", () => {
  assert.equal(copyrightYear(new Date("2026-10-05T12:00:00Z")), 2026);
  assert.equal(copyrightYear(new Date("2027-01-01T00:00:00Z")), 2027);
  // Still 31 December in UTC, whatever the server's own zone says.
  assert.equal(copyrightYear(new Date("2026-12-31T23:59:59Z")), 2026);
});

test("the legal line names the company and the year", () => {
  assert.equal(copyright(new Date("2026-10-05T00:00:00Z")), "© 2026 Flagon, Inc. All rights reserved.");
  assert.equal(copyright(new Date("2031-03-01T00:00:00Z")), "© 2031 Flagon, Inc. All rights reserved.");
});

test("products are listed the way a sentence lists them", () => {
  assert.equal(listed([]), "");
  assert.equal(listed(["HEY"]), "HEY");
  assert.equal(listed(["HEY", "Fizzy"]), "HEY and Fizzy");
  assert.equal(listed(["A", "B", "C"]), "A, B and C");
});

test("policy dates read as words", () => {
  assert.equal(longDate("2026-10-05"), "October 5, 2026");
  assert.equal(longDate("2027-01-31"), "January 31, 2027");
});

test("every policy has its own address", () => {
  const slugs = POLICIES.map((policy) => policy.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) assert.match(slug, /^[a-z-]+$/);
});

test("security.txt has the fields RFC 9116 asks for, and expires within a year", () => {
  const now = new Date("2026-10-05T15:30:00Z");
  const text = securityTxt(now);
  assert.ok(text.split("\n").includes(`Contact: mailto:${CONTACT.security}`));
  assert.match(text, /^Policy: https:\/\/g1t\.sh\/security#responsible-disclosure$/m);
  const expires = /^Expires: (.+)$/m.exec(text)?.[1];
  assert.ok(expires);
  assert.match(expires, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  const days = (Date.parse(expires) - now.getTime()) / 86_400_000;
  assert.ok(days > 30 && days < 365, `${days} days`);
  assert.ok(text.endsWith("\n"));
});
