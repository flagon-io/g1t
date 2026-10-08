import assert from "node:assert/strict";
import { test } from "node:test";

import { PERMISSIONS } from "@g1t/contracts/fine-grained";

import {
  accessLabel,
  expiryChoices,
  fineGrainedFromForm,
  lifetimeFromForm,
  permissionChips,
  permissionsFor,
  policyNote,
  reachSummary,
  statusBadge,
} from "./fine-grained.ts";

function form(fields: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const value = fields[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    getAll: (name: string) => {
      const value = fields[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    },
  };
}

const policy = { allowClassic: true, allowFineGrained: true, requireApproval: true, maxLifetimeDays: null, forbidNoExpiry: false };

test("a workspace's token reads its form into permissions, always with metadata", () => {
  const parsed = fineGrainedFromForm(
    form({
      name: "release bot",
      owner: "Acme",
      expires: "30",
      repository_selection: "selected",
      repo: ["web", "acme/api", "web"],
      "perm.contents": "write",
      "perm.issues": "none",
      "perm.workflows": "write",
      // Not for a workspace: left out.
      "perm.email_addresses": "write",
    }),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.value.workspace, "acme");
  assert.equal(parsed.value.ttlSeconds, 30 * 86_400);
  assert.deepEqual(parsed.value.repositories, ["web", "acme/api"]);
  assert.deepEqual(parsed.value.permissions, { contents: "write", workflows: "write", metadata: "read" });
});

test("your own account takes only account permissions and no repositories", () => {
  const parsed = fineGrainedFromForm(form({ name: "inbox", owner: "", expires: "7", "perm.notifications": "write", "perm.contents": "write" }));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.workspace, null);
  assert.equal(parsed.value.repositorySelection, "public");
  assert.deepEqual(parsed.value.permissions, { notifications: "write" });
  assert.equal(fineGrainedFromForm(form({ name: "x", owner: "", expires: "7" })).ok, false, "at least one permission");
});

test("mistakes are named", () => {
  assert.match((fineGrainedFromForm(form({ owner: "acme" })) as { error: string }).error, /Name/);
  assert.match((fineGrainedFromForm(form({ name: "x", owner: "acme", expires: "400" })) as { error: string }).error, /366/);
  assert.match((fineGrainedFromForm(form({ name: "x", owner: "acme", expires: "30", repository_selection: "selected" })) as { error: string }).error, /repository/);
  assert.match((fineGrainedFromForm(form({ name: "x", owner: "acme", expires: "30", "perm.workflows": "read" })) as { error: string }).error, /Workflows/);
});

test("the form offers each group to the right resource owner", () => {
  assert.ok(permissionsFor(true).every((permission) => permission.group !== "account"));
  assert.ok(permissionsFor(false).every((permission) => permission.group === "account"));
  assert.equal(permissionsFor(true).length + permissionsFor(false).length, PERMISSIONS.length);
  assert.equal(accessLabel("write", PERMISSIONS.find((p) => p.name === "workflows")), "Write");
  assert.equal(accessLabel("write", PERMISSIONS.find((p) => p.name === "contents")), "Read and write");
});

test("lifetimes follow the workspace's rules", () => {
  assert.deepEqual(expiryChoices(null), [7, 30, 60, 90, 180, 366]);
  assert.deepEqual(expiryChoices({ ...policy, maxLifetimeDays: 90 }), [7, 30, 60, 90]);
  assert.deepEqual(expiryChoices({ ...policy, maxLifetimeDays: 45 }), [7, 30, 45]);
  assert.deepEqual(lifetimeFromForm(""), { ok: true, value: null });
  assert.deepEqual(lifetimeFromForm("90"), { ok: true, value: 90 });
  assert.equal(lifetimeFromForm("0").ok, false);
});

test("lists read a fine-grained token in a line", () => {
  const token = {
    id: "tok_1", name: "ci", createdAt: "", lastUsedAt: null, createdBy: null, scopes: [], legacy: false, expiresAt: null,
    fineGrained: { workspace: "acme", repositorySelection: "selected" as const, repositories: ["acme/web", "acme/api"], permissions: { metadata: "read" as const, issues: "read" as const, contents: "write" as const }, status: "pending" as const },
  };
  assert.equal(reachSummary(token), "acme · 2 repositories");
  assert.deepEqual(permissionChips(token.fineGrained.permissions), ["Contents: write", "Issues: read"]);
  assert.deepEqual(statusBadge("pending"), { label: "Pending approval", tone: "warn" });
  assert.equal(statusBadge("active"), null);
  assert.match(policyNote("acme", policy, false) ?? "", /must approve/);
  assert.equal(policyNote("acme", policy, true), null, "owners' own tokens never wait");
  assert.match(policyNote("acme", { ...policy, allowFineGrained: false }, true) ?? "", /does not allow/);
});
