import assert from "node:assert/strict";
import { test } from "node:test";
import type { Setting } from "@g1t/contracts";
import { settingOverride } from "./setting-overrides.ts";

const workspace: Setting = {
  id: "w",
  name: "TOKEN",
  kind: "secret",
  scope: "workspace",
  value: null,
  updatedAt: "",
  environments: [],
  availableTo: ["workflows", "deployments"],
  projects: [],
};
const project: Setting = { ...workspace, id: "p", scope: "project" };

test("full overrides remain visible on both scopes", () => {
  assert.equal(settingOverride(workspace, [workspace, project]), "Overridden by repository");
  assert.match(settingOverride(project, [workspace, project])!, /^Overrides workspace/);
});

test("environment-restricted project keys still suppress workspace fallback", () => {
  assert.equal(settingOverride(workspace, [workspace, { ...project, environments: ["production"] }]), "Overridden by repository");
  assert.equal(
    settingOverride({ ...workspace, environments: ["production"] }, [workspace, { ...project, environments: ["preview"] }]),
    "Overridden by repository",
  );
});

test("only shared readers are overridden", () => {
  assert.equal(settingOverride(workspace, [workspace, { ...project, availableTo: ["workflows"] }]), "Partially overridden: Workflows");
  assert.equal(
    settingOverride(workspace, [workspace, { ...project, availableTo: ["workflows"] }, { ...project, availableTo: ["deployments"] }]),
    "Overridden by repository",
  );
});

test("different names, kinds and readers do not override", () => {
  const scoped = { ...workspace, availableTo: ["workflows"] };
  for (const other of [
    { ...project, name: "OTHER" },
    { ...project, kind: "variable" },
    { ...project, availableTo: ["deployments"] },
  ]) {
    assert.equal(settingOverride(scoped, [scoped, other]), null);
  }
});
