import assert from "node:assert/strict";
import { test } from "node:test";

import { accountWentSummary, confirmsUsername, staffDeletionRefusal } from "./deleted-accounts.ts";

const deletion = {
  username: "ada",
  workspaces: 2,
  tokens: 1,
  ssh_keys: 0,
  applications: 0,
  repositories: 0,
  sole_owner_of: [],
  protected: false,
};

test("what went reads as one line", () => {
  assert.equal(
    accountWentSummary({ workspaces: 2, teams: 1, repositories: 3, tokens: 1, sshKeys: 2, staff: null, reason: null }),
    "2 workspaces, 1 team, 3 repositories, 1 token, 2 SSH keys",
  );
});

test("an account that owns workspaces alone, or is protected, is refused", () => {
  assert.equal(staffDeletionRefusal(deletion), null);
  const owner = { ...deletion, sole_owner_of: [{ slug: "acme", name: "Acme", members: 3, billing: null }] };
  assert.equal(
    staffDeletionRefusal(owner),
    "ada is the only owner of 1 workspace. Each needs another owner, or to be deleted by its owner, first.",
  );
  assert.equal(
    staffDeletionRefusal({ ...owner, username: "g1t", protected: true }),
    "g1t is protected and can never be deleted.",
  );
});

test("staff confirm with the username", () => {
  assert.ok(confirmsUsername("ada", " ADA "));
  assert.ok(!confirmsUsername("ada", ""));
  assert.ok(!confirmsUsername("ada", "grace"));
});
