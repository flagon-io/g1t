import assert from "node:assert/strict";
import { test } from "node:test";

import { type ApiSessionTouch, sessionTitle, sessionsQuery, subagentTree, touchedFiles } from "./sessions.ts";

test("subagents are a tree under their session, in the order they started", () => {
  const children = [
    { id: "b", parent_id: "root", started_at: "2026-10-17T10:02:00Z" },
    { id: "a1", parent_id: "a", started_at: "2026-10-17T10:03:00Z" },
    { id: "a", parent_id: "root", started_at: "2026-10-17T10:01:00Z" },
    // Its parent is not in the list: it sits under the root.
    { id: "c", parent_id: "gone", started_at: "2026-10-17T10:04:00Z" },
  ];
  assert.deepEqual(
    subagentTree("root", children).map(({ session, depth }) => [session.id, depth]),
    [
      ["a", 1],
      ["a1", 2],
      ["b", 1],
      ["c", 1],
    ],
  );
});

test("the files a session touched, once each", () => {
  const touched: ApiSessionTouch[] = [
    { session_id: "s", kind: "file", value: "src/b.ts", at: "2026-10-17T10:02:00Z" },
    { session_id: "s", kind: "commit", value: "abc", at: "2026-10-17T10:00:00Z" },
    { session_id: "t", kind: "file", value: "src/a.ts", at: "2026-10-17T10:01:00Z" },
    { session_id: "t", kind: "file", value: "src/b.ts", at: "2026-10-17T10:03:00Z" },
  ];
  assert.deepEqual(touchedFiles(touched), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(touchedFiles(undefined), []);
});

test("a session's name is its title, else its task or first prompt", () => {
  assert.equal(sessionTitle({ title: "Fix login", task: null, first_prompt: null, agent_type: null }), "Fix login");
  assert.equal(sessionTitle({ title: null, task: null, first_prompt: "Look at the queue\nand more", agent_type: null }), "Look at the queue");
  assert.equal(sessionTitle({ title: null, task: null, first_prompt: null, agent_type: "Explore" }), "Explore subagent");
  assert.equal(sessionTitle(null), "Untitled session");
});

test("the list's filters are the API's", () => {
  assert.equal(sessionsQuery({ state: "live" }), "state=live");
  assert.equal(sessionsQuery({ state: "ended", person: "ada", repo: "web", item: 4 }), "state=ended&person=ada&repo=web&item=4");
});
