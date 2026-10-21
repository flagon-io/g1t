import assert from "node:assert/strict";
import { test } from "node:test";

import type { Decision, SessionEntry, SessionTouch } from "@g1t/contracts";

import { activity, deliverables, filesTouched, highlights, sessionAnswer } from "./session-story.ts";

const entry = (seq: number, kind: SessionEntry["kind"], text: string, at: string, withheld = false): SessionEntry => ({
  seq,
  kind,
  text,
  tool: null,
  commit: null,
  at,
  withheld,
});

test("the answer is what the session reported, else once it ended the last thing it said", () => {
  const entries = [entry(1, "message", "First look.", "2026-10-21T10:00:00Z"), entry(2, "message", "Done: the retry lands.", "2026-10-21T10:05:00Z")];
  assert.equal(sessionAnswer({ result: " Fixed it. ", state: "active" }, entries), "Fixed it.");
  assert.equal(sessionAnswer({ result: null, state: "ended" }, entries), "Done: the retry lands.");
  // Still going and nothing reported: the transcript is the story so far.
  assert.equal(sessionAnswer({ result: null, state: "active" }, entries), null);
  assert.equal(sessionAnswer({ result: null, state: "ended" }, [entry(1, "message", "", "2026-10-21T10:00:00Z", true)]), null);
});

test("activity cuts the run into equal slices and counts what each holds", () => {
  const entries = [
    entry(1, "prompt", "go", "2026-10-21T10:00:00Z"),
    entry(2, "tool_call", "{}", "2026-10-21T10:00:30Z"),
    entry(3, "tool_call", "{}", "2026-10-21T10:03:10Z"),
    // A clock that disagreed: counted in the last slice, not lost.
    entry(4, "message", "done", "2026-10-21T10:09:00Z"),
  ];
  const bars = activity(entries, "2026-10-21T10:00:00Z", "2026-10-21T10:04:00Z", 0, 4);
  assert.deepEqual(
    bars.map((bar) => [bar.entries, bar.tools]),
    [
      [2, 1],
      [0, 0],
      [0, 0],
      [2, 1],
    ],
  );
  assert.equal(bars[0]!.to - bars[0]!.from, 60_000);
  assert.deepEqual(activity([], "2026-10-21T10:00:00Z", null, Date.now()), []);
});

test("highlights are the tree's decisions and its notes, oldest first, each citing where it is", () => {
  const decision = (id: string, sessionId: string | null, summary: string, createdAt: string, pull: number | null = 7): Decision => ({
    id,
    item: 304,
    pull,
    sessionId,
    actor: "syntaqx",
    kind: "proposal",
    confidence: "claimed",
    summary,
    evidence: {},
    createdAt,
  });
  const decisions = [
    decision("d1", "ses_a", "Carry ACP shapes over our own socket", "2026-10-21T10:02:00Z"),
    decision("d2", "ses_sub", "Keep the old entry kinds readable", "2026-10-21T10:04:00Z", null),
    decision("d3", "ses_other", "Someone else's", "2026-10-21T10:01:00Z"),
    // The same decision again, on the work item: one highlight.
    decision("d4", "ses_a", "Carry ACP shapes over our own socket", "2026-10-21T10:02:30Z", null),
  ];
  const entries = [
    entry(5, "note", "The approvals were declined because nobody watched.", "2026-10-21T10:01:00Z"),
    entry(6, "note", "", "2026-10-21T10:03:00Z"),
    entry(8, "message", "Not a highlight.", "2026-10-21T10:03:30Z"),
  ];
  const where = (d: Decision) => (d.pull != null ? `/acme/web/pull/${d.pull}` : `/acme/-/work/${d.item}`);
  assert.deepEqual(highlights(decisions, entries, new Set(["ses_a", "ses_sub"]), where), [
    { text: "The approvals were declined because nobody watched.", at: "2026-10-21T10:01:00Z", cite: { kind: "entry", seq: 5 } },
    { text: "Carry ACP shapes over our own socket", at: "2026-10-21T10:02:00Z", cite: { kind: "decision", to: "/acme/web/pull/7" } },
    { text: "Keep the old entry kinds readable", at: "2026-10-21T10:04:00Z", cite: { kind: "decision", to: "/acme/-/work/304" } },
  ]);
});

test("deliverables are its pull requests, its work items, then its commits as one", () => {
  const touched: SessionTouch[] = [
    { sessionId: "s", kind: "commit", value: "abc1234", at: "" },
    { sessionId: "s", kind: "file", value: "a.ts", at: "" },
    { sessionId: "s", kind: "file", value: "a.ts", at: "" },
    { sessionId: "s", kind: "commit", value: "abc1234", at: "" },
    { sessionId: "s", kind: "commit", value: "def5678", at: "" },
  ];
  const links = [
    { kind: "item" as const, number: 304, title: "Sessions", state: "open", via: [], sessionIds: [] },
    { kind: "pull" as const, number: 305, title: "Event model", state: "open", via: [], sessionIds: [] },
  ];
  assert.deepEqual(deliverables(links, touched), [
    { kind: "pull", number: 305, title: "Event model", state: "open" },
    { kind: "item", number: 304, title: "Sessions", state: "open" },
    { kind: "commits", shas: ["abc1234", "def5678"] },
  ]);
  assert.deepEqual(filesTouched(touched), ["a.ts"]);
});
