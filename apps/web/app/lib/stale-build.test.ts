import assert from "node:assert/strict";
import { test } from "node:test";

import { RELOADED_KEY, clientNavigated, reloadFixes, reloadedBefore } from "./stale-build.ts";

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

test("the location a tab's document loaded at is no client navigation, whatever its key", () => {
  // ScrollRestoration's inline script gives the first entry a random key.
  assert.equal(clientNavigated("kvhli4udgd", "kvhli4udgd"), false);
  assert.equal(clientNavigated("default", "default"), false);
  assert.equal(clientNavigated("a1b2c3", "kvhli4udgd"), true);
  // The server never navigated.
  assert.equal(clientNavigated("default", undefined), false);
  assert.equal(clientNavigated("a1b2c3", undefined), false);
});

test("an address loaded again once is not loaded again", () => {
  const storage = (value: string | null) => ({ getItem: (key: string) => (key === RELOADED_KEY ? value : null) });
  assert.equal(reloadedBefore("/flagon-io/-/docs", storage("/flagon-io/-/docs")), true);
  assert.equal(reloadedBefore("/flagon-io/-/docs", storage("/flagon-io/g1t/nope")), false);
  assert.equal(reloadedBefore("/flagon-io/-/docs", storage(null)), false);
  // No storage, or storage that throws: nothing remembered.
  assert.equal(reloadedBefore("/flagon-io/-/docs", undefined), false);
  assert.equal(reloadedBefore("/flagon-io/-/docs", { getItem: () => { throw new Error("denied"); } }), false);
});
