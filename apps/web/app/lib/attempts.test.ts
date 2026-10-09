import assert from "node:assert/strict";
import { test } from "node:test";

import type { Overlap } from "@g1t/contracts";

import { MAX_ATTEMPTS, attemptOutcome, attemptReview, otherAttempts, sharedPaths, splitOverlaps } from "./attempts.ts";

const overlap = (number: number, issue: number | null): Overlap => ({ number, title: `#${number}`, issue, paths: ["src/lib.rs"] });

test("overlaps for the same issue are alternatives; the rest are collisions", () => {
  const { collisions, alternatives } = splitOverlaps([overlap(3, 2), overlap(4, 7), overlap(5, null)], 2);
  assert.deepEqual(alternatives.map((o) => o.number), [3]);
  assert.deepEqual(collisions.map((o) => o.number), [4, 5]);
  // A pull request for no issue has no alternatives.
  assert.deepEqual(splitOverlaps([overlap(5, null)], null).alternatives, []);
});

test("the other attempts are the issue's other pull requests, newest first, a few at most", () => {
  const pulls = [3, 9, 4, 12, 7, 8].map((number) => ({ number }));
  const others = otherAttempts(pulls, 9);
  assert.deepEqual(others, [12, 8, 7, 4]);
  assert.equal(others.length, MAX_ATTEMPTS);
  assert.deepEqual(otherAttempts([{ number: 9 }], 9), []);
});

test("shared paths are the files both change", () => {
  assert.deepEqual(
    sharedPaths([{ path: "README.md" }, { path: "src/lib.rs" }, { path: "src/main.rs" }], [{ path: "src/main.rs" }, { path: "README.md" }]),
    ["README.md", "src/main.rs"],
  );
});

const said = (username: string, verdict: "approve" | "request_changes" | null) => ({
  author: { id: `usr_${username}`, username },
  verdict,
});

test("a review stands at each reviewer's latest verdict, changes asked for first", () => {
  assert.deepEqual(attemptReview([said("g1t", "approve")], []), { state: "approved", text: "Approved by g1t" });
  assert.deepEqual(attemptReview([said("g1t", "request_changes"), said("g1t", "approve"), said("ada", "approve")], []), {
    state: "approved",
    text: "Approved by g1t, ada",
  });
  assert.deepEqual(attemptReview([said("g1t", "approve"), said("ada", "request_changes")], ["sam"]), {
    state: "changes_requested",
    text: "Changes requested by ada",
  });
  assert.deepEqual(attemptReview([said("ada", null)], ["g1t"]), { state: "requested", text: "Review requested from g1t" });
  assert.deepEqual(attemptReview([], []), { state: "none", text: "No review yet" });
});

test("an attempt's outcome says which was merged instead", () => {
  assert.equal(attemptOutcome({ status: "merged", supersededBy: null }), "Merged");
  assert.equal(attemptOutcome({ status: "closed", supersededBy: 5 }), "Closed · #5 was merged instead");
  assert.equal(attemptOutcome({ status: "closed", supersededBy: null }), "Closed without merging");
  assert.equal(attemptOutcome({ status: "draft", supersededBy: null }), "Draft · in progress");
  assert.equal(attemptOutcome({ status: "open", supersededBy: null }), "Open");
});

test("an agent's review is advisory: it neither approves nor asks for changes", () => {
  const margo = { id: "agt_1", handle: "margo", displayName: "Margo", avatarSeed: "margo" };
  const advisory = (verdict: "approve" | "request_changes") => ({
    author: { id: "agt_1", username: "margo" },
    verdict,
    agent: margo,
    advisory: true,
  });
  assert.deepEqual(attemptReview([advisory("approve")], []), { state: "none", text: "No review yet" });
  assert.deepEqual(attemptReview([advisory("request_changes")], ["ada"]), { state: "requested", text: "Review requested from ada" });
});
