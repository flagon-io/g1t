import assert from "node:assert/strict";
import { test } from "node:test";

import { SCOPE_RESOURCES, permissionsOf, scopesOfPermissions } from "@g1t/contracts/scopes";

import {
  changesTo,
  currentTokensPath,
  expiryChoices,
  keptOutOfAll,
  levelLabel,
  lifetimeFromForm,
  permissionChips,
  permissionGroups,
  policyNote,
  reachSummary,
  resourcesFor,
  statusBadge,
  tokenFromForm,
} from "./access-tokens.ts";

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

const policy = {
  allowTokensForAllWorkspaces: true,
  allowTokensForThisWorkspace: true,
  requireApproval: true,
  maxLifetimeDays: null,
  forbidNoExpiry: false,
};

test("a token made for one workspace reads its reach, repositories and permissions", () => {
  const parsed = tokenFromForm(
    form({
      name: "release bot",
      workspace: "Acme",
      expires: "30",
      repository_selection: "selected",
      repo: ["web", "acme/api", "web"],
      "perm.code": "write",
      "perm.issues": "none",
      "perm.workflow_files": "write",
      "perm.packages": "delete",
    }),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.value.workspace, "acme");
  assert.equal(parsed.value.ttlSeconds, 30 * 86_400);
  assert.deepEqual(parsed.value.repositories, ["web", "acme/api"]);
  assert.deepEqual(parsed.value.permissions, { code: "write", workflow_files: "write", packages: "delete" });
});

test("a token reaches every workspace, or none, and may never expire", () => {
  const all = tokenFromForm(form({ name: "laptop", workspace: "*", expires: "never", "perm.repo": "read", repository_selection: "selected" }));
  assert.ok(all.ok);
  assert.equal(all.value.workspace, null);
  assert.equal(all.value.repositorySelection, "all", "only a token for one workspace selects repositories");
  assert.equal(all.value.ttlSeconds, null);
  const none = tokenFromForm(form({ name: "inbox", workspace: "-", expires: "7", "perm.notifications": "write" }));
  assert.ok(none.ok);
  assert.equal(none.value.workspace, null);
  assert.equal(none.value.repositorySelection, "public");
});

test("a workspace's own token holds nothing about a person, and reaches all or selected repositories", () => {
  const parsed = tokenFromForm(
    form({ name: "deploy", expires: "90", repository_selection: "public", "perm.code": "write", "perm.notifications": "write" }),
    { workspaceOwned: true, owner: "acme" },
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.value.owner, "acme");
  assert.equal(parsed.value.repositorySelection, "all");
  assert.deepEqual(parsed.value.permissions, { code: "write" });
  assert.ok(resourcesFor(true).every((row) => row.group !== "account"));
  assert.equal(resourcesFor(false).length, SCOPE_RESOURCES.length);
  assert.ok(permissionGroups(true).every((group) => group.group !== "account"));
});

test("editing reads neither the expiry nor needs a name", () => {
  const parsed = tokenFromForm(form({ expires: "9999", "perm.issues": "read" }), { editing: true });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.name, "");
});

test("mistakes are named", () => {
  const error = (fields: Record<string, string | string[]>) => (tokenFromForm(form(fields)) as { ok: false; error: string }).error;
  assert.match(error({ workspace: "acme" }), /Name/);
  assert.match(error({ name: "x", expires: "400", "perm.repo": "read" }), /366/);
  assert.match(error({ name: "x", workspace: "acme", repository_selection: "selected", "perm.repo": "read" }), /repository/);
  assert.match(error({ name: "x", "perm.workflow_files": "read" }), /Workflow files/);
  assert.match(error({ name: "x", "perm.issues": "admin" }), /Issues/);
  assert.match(error({ name: "x" }), /at least one permission/);
});

test("permissions are scopes read per resource", () => {
  assert.deepEqual(permissionsOf(["repo:read", "repo:admin", "issues:write", "bogus"]), { repo: "admin", issues: "write" });
  assert.deepEqual(scopesOfPermissions({ issues: "write", repo: "read" }), ["repo:read", "issues:write"]);
  assert.equal(Object.keys(permissionsOf(null)).length, SCOPE_RESOURCES.length, "full access is every resource");
  assert.equal(levelLabel("workflow_files", "write"), "Write");
  assert.equal(levelLabel("issues", "write"), "Read and write");
  assert.equal(levelLabel("packages", "delete"), "Read, write and delete");
});

