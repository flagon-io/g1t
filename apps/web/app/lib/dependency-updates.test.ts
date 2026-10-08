import assert from "node:assert/strict";
import { test } from "node:test";

import type { UpdatePull, VersionUpdateEntry } from "@g1t/contracts";

import { conditionText, entryStatus, groupText, ignoreText, livePulls, timeUntil, utc } from "./dependency-updates.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");

test("a next run is said as a time ahead", () => {
  assert.equal(timeUntil("2026-10-07T15:30:00Z", NOW), "in 3h");
  assert.equal(timeUntil("2026-10-09T12:00:00Z", NOW), "in 2d");
  assert.equal(timeUntil("2026-10-07T12:20:00Z", NOW), "in 20m");
  assert.equal(timeUntil("2026-10-07T11:00:00Z", NOW), "due now");
  assert.equal(utc("2026-10-12T05:00:00.000Z"), "2026-10-12 05:00 UTC");
});

const entry: VersionUpdateEntry = {
  id: "npm:/",
  ecosystem: "npm",
  directories: ["/"],
  supported: true,
  interval: "weekly",
  schedule: "Mondays at 05:00 (UTC)",
  openPullRequestsLimit: 5,
  targetBranch: null,
  multiEcosystemGroup: null,
  groups: [],
  ignore: [],
  allow: [],
  labels: null,
  assignees: [],
  reviewers: [],
  milestone: null,
  versioningStrategy: null,
  options: {},
  notes: [],
  nextRunAt: "2026-10-12T05:00:00Z",
  lastCheckedAt: null,
  lastResult: null,
  lastError: null,
};

test("an entry's status", () => {
  assert.deepEqual(entryStatus(entry), { label: "Active", tone: "accent" });
  assert.equal(entryStatus({ ...entry, supported: false }).label, "Not updated yet");
  assert.equal(entryStatus({ ...entry, openPullRequestsLimit: 0 }).label, "Off");
  assert.equal(entryStatus({ ...entry, nextRunAt: null }).label, "Not scheduled");
  assert.equal(entryStatus({ ...entry, lastError: "boom" }).label, "Last check failed");
});

test("rules read as one line", () => {
  assert.equal(
    groupText({ name: "lint", appliesTo: "version-updates", patterns: ["eslint*"], excludePatterns: ["eslint-old"], updateTypes: ["minor"], dependencyType: "development", groupBy: null }),
    "lint: eslint* · not eslint-old · development · minor",
  );
  assert.equal(
    groupText({ name: "fixes", appliesTo: "security-updates", patterns: [], excludePatterns: [], updateTypes: [], dependencyType: null, groupBy: null }),
    "fixes: every dependency · security updates",
  );
  assert.equal(ignoreText({ dependency: "react", versions: [">=19"], updateTypes: [] }), "react >=19");
  assert.equal(ignoreText({ dependency: "*", versions: [], updateTypes: ["version-update:semver-major"] }), "* major");
  assert.equal(ignoreText({ dependency: "left-pad", versions: [], updateTypes: [] }), "left-pad (every version)");
  const condition = { ecosystem: "npm", dependency: "react", versions: null, updateType: null, by: "ana", pull: 4, at: "" };
  assert.equal(conditionText(condition), "every version");
  assert.equal(conditionText({ ...condition, versions: ">= 19.a, < 20" }), ">= 19.a, < 20");
  assert.equal(conditionText({ ...condition, updateType: "version-update:semver-minor" }), "minor versions");
});

test("only live update pull requests are listed", () => {
  const pull = (state: UpdatePull["state"]): UpdatePull => ({
    kind: "version",
    entry: "npm:/",
    ecosystem: "npm",
    group: null,
    branch: "g1t/npm_and_yarn/x",
    title: "Bump x",
    state,
    pull: 1,
    dependencies: [],
    mergeRequestedBy: null,
    error: null,
    updatedAt: "",
  });
  assert.deepEqual(
    livePulls([pull("open"), pull("merged"), pull("requested"), pull("superseded"), pull("needs_code")]).map((p) => p.state),
    ["open", "requested", "needs_code"],
  );
});
