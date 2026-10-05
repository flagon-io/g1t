import assert from "node:assert/strict";
import { test } from "node:test";

import type { AccountSummary, AdminWorkspace, Limit, Terms } from "@g1t/contracts";

import { STANDARD_TERMS, joinWorkspaces, legacyAccountPath, paginate } from "./workspaces.ts";

function limit(workspace: string, account: string, exposureMicros = 0): Limit {
  return {
    workspace,
    account,
    accountName: account,
    trust: "new",
    exposureMicros,
    ceilingMicros: 10_000_000,
    trustCeilingMicros: 10_000_000,
    spendLimitMicros: null,
    state: "ok",
    message: null,
  };
}

function workspace(slug: string, owner = `${slug}-owner`): AdminWorkspace {
  return {
    slug,
    name: slug.toUpperCase(),
    createdAt: "2026-10-01T00:00:00Z",
    owners: [{ username: owner, email: `${owner}@example.com` }],
    memberCount: 1,
  };
}

const COMPED: Terms = { ...STANDARD_TERMS, kind: "comped", note: "g1t's own" };

const OWN: AccountSummary = {
  account: { id: "ws_syntaqx", kind: "workspace", name: "syntaqx", terms: COMPED, workspaces: ["syntaqx"], createdAt: "2026-10-05T00:00:00Z" },
  limit: limit("syntaqx", "ws_syntaqx", 3_000_000),
  chargedMicros: 0,
  costMicros: 3_000_000,
  paidMicros: 0,
  byWorkspace: [{ workspace: "syntaqx", chargedMicros: 0, costMicros: 3_000_000, paidMicros: 0 }],
};

const ACME: AccountSummary = {
  account: { id: "ent_acme", kind: "enterprise", name: "Acme Corp", terms: STANDARD_TERMS, workspaces: ["acme", "acme-labs"], createdAt: "2026-10-02T00:00:00Z" },
  limit: limit("acme", "ent_acme", 9_000_000),
  chargedMicros: 12_000_000,
  costMicros: 6_000_000,
  paidMicros: 0,
  byWorkspace: [
    { workspace: "acme", chargedMicros: 12_000_000, costMicros: 6_000_000, paidMicros: 0 },
    { workspace: "acme-labs", chargedMicros: 0, costMicros: 0, paidMicros: 0 },
  ],
};

test("every workspace is listed, with or without billing", () => {
  const rows = joinWorkspaces([workspace("syntaqx"), workspace("quiet")], [OWN]);
  assert.deepEqual(
    rows.map((row) => row.slug),
    ["syntaqx", "quiet"],
  );
  const [syntaqx, quiet] = rows;
  assert.equal(syntaqx.billing.terms.kind, "comped");
  assert.equal(syntaqx.billing.costMicros, 3_000_000);
  assert.equal(syntaqx.billing.billedTo, null);
  assert.equal(quiet.billing.terms.kind, "standard");
  assert.equal(quiet.billing.limit, null);
  assert.equal(quiet.billing.chargedMicros, 0);
});

test("a workspace on an enterprise shows the enterprise and only its own share", () => {
  const rows = joinWorkspaces([workspace("acme"), workspace("acme-labs")], [ACME]);
  const labs = rows.find((row) => row.slug === "acme-labs");
  assert.deepEqual(labs?.billing.billedTo, { id: "ent_acme", name: "Acme Corp" });
  assert.equal(labs?.billing.chargedMicros, 0);
  assert.equal(labs?.billing.limit?.exposureMicros, 9_000_000);
  assert.equal(rows.find((row) => row.slug === "acme")?.billing.chargedMicros, 12_000_000);
});

test("a page lists only its own workspaces, not the rest of an enterprise", () => {
  const rows = joinWorkspaces([workspace("acme")], [ACME]);
  assert.deepEqual(
    rows.map((row) => row.slug),
    ["acme"],
  );
});

test("pages stay within the list", () => {
  const items = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(paginate(items, null).items.slice(0, 2), [0, 1]);
  const third = paginate(items, "3");
  assert.equal(third.page, 3);
  assert.equal(third.pages, 3);
  assert.equal(third.items.length, 20);
  assert.equal(paginate(items, "99").page, 3);
  assert.equal(paginate(items, "-4").page, 1);
  assert.equal(paginate(items, "abc").page, 1);
  assert.deepEqual(paginate([], "2"), { page: 1, pages: 1, items: [] });
});

test("old account links go to the workspace or the enterprise", () => {
  assert.equal(legacyAccountPath("ws_syntaqx"), "/workspaces/syntaqx");
  assert.equal(legacyAccountPath("syntaqx"), "/workspaces/syntaqx");
  assert.equal(legacyAccountPath("ent_01abc"), "/enterprises/ent_01abc");
  assert.equal(legacyAccountPath("ws_"), null);
  assert.equal(legacyAccountPath("../etc"), null);
});
