import assert from "node:assert/strict";
import { test } from "node:test";

import type { User } from "@g1t/contracts";

import { can, needs, permission } from "../../../packages/contracts/src/access.ts";
import { NEEDS, repoRef } from "./access.ts";

const row = (isPrivate: boolean) => ({ repo_id: "repo_api", repo_namespace: "acme", repo_private: isPrivate ? 1 : 0 });
const person = (extra: Partial<User>): User => ({ id: "u", username: "u", kind: "user", verified: true, workspaces: [], ...extra }) as User;

test("a private project is seen by those who can read its repository", () => {
  const none = person({ workspaces: [{ slug: "acme", role: "member", base_permission: "none" }] });
  assert.equal(permission(none, repoRef(row(true))), null, "a member with no base permission does not see it");
  assert.ok(permission(none, repoRef(row(false))), "but sees a public one");
  const granted = person({ workspaces: [{ slug: "acme", role: "member", base_permission: "none" }], grants: [{ repo_id: "repo_api", workspace: "acme", role: "read" }] });
  assert.equal(permission(granted, repoRef(row(true))), "read");
  const outside = person({ grants: [{ repo_id: "repo_api", workspace: "acme", role: "read" }] });
  assert.equal(permission(outside, repoRef(row(true))), "read", "an outside collaborator sees the project of a repository shared with them");
});

test("changing a project takes Maintain", () => {
  const member = person({ workspaces: [{ slug: "acme", role: "member" }] });
  assert.ok(!can(member, repoRef(row(true)), NEEDS.update), "Write, the default base permission, is not enough");
  assert.equal(needs(NEEDS.update), "Needs the Maintain role or higher.");
  const maintainer = person({ grants: [{ repo_id: "repo_api", workspace: "acme", role: "maintain" }] });
  for (const capability of [NEEDS.update, NEEDS.create]) assert.ok(can(maintainer, repoRef(row(true)), capability));
  const owner = person({ workspaces: [{ slug: "acme", role: "owner" }] });
  assert.ok(can(owner, repoRef(row(true)), NEEDS.create));
});
