import assert from "node:assert/strict";
import { test } from "node:test";

import { type Attempt, shipStateOf, shipmentOf, sitePath, walkPage } from "./shipped.ts";

const commit = (hash: string, parent: string | null = null) => ({ hash, parents: parent ? [parent] : [] });

test("a deployment ships what no deployment shipped before, and stops at the last one's history", () => {
  const page = [commit("c3", "c2"), commit("c2", "c1"), commit("c1", "c0")];
  // Nothing shipped yet, a page not full: all of it, and no more pages.
  assert.deepEqual(walkPage(page, new Set(), false), { ship: ["c3", "c2", "c1"], more: false, next: "c0" });
  // A full page with nothing known: read on from the last commit's first parent.
  assert.deepEqual(walkPage(page, new Set(), true), { ship: ["c3", "c2", "c1"], more: true, next: "c0" });
  // The last deployment shipped c1: only what came after it, and the walk stops.
  assert.deepEqual(walkPage(page, new Set(["c1"]), true), { ship: ["c3", "c2"], more: false, next: "c0" });
  // A rollback to a commit shipped before ships nothing.
  assert.deepEqual(walkPage([commit("c1", "c0")], new Set(["c1", "c0"]), false).ship, []);
  // A merged branch's older commits after the last deployment's commit in the log still ship.
  assert.deepEqual(walkPage([commit("m", "c1"), commit("c1", "c0"), commit("f1", "c0")], new Set(["c1"]), false).ship, ["m", "f1"]);
});

const ask = { sha: "abc", landed_at: "2026-10-14T10:00:00.000Z" };
const at = (minutes: number) => new Date(Date.parse(ask.landed_at) + minutes * 60_000).toISOString();
const attempt = (minutes: number, outcome: Attempt["outcome"], url = `/acme/web/deployments/d${minutes}`): Attempt => ({
  at: at(minutes),
  outcome,
  url,
  environment: "production",
});

test("a change shipped is live from the deployment that first shipped it", () => {
  const shipped = { deployed_at: at(9), url: "/acme/web/actions/runs/run_1", environment: "production" };
  assert.deepEqual(shipStateOf(ask, shipped, [attempt(3, "failed"), attempt(9, "live")], at(-60)), {
    sha: "abc",
    state: "live",
    deployed_at: at(9),
    url: "/acme/web/actions/runs/run_1",
    environment: "production",
  });
});

test("a change not shipped is deploying, failed or waiting, by the production attempts after it", () => {
  const start = at(-60);
  assert.equal(shipStateOf(ask, null, [attempt(2, "running")], start).state, "deploying");
  const failed = shipStateOf(ask, null, [attempt(2, "failed")], start);
  assert.equal(failed.state, "failed");
  assert.equal(failed.url, "/acme/web/deployments/d2");
  assert.equal(shipStateOf(ask, null, [], start).state, "waiting");
  // A failure fixed by a later deployment that did not ship it (another branch, say): waiting again.
  assert.equal(shipStateOf(ask, null, [attempt(2, "failed"), attempt(5, "live")], start).state, "waiting");
  // Attempts before it landed say nothing about it.
  assert.equal(shipStateOf(ask, null, [attempt(-5, "failed")], start).state, "waiting");
});

test("a change that landed before recording began goes live with the first success after it", () => {
  const start = at(120);
  const live = shipStateOf(ask, null, [attempt(-5, "live"), attempt(4, "failed"), attempt(30, "live")], start);
  assert.equal(live.state, "live");
  assert.equal(live.deployed_at, at(30));
  // Even when the first walk wrote it down later, as of that walk.
  assert.equal(shipStateOf(ask, { deployed_at: start, url: null, environment: "production" }, [attempt(30, "live")], start).deployed_at, at(30));
  // Nothing recorded at all yet: the same.
  assert.equal(shipStateOf(ask, null, [attempt(30, "live")], null).deployed_at, at(30));
});

test("only a production success is a shipment, linked to its page", () => {
  const repo = { namespace: "acme", name: "web" };
  const deployment = {
    id: "dep_1",
    sha: "abc",
    environment: "production",
    production_environment: true,
    source: "actions" as const,
    project: null,
    run_url: "https://g1t.sh/acme/web/actions/runs/run_1",
    updated_at: "2026-10-14T10:09:00.000Z",
  };
  const status = { state: "success" as const, created_at: "2026-10-14T10:09:00.000Z" };
  assert.deepEqual(shipmentOf({ repoId: "rep_1", deployment, deploymentStatus: status }, repo, "https://g1t.sh"), {
    deploymentId: "dep_1",
    repoId: "rep_1",
    repo,
    sha: "abc",
    environment: "production",
    deployedAt: "2026-10-14T10:09:00.000Z",
    url: "/acme/web/actions/runs/run_1",
  });
  assert.equal(shipmentOf({ repoId: "rep_1", deployment, deploymentStatus: { ...status, state: "in_progress" } }, repo, "https://g1t.sh"), null);
  assert.equal(
    shipmentOf({ repoId: "rep_1", deployment: { ...deployment, production_environment: false }, deploymentStatus: status }, repo, "https://g1t.sh"),
    null,
  );
  const build = { ...deployment, id: "dpl_1", source: "g1t_page" as const, project: "site", run_url: null };
  assert.equal(shipmentOf({ repoId: "rep_1", deployment: build, deploymentStatus: status }, repo, "https://g1t.sh")?.url, "/acme/site/deployments/dpl_1");
  // Reported through the API with no run: the repository's deployments.
  assert.equal(
    shipmentOf({ repoId: "rep_1", deployment: { ...deployment, source: "api" as const, run_url: null }, deploymentStatus: status }, repo, "https://g1t.sh")
      ?.url,
    "/acme/web/deployments",
  );
});

test("addresses stay on the site", () => {
  assert.equal(sitePath("https://g1t.sh/acme/web/actions/runs/1", "https://g1t.sh"), "/acme/web/actions/runs/1");
  assert.equal(sitePath("/acme/web", "https://g1t.sh"), "/acme/web");
  assert.equal(sitePath("https://elsewhere.example/x", "https://g1t.sh"), null);
  assert.equal(sitePath(null, "https://g1t.sh"), null);
});
