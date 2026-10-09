import assert from "node:assert/strict";
import { test } from "node:test";

import type { HandbackPlan, RepoMirror } from "@g1t/contracts";

import { DEFAULT_MIRROR_SETTINGS, TAKE_OVER_AFTER_MINUTES, mirrorWritable } from "../../../../packages/contracts/src/mirrors.ts";

import {
  clampMinutes,
  decisionsFrom,
  handBackReady,
  mirrorBadge,
  mirrorBanner,
  mirrorReason,
  mirrorSettingsFrom,
  shortSha,
  TAKE_OVER_MINUTES,
  workflowReason,
  writable,
} from "./mirror.ts";

const mirror = (state: RepoMirror["state"]): RepoMirror => ({
  state,
  remote: "github.com/acme/web",
  url: "https://github.com/acme/web",
  since: "2026-10-08T10:00:00Z",
});
const repo = (state: RepoMirror["state"] | null) => ({ namespace: "acme", name: "web", mirror: state ? mirror(state) : null });
const leader = (reachable: boolean) => ({ repoId: "r", role: "leader" as const, name: "github.com/acme/web", state: "standby" as const, reachable });
const follower = (name: string) => ({ repoId: "r", role: "follower" as const, name, state: "following" as const, reachable: true });

test("the copies agree with the contracts", () => {
  for (const state of [null, "standby", "ci", "takeover", "handing_back"] as const) {
    assert.equal(writable(state ? mirror(state) : null), mirrorWritable(state ? mirror(state) : null));
  }
  assert.deepEqual([...TAKE_OVER_MINUTES], [...TAKE_OVER_AFTER_MINUTES]);
});

test("a read-only mirror says why its buttons are off, and where to take over", () => {
  assert.equal(
    mirrorReason(repo("standby")),
    "acme/web is a mirror of github.com/acme/web. Work happens there until someone takes over in Settings → Mirroring.",
  );
  assert.equal(mirrorReason(repo("ci")), mirrorReason(repo("standby")));
  assert.equal(mirrorReason(repo("handing_back")), "acme/web is handing back to github.com/acme/web; it takes changes again when that is done.");
  assert.equal(mirrorReason(repo("takeover")), null);
  assert.equal(mirrorReason(repo(null)), null);
  assert.equal(mirrorReason(null), null);
});

test("workflows run in CI failover and takeovers, not while standing by or handing back", () => {
  assert.equal(workflowReason(repo("ci")), null);
  assert.equal(workflowReason(repo("takeover")), null);
  assert.ok(workflowReason(repo("standby")));
  assert.ok(workflowReason(repo("handing_back")));
  assert.equal(workflowReason(repo(null)), null);
});

test("the badge says what the repository is to its remotes", () => {
  assert.deepEqual(mirrorBadge(mirror("standby"), []), { label: "Mirror of github.com/acme/web", tone: "neutral", more: 0 });
  assert.equal(mirrorBadge(mirror("ci"), [])?.tone, "info");
  assert.equal(mirrorBadge(mirror("takeover"), [])?.label, "Taken over from github.com/acme/web");
  assert.equal(mirrorBadge(mirror("handing_back"), [])?.label, "Handing back to github.com/acme/web");
  assert.deepEqual(mirrorBadge(null, [follower("github.com/acme/web"), follower("git.example.com/web")]), {
    label: "Mirrored to github.com/acme/web",
    tone: "accent",
    more: 1,
  });
  assert.equal(mirrorBadge(null, []), null);
});

test("a mirror standing by whose remote answers needs no banner", () => {
  assert.equal(mirrorBanner(mirror("standby"), [leader(true)]), null);
  assert.equal(mirrorBanner(mirror("standby"), []), null);
  assert.equal(mirrorBanner(mirror("standby"), [leader(false)]), "unreachable");
  assert.equal(mirrorBanner(mirror("ci"), [leader(false)]), "unreachable");
  assert.equal(mirrorBanner(mirror("ci"), [leader(true)]), "ci");
  assert.equal(mirrorBanner(mirror("takeover"), [leader(false)]), "takeover");
  assert.equal(mirrorBanner(mirror("handing_back"), []), "handing_back");
  assert.equal(mirrorBanner(null, [follower("x")]), null);
});

test("hand-back decisions are read from their fields, and only known ones", () => {
  const form = new FormData();
  form.set("intent", "hand-back");
  form.set("decision:main", "keep_ours");
  form.set("decision:release/1.x", "pull_request");
  form.set("decision:dev", "delete_everything");
  assert.deepEqual(decisionsFrom(form.entries()), { main: "keep_ours", "release/1.x": "pull_request" });
});

test("a hand-back is ready once the remote answers and every diverged branch has a decision", () => {
  const plan: HandbackPlan = {
    reachable: true,
    ready: false,
    refs: [
      { ref: "main", base: "a", ours: "b", theirs: "c", action: "diverged", decision: null },
      { ref: "dev", base: "a", ours: "b", theirs: "a", action: "push", decision: null },
    ],
  };
  assert.equal(handBackReady(plan, {}), false);
  assert.equal(handBackReady(plan, { main: "keep_theirs" }), true);
  assert.equal(handBackReady({ ...plan, reachable: false }, { main: "keep_theirs" }), false);
});

test("settings come back from the form, keeping what it did not carry", () => {
  const leaderForm = new FormData();
  leaderForm.set("kind", "leader");
  leaderForm.set("notify", "inbox");
  leaderForm.set("autoTakeOver", "on");
  leaderForm.set("takeOverAfter", "2");
  leaderForm.set("githubWorkflows", "on");
  const current = { ...DEFAULT_MIRROR_SETTINGS, remotePushes: "overwrite" as const };
  assert.deepEqual(mirrorSettingsFrom(leaderForm, current), {
    notify: "inbox",
    takeOverAfter: 5,
    handBack: "ask",
    keepCiWarm: false,
    githubWorkflows: true,
    holdDeploys: false,
    remotePushes: "overwrite",
  });
  const followerForm = new FormData();
  followerForm.set("kind", "follower");
  followerForm.set("remotePushes", "overwrite");
  assert.deepEqual(mirrorSettingsFrom(followerForm, DEFAULT_MIRROR_SETTINGS), { ...DEFAULT_MIRROR_SETTINGS, remotePushes: "overwrite" });
});

test("minutes and commits are shown within bounds", () => {
  assert.equal(clampMinutes(3), 5);
  assert.equal(clampMinutes(90.4), 90);
  assert.equal(clampMinutes(99999), 1440);
  assert.equal(clampMinutes(Number.NaN), 5);
  assert.equal(shortSha("0123456789abcdef"), "0123456");
  assert.equal(shortSha(null), "—");
});
