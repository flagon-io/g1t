import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aclChain,
  aclRootOf,
  agentAbilities,
  agentFolioRole,
  canShare,
  effectiveRole,
  explicitAccess,
  folioPathOf,
  folioReadableByAll,
  folioReadableByWorkspace,
  folioScope,
  generalRoleCap,
  inheritsSpace,
  isPrivateFolio,
  materialize,
  roleOf,
  type FolioAclNode,
  type FolioGrant,
  type Person,
  type SpaceRules,
} from "./access.ts";

// People: Ana (team web), Bo (no team), Cy (team design), Wes (workspace owner).
const ana: Person = { user_id: "ana", owner: false, teams: new Set(["web"]) };
const bo: Person = { user_id: "bo", owner: false, teams: new Set() };
const cy: Person = { user_id: "cy", owner: false, teams: new Set(["design"]) };
const wes: Person = { user_id: "wes", owner: true, teams: new Set() };

// Spaces.
const open: SpaceRules = { kind: "workspace", team: null, default_role: "edit", members: [] };
const openView: SpaceRules = { kind: "workspace", team: null, default_role: "view", members: [] };
const team: SpaceRules = { kind: "team", team: "web", default_role: "comment", members: [] };
const membersOnly: SpaceRules = { kind: "private", team: null, default_role: null, members: [{ principal: "user:cy", role: "manage" }] };
const SPACES: Record<string, SpaceRules> = { open, openView, team, membersOnly };

function node(id: string, over: Partial<FolioAclNode> = {}): FolioAclNode {
  return { id, owner: "user:ana", parent_id: null, space_id: null, inherit: true, general_access: "none", general_role: null, created_at: "2026-10-01T00:00:00Z", ...over };
}

/** The role a person has on `id`, given every node and grant. */
function roleIn(nodes: FolioAclNode[], grants: Record<string, FolioGrant[]>, id: string, person: Person, visited = false) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain = aclChain(id, byId);
  const root = chain[chain.length - 1]!;
  const space = root.space_id ? SPACES[root.space_id]! : null;
  return effectiveRole(chain, new Map(Object.entries(grants)), space ? roleOf(space, person) : null, person, { visited });
}

