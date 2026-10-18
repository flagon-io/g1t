import assert from "node:assert/strict";
import { test } from "node:test";

import { type BoardItem, type BoardSession, boardOf, peopleOn, stageOf } from "./board.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;

function item(number: number, change: Partial<BoardItem> = {}): BoardItem {
  return { number, state: "open", assignees: [], repos: [], closed_at: null, ...change };
}

function target(path: string, landed: boolean) {
  return { repo_id: path, path, role: "target" as const, legacy_number: null, landed };
}

function session(change: Partial<BoardSession>): BoardSession {
  return { item: null, state: "active", actor: "ada", harness: "claude_code", pull: null, pull_status: null, ...change };
}

const none = { pulls: [], sessions: [], now: NOW };

test("an open item nobody is on is in the backlog", () => {
  assert.equal(stageOf(item(1), none), "backlog");
  // A session that ended, or one on another item, puts nobody on it.
  assert.equal(stageOf(item(1), { ...none, sessions: [session({ item: 1, state: "ended" }), session({ item: 2 })] }), "backlog");
  // So does a pull request that merged or closed.
  assert.equal(stageOf(item(1), { ...none, pulls: [{ item: 1, status: "closed" }] }), "backlog");
});

test("an item someone is on, or with a draft, is in progress", () => {
  assert.equal(stageOf(item(1, { assignees: ["ada"] }), none), "in_progress");
  assert.equal(stageOf(item(1, { claimed: true }), none), "in_progress");
  assert.equal(stageOf(item(1), { ...none, sessions: [session({ item: 1 })] }), "in_progress");
  assert.equal(stageOf(item(1), { ...none, sessions: [session({ item: 1, state: "idle" })] }), "in_progress");
  assert.equal(stageOf(item(1), { ...none, pulls: [{ item: 1, status: "draft" }] }), "in_progress");
});

test("an item with an open pull request is in review, even with someone on it", () => {
  assert.equal(stageOf(item(1, { assignees: ["ada"] }), { ...none, pulls: [{ item: 1, status: "open" }] }), "in_review");
  // A session names its pull request's status too.
  assert.equal(stageOf(item(1), { ...none, sessions: [session({ item: 1, pull: 4, pull_status: "open" })] }), "in_review");
  assert.equal(stageOf(item(1), { ...none, pulls: [{ item: 2, status: "open" }] }), "backlog");
});

test("an item landed in some targets but not all is landing, ahead of review", () => {
  const repos = [target("acme/web", true), target("acme/api", false)];
  assert.equal(stageOf(item(1, { repos }), { ...none, pulls: [{ item: 1, status: "open" }] }), "landing");
  // Landed in none of them is not landing.
  assert.equal(stageOf(item(1, { repos: [target("acme/web", false), target("acme/api", false)] }), none), "backlog");
  // Where it only touched does not count.
  const touched = { ...target("acme/docs", true), role: "touched" as const };
  assert.equal(stageOf(item(1, { repos: [touched, target("acme/api", false)] }), none), "backlog");
});

test("an item closed in the last two weeks is done, and older ones are left out", () => {
  assert.equal(stageOf(item(1, { state: "closed", closed_at: new Date(NOW - 3 * DAY).toISOString() }), none), "done");
  assert.equal(stageOf(item(1, { state: "closed", closed_at: new Date(NOW - 15 * DAY).toISOString() }), none), null);
  assert.equal(stageOf(item(1, { state: "closed", closed_at: null }), none), null);
  // Closed as not planned did not ship.
  assert.equal(stageOf(item(1, { state: "closed", reason: "not_planned", closed_at: new Date(NOW - DAY).toISOString() }), none), null);
  // Done wins over everything else.
  const repos = [target("acme/web", true), target("acme/api", false)];
  assert.equal(stageOf(item(1, { state: "closed", repos, closed_at: new Date(NOW - DAY).toISOString() }), { ...none, pulls: [{ item: 1, status: "open" }] }), "done");
});

test("the board puts each item in its stage once, done newest first", () => {
  const items = [
    item(1),
    item(2, { assignees: ["ada"] }),
    item(3, { state: "closed", closed_at: new Date(NOW - 5 * DAY).toISOString() }),
    item(4, { state: "closed", closed_at: new Date(NOW - DAY).toISOString() }),
    item(5, { state: "closed", closed_at: new Date(NOW - 30 * DAY).toISOString() }),
    item(1),
  ];
  const board = boardOf(items, none);
  assert.deepEqual(board.backlog.map((card) => card.item.number), [1]);
  assert.deepEqual(board.in_progress.map((card) => card.item.number), [2]);
  assert.deepEqual(board.done.map((card) => card.item.number), [4, 3]);
  assert.deepEqual([...board.in_review, ...board.landing], []);
});

test("who is on an item: its assignees, then who runs a live session on it, in what", () => {
  const sessions = [
    session({ item: 1, actor: "ada", harness: "claude_code" }),
    session({ item: 1, actor: "bob", harness: "codex" }),
    session({ item: 1, actor: "cy", state: "ended" }),
    session({ item: 2, actor: "dee" }),
  ];
  assert.deepEqual(peopleOn(item(1, { assignees: ["ada"] }), sessions), [
    { name: "ada", harness: "claude_code" },
    { name: "bob", harness: "codex" },
  ]);
});
