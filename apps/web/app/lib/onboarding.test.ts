import assert from "node:assert/strict";
import { test } from "node:test";

import { type OnboardingFacts, STEP_ORDER, finished, firstOpenStep, opensByItself, progressOf, setupPath, stepsFrom, withSkipped } from "./onboarding.ts";

const nothing: OnboardingFacts = {
  providers: { total: 0, working: 0 },
  askReady: false,
  askWith: null,
  projects: 0,
  github: { configured: true, connected: false },
  cli: false,
  harnessApp: false,
  people: { others: 0, pending: 0 },
  invitesNeedPlan: false,
  runners: 0,
};

const everything: OnboardingFacts = {
  providers: { total: 1, working: 1 },
  askReady: true,
  askWith: "Anthropic · Auto",
  projects: 3,
  github: { configured: true, connected: true },
  cli: true,
  harnessApp: true,
  people: { others: 2, pending: 0 },
  invitesNeedPlan: false,
  runners: 1,
};

const fresh = { dismissed_at: null, skipped: [], updated_at: null };

test("a new workspace has every step to do, in the guide's order", () => {
  const steps = stepsFrom(nothing, fresh);
  assert.deepEqual(
    steps.map((step) => step.key),
    STEP_ORDER,
  );
  assert.ok(steps.every((step) => !step.done && !step.skipped));
  assert.equal(firstOpenStep(steps), "ai");
  assert.deepEqual(progressOf(steps), { settled: 0, total: 6, percent: 0 });
  assert.equal(finished(steps), false);
});

test("a step is done from the workspace's state, not from clicks", () => {
  const steps = stepsFrom(everything, fresh);
  assert.ok(steps.every((step) => step.done));
  assert.equal(finished(steps), true);
  assert.equal(steps.find((step) => step.key === "ask")?.summary, "Anthropic · Auto");
  assert.equal(steps.find((step) => step.key === "code")?.summary, "3 repositories");
});

test("a provider whose check failed is not a working one", () => {
  const steps = stepsFrom({ ...nothing, providers: { total: 1, working: 0 } }, fresh);
  const ai = steps.find((step) => step.key === "ai")!;
  assert.equal(ai.done, false);
  assert.equal(ai.summary, "Added, but its check failed");
  // A service that did not answer leaves the step to do.
  assert.equal(stepsFrom({ ...nothing, providers: null }, fresh)[0]!.done, false);
});

test("code is brought by a project or a connected GitHub; people by a member or an invitation", () => {
  const github = stepsFrom({ ...nothing, github: { configured: true, connected: true } }, fresh);
  assert.equal(github.find((step) => step.key === "code")?.done, true);
  const invited = stepsFrom({ ...nothing, people: { others: 0, pending: 1 } }, fresh);
  assert.equal(invited.find((step) => step.key === "people")?.summary, "1 invitation sent");
  const free = stepsFrom({ ...nothing, invitesNeedPlan: true }, fresh);
  assert.equal(free.find((step) => step.key === "people")?.summary, "Invites come with the plan");
});

test("either the CLI or the plugin signed in connects the harness", () => {
  assert.equal(stepsFrom({ ...nothing, cli: true }, fresh).find((step) => step.key === "harness")?.done, true);
  assert.equal(stepsFrom({ ...nothing, harnessApp: true }, fresh).find((step) => step.key === "harness")?.summary, "AI client signed in");
});

test("skipped steps count as settled, but the AI provider cannot be skipped and a done step is not skipped", () => {
  const steps = stepsFrom({ ...nothing, runners: 1 }, { ...fresh, skipped: ["ai", "people", "runner"] });
  assert.equal(steps.find((step) => step.key === "ai")?.skipped, false);
  assert.equal(steps.find((step) => step.key === "people")?.skipped, true);
  assert.equal(steps.find((step) => step.key === "runner")?.skipped, false);
  assert.equal(progressOf(steps).settled, 2);
  assert.equal(firstOpenStep(steps), "ai");
});

test("skipping keeps the guide's order and takes a skip back", () => {
  assert.deepEqual(withSkipped(["runner"], "people", true), ["people", "runner"]);
  assert.deepEqual(withSkipped(["people", "runner"], "people", false), ["runner"]);
  assert.deepEqual(withSkipped([], "ask", true), ["ask"]);
});

test("it opens by itself until dismissed, and whenever it is asked for", () => {
  assert.equal(opensByItself({ state: fresh }, false), true);
  const dismissed = { state: { ...fresh, dismissed_at: "2026-10-14T21:05:00.000Z" } };
  assert.equal(opensByItself(dismissed, false), false);
  assert.equal(opensByItself(dismissed, true), true);
  assert.equal(opensByItself(null, true), false);
  assert.equal(setupPath("flagon-io"), "/flagon-io/-/home?setup=1");
});
