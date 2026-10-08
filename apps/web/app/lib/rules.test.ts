import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL,
  DEFAULT_BRANCH,
  RULES,
  describeAppliesTo,
  describeBypassActor,
  exportRuleset,
  importRuleset,
  newRule,
  newRuleset,
  ruleInfo,
  targetSummary,
} from "./rules.ts";

test("a new ruleset protects the default branch, and a workspace's holds everywhere", () => {
  const repo = newRuleset("repository");
  assert.deepEqual(repo.conditions.ref_name.include, [DEFAULT_BRANCH]);
  assert.equal(repo.conditions.repository, undefined);
  assert.equal(repo.enforcement, "active");
  const workspace = newRuleset("workspace");
  assert.deepEqual(workspace.conditions.repository?.include, [ALL]);
});

test("every rule type has a label, a group and its defaults", () => {
  const types = new Set(RULES.map((rule) => rule.type));
  assert.equal(types.size, RULES.length, "each type once");
  assert.equal(RULES.length, 26);
  for (const rule of RULES) {
    assert.ok(rule.label && rule.about && rule.targets.length > 0, rule.type);
  }
  const pull = newRule("pull_request", "agents");
  assert.equal(pull.applies_to, "agents");
  assert.equal(pull.type === "pull_request" && pull.parameters.required_approvals, 1);
  // A new rule's parameters are its own, not the defaults themselves.
  const a = newRule("file_path_restriction");
  if (a.type === "file_path_restriction") a.parameters.restricted_file_paths.push("x");
  const info = ruleInfo("file_path_restriction")!;
  assert.deepEqual((info.defaults as { restricted_file_paths: string[] }).restricted_file_paths, []);
  assert.equal(ruleInfo("no_such_rule"), undefined);
});

test("an export imports back as it was", () => {
  const ruleset = {
    ...newRuleset("repository"),
    name: "Protect main",
    rules: [newRule("deletion"), newRule("cost_cap", "agents")],
  };
  const text = JSON.stringify({ ...exportRuleset(ruleset), id: "rs_1", created_by: "ada" });
  const back = importRuleset(text, "repository");
  assert.deepEqual(back, exportRuleset(ruleset));
});

test("an import fills in what it leaves out and refuses what is not a ruleset", () => {
  const spec = importRuleset(
    JSON.stringify({ ruleset_name: "From the API", enforcement: "nonsense", rules: [{ type: "max_file_size", parameters: { max_file_size_mb: 5 } }] }),
    "workspace",
  );
  assert.equal(spec.name, "From the API");
  assert.equal(spec.enforcement, "active");
  assert.equal(spec.rules[0]?.applies_to, "everyone");
  assert.deepEqual(spec.conditions.repository?.include, [ALL]);
  assert.equal(spec.rules[0]?.type === "max_file_size" && spec.rules[0].parameters.max_file_size_mb, 5);
  assert.throws(() => importRuleset("{", "repository"), /not JSON/);
  assert.throws(() => importRuleset("[]", "repository"), /one JSON object/);
  assert.throws(() => importRuleset(JSON.stringify({ rules: [{ type: "teleport" }] }), "repository"), /teleport is not a rule type/);
});

test("who may bypass, and whose changes a rule holds for, read plainly", () => {
  assert.equal(describeBypassActor({ kind: "role", value: "maintain", mode: "always" }), "Maintain role and up");
  assert.equal(describeBypassActor({ kind: "role", value: "owner", mode: "always" }), "Workspace owners");
  assert.equal(describeBypassActor({ kind: "team", value: "acme/release", mode: "pull_requests" }), "@acme/release");
  assert.equal(describeBypassActor({ kind: "g1t", value: "", mode: "always" }), "g1t");
  assert.equal(describeBypassActor({ kind: "token", value: "workspace", mode: "always" }), "The workspace's tokens");
  assert.equal(describeAppliesTo("agents"), "Agents' changes");
  assert.equal(describeAppliesTo("everyone"), "Everyone");
});

test("what a ruleset targets, in a few words", () => {
  assert.equal(targetSummary({ conditions: { ref_name: { include: [DEFAULT_BRANCH, "release/*"], exclude: [] } } }), "Default branch, release/*");
  assert.equal(targetSummary({ conditions: { ref_name: { include: [ALL], exclude: ["dependabot/**"] } } }), "All, except dependabot/**");
  assert.equal(targetSummary({ conditions: { ref_name: { include: [], exclude: [] } } }), "Nothing yet");
});
