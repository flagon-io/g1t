import assert from "node:assert/strict";
import { test } from "node:test";

import type { G1tEvent } from "@g1t/contracts";

import { activityLine, alignWeeks, count, languageBar, licenseLabel, peak } from "./about.ts";

test("a license is named by its SPDX id, or not at all", () => {
  assert.equal(licenseLabel({ spdxId: "MIT", name: "MIT License", path: "LICENSE" }), "MIT license");
  assert.equal(licenseLabel({ spdxId: null, name: "Other", path: "COPYING" }), "View license");
});

test("counts read as words", () => {
  assert.equal(count(1, "star"), "1 star");
  assert.equal(count(0, "star"), "0 stars");
  assert.equal(count(1234, "star"), "1.2k stars");
  assert.equal(count(2000, "star"), "2k stars");
  assert.equal(count(15_400, "star"), "15k stars");
  assert.equal(count(3, "watching", "watching"), "3 watching");
});

test("small languages are gathered as Other", () => {
  const rust = { name: "Rust", color: "#dea584", bytes: 900, percent: 90 };
  const shell = { name: "Shell", color: "#89e051", bytes: 95, percent: 9.5 };
  const nix = { name: "Nix", color: "#7e7eff", bytes: 5, percent: 0.5 };
  assert.deepEqual(languageBar([rust, shell]), [rust, shell]);
  const bar = languageBar([rust, shell, nix]);
  assert.equal(bar.length, 3);
  assert.equal(bar[2].name, "Other");
  assert.equal(bar[2].percent, 0.5);
  assert.deepEqual(languageBar([rust, { ...nix, percent: 0 }]), [rust], "nothing to show for nothing");
  assert.deepEqual(languageBar([]), []);
});

test("weeks line up with the repository's", () => {
  const all = [
    { week: "2026-09-21", commits: 2 },
    { week: "2026-09-28", commits: 0 },
    { week: "2026-10-05", commits: 5 },
  ];
  assert.deepEqual(alignWeeks(all, [{ week: "2026-10-05", commits: 3 }]), [0, 0, 3]);
  assert.equal(peak(all), 5);
  assert.equal(peak([]), 1);
});

function event(type: string, data: Record<string, unknown>): G1tEvent {
  return { id: "evt_1", type, source: "repos", time: "2026-10-07T10:00:00Z", repoId: "rep_1", actor: "usr_1", data } as unknown as G1tEvent;
}

test("pushes, tags, merges and renames are activity", () => {
  assert.deepEqual(activityLine(event("git.push", { ref: "refs/heads/main", before: "a", after: "b", defaultBranch: true })), {
    kind: "push",
    branch: "main",
    commit: "b",
    before: "a",
    created: false,
    defaultBranch: true,
  });
  assert.equal((activityLine(event("git.push", { ref: "refs/heads/feat", after: "b", defaultBranch: false })) as { created: boolean }).created, true);
  assert.deepEqual(activityLine(event("git.push", { ref: "refs/tags/v1.0.0", after: "c", defaultBranch: false })), { kind: "tag", tag: "v1.0.0", commit: "c" });
  assert.equal(activityLine(event("git.push", { ref: "refs/pull/1/head", after: "c", defaultBranch: false })), null);
  assert.deepEqual(activityLine(event("pull.merged", { number: 7, commit: "d" })), { kind: "merge", number: 7, commit: "d" });
  assert.deepEqual(activityLine(event("branch.renamed", { from: "master", to: "main" })), { kind: "renamed", from: "master", to: "main" });
  assert.equal(activityLine(event("repo.default_branch_changed", { from: "master", to: "main", renamed: true })), null);
  assert.equal(activityLine(event("issue.opened", { number: 1 })), null);
});
