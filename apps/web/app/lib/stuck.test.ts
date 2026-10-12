import assert from "node:assert/strict";
import { test } from "node:test";

import { stuckTarget } from "./stuck.ts";

const location = { pathname: "/flagon-io/g1t/pulls", search: "?state=closed", hash: "#top" };

test("an idle page has nothing to retry", () => {
  assert.equal(stuckTarget({ state: "idle" }), null);
});

test("a navigation still loading is retried at its full address", () => {
  assert.equal(stuckTarget({ state: "loading", location }), "/flagon-io/g1t/pulls?state=closed#top");
});

test("a form still being sent is never sent again", () => {
  assert.equal(stuckTarget({ state: "submitting", location }), null);
});