test("lifetimes follow the rules of every workspace a token reaches", () => {
  assert.deepEqual(expiryChoices([null]), { days: [7, 30, 60, 90, 180, 366], never: true });
  assert.deepEqual(expiryChoices([{ ...policy, maxLifetimeDays: 90 }]), { days: [7, 30, 60, 90], never: false });
  assert.deepEqual(expiryChoices([policy, { ...policy, maxLifetimeDays: 45 }]), { days: [7, 30, 45], never: false });
  assert.equal(expiryChoices([{ ...policy, forbidNoExpiry: true }]).never, false);
  assert.deepEqual(lifetimeFromForm(""), { ok: true, value: null });
  assert.deepEqual(lifetimeFromForm("90"), { ok: true, value: 90 });
  assert.equal(lifetimeFromForm("0").ok, false);
});

test("lists read a token in a line", () => {
  const token = {
    scopes: ["repo:read", "code:write", "issues:read"],
    workspace: "acme",
    repositorySelection: "selected" as const,
    repositories: ["acme/web", "acme/api"],
  };
  assert.equal(reachSummary(token), "acme · 2 repositories");
  assert.equal(reachSummary({ workspace: null, repositorySelection: "all" }), "All your workspaces");
  assert.equal(reachSummary({ workspace: null, repositorySelection: "public" }), "Your account and public repositories");
  assert.equal(reachSummary({ workspaceOwned: true, repositorySelection: "all" }), "All repositories");
  assert.deepEqual(
    permissionChips(token).map((chip) => chip.label),
    ["Repositories: read", "Code: write", "Issues: read"],
  );
  assert.ok(permissionChips({ scopes: ["repo:admin"] })[0]!.dangerous);
  assert.deepEqual(statusBadge("pending"), { label: "Pending approval", tone: "warn" });
  assert.equal(statusBadge("active"), null);
  assert.match(policyNote("acme", policy, false) ?? "", /must approve/);
  assert.equal(policyNote("acme", policy, true), null, "owners' own tokens never wait");
  assert.match(policyNote("acme", { ...policy, allowTokensForThisWorkspace: false }, true) ?? "", /does not allow/);
  assert.deepEqual(keptOutOfAll([{ slug: "acme", policy: { ...policy, allowTokensForAllWorkspaces: false } }, { slug: "globex", policy }]), ["acme"]);
});

test("old addresses of the token settings go to the current pages", () => {
  assert.equal(currentTokensPath("/settings/tokens", new URLSearchParams("tab=classic")), "/settings/tokens");
  assert.equal(currentTokensPath("/settings/tokens", new URLSearchParams("tab=classic&edit=tok_01ABC")), "/settings/tokens/tok_01ABC");
  assert.equal(currentTokensPath("/acme/-/personal-access-tokens", new URLSearchParams("kind=fine_grained")), "/acme/-/personal-access-tokens");
  assert.equal(currentTokensPath("/settings/tokens", new URLSearchParams("")), null);
});

test("saving a token sends only what changed", () => {
  const token = {
    id: "tok_1", name: "ci", createdAt: "", lastUsedAt: null, createdBy: null, legacy: false, expiresAt: null,
    scopes: ["repo:read", "repo:write", "code:read", "code:write"],
    workspace: "acme", repositorySelection: "selected" as const, repositories: ["acme/web"], description: null,
  };
  const same = { owner: null, name: "", description: null, ttlSeconds: null, workspace: "acme", repositorySelection: "selected" as const, repositories: ["Acme/Web"], permissions: { repo: "write" as const, code: "write" as const } };
  assert.deepEqual(changesTo(token, same), {}, "the same permissions and repositories ask nothing again");
  assert.deepEqual(changesTo(token, { ...same, permissions: { repo: "write", code: "read" } }), { permissions: { repo: "write", code: "read" } });
  assert.deepEqual(changesTo(token, { ...same, repositories: ["acme/web", "acme/api"] }), { repositorySelection: "selected", repositories: ["acme/web", "acme/api"] });
  assert.deepEqual(changesTo(token, { ...same, repositorySelection: "all", repositories: [] }), { repositorySelection: "all" });
  assert.deepEqual(changesTo(token, { ...same, name: "release", description: "ships" }), { name: "release", description: "ships" });
});
