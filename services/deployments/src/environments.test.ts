import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionsTransition,
  address,
  buildState,
  commitState,
  compareEnvironments,
  environmentName,
  payloadOf,
  runOutcome,
  shortRef,
  statusContext,
} from "./environments.ts";
import { buildStatuses, fromBuild, type BuildRow } from "./environments.ts";

const appUrl = (script: string) => `https://${script}.g1t.page`;

test("an environment is named as given, production when not", () => {
  assert.equal(environmentName(undefined), "production");
  assert.equal(environmentName("  "), "production");
  assert.equal(environmentName(" staging "), "staging");
  assert.equal(environmentName("review/feature-x"), "review/feature-x");
  assert.deepEqual(environmentName("a\nb"), { error: "`environment` cannot hold control characters." });
  assert.ok(typeof environmentName("x".repeat(256)) === "object");
  assert.ok(typeof environmentName(3) === "object");
});

test("addresses are http(s), and a payload is an object", () => {
  assert.equal(address("https://g1t.sh", "environment_url"), "https://g1t.sh");
  assert.equal(address(null, "log_url"), null);
  assert.ok(typeof address("ftp://example.com", "log_url") === "object");
  assert.ok(typeof address("not a url", "log_url") === "object");
  assert.deepEqual(payloadOf(undefined), { value: {} });
  assert.deepEqual(payloadOf({ error: "kept" }), { value: { error: "kept" } });
  assert.deepEqual(payloadOf('{"units":["api"]}'), { value: { units: ["api"] } });
  assert.ok("error" in payloadOf("[1]"));
  assert.ok("error" in payloadOf("{"));
});

test("refs read as their branch or tag", () => {
  assert.equal(shortRef("refs/heads/main"), "main");
  assert.equal(shortRef("refs/tags/v1.2.0"), "v1.2.0");
  assert.equal(shortRef("main"), "main");
});

test("each state says something on the commit, but inactive", () => {
  assert.equal(statusContext("production"), "deploy / production");
  assert.equal(commitState("queued"), "pending");
  assert.equal(commitState("in_progress"), "pending");
  assert.equal(commitState("success"), "success");
  assert.equal(commitState("failure"), "failure");
  assert.equal(commitState("error"), "error");
  assert.equal(commitState("inactive"), null);
});

test("a g1t.page build's status reads as a deployment state", () => {
  assert.equal(buildState("queued"), "queued");
  assert.equal(buildState("building"), "in_progress");
  assert.equal(buildState("ready"), "success");
  assert.equal(buildState("failed"), "failure");
  assert.equal(buildState("skipped"), "error");
  assert.equal(buildState("replaced"), "inactive");
  assert.equal(buildState("down"), "inactive");
});

test("a run's deployment moves on, and a failure sticks until the run ends", () => {
  assert.equal(actionsTransition(null, "in_progress", false), "in_progress");
  assert.equal(actionsTransition("in_progress", "in_progress", false), null);
  assert.equal(actionsTransition("in_progress", "failure", false), "failure");
  assert.equal(actionsTransition("failure", "in_progress", false), null, "a later job does not undo a failure");
  assert.equal(actionsTransition("failure", "success", true), "success", "the run's outcome is the last word");
  assert.equal(actionsTransition("success", "in_progress", false), null);
  assert.equal(actionsTransition("in_progress", "success", true), "success");
});

test("a run's outcome for an environment comes from the jobs that ran", () => {
  assert.equal(runOutcome(["success", "skipped"]), "success");
  assert.equal(runOutcome(["success", "failure"]), "failure");
  assert.equal(runOutcome(["success", "cancelled"]), "error");
  assert.equal(runOutcome(["skipped", "skipped"]), null);
  assert.equal(runOutcome([]), null);
});

test("production comes first, then the newest", () => {
  const env = (name: string, production: boolean, at: string) => ({ name, production_environment: production, updated_at: at });
  const sorted = [env("preview", false, "2026-10-07"), env("staging", false, "2026-10-06"), env("Production", true, "2026-10-01"), env("eu", true, "2026-10-05")].sort(
    compareEnvironments,
  );
  assert.deepEqual(
    sorted.map((e) => e.name),
    ["Production", "eu", "preview", "staging"],
  );
});

const build = (over: Partial<BuildRow>): BuildRow => ({
  id: "dpl_1",
  workspace: "acme",
  slug: "web",
  repo_id: "rep_1",
  kind: "production",
  branch: null,
  number: null,
  commit_sha: "a".repeat(40),
  script: "web-acme",
  status: "ready",
  error: null,
  created_by: "usr_1",
  created_at: "2026-10-07T10:00:00.000Z",
  started_at: "2026-10-07T10:00:05.000Z",
  finished_at: "2026-10-07T10:01:00.000Z",
  ...over,
});

test("a g1t.page build is a deployment in the same model", () => {
  const live = fromBuild(build({}), "main", "https://g1t.sh", appUrl, { usr_1: "ada" });
  assert.equal(live.environment, "production");
  assert.equal(live.ref, "main");
  assert.equal(live.state, "success");
  assert.equal(live.source, "g1t_page");
  assert.equal(live.creator, "ada");
  assert.equal(live.environment_url, "https://web-acme.g1t.page");
  assert.equal(live.log_url, "https://g1t.sh/acme/web/deployments/dpl_1");
  assert.equal(live.production_environment, true);
  const preview = fromBuild(build({ kind: "preview", branch: "fix", number: 7, status: "failed", error: "The build failed.", finished_at: null }), "main", "https://g1t.sh", appUrl);
  assert.equal(preview.ref, "fix");
  assert.equal(preview.number, 7);
  assert.equal(preview.transient_environment, true);
  assert.equal(preview.environment_url, null, "a failed build is not served");
  assert.equal(preview.creator, "g1t", "an id no one could name is g1t");
});

test("a build's statuses come from its own timestamps", () => {
  const row = build({ status: "replaced" });
  const statuses = buildStatuses(row, fromBuild(row, "main", "https://g1t.sh", appUrl));
  assert.deepEqual(
    statuses.map((s) => s.state),
    ["queued", "in_progress", "success", "inactive"],
  );
  const queued = build({ status: "queued", started_at: null, finished_at: null });
  assert.deepEqual(
    buildStatuses(queued, fromBuild(queued, "main", "https://g1t.sh", appUrl)).map((s) => s.state),
    ["queued"],
  );
});
