import assert from "node:assert/strict";
import { test } from "node:test";

import { pageOf } from "./confirm-gate.ts";
import { NO_WORKSPACE_PATH, hasNoWorkspace, workspaceGate } from "./workspace-gate.ts";

const nobody = { kind: "user", verified: true, workspaces: [], grants: [], held: [] };
const member = { ...nobody, workspaces: [{ slug: "acme", role: "member" }] };

test("someone with no workspace is sent to make one or answer an invitation, never to Mission control", () => {
  assert.equal(workspaceGate("/", "", nobody), NO_WORKSPACE_PATH);
  // A data request for Mission control is gated too, so a client navigation never shows it.
  assert.equal(workspaceGate(pageOf("/_root.data"), "?_routes=routes%2Fhome", nobody), NO_WORKSPACE_PATH);
  // Where they were going comes back as `next`.
  assert.equal(workspaceGate("/acme/rocket", "?tab=pulls", nobody), `${NO_WORKSPACE_PATH}?next=${encodeURIComponent("/acme/rocket?tab=pulls")}`);
});

test("the pages someone without a workspace needs stay open", () => {
  for (const page of [NO_WORKSPACE_PATH, "/invitations", "/settings", "/settings/invites", "/logout", "/invite/g1t-k7m2", "/acme/rocket/invitations", "/inbox", "/u/ada", "/-/hovercard/user/ada"]) {
    assert.equal(workspaceGate(page, "", nobody), null, page);
  }
});

test("nobody else is gated: a member, an unconfirmed account, a repository collaborator, someone held by a policy, a visitor", () => {
  assert.equal(hasNoWorkspace(member), false);
  assert.equal(workspaceGate("/", "", member), null);
  assert.equal(workspaceGate("/", "", { ...nobody, verified: false }), null);
  assert.equal(workspaceGate("/", "", { ...nobody, grants: [{ repo: "acme/rocket" }] }), null);
  assert.equal(workspaceGate("/", "", { ...nobody, held: [{ slug: "acme" }] }), null);
  assert.equal(workspaceGate("/", "", { ...nobody, kind: "agent" }), null);
  assert.equal(workspaceGate("/", "", null), null);
});
