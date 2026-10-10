import assert from "node:assert/strict";
import { test } from "node:test";

import { aclChain, type FolioAclNode, type FolioGrant, type Person, type SpaceRules } from "../access.ts";
import { agentMayFind, agentReach, audienceRule, type AudienceRule } from "./agents.ts";

// The leak rules (docs.g1t.sh/guides/agent-access/).

const ana: Person = { user_id: "ana", owner: false, teams: new Set(["web"]) };
const bo: Person = { user_id: "bo", owner: false, teams: new Set() };
const cy: Person = { user_id: "cy", owner: false, teams: new Set(["web"]) };

const open: SpaceRules = { kind: "workspace", team: null, default_role: "edit", members: [] };
const team: SpaceRules = { kind: "team", team: "web", default_role: "edit", members: [] };

function node(id: string, over: Partial<FolioAclNode> = {}): FolioAclNode {
  return { id, owner: "user:ana", parent_id: null, space_id: null, inherit: true, general_access: "none", general_role: null, ...over };
}

function reach(n: FolioAclNode, grants: Record<string, FolioGrant[]>, space: SpaceRules | null, rule: AudienceRule, people: Person[] = [], visits: string[] = [], asker = ana) {
  return agentReach({
    chain: aclChain(n.id, new Map([[n.id, n]])),
    grants: new Map(Object.entries(grants)),
    space,
    asker,
    askerVisited: visits.includes(asker.user_id),
    rule,
    people,
    visited: (p) => visits.includes(p.user_id),
    agent_mode: "edit",
  });
}

test("audience rules: none or only the asker is the asker; more than 20 people is the workspace", () => {
  assert.deepEqual(audienceRule(null, "ana"), { kind: "asker" });
  assert.deepEqual(audienceRule({ kind: "people", user_ids: ["ana"] }, "ana"), { kind: "asker" });
  assert.deepEqual(audienceRule({ kind: "people", user_ids: ["ana", "bo", "bo"] }, "ana"), { kind: "people", user_ids: ["bo"] });
  assert.deepEqual(audienceRule({ kind: "workspace" }, "ana"), { kind: "workspace" });
  const crowd = Array.from({ length: 21 }, (_, i) => `u${i}`);
  assert.deepEqual(audienceRule({ kind: "people", user_ids: crowd }, "ana"), { kind: "workspace" });
  const twenty = Array.from({ length: 19 }, (_, i) => `u${i}`);
  assert.equal(audienceRule({ kind: "people", user_ids: twenty }, "ana").kind, "people");
});

test("rule 1: a public channel finds only open-space and workspace-wide folios", () => {
  const ws: AudienceRule = { kind: "workspace" };
  assert.equal(agentMayFind(reach(node("a", { space_id: "open" }), {}, open, ws)), true);
  assert.equal(agentMayFind(reach(node("a", { general_access: "workspace", general_role: "view" }), {}, null, ws)), true);
  // Private, shared, team, link: never in a public channel.
  assert.equal(agentMayFind(reach(node("a"), {}, null, ws)), false);
  assert.equal(agentMayFind(reach(node("a"), { a: [{ principal: "user:bo", role: "view" }] }, null, ws)), false);
  assert.equal(agentMayFind(reach(node("a", { space_id: "team" }), {}, team, ws)), false);
  assert.equal(agentMayFind(reach(node("a", { general_access: "link", general_role: "view" }), {}, null, ws, [], ["ana"])), false);
});

test("rule 1: a conversation finds only what everyone in it can read", () => {
  const withBo: AudienceRule = { kind: "people", user_ids: ["bo"] };
  const shared = node("a");
  assert.equal(agentMayFind(reach(shared, { a: [{ principal: "user:bo", role: "view" }] }, null, withBo, [bo])), true);
  assert.equal(agentMayFind(reach(shared, {}, null, withBo, [bo])), false);
  // A team space: Cy is in the team, Bo isn't.
  const t = node("t", { space_id: "team" });
  assert.equal(agentMayFind(reach(t, {}, team, { kind: "people", user_ids: ["cy"] }, [cy])), true);
  assert.equal(agentMayFind(reach(t, {}, team, withBo, [bo])), false);
  // A link folio: only when everyone opened it.
  const link = node("l", { general_access: "link", general_role: "view" });
  assert.equal(agentMayFind(reach(link, {}, null, withBo, [bo], ["ana"])), false);
  assert.equal(agentMayFind(reach(link, {}, null, withBo, [bo], ["ana", "bo"])), true);
});

test("rule 1: the asker's own Private is theirs alone", () => {
  assert.equal(agentMayFind(reach(node("p"), {}, null, { kind: "asker" })), true);
  assert.equal(agentMayFind(reach(node("p"), {}, null, { kind: "people", user_ids: ["bo"] }, [bo])), false);
  // Someone else's Private: not even for its asker.
  assert.equal(agentMayFind(reach(node("p", { owner: "user:bo" }), {}, null, { kind: "asker" })), false);
});

test("rule 2: reading what the audience can't all read says so", () => {
  const r = reach(node("p"), {}, null, { kind: "workspace" });
  assert.equal(r.asker_role, "manage");
  assert.equal(r.audience_can_read, false);
  const fine = reach(node("o", { space_id: "open" }), {}, open, { kind: "workspace" });
  assert.equal(fine.audience_can_read, true);
});

test("an agent's grant never widens what it can do for its asker", () => {
  const n = node("f", { owner: "user:cy" });
  const grants = { f: [{ principal: "agent:ag1", role: "manage" as const }, { principal: "user:bo", role: "comment" as const }] };
  const r = reach(n, grants, null, { kind: "asker" }, [], [], bo);
  assert.equal(r.asker_role, "comment");
  assert.deepEqual(r.can, { read: true, suggest: true, edit: false });
  const none = reach(n, grants, null, { kind: "asker" }, [], [], ana);
  assert.equal(none.asker_role, null);
  assert.deepEqual(none.can, { read: false, suggest: false, edit: false });
  assert.equal(agentMayFind(none), false);
});
