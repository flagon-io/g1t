import assert from "node:assert/strict";
import { test } from "node:test";

import { pullDetailFromWire, workClient } from "../../../../packages/contracts/src/clients.ts";

/** A pull request's detail as the work service writes it: its own fields in snake_case. */
const wire = {
  pull: { number: 7, headCommit: "abc" },
  issue: null,
  comments: [],
  checks: null,
  overlaps: [],
  behind: false,
  review_pending: true,
  lifecycle: null,
  landing: false,
  stalled: null,
  messages: [],
  statuses: [],
  mergeable: "clean",
  conflicts: [],
  earlier_checks: [{ id: "chk_1", status: "failed" }],
  required_checks: [{ name: "CI", state: "failure", description: null, targetUrl: null }],
  code_owners: { path: ".g1t/CODEOWNERS", required: true, missing: ["@acme/web"] },
};

test("a pull request's own snake_case fields are read into camelCase", () => {
  const detail = pullDetailFromWire(wire);
  assert.equal(detail.reviewPending, true);
  assert.deepEqual(detail.earlierChecks, wire.earlier_checks);
  assert.deepEqual(detail.requiredChecks, wire.required_checks);
  assert.deepEqual(detail.codeOwners, wire.code_owners);
  // The snake_case names are gone, and what they hold is untouched.
  for (const key of ["review_pending", "earlier_checks", "required_checks", "code_owners"]) assert.ok(!(key in detail), key);
  assert.equal(detail.requiredChecks?.[0]?.targetUrl, null);
  assert.equal(detail.pull.number, 7);
});

test("camelCase is taken as it is, and a missing review_pending is false", () => {
  const detail = pullDetailFromWire({ pull: {}, requiredChecks: [{ name: "CI" }], reviewPending: false });
  assert.deepEqual(detail.requiredChecks, [{ name: "CI" }]);
  assert.equal(detail.reviewPending, false);
  assert.equal(pullDetailFromWire({ pull: {} }).reviewPending, false);
});

test("getPull reads the work service's answer at the edge", async () => {
  const calls: string[] = [];
  const service = {
    fetch: async (url: string) => {
      calls.push(url);
      return Response.json({ ok: true, value: wire });
    },
  };
  const found = await workClient(service).getPull({ namespace: "acme", name: "web" }, 7, null);
  assert.deepEqual(calls, ["https://service/rpc/get_pull"]);
  assert.ok(found.ok);
  assert.equal(found.value.reviewPending, true);
  assert.equal(found.value.requiredChecks?.[0]?.name, "CI");
  assert.equal(found.value.earlierChecks?.length, 1);
  assert.deepEqual(found.value.codeOwners?.missing, ["@acme/web"]);
});

test("getPull passes a refusal through", async () => {
  const service = { fetch: async () => Response.json({ ok: false, error: { code: "not_found", message: "No such pull request." } }) };
  const found = await workClient(service).getPull({ namespace: "acme", name: "web" }, 8, null);
  assert.equal(found.ok, false);
});
