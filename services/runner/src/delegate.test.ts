import assert from "node:assert/strict";
import { test } from "node:test";

import type { Issue, Pull } from "@g1t/contracts";

import { delegateInput, fixUrlFor, noModelMessage, notStarted, queued, started } from "./delegate.ts";

const issue = { number: 41, title: "Retry webhooks" } as Issue;

test("each refusal points at where it is fixed", () => {
  const cases: [string, string | null][] = [
    ["not_paid", "https://g1t.sh/acme/-/billing"],
    ["trial_used", "https://g1t.sh/acme/-/billing"],
    ["limit", "https://g1t.sh/acme/-/billing#limit"],
    ["issue_cap", "https://g1t.sh/acme/-/billing#caps"],
    ["no_model", "https://g1t.sh/acme/-/integrations"],
    // Nothing on a page fixes these: support does, or a minute's wait.
    ["paused", null],
    ["billing_unavailable", null],
  ];
  for (const [code, url] of cases) assert.equal(fixUrlFor(code, "Acme"), url, code);
});

test("the issue is kept whatever became of the agent", () => {
  const pull = { number: 42 } as Pull;
  assert.deepEqual(started(issue, pull), {
    issue,
    pull,
    agent: { status: "started", code: null, message: null, fixUrl: null },
  });
  const waiting = queued(issue, "Every agent slot is busy.");
  assert.equal(waiting.issue, issue);
  assert.equal(waiting.pull, null);
  assert.equal(waiting.agent.status, "queued");
  const refused = notStarted(issue, "not_paid", "Agents need a paid workspace.", "acme");
  assert.equal(refused.issue.number, 41);
  assert.deepEqual(refused.agent, {
    status: "not_started",
    code: "not_paid",
    message: "Agents need a paid workspace.",
    fixUrl: "https://g1t.sh/acme/-/billing",
  });
  assert.match(noModelMessage("acme"), /Integrations/);
});

test("what to do is tidied, and checks may come one per line", () => {
  assert.deepEqual(delegateInput({ title: "  Retry webhooks ", body: " Use backoff. ", checks: "npm test\n\n  npm run lint " }), {
    title: "Retry webhooks",
    body: "Use backoff.",
    checks: ["npm test", "npm run lint"],
    labels: [],
  });
  assert.deepEqual(delegateInput({ title: 3, checks: ["cargo test", " "], labels: ["bug"] }), {
    title: "",
    body: "",
    checks: ["cargo test"],
    labels: ["bug"],
  });
});
