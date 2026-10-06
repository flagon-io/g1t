import assert from "node:assert/strict";
import { test } from "node:test";

import type { Project, User } from "@g1t/contracts";

import { can, needs, permission } from "../../../packages/contracts/src/access.ts";
import { NEEDS, repoRef, type Method } from "./access.ts";

const project = (isPrivate: boolean): Project => ({
  id: "prj_1",
  workspace: "acme",
  slug: "web",
  name: "web",
  description: null,
  source: { kind: "hosted", repoId: "repo_web", repo: { namespace: "acme", name: "web" }, rootDir: "", defaultBranch: "main" },
  private: isPrivate,
  archived: false,
  primary: true,
  createdBy: "ada",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});

const person = (extra: Partial<User>): User => ({ id: "u", username: "u", kind: "user", verified: true, workspaces: [], ...extra }) as User;
const collaborator = (role: "read" | "write" | "admin") => person({ grants: [{ repo_id: "repo_web", workspace: "acme", role }] });

const allowed = (viewer: User | null, method: Method, isPrivate = true) => can(viewer, repoRef(project(isPrivate)), NEEDS[method]);

test("a Read collaborator sees a project's deployments but cannot deploy or change them", () => {
  const reader = collaborator("read");
  for (const method of ["settings", "list", "get", "listDomains"] as const) assert.ok(allowed(reader, method), method);
  for (const method of ["redeploy", "stack", "takeDown", "updateSettings", "addDomain"] as const) assert.ok(!allowed(reader, method), method);
  assert.equal(needs(NEEDS.redeploy), "Needs the Write role or higher.");
});

test("an outside collaborator with Write can deploy, but settings and domains need Admin", () => {
  const writer = collaborator("write");
  assert.ok(allowed(writer, "redeploy"));
  assert.ok(allowed(writer, "takeDown"));
  assert.ok(!allowed(writer, "updateSettings"));
  assert.ok(!allowed(writer, "addDomain"));
  assert.equal(needs(NEEDS.addDomain), "Needs the Admin role or higher.");
  assert.ok(allowed(collaborator("admin"), "addDomain"));
});

test("members follow the workspace's base permission; owners manage everything", () => {
  const member = person({ workspaces: [{ slug: "acme", role: "member" }] });
  assert.ok(allowed(member, "redeploy"), "Write by default");
  assert.ok(!allowed(member, "updateSettings"));
  const none = person({ workspaces: [{ slug: "acme", role: "member", base_permission: "none" }] });
  assert.equal(permission(none, repoRef(project(true))), null, "a private project is not found");
  const owner = person({ workspaces: [{ slug: "acme", role: "owner" }] });
  assert.ok(allowed(owner, "updateSettings"));
});

test("anyone can see a public project's deployments, and no more", () => {
  assert.ok(allowed(null, "list", false));
  assert.ok(!allowed(null, "redeploy", false));
  assert.equal(permission(null, repoRef(project(true))), null);
});
