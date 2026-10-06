import assert from "node:assert/strict";
import { test } from "node:test";

import { chosenRepo, delegateForm, issuePath, notStarted } from "./delegate.ts";

const repos = [
  { namespace: "acme", name: "web" },
  { namespace: "acme", name: "api" },
];

test("a form becomes what to put the agent on", () => {
  const form = new FormData();
  form.set("title", "  Retry webhooks with backoff ");
  form.set("body", " Failed deliveries are dropped. ");
  form.set("checks", "npm test\n\n  npm run lint  ");
  form.append("label", "bug");
  form.set("labels", "webhooks, ");
  assert.deepEqual(delegateForm(form), {
    title: "Retry webhooks with backoff",
    body: "Failed deliveries are dropped.",
    labels: ["bug", "webhooks"],
    checks: ["npm test", "npm run lint"],
  });
});

test("only one of the viewer's projects can be chosen", () => {
  assert.deepEqual(chosenRepo("acme/API", repos), { namespace: "acme", name: "api" });
  assert.equal(chosenRepo("acme/billing", repos), null);
  assert.equal(chosenRepo("acme", repos), null);
  assert.equal(chosenRepo("acme/web/x", repos), null);
  assert.equal(chosenRepo(null, repos), null);
});

test("a started or queued agent goes on to the issue; one that did not start says why and where", () => {
  const repo = repos[0];
  assert.equal(issuePath(repo, 41), "/acme/web/issues/41");
  assert.equal(notStarted({ status: "started", code: null, message: null, fixUrl: null }, repo, 41), null);
  assert.equal(notStarted({ status: "queued", code: "waiting", message: "Busy.", fixUrl: null }, repo, 41), null);
  assert.deepEqual(
    notStarted(
      { status: "not_started", code: "not_paid", message: "Agents need a paid workspace.", fixUrl: "https://g1t.sh/acme/-/billing" },
      repo,
      41,
    ),
    {
      to: "/acme/web/issues/41",
      number: 41,
      message: "Agents need a paid workspace.",
      fix: { label: "Start the plan or the trial", to: "/acme/-/billing" },
    },
  );
  assert.equal(notStarted({ status: "not_started", code: "paused", message: "Paused.", fixUrl: null }, repo, 41)?.fix, null);
  // The address a message ends with is the fix link's, so it is said once.
  assert.equal(
    notStarted(
      { status: "not_started", code: "trial_used", message: "Start the $20 plan to keep going: /acme/-/billing", fixUrl: "https://g1t.sh/acme/-/billing" },
      repo,
      41,
    )?.message,
    "Start the $20 plan to keep going.",
  );
});
