import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmsPurge, daysLeft, wentSummary } from "./deleted-workspaces.ts";

test("what went reads as one line", () => {
  assert.equal(
    wentSummary({ repositories: 3, projects: 1, members: 2, billing: null, protected: false }),
    "3 repositories, 1 project, 2 members",
  );
  assert.equal(
    wentSummary({ repositories: 1, projects: 0, members: 1, billing: null, protected: false }),
    "1 repository, 0 projects, 1 member",
  );
});

test("days left round up, and none once it is due", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(daysLeft("2026-11-05T12:00:00Z", now), 30);
  assert.equal(daysLeft("2026-10-06T13:00:00Z", now), 1);
  assert.equal(daysLeft("2026-10-06T12:00:00Z", now), 0);
  assert.equal(daysLeft("2026-10-01T00:00:00Z", now), 0);
  assert.equal(daysLeft("not a date", now), 0);
});

test("a purge is confirmed by the slug alone", () => {
  assert.ok(confirmsPurge("acme", " Acme "));
  assert.ok(!confirmsPurge("acme", ""));
  assert.ok(!confirmsPurge("acme", "acme-inc"));
});
