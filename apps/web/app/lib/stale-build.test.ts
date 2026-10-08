import assert from "node:assert/strict";
import { test } from "node:test";

import { reloadFixes } from "./stale-build.ts";

test("a client navigation that hits an older build reloads the page", () => {
  const seen = { clientNavigation: true, caughtByCatchAll: false };
  assert.equal(reloadFixes({ ...seen, error: new Error("Unable to discover routes due to manifest version mismatch.") }), true);
  assert.equal(reloadFixes({ ...seen, error: new TypeError("Failed to fetch dynamically imported module: https://g1t.sh/assets/pull-abc.js") }), true);
  assert.equal(reloadFixes({ ...seen, error: new TypeError("Importing a module script failed.") }), true);
});

test("an address only the new build knows reloads, once it fell to the catch-all", () => {
  assert.equal(reloadFixes({ error: {}, status: 404, clientNavigation: true, caughtByCatchAll: true }), true);
  // A 404 a page threw itself (a missing issue) is a real one.
  assert.equal(reloadFixes({ error: {}, status: 404, clientNavigation: true, caughtByCatchAll: false }), false);
});

test("a document load, or any other error, shows the error page", () => {
  assert.equal(reloadFixes({ error: new Error("manifest version mismatch"), clientNavigation: false, caughtByCatchAll: false }), false);
  assert.equal(reloadFixes({ error: {}, status: 404, clientNavigation: false, caughtByCatchAll: true }), false);
  assert.equal(reloadFixes({ error: new Error("D1_ERROR: no such table"), clientNavigation: true, caughtByCatchAll: false }), false);
  assert.equal(reloadFixes({ error: {}, status: 500, clientNavigation: true, caughtByCatchAll: false }), false);
});
