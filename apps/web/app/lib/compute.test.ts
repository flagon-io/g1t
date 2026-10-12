import assert from "node:assert/strict";
import { test } from "node:test";

import { linkPaths } from "./compute.ts";

test("the page a refusal names becomes a link, without its full stop", () => {
  assert.deepEqual(linkPaths("Deployments need a paid workspace. Start the $20 plan: /acme/-/billing"), [
    { text: "Deployments need a paid workspace. Start the $20 plan: " },
    { text: "/acme/-/billing", href: "/acme/-/billing" },
  ]);
  assert.deepEqual(linkPaths("An owner can raise it: /acme/-/billing. Then try again."), [
    { text: "An owner can raise it: " },
    { text: "/acme/-/billing", href: "/acme/-/billing" },
    { text: ". Then try again." },
  ]);
});

test("text without a page, or with other slashes, stays text", () => {
  assert.deepEqual(linkPaths("Try again in a minute."), [{ text: "Try again in a minute." }]);
  assert.deepEqual(linkPaths("It reads src/-/x and a/b"), [{ text: "It reads src/-/x and a/b" }]);
});
