import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditEntry } from "@g1t/contracts";

import {
  actorLabel,
  exportName,
  filterHref,
  parseFilters,
  retainedSince,
  ruleLabel,
  targetLabel,
  toCsv,
  toQuery,
  visibilityFor,
} from "./audit.ts";

const entry: AuditEntry = {
  id: "aud_1",
  time: "2026-10-04T12:00:00.000Z",
  actorKind: "agent",
  actor: "g1t-agent",
  actorId: "usr_g1t_agent",
  agent: "g1t-agent",
  onBehalfOf: "syntaqx",
  runId: "run_1",
  runKind: "implement",
  credentialId: "tok_1",
  action: "merge_pull_request",
  surface: "mcp",
  workspace: "acme",
  repo: "acme/rocket",
  number: 12,
  gitRef: null,
  path: null,
  outcome: "denied",
  rule: "never",
  result: "forbidden",
  message: 'A g1t agent\'s token can never use merge_pull_request: "merging" is for people, too.',
  requestId: "8c1f",
};

test("owners see everything, members their projects, others nothing", () => {
  assert.deepEqual(visibilityFor("owner", "ana"), { kind: "all" });
  assert.deepEqual(visibilityFor("member", "ana"), { kind: "projects", username: "ana" });
  assert.equal(visibilityFor(null, "ana"), null);
});

test("filters are read from the address, and nonsense is dropped", () => {
  const filters = parseFilters(
    new URLSearchParams("actor=syntaqx&outcome=maybe&kind=agent&from=2026-10-01&to=yesterday&project=rocket"),
  );
  assert.equal(filters.actor, "syntaqx");
  assert.equal(filters.outcome, "");
  assert.equal(filters.kind, "agent");
  assert.equal(filters.from, "2026-10-01");
  assert.equal(filters.to, "");
  const query = toQuery("acme", { kind: "all" }, { ...filters, to: "2026-10-04" }, 100);
  assert.equal(query.repo, "acme/rocket");
  assert.equal(query.since, "2026-10-01T00:00:00.000Z");
  // The end day is inclusive.
  assert.equal(query.until, "2026-10-05T00:00:00.000Z");
  assert.equal(query.actorKind, "agent");
  assert.equal(query.outcome, null);
});

test("links keep the other filters", () => {
  const filters = parseFilters(new URLSearchParams("actor=ana&outcome=denied"));
  assert.equal(filterHref("/acme/-/audit", filters, { before: "aud_9" }), "/acme/-/audit?actor=ana&outcome=denied&before=aud_9");
  assert.equal(filterHref("/acme/-/audit", parseFilters(new URLSearchParams())), "/acme/-/audit");
});

test("an agent is shown with whom it acted for", () => {
  assert.equal(actorLabel(entry), "g1t-agent on behalf of syntaqx");
  assert.equal(actorLabel({ actor: "ana", agent: null, onBehalfOf: null }), "ana");
  assert.equal(targetLabel(entry), "acme/rocket#12");
  assert.equal(targetLabel({ ...entry, number: null, gitRef: "refs/heads/fix" }), "acme/rocket refs/heads/fix");
  assert.equal(ruleLabel("never"), "never allowed for agents");
  assert.equal(ruleLabel("run:implement/tools"), "implement run tools");
  assert.equal(ruleLabel("run:update/runner:push"), "update run runner (push)");
});

test("the CSV quotes what it must and keeps formulas as text", () => {
  const csv = toCsv([entry, { ...entry, id: "aud_2", path: "=HYPERLINK(1)", message: null }]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("id,time,workspace,actorKind,actor"));
  assert.ok(lines[1].includes('"A g1t agent\'s token can never use merge_pull_request: ""merging"" is for people, too."'));
  assert.ok(lines[2].includes("'=HYPERLINK(1)"));
  assert.equal(exportName("acme", "csv", new Date("2026-10-04T23:00:00Z")), "acme-audit-2026-10-04.csv");
});

test("the log reads back only as far as the plan keeps it", () => {
  const now = Date.parse("2026-10-31T00:00:00.000Z");
  // 90 days, on every plan.
  assert.equal(retainedSince(null, 90, now), "2026-08-02T00:00:00.000Z");
  assert.equal(retainedSince(null, 30, now), "2026-10-01T00:00:00.000Z");
  assert.equal(retainedSince("2026-01-01T00:00:00.000Z", 30, now), "2026-10-01T00:00:00.000Z");
  // A later start than the window is kept.
  assert.equal(retainedSince("2026-10-20T00:00:00.000Z", 30, now), "2026-10-20T00:00:00.000Z");
  // A longer window, where one is set.
  assert.equal(retainedSince("2026-01-01T00:00:00.000Z", 365, now), "2026-01-01T00:00:00.000Z");
});
