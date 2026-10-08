import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountWentSummary,
  confirmsUsername,
  deletedWithAccount,
  soleOwnerNote,
  soleWorkspacesRefusal,
  staffDeleteProblem,
  staffDeletionRefusal,
} from "./deleted-accounts.ts";

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

const sole = (slug: string) => ({ slug, name: slug, members: 1, billing: null, protected: false });

const went = { workspaces: 2, teams: 1, repositories: 3, tokens: 1, sshKeys: 2, staff: null, reason: null, deletedWorkspaces: [] };

test("what went reads as one line", () => {
  assert.equal(accountWentSummary(went), "2 workspaces, 1 team, 3 repositories, 1 token, 2 SSH keys");
});

test("only a protected account is refused outright", () => {
  assert.equal(staffDeletionRefusal(deletion), null);
  const owner = { ...deletion, sole_owner_of: [sole("acme")] };
  assert.equal(staffDeletionRefusal(owner), null);
  assert.equal(
    staffDeletionRefusal({ ...owner, username: "g1t", protected: true }),
    "g1t is protected and can never be deleted.",
  );
});

test("workspaces it owns alone go with it, said up front", () => {
  assert.equal(soleOwnerNote(deletion), null);
  assert.match(soleOwnerNote({ ...deletion, sole_owner_of: [sole("ada")] })!, /^ada is the only owner of 1 workspace\. Deleting the account deletes it first/);
  assert.match(soleOwnerNote({ ...deletion, sole_owner_of: [sole("a"), sole("b")] })!, /of 2 workspaces\. Deleting the account deletes them first/);
  assert.equal(soleWorkspacesRefusal({ ...deletion, sole_owner_of: [sole("ada")] }), null);
});

test("a protected workspace or billing that cannot settle stops it, naming which", () => {
  const owner = {
    ...deletion,
    sole_owner_of: [
      sole("ada"),
      { ...sole("flagon-io"), protected: true },
      { ...sole("ada-labs"), billing: "ada-labs has an unpaid invoice. Pay it from the workspace's Billing page first." },
    ],
  };
  assert.equal(
    soleWorkspacesRefusal(owner),
    "ada cannot be deleted with its workspaces yet. flagon-io is protected and can never be deleted. ada-labs has an unpaid invoice. Pay it from the workspace's Billing page first.",
  );
});

test("staff confirm with the username", () => {
  assert.ok(confirmsUsername("ada", " ADA "));
  assert.ok(!confirmsUsername("ada", ""));
  assert.ok(!confirmsUsername("ada", "grace"));
});

test("the form needs a reason, the username, and the box ticked when workspaces go too", () => {
  const form = { username: "ada", reason: "Retired test account", confirm: "ada", withWorkspaces: false, acknowledged: false };
  assert.equal(staffDeleteProblem(form), null);
  assert.equal(staffDeleteProblem({ ...form, reason: "" }), "Say why the account is being deleted.");
  assert.equal(staffDeleteProblem({ ...form, confirm: "grace" }), "Type ada to confirm.");
  assert.equal(
    staffDeleteProblem({ ...form, withWorkspaces: true }),
    "Tick the box to say the workspaces it alone owns are deleted too.",
  );
  assert.equal(staffDeleteProblem({ ...form, withWorkspaces: true, acknowledged: true }), null);
});

test("workspaces deleted with the account are matched to their deletions", () => {
  const waiting = {
    workspaceId: "wsp_1",
    slug: "ada",
    name: "Ada",
    deletedAt: "2026-10-08T00:00:00.000Z",
    deletedBy: "staff@g1t.sh",
    purgeAfter: "2026-11-07T00:00:00.000Z",
    went: { repositories: 1, projects: 0, members: 1, billing: null, protected: false },
    restorable: true,
  };
  const gone = deletedWithAccount(
    { ...went, deletedWorkspaces: [{ workspaceId: "wsp_1", slug: "ada" }, { workspaceId: "wsp_2", slug: "ada-labs" }] },
    [waiting],
  );
  assert.deepEqual(gone, [
    { workspaceId: "wsp_1", slug: "ada", deleted: waiting },
    { workspaceId: "wsp_2", slug: "ada-labs", deleted: null },
  ]);
  assert.deepEqual(deletedWithAccount(went, [waiting]), []);
});
