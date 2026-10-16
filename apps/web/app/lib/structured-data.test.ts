import assert from "node:assert/strict";
import { test } from "node:test";
import { organization } from "./structured-data.ts";

test("organization contact is the supplied public email, without an invented postal address", () => {
  const descriptor = organization() as { "script:ld+json": Record<string, unknown> };
  assert.deepEqual(descriptor["script:ld+json"].contactPoint, { "@type": "ContactPoint", email: "hey@flagon.io", contactType: "customer support" });
  assert.equal(descriptor["script:ld+json"].address, undefined);
});
