import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckItem } from "@g1t/contracts";

import { checkDetail, checksHeadline, checksTally, detailsLink, took } from "./commit-checks.ts";

const item = (over: Partial<CheckItem>): CheckItem => ({
  kind: "check_run",
  id: "cr_1",
  name: "lint",
  state: "success",
  description: null,
  detailsUrl: null,
  url: null,
  app: null,
  startedAt: null,
  completedAt: null,
  ...over,
});

test("the headline says the worst of a commit's checks", () => {
  assert.equal(checksHeadline({ state: "success" }), "All checks have passed");
  assert.equal(checksHeadline({ state: "failure" }), "Some checks were not successful");
  assert.equal(checksHeadline({ state: "pending" }), "Some checks haven't completed yet");
});

test("the tally counts each kind, worst first", () => {
  assert.equal(checksTally({ total: 2, successful: 2, failed: 0, pending: 0, skipped: 0 }), "2 successful checks");
  assert.equal(checksTally({ total: 1, successful: 1, failed: 0, pending: 0, skipped: 0 }), "1 successful check");
  assert.equal(
    checksTally({ total: 4, successful: 2, failed: 1, pending: 1, skipped: 0 }),
    "1 failing, 1 in progress and 2 successful checks",
  );
});

test("a check run says how it went and how long it took", () => {
  const started = "2026-10-07T14:00:00Z";
  assert.equal(took(started, "2026-10-07T14:00:25Z"), "25s");
  assert.equal(took(started, "2026-10-07T14:01:12Z"), "1m 12s");
  assert.equal(took(started, null), "");
  assert.equal(checkDetail(item({ startedAt: started, completedAt: "2026-10-07T14:00:25Z" })), "Successful in 25s");
  assert.equal(
    checkDetail(item({ state: "failure", startedAt: started, completedAt: "2026-10-07T14:00:12Z", description: "2 problems" })),
    "Failing after 12s — 2 problems",
  );
  assert.equal(checkDetail(item({ state: "pending" })), "Queued");
  assert.equal(checkDetail(item({ state: "pending", startedAt: started })), "In progress");
  assert.equal(checkDetail(item({ kind: "status", description: "Deployment has completed" })), "Deployment has completed");
  assert.equal(checkDetail(item({ kind: "status", state: "skipped" })), "Skipped");
});

test("details go to g1t's own page first, and elsewhere apart", () => {
  assert.deepEqual(detailsLink(item({ url: "/acme/web/checks/cr_1", detailsUrl: "https://ci.example.com/1" })), {
    href: "/acme/web/checks/cr_1",
    external: false,
  });
  assert.deepEqual(detailsLink(item({ detailsUrl: "https://g1t.sh/acme/web/actions/runs/run_1" })), {
    href: "/acme/web/actions/runs/run_1",
    external: false,
  });
  assert.deepEqual(detailsLink(item({ detailsUrl: "https://vercel.com/acme/web/1" })), { href: "https://vercel.com/acme/web/1", external: true });
  assert.equal(detailsLink(item({ detailsUrl: "javascript:alert(1)" })), null);
  assert.equal(detailsLink(item({})), null);
});
