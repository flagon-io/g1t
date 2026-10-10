import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewAssignment } from "@g1t/contracts";

import {
  filterTeams,
  newTeamFromForm,
  parentChoices,
  reviewAssignmentFromForm,
  splitTeams,
  teamChangesFromForm,
  teamCounts,
  teamPath,
} from "./teams.ts";

const team = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: null as string | null,
  visibility: "visible" as "visible" | "secret",
  parent: null as { slug: string; name: string } | null,
  viewer_role: null as "member" | "maintainer" | null,
  ...extra,
});

const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
};

const DEFAULTS: ReviewAssignment = {
  enabled: false,
  algorithm: "round_robin",
  count: 1,
  skip_busy: false,
  busy_at: 5,
  include_child_teams: false,
  excluded: [],
  notify_team: false,
};

test("team pages live under the workspace's teams", () => {
  assert.equal(teamPath("acme", "backend"), "/acme/-/teams/backend");
  assert.equal(teamPath("acme", "backend", "settings"), "/acme/-/teams/backend/settings");
});

test("teams are found by every word of the search", () => {
  const teams = [team("backend", { description: "APIs and data" }), team("web"), team("platform", { description: "Shared backend tools" })];
  assert.deepEqual(filterTeams(teams, "").map((t) => t.slug), ["backend", "web", "platform"]);
  assert.deepEqual(filterTeams(teams, "BACKEND").map((t) => t.slug), ["backend", "platform"]);
  assert.deepEqual(filterTeams(teams, "backend tools").map((t) => t.slug), ["platform"]);
  assert.deepEqual(filterTeams(teams, "nothing"), []);
});

test("your teams come first", () => {
  const { mine, others } = splitTeams([team("a"), team("b", { viewer_role: "member" }), team("c", { viewer_role: "maintainer" })]);
  assert.deepEqual(mine.map((t) => t.slug), ["b", "c"]);
  assert.deepEqual(others.map((t) => t.slug), ["a"]);
});

test("a team can go under any visible team but itself and those below it", () => {
  const teams = [
    team("eng"),
    team("backend", { parent: { slug: "eng", name: "Eng" } }),
    team("api", { parent: { slug: "backend", name: "Backend" } }),
    team("web", { parent: { slug: "eng", name: "Eng" } }),
    team("secret", { visibility: "secret" }),
  ];
  assert.deepEqual(parentChoices(teams, "backend").map((t) => t.slug), ["eng", "web"]);
  assert.deepEqual(parentChoices(teams, "eng").map((t) => t.slug), []);
  assert.deepEqual(parentChoices(teams, null).map((t) => t.slug), ["eng", "backend", "api", "web"]);
});

test("a new team reads its form", () => {
  assert.deepEqual(newTeamFromForm(form({ name: " Backend ", slug: "", description: "", visibility: "secret", parent: "", members: "@ana, bo  cy" })), {
    name: "Backend",
    slug: null,
    description: null,
    visibility: "secret",
    parent: null,
    members: ["ana", "bo", "cy"],
  });
  assert.equal(newTeamFromForm(form({ name: "x", visibility: "weird" })).visibility, "visible");
});

test("settings change only what their form has", () => {
  assert.deepEqual(teamChangesFromForm(form({ name: "Web", description: " UI " })), { name: "Web", description: "UI" });
  assert.deepEqual(teamChangesFromForm(form({ parent: "" })), { parent: "" });
  assert.deepEqual(teamChangesFromForm(form({ "notify-shown": "1" })), { notify: false });
  assert.deepEqual(teamChangesFromForm(form({ "notify-shown": "1", notify: "on" })), { notify: true });
  assert.deepEqual(teamChangesFromForm(form({ visibility: "secret" })), { visibility: "secret" });
});

test("review assignment is read within bounds", () => {
  const read = reviewAssignmentFromForm(
    form({ enabled: "on", algorithm: "load_balance", count: "40", skip_busy: "on", busy_at: "0", excluded: "@Ana, bo ana" }),
    DEFAULTS,
  );
  assert.deepEqual(read, {
    enabled: true,
    algorithm: "load_balance",
    count: 10,
    skip_busy: true,
    busy_at: 1,
    include_child_teams: false,
    excluded: ["ana", "bo"],
    notify_team: false,
  });
  // Off, and nonsense kept as it was.
  const off = reviewAssignmentFromForm(form({ algorithm: "random", count: "many" }), { ...DEFAULTS, count: 3 });
  assert.equal(off.enabled, false);
  assert.equal(off.algorithm, "round_robin");
  assert.equal(off.count, 3);
});

test("counts leave out what is none", () => {
  assert.equal(teamCounts({ members_count: 1, repos_count: 0, child_teams_count: 2 }), "1 member · 2 child teams");
  assert.equal(teamCounts({ members_count: 0, repos_count: 0, child_teams_count: 0 }), "No members yet");
  assert.equal(teamCounts({ members_count: 2, repos_count: 1, child_teams_count: 0 }, 1), "2 members · 1 agent · 1 repository");
  assert.equal(teamCounts({ members_count: 0, repos_count: 0, child_teams_count: 0 }, 3), "3 agents");
});

test("who may create teams follows the workspace's setting", async () => {
  // From the contracts' source: the Teams page and the + menu decide with it.
  const { mayCreateTeams } = await import("../../../../packages/contracts/src/teams.ts");
  assert.equal(mayCreateTeams(undefined, "member"), true);
  assert.equal(mayCreateTeams("members", "member"), true);
  assert.equal(mayCreateTeams("owners", "member"), false);
  assert.equal(mayCreateTeams("owners", "owner"), true);
  assert.equal(mayCreateTeams("members", null), false);
});