test("private: only the owner, and not the workspace owner", () => {
  const nodes = [node("f")];
  assert.equal(roleIn(nodes, {}, "f", ana), "manage");
  assert.equal(roleIn(nodes, {}, "f", bo), null);
  assert.equal(roleIn(nodes, {}, "f", wes), null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(isPrivateFolio(aclChain("f", byId), new Map()), true);
});

test("an open space gives every member its base role; owners manage", () => {
  const nodes = [node("f", { space_id: "open", owner: "user:cy" })];
  assert.equal(roleIn(nodes, {}, "f", ana), "edit");
  assert.equal(roleIn(nodes, {}, "f", bo), "edit");
  assert.equal(roleIn(nodes, {}, "f", cy), "manage");
  assert.equal(roleIn(nodes, {}, "f", wes), "manage");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(isPrivateFolio(aclChain("f", byId), new Map()), false);
});

test("a team space: its team gets the base role; others nothing; workspace owners manage", () => {
  const nodes = [node("f", { space_id: "team", owner: "user:cy" })];
  assert.equal(roleIn(nodes, {}, "f", ana), "comment");
  assert.equal(roleIn(nodes, {}, "f", bo), null);
  assert.equal(roleIn(nodes, {}, "f", wes), "manage");
});

test("a members-only space: only its members, never the workspace owner", () => {
  const nodes = [node("f", { space_id: "membersOnly", owner: "user:cy" })];
  assert.equal(roleIn(nodes, {}, "f", cy), "manage");
  assert.equal(roleIn(nodes, {}, "f", ana), null);
  assert.equal(roleIn(nodes, {}, "f", wes), null);
});

test("grants to a person, an agent and a team", () => {
  const nodes = [node("f")];
  const grants = { f: [{ principal: "user:bo", role: "comment" as const }, { principal: "team:design", role: "edit" as const }, { principal: "agent:ag1", role: "edit" as const }] };
  assert.equal(roleIn(nodes, grants, "f", bo), "comment");
  assert.equal(roleIn(nodes, grants, "f", cy), "edit");
  // An agent grant gives no person anything.
  assert.equal(roleIn(nodes, grants, "f", wes), null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(isPrivateFolio(aclChain("f", byId), new Map(Object.entries(grants))), false);
});

test("a grant raises a space role but never lowers it", () => {
  const nodes = [node("f", { space_id: "openView", owner: "user:cy" })];
  assert.equal(roleIn(nodes, { f: [{ principal: "user:bo", role: "edit" }] }, "f", bo), "edit");
  assert.equal(roleIn(nodes, { f: [{ principal: "user:ana", role: "view" }] }, "f", ana), "view");
  const open2 = [node("f", { space_id: "open", owner: "user:cy" })];
  assert.equal(roleIn(open2, { f: [{ principal: "user:ana", role: "view" }] }, "f", ana), "edit");
});

test("general access: workspace gives every member its role, never manage", () => {
  const nodes = [node("f", { general_access: "workspace", general_role: "comment" })];
  assert.equal(roleIn(nodes, {}, "f", bo), "comment");
  assert.equal(roleIn(nodes, {}, "f", wes), "comment");
  const capped = [node("f", { general_access: "workspace", general_role: "manage" })];
  assert.equal(roleIn(capped, {}, "f", bo), "edit");
  assert.equal(generalRoleCap(null), "view");
});

test("general access: link gives its role only to people who opened it", () => {
  const nodes = [node("f", { general_access: "link", general_role: "view" })];
  assert.equal(roleIn(nodes, {}, "f", bo), null);
  assert.equal(roleIn(nodes, {}, "f", bo, true), "view");
});

test("nested docs inherit their parent's grants, space and general access", () => {
  const nodes = [
    node("top", { space_id: "team", owner: "user:cy" }),
    node("mid", { space_id: "team", owner: "user:cy", parent_id: "top" }),
    node("leaf", { space_id: "team", owner: "user:cy", parent_id: "mid" }),
  ];
  const grants = { top: [{ principal: "user:bo", role: "view" as const }] };
  assert.equal(roleIn(nodes, grants, "leaf", ana), "comment");
  assert.equal(roleIn(nodes, grants, "leaf", bo), "view");
  assert.equal(roleIn(nodes, grants, "leaf", wes), "manage");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.deepEqual(
    aclChain("leaf", byId).map((n) => n.id),
    ["leaf", "mid", "top"],
  );
  assert.equal(inheritsSpace(aclChain("leaf", byId)), true);
});

test("a parent's owner keeps full access to what others add under it", () => {
  const nodes = [node("top"), node("child", { parent_id: "top", owner: "user:bo" })];
  assert.equal(roleIn(nodes, {}, "child", ana), "manage");
  assert.equal(roleIn(nodes, {}, "child", bo), "manage");
  assert.equal(roleIn(nodes, {}, "child", cy), null);
});

test("restricting stops the space, the parent's grants and general access", () => {
  const nodes = [
    node("top", { space_id: "open", owner: "user:cy", general_access: "workspace", general_role: "view" }),
    node("secret", { space_id: "open", owner: "user:cy", parent_id: "top", inherit: false }),
    node("under", { space_id: "open", owner: "user:cy", parent_id: "secret" }),
  ];
  const grants = { top: [{ principal: "user:bo", role: "edit" as const }], secret: [{ principal: "user:ana", role: "comment" as const }] };
  assert.equal(roleIn(nodes, grants, "secret", bo), null);
  assert.equal(roleIn(nodes, grants, "secret", ana), "comment");
  assert.equal(roleIn(nodes, grants, "under", ana), "comment");
  assert.equal(roleIn(nodes, grants, "under", wes), null);
  assert.equal(roleIn(nodes, grants, "under", cy), "manage");
  // A restricted top-level folio in a space leaves the space's people out too.
  const top = [node("t", { space_id: "open", owner: "user:cy", inherit: false })];
  assert.equal(roleIn(top, {}, "t", ana), null);
  assert.equal(roleIn(top, {}, "t", wes), null);
});

test("the access root and path of a new folio", () => {
  assert.equal(aclRootOf({ id: "a", inherit: true, parent_id: null }, null), "a");
  assert.equal(aclRootOf({ id: "b", inherit: true, parent_id: "a" }, "a"), "a");
  assert.equal(aclRootOf({ id: "c", inherit: false, parent_id: "b" }, "a"), "c");
  assert.equal(folioPathOf("a", null), "/a/");
  assert.equal(folioPathOf("b", "/a/"), "/a/b/");
});

test("materialize writes the owner, ancestor owners and grants up to the access root, highest role each", () => {
  const nodes = [
    node("top", { owner: "user:ana" }),
    node("child", { parent_id: "top", owner: "user:bo" }),
    node("restricted", { parent_id: "child", owner: "user:bo", inherit: false }),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const grants = new Map<string, FolioGrant[]>([
    ["top", [{ principal: "user:cy", role: "view", granted_at: "2026-10-02T00:00:00Z" }]],
    ["child", [{ principal: "user:cy", role: "edit", granted_at: "2026-10-03T00:00:00Z" }]],
  ]);
  const rows = materialize(["top", "child", "restricted"], byId, grants);
  const of = (id: string) => Object.fromEntries(rows.filter((r) => r.folio_id === id).map((r) => [r.principal, `${r.role}@${r.via}`]));
  assert.deepEqual(of("top"), { "user:ana": "manage@owner", "user:cy": "view@top" });
  assert.deepEqual(of("child"), { "user:bo": "manage@owner", "user:cy": "edit@child", "user:ana": "manage@top" });
  assert.deepEqual(of("restricted"), { "user:bo": "manage@owner" });
  assert.equal(explicitAccess(aclChain("child", byId), grants).get("user:cy")?.since, "2026-10-03T00:00:00Z");
});

test("the index scope is the space's only when access is exactly the space's", () => {
  const byId = (nodes: FolioAclNode[]) => new Map(nodes.map((n) => [n.id, n]));
  const plain = byId([node("a", { space_id: "open" })]);
  assert.equal(folioScope(aclChain("a", plain), new Map()), "space:open");
  assert.equal(folioScope(aclChain("a", plain), new Map([["a", [{ principal: "user:bo", role: "view" }]]])), "folio:a");
  const general = byId([node("a", { space_id: "open", general_access: "workspace", general_role: "view" })]);
  assert.equal(folioScope(aclChain("a", general), new Map()), "folio:a");
  const nested = byId([node("a", { space_id: "open" }), node("b", { space_id: "open", parent_id: "a", owner: "user:bo" })]);
  assert.equal(folioScope(aclChain("b", nested), new Map()), "space:open");
  const restricted = byId([node("a", { space_id: "open" }), node("b", { space_id: "open", parent_id: "a", inherit: false })]);
  assert.equal(folioScope(aclChain("b", restricted), new Map()), "folio:b");
  const priv = byId([node("p")]);
  assert.equal(folioScope(aclChain("p", priv), new Map()), "folio:p");
});

test("readable by the whole workspace: open spaces and workspace general access only", () => {
  const byId = (nodes: FolioAclNode[]) => new Map(nodes.map((n) => [n.id, n]));
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a", { space_id: "open" })])), open), true);
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a", { space_id: "team" })])), team), false);
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a", { space_id: "membersOnly" })])), membersOnly), false);
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a")])), null), false);
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a", { general_access: "workspace", general_role: "view" })])), null), true);
  // A link is never the workspace's, even for people who opened it.
  assert.equal(folioReadableByWorkspace(aclChain("a", byId([node("a", { general_access: "link", general_role: "view" })])), null), false);
  // Restricted inside an open space: not the workspace's.
  const restricted = byId([node("a", { space_id: "open" }), node("b", { space_id: "open", parent_id: "a", inherit: false })]);
  assert.equal(folioReadableByWorkspace(aclChain("b", restricted), open), false);
});

test("readable by an audience only when every person in it can read", () => {
  const nodes = new Map([["f", node("f", { owner: "user:ana" })]]);
  const chain = aclChain("f", nodes);
  const grants = new Map([["f", [{ principal: "user:bo", role: "view" as const }]]]);
  assert.equal(folioReadableByAll(chain, grants, null, [ana, bo]), true);
  assert.equal(folioReadableByAll(chain, grants, null, [ana, bo, cy]), false);
  const link = new Map([["l", node("l", { general_access: "link", general_role: "view" })]]);
  assert.equal(folioReadableByAll(aclChain("l", link), new Map(), null, [ana, bo]), false);
  assert.equal(
    folioReadableByAll(aclChain("l", link), new Map(), null, [ana, bo], (p) => p.user_id === "bo"),
    true,
  );
});

test("an agent is capped by its asker and narrowed by its audience", () => {
  // The agent holds an edit grant, its asker only view: it may only read.
  const nodes = [node("f", { owner: "user:cy" })];
  const grants = { f: [{ principal: "agent:ag1", role: "edit" as const }, { principal: "user:bo", role: "view" as const }] };
  const asker = roleIn(nodes, grants, "f", bo);
  assert.equal(asker, "view");
  assert.equal(agentFolioRole(asker, true), "view");
  assert.deepEqual(agentAbilities(agentFolioRole(asker, true), "edit"), { read: true, suggest: false, edit: false });
  // Someone in the conversation can't read it: the agent can't either.
  assert.equal(agentFolioRole("manage", false), null);
  // Someone who can't read it gets nothing from the agent's grant.
  assert.equal(agentFolioRole(roleIn(nodes, grants, "f", ana), true), null);
});

test("who may share", () => {
  assert.equal(canShare("manage"), true);
  assert.equal(canShare("edit"), false);
  assert.equal(canShare("edit", true), true);
  assert.equal(canShare(null, true), false);
});
