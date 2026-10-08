import assert from "node:assert/strict";
import { test } from "node:test";

import { accountDeletionRefusal, confirmsUsername, whatAccountDeletionTakes } from "./account-deletion.ts";

const nothing = {
  username: "ada",
  workspaces: 0,
  tokens: 0,
  ssh_keys: 0,
  applications: 0,
  repositories: 0,
  sole_owner_of: [],
  protected: false,
};

const sole = (slug: string) => ({ slug, name: slug, members: 3, billing: null, protected: false });

test("the dialog lists only what the account has", () => {
  assert.deepEqual(whatAccountDeletionTakes(nothing), []);
  assert.deepEqual(
    whatAccountDeletionTakes({ ...nothing, workspaces: 2, repositories: 1, tokens: 3, ssh_keys: 1, applications: 2 }),
    [
      "Your membership of 2 workspaces",
      "Your role on 1 repository you were added to",
      "3 access tokens",
      "1 SSH key",
      "2 connected applications",
    ],
  );
  assert.deepEqual(whatAccountDeletionTakes({ ...nothing, workspaces: 1, tokens: 1 }), [
    "Your membership of 1 workspace",
    "1 access token",
  ]);
});

test("owning a workspace alone stands in the way, and names it", () => {
  assert.equal(accountDeletionRefusal(null), null);
  assert.equal(accountDeletionRefusal({ ...nothing, workspaces: 4 }), null);
  assert.equal(
    accountDeletionRefusal({ ...nothing, sole_owner_of: [sole("acme")] }),
    "You are the only owner of acme. Make someone else an owner of it, or delete it, first.",
  );
  assert.equal(
    accountDeletionRefusal({ ...nothing, sole_owner_of: [sole("acme"), sole("globex"), sole("initech")] }),
    "You are the only owner of acme, globex and initech. Make someone else an owner of each, or delete them, first.",
  );
});

test("a protected account says so first", () => {
  assert.equal(
    accountDeletionRefusal({ ...nothing, username: "g1t", protected: true, sole_owner_of: [sole("acme")] }),
    "g1t is protected and can never be deleted.",
  );
});

test("only the username itself confirms", () => {
  assert.ok(confirmsUsername("ada", " Ada "));
  assert.ok(!confirmsUsername("ada", ""));
  assert.ok(!confirmsUsername("ada", "  "));
  assert.ok(!confirmsUsername("ada", "ada-l"));
});
