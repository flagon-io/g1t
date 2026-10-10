import assert from "node:assert/strict";
import { test } from "node:test";

import { agentAbilities, atLeast, leavesNoManager, readableByAll, readableByWorkspace, roleOf, type Person, type SpaceRules } from "./access.ts";

const ana: Person = { user_id: "u1", owner: false, teams: new Set(["web"]) };
const bo: Person = { user_id: "u2", owner: false, teams: new Set() };
const owner: Person = { user_id: "u9", owner: true, teams: new Set() };

const workspace: SpaceRules = { kind: "workspace", team: null, default_role: "edit", members: [] };
const team: SpaceRules = { kind: "team", team: "web", default_role: "comment", members: [] };
const secret: SpaceRules = { kind: "private", team: null, default_role: null, members: [{ principal: "user:u1", role: "manage" }] };

test("workspace spaces give every member their base role", () => {
  assert.equal(roleOf(workspace, ana), "edit");
  assert.equal(roleOf(workspace, bo), "edit");
});

test("team spaces give the team's members their base role, and nobody else anything", () => {
  assert.equal(roleOf(team, ana), "comment");
  assert.equal(roleOf(team, bo), null);
});

test("a listing raises a role but never lowers it", () => {
  const raised: SpaceRules = { ...team, members: [{ principal: "user:u1", role: "manage" }, { principal: "user:u2", role: "view" }] };
  assert.equal(roleOf(raised, ana), "manage");
  assert.equal(roleOf(raised, bo), "view");
  const lowered: SpaceRules = { ...workspace, members: [{ principal: "user:u2", role: "view" }] };
  assert.equal(roleOf(lowered, bo), "edit");
});

test("a team listed on a space reaches its members", () => {
  const listed: SpaceRules = { ...secret, members: [{ principal: "team:WEB", role: "edit" }] };
  assert.equal(roleOf(listed, ana), "edit");
  assert.equal(roleOf(listed, bo), null);
});

test("owners manage workspace and team spaces, but a private space is its members' alone", () => {
  assert.equal(roleOf(team, owner), "manage");
  assert.equal(roleOf(secret, owner), null);
  assert.equal(roleOf(secret, ana), "manage");
});

test("an audience reads a space only if every person in it can", () => {
  assert.equal(readableByAll(team, [ana]), true);
  assert.equal(readableByAll(team, [ana, bo]), false);
  assert.equal(readableByAll(workspace, [ana, bo]), true);
  assert.equal(readableByWorkspace(workspace), true);
  assert.equal(readableByWorkspace(team), false);
  assert.equal(readableByWorkspace({ ...workspace, default_role: null }), false);
});

test("an agent is capped by the person it acts for and by the space's agent mode", () => {
  assert.deepEqual(agentAbilities("edit", "suggest"), { read: true, suggest: true, edit: false });
  assert.deepEqual(agentAbilities("edit", "edit"), { read: true, suggest: true, edit: true });
  assert.deepEqual(agentAbilities("view", "edit"), { read: true, suggest: false, edit: false });
  assert.deepEqual(agentAbilities("comment", "edit"), { read: true, suggest: true, edit: false });
  assert.deepEqual(agentAbilities(null, "edit"), { read: false, suggest: false, edit: false });
});

test("roles order view < comment < edit < manage", () => {
  assert.equal(atLeast("comment", "view"), true);
  assert.equal(atLeast("comment", "edit"), false);
  assert.equal(atLeast(null, "view"), false);
});

test("a private space keeps someone who can manage it", () => {
  const members = [
    { principal: "user:u1", role: "manage" as const },
    { principal: "user:u2", role: "edit" as const },
  ];
  assert.equal(leavesNoManager("private", members, "user:u1", null), true);
  assert.equal(leavesNoManager("private", members, "user:u1", "edit"), true);
  assert.equal(leavesNoManager("private", members, "user:u2", null), false);
  assert.equal(leavesNoManager("workspace", members, "user:u1", null), false);
});
