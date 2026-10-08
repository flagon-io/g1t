import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodeAlert, SecretFinding } from "@g1t/contracts";

import {
  codeFilters,
  codeScanningBranch,
  codeScanningPullBody,
  codeScanningWorkflow,
  countStates,
  keepCode,
  keepSecret,
  legacySecurityTarget,
  secretFilters,
  secretTypes,
  severityCounts,
  total,
  trendMax,
} from "./security-suite.ts";

const secret = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  id: "sec_1",
  repoId: "r",
  kind: "github_token",
  label: "a GitHub token",
  path: "scripts/release.sh",
  line: 12,
  commit: "abcdef1234",
  preview: "ghp_X7…",
  status: "open",
  source: "push",
  foundBy: "ana",
  foundAt: "2026-10-06T09:00:00.000Z",
  decidedBy: null,
  reason: null,
  decidedAt: null,
  state: "open",
  ...over,
});

const code = (over: Partial<CodeAlert> = {}): CodeAlert => ({
  id: "cod_1",
  number: 1,
  repoId: "r",
  tool: "Semgrep OSS",
  category: "Semgrep OSS",
  ruleId: "rule",
  ruleName: null,
  ruleDescription: null,
  help: null,
  helpUri: null,
  tags: [],
  level: "error",
  securitySeverity: null,
  severity: "high",
  message: "m",
  path: "a.js",
  startLine: 1,
  endLine: 1,
  startColumn: null,
  endColumn: null,
  state: "open",
  fingerprint: "f",
  firstCommit: "c",
  lastCommit: "c",
  createdAt: "",
  updatedAt: "",
  fixedAt: null,
  dismissedBy: null,
  dismissedReason: null,
  dismissedComment: null,
  dismissedAt: null,
  issue: null,
  ...over,
});

test("secret filters are read from the address and narrow the list", () => {
  const filters = secretFilters(new URLSearchParams("state=open&validity=active&bypassed=true"));
  assert.deepEqual(filters, { state: "open", type: null, validity: "active", bypassed: true });
  const bypassed = secret({ validity: "active", bypass: { reason: "will_fix_later", comment: null, by: "ana", at: "x", approvedBy: null } });
  assert.equal(keepSecret(bypassed, filters), true);
  assert.equal(keepSecret(secret({ validity: "active" }), filters), false);
  // Unknown words fall back to the defaults.
  assert.deepEqual(secretFilters(new URLSearchParams("state=everything&validity=maybe")), { state: "open", type: null, validity: null, bypassed: null });
  // Never asked counts as unknown.
  assert.equal(keepSecret(secret(), { state: "open", type: null, validity: "unknown", bypassed: null }), true);
});

test("secret types are listed once each, custom patterns by name", () => {
  const types = secretTypes([secret(), secret({ id: "sec_2" }), secret({ kind: "custom_pattern", patternName: "Acme key", label: "a match for the custom pattern \"Acme key\"" })]);
  assert.deepEqual(types, [["github_token", "GitHub token"], ["custom_pattern", "Custom: Acme key"]].sort((a, b) => a[1].localeCompare(b[1])));
});

test("code filters and counts", () => {
  const filters = codeFilters(new URLSearchParams("severity=high&tool=Semgrep OSS"));
  assert.equal(keepCode(code(), filters), true);
  assert.equal(keepCode(code({ severity: "low" }), filters), false);
  assert.equal(keepCode(code({ state: "fixed" }), filters), false);
  assert.deepEqual(countStates([code(), code({ state: "fixed" }), code({ state: "fixed" })]), { open: 1, dismissed: 0, fixed: 2 });
  const counts = severityCounts([code(), code({ severity: "critical" }), code({ state: "dismissed" })]);
  assert.deepEqual(counts, { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 });
  assert.equal(total(counts), 2);
});

test("old Security links go to the sections that replaced their tabs", () => {
  const base = "/acme/rocket";
  assert.equal(legacySecurityTarget(base, new URLSearchParams("tab=secrets&finding=sec_9")), "/acme/rocket/security/secret-scanning/sec_9");
  assert.equal(legacySecurityTarget(base, new URLSearchParams("finding=vul_3")), "/acme/rocket/security/vulnerabilities?finding=vul_3");
  assert.equal(legacySecurityTarget(base, new URLSearchParams("tab=dependencies&state=fixed")), "/acme/rocket/security/vulnerabilities?state=fixed");
  assert.equal(legacySecurityTarget(base, new URLSearchParams("")), null);
});

test("the starter workflow scans each language it finds, then uploads SARIF for the right ref", () => {
  const yaml = codeScanningWorkflow("main");
  assert.match(yaml, /branches: \["main"\]/);
  // A scanner per language, each run only when the repository has it.
  assert.match(yaml, /if: steps\.languages\.outputs\.python == 'true'/);
  assert.match(yaml, /bandit --recursive \. .*\n.*--format sarif --output \/tmp\/sarif\/python\.sarif/);
  assert.match(yaml, /if: steps\.languages\.outputs\.go == 'true'/);
  assert.match(yaml, /-fmt sarif -out "\$out" \.\/\.\.\./);
  assert.match(yaml, /if: steps\.languages\.outputs\.javascript == 'true'/);
  assert.match(yaml, /eslint-plugin-security/);
  assert.match(yaml, /@microsoft\/eslint-formatter-sarif/);
  assert.match(yaml, /if: steps\.languages\.outputs\.rust == 'true'/);
  assert.match(yaml, /cargo clippy --all-targets --message-format=json/);
  assert.match(yaml, /clippy-sarif/);
  assert.ok(!/semgrep/i.test(yaml), "no Semgrep");
  // Each language's results under their own category.
  for (const category of ["python", "javascript", '"go"', '"rust"']) assert.ok(yaml.includes(category), category);
  assert.match(yaml, /--arg category "\$category"/);
  assert.match(yaml, /refs\/pull\/\$\(jq -r \.number "\$GITHUB_EVENT_PATH"\)\/head/);
  assert.match(yaml, /--rawfile sarif "\$file\.b64"/);
  assert.match(yaml, /\/code-scanning\/sarifs/);
  assert.match(yaml, /\$\{\{ secrets\.G1T_TOKEN \}\}/);
  // Its token may upload results, and nothing more.
  assert.match(yaml, /\npermissions:\n  contents: read\n  security-events: write\n/);
  assert.ok(!yaml.includes("\t"), "YAML takes no tabs");
  assert.match(codeScanningPullBody("main"), /Code scanning\*\* check/);
  assert.equal(codeScanningBranch([]), "add-code-scanning");
  assert.equal(codeScanningBranch(["add-code-scanning", "add-code-scanning-2"]), "add-code-scanning-3");
});

test("a trend is scaled to its tallest day", () => {
  assert.equal(trendMax([]), 1);
  assert.equal(trendMax([{ day: "d", secretScanning: 1, codeScanning: 2, vulnerability: 3 }]), 6);
});
