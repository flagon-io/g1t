import assert from "node:assert/strict";
import { test } from "node:test";

import { MIRROR_READ_AREAS, type RepoArea, type RepoMirror, mirrorOffers, mirrorUpdatesWait, mirrorWritable } from "./mirrors.ts";

const mirror = (state: RepoMirror["state"], warm = false): RepoMirror => ({
  state,
  remote: "github.com/acme/web",
  url: "https://github.com/acme/web",
  since: "2026-10-08T10:00:00Z",
  warm,
});
const AREAS: RepoArea[] = ["code", "issues", "pulls", "agents", "workflows", "deployments", "security", "insights", "settings", "updates"];
const WORK: RepoArea[] = ["issues", "pulls", "agents", "deployments", "updates"];

test("only a takeover takes writes", () => {
  assert.equal(mirrorWritable(null), true);
  assert.equal(mirrorWritable(undefined), true);
  assert.equal(mirrorWritable(mirror("takeover")), true);
  for (const state of ["standby", "ci", "handing_back"] as const) assert.equal(mirrorWritable(mirror(state)), false, state);
});

test("a mirror offers a read-only copy until it is taken over", () => {
  for (const state of ["standby", "ci", "handing_back"] as const) {
    for (const area of MIRROR_READ_AREAS) assert.ok(mirrorOffers(mirror(state), area), `${state} ${area}`);
    for (const area of WORK) assert.ok(!mirrorOffers(mirror(state), area), `${state} ${area}`);
  }
  for (const area of AREAS) {
    assert.ok(mirrorOffers(mirror("takeover"), area), `taken over: ${area}`);
    assert.ok(mirrorOffers(null, area), `leads: ${area}`);
  }
});

test("workflows run in CI failover, during a takeover, and on a standby kept warm", () => {
  assert.equal(mirrorOffers(mirror("standby"), "workflows"), false);
  assert.equal(mirrorOffers(mirror("standby", true), "workflows"), true);
  assert.equal(mirrorOffers(mirror("ci"), "workflows"), true);
  assert.equal(mirrorOffers(mirror("takeover"), "workflows"), true);
  assert.equal(mirrorOffers(mirror("handing_back"), "workflows"), false);
  assert.equal(mirrorOffers(mirror("handing_back", true), "workflows"), false, "nothing starts while handing back");
});

test("why updates wait names the repository and its remote", () => {
  const why = mirrorUpdatesWait("acme", "web", mirror("standby"));
  assert.ok(why.startsWith("Security updates wait until acme/web is taken over or moved to g1t."));
  assert.ok(why.includes("github.com/acme/web"));
});
