import assert from "node:assert/strict";
import { test } from "node:test";

import type { AlertActivity, SecretFinding, Vulnerability } from "@g1t/contracts";

import {
  alertActivity,
  alertCapability,
  compareVersions,
  countByState,
  groupByPackage,
  highestFix,
  latestUpdate,
  parseAlertState,
  splitSecrets,
  tabOf,
  worstSeverity,
} from "./security-alerts.ts";

const secret = (over: Partial<SecretFinding> = {}): SecretFinding => ({
  id: "sec_1",
  repoId: "r",
  kind: "aws_access_key",
  label: "an AWS access key",
  path: "src/config.ts",
  line: 4,
  commit: "abcdef1234",
  preview: "AKIA…WXYZ",
  status: "open",
  source: "history",
  foundBy: null,
  foundAt: "2026-10-01T10:00:00Z",
  decidedBy: null,
  reason: null,
  decidedAt: null,
  state: "open",
  ...over,
});

const vuln = (over: Partial<Vulnerability> = {}): Vulnerability => ({
  id: "vul_1",
  repoId: "r",
  ecosystem: "npm",
  package: "lodash",
  version: "4.17.20",
  manifest: "package-lock.json",
  advisory: "GHSA-1",
  osvId: "GHSA-1",
  summary: "Prototype pollution",
  severity: "high",
  fixedVersion: "4.17.21",
  status: "open",
  issue: null,
  foundAt: "2026-10-01T10:00:00Z",
  fixedAt: null,
  state: "open",
  ...over,
});

test("the state parameter falls back to open", () => {
  assert.equal(parseAlertState(null), "open");
  assert.equal(parseAlertState("dismissed"), "dismissed");
  assert.equal(parseAlertState("fixed"), "fixed");
  assert.equal(parseAlertState("nonsense"), "open");
});

test("ids say which tab and which role an alert takes", () => {
  assert.equal(tabOf("sec_9"), "secrets");
  assert.equal(tabOf("vul_9"), "dependencies");
  assert.equal(alertCapability("sec_9"), "manage_integrations");
  assert.equal(alertCapability("vul_9"), "push");
});

test("alerts are counted by state", () => {
  assert.deepEqual(countByState([secret(), secret({ state: "dismissed" }), secret({ state: "fixed" }), secret()]), {
    open: 2,
    dismissed: 1,
    fixed: 1,
  });
});

test("likely test values are listed apart from real secrets", () => {
  const real = secret({ id: "sec_real" });
  const fake = secret({ id: "sec_fake", testValue: "AWS's documented example key" });
  const { real: shown, tests } = splitSecrets([fake, real]);
  assert.deepEqual(shown.map((s) => s.id), ["sec_real"]);
  assert.deepEqual(tests.map((s) => s.id), ["sec_fake"]);
});

test("packages group their alerts and take the worst severity", () => {
  const groups = groupByPackage([
    vuln({ id: "vul_1", severity: "medium" }),
    vuln({ id: "vul_2", package: "express" }),
    vuln({ id: "vul_3", severity: "critical", fixedVersion: "4.17.3" }),
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["lodash", "express"]);
  assert.equal(worstSeverity(groups[0].vulns), "critical");
  assert.equal(highestFix(groups[0].vulns), "4.17.21");
});

test("versions compare number by number", () => {
  assert.ok(compareVersions("4.17.10", "4.17.9") > 0);
  assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
  assert.equal(highestFix([vuln({ fixedVersion: null })]), null);
});

test("the newest security update wins", () => {
  const older = { state: "superseded" as const, target: "4.17.20", branch: null, pull: 3, issue: null, error: null, updatedAt: "2026-10-01T00:00:00Z" };
  const newer = { ...older, state: "open" as const, target: "4.17.21", pull: 14, updatedAt: "2026-10-02T00:00:00Z" };
  assert.equal(latestUpdate([vuln({ update: older }), vuln({ update: newer }), vuln()])?.pull, 14);
  assert.equal(latestUpdate([vuln()]), null);
});

const row = (over: Partial<AlertActivity>): AlertActivity => ({
  id: "act_1",
  alertId: "sec_1",
  action: "dismissed",
  actor: "syntaqx",
  reason: "used_in_tests",
  comment: "A fixture.",
  number: null,
  at: "2026-10-03T00:00:00Z",
  ...over,
});

test("a secret's activity starts with when it was found", () => {
  const entries = alertActivity(secret({ source: "push", status: "blocked", foundBy: "ana" }), [
    row({}),
    row({ id: "act_2", alertId: "sec_other" }),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.actor, e.text]),
    [
      ["ana", "pushed it, and the push was refused"],
      ["syntaqx", "dismissed it"],
    ],
  );
  assert.equal(entries[1].reason, "used_in_tests");
});

test("an older decision without a row is shown from the alert itself", () => {
  const entries = alertActivity(
    secret({ status: "allowed", state: "dismissed", decidedBy: "ana", decidedAt: "2026-10-02T00:00:00Z", reason: "Docs example." }),
    [],
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "Found in the history");
  assert.equal(entries[0].actor, null);
  assert.deepEqual([entries[1].actor, entries[1].comment, entries[1].reason], ["ana", "Docs example.", "false_positive"]);
  // A row for the dismissal replaces it.
  const covered = alertActivity(
    secret({ status: "allowed", state: "dismissed", decidedBy: "ana", decidedAt: "2026-10-02T00:00:00Z" }),
    [row({ actor: "ana" })],
  );
  assert.equal(covered.filter((e) => e.text === "dismissed it").length, 1);
});

test("a dependency's activity links its pull request and issue", () => {
  const entries = alertActivity(vuln({ state: "fixed", status: "fixed", fixedAt: "2026-10-05T00:00:00Z" }), [
    row({ id: "a", alertId: "vul_1", action: "update_opened", actor: "g1t", reason: null, comment: null, number: 14, at: "2026-10-02T00:00:00Z" }),
    row({ id: "b", alertId: "vul_1", action: "update_needs_code", actor: "g1t", reason: null, comment: null, number: 15, at: "2026-10-03T00:00:00Z" }),
    row({ id: "c", alertId: "vul_1", action: "update_merged", actor: "g1t", reason: null, comment: null, number: 14, at: "2026-10-04T00:00:00Z" }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.ref),
    [null, { kind: "pull", number: 14 }, { kind: "issue", number: 15 }, { kind: "pull", number: 14 }],
  );
  // A merged update already says it was fixed.
  assert.ok(!entries.some((e) => e.text === "found it no longer vulnerable"));
});
