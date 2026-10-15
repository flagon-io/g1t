import assert from "node:assert/strict";
import { test } from "node:test";

import { isFailed, orElse, part } from "./partial.ts";

test("a part that throws is kept as failed, by what it is; one that answers is its answer", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const failed = await part(Promise.reject(new Error("work failed with status 503")), "Reviewers");
    assert.deepEqual(failed, { failed: true, what: "Reviewers" });
    assert.equal(isFailed(failed), true);
    assert.equal(orElse(failed, []).length, 0);
  } finally {
    console.warn = quiet;
  }
  // A refusal is an answer, not a failure.
  const refused = await part(Promise.resolve({ ok: false, code: "not_found" }), "Reviewers");
  assert.equal(isFailed(refused), false);
  assert.deepEqual(await part(null, "Nothing asked"), null);
  assert.equal(isFailed({ failed: true }), false);
});
