import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, ItemRepo, WorkItem, WorkspaceSession } from "@g1t/contracts";

import { boardOf, pullRepos, pullsByItem, shownStage, stageOf } from "./board.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;

function repo(path: string, role: ItemRepo["role"], landed = false): ItemRepo {
  return { repoId: `rep_${path}`, path, role, legacyNumber: null, landed };
}

function item(number: number, more: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `wki_${number}`,
    workspace: "acme",
    number,
    title: `Item ${number}`,
    body: "",
    labels: [],
    state: "open",
    reason: null,
    resolutions: [],
    author: { id: "usr_1", username: "ana" } as WorkItem["author"],
    requestedBy: null,
    createdAt: new Date(NOW - 5 * DAY).toISOString(),
    updatedAt: new Date(NOW - number * 1000).toISOString(),
    closedAt: null,
    pullCount: 0,
    commentCount: 0,
    assignees: [],
    blockedBy: [],
    agent: null,
    repos: [repo("acme/web", "origin")],
    ...more,
  };
}

function live(item: number, more: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    kind: "harness",
    id: `ses_${item}`,
    repo: "acme/web",
    repoId: "rep_acme/web",
    title: null,
    actor: "bo",
    harness: "claude_code",
    agent: null,
    branch: "main",
    item,
    itemTitle: null,
    pull: null,
    pullTitle: null,
    pullStatus: null,
    state: "active",
    startedAt: new Date(NOW).toISOString(),
    lastActivityAt: new Date(NOW).toISOString(),
    subagents: 0,
    step: null,
    session: null,
    ...more,
  };
}

const claim = (number: number, who: string): Claim =>
  ({ id: `clm_${number}`, item: number, workspace: "acme", state: "active", actor: { id: "usr_9", username: who } }) as Claim;

test("each work item's stage is the first that holds: done, landing, review, progress, backlog", () => {
  assert.equal(stageOf(item(1), {}, NOW), "backlog");
  assert.equal(stageOf(item(2, { assignees: ["ana"] }), {}, NOW), "progress");
  assert.equal(stageOf(item(3), { claimed: true }, NOW), "progress");
  assert.equal(stageOf(item(4), { live: true }, NOW), "progress");
  assert.equal(stageOf(item(5), { pulls: ["draft"] }, NOW), "progress");
  assert.equal(stageOf(item(6, { assignees: ["ana"] }), { pulls: ["draft", "open"] }, NOW), "review");
  // Landed in one target, not yet the other: Landing, even with a pull request open.
  const landing = item(7, { repos: [repo("acme/web", "target", true), repo("acme/api", "target")] });
  assert.equal(stageOf(landing, { pulls: ["open"] }, NOW), "landing");
  // A touched repository's landing is not a target's.
  assert.equal(stageOf(item(8, { repos: [repo("acme/web", "touched", true), repo("acme/api", "target")] }), {}, NOW), "backlog");
  assert.equal(stageOf(item(9, { state: "closed", closedAt: new Date(NOW - 3 * DAY).toISOString() }), {}, NOW), "done");
  // Closed long ago: off the board.
  assert.equal(stageOf(item(10, { state: "closed", closedAt: new Date(NOW - 40 * DAY).toISOString() }), {}, NOW), null);
});

test("the board puts each item in its column with who and which session is on it", () => {
  const items = [
    item(1),
    item(2),
    item(3),
    item(4),
    item(5, { state: "closed", closedAt: new Date(NOW - DAY).toISOString() }),
    item(6, { state: "closed", closedAt: new Date(NOW - 2 * DAY).toISOString() }),
  ];
  const board = boardOf(
    items,
    { claims: [claim(2, "cy")], sessions: [live(3, { pull: 9, pullStatus: "open" }), live(1, { state: "ended" })], pulls: pullsByItem([{ item: 4, status: "draft" }, { item: null, status: "open" }]) },
    NOW,
  );
  assert.deepEqual(board.backlog.map((card) => card.item.number), [1]);
  assert.deepEqual(board.progress.map((card) => card.item.number), [2, 4]);
  assert.deepEqual(board.progress[0]!.on.people, ["cy"]);
  // A live session's open pull request puts its item in review, the session on the card.
  assert.deepEqual(board.review.map((card) => card.item.number), [3]);
  assert.deepEqual(board.review[0]!.on.sessions.map((session) => session.id), ["ses_3"]);
  assert.deepEqual(board.review[0]!.on.people, ["bo"]);
  // Done: the most recently closed first.
  assert.deepEqual(board.done.map((card) => card.item.number), [5, 6]);
});

test("a phone shows the stage asked for, else the first with something in it", () => {
  const board = boardOf([item(1, { assignees: ["ana"] })], {}, NOW);
  assert.equal(shownStage("review", board), "review");
  assert.equal(shownStage("nonsense", board), "progress");
  assert.equal(shownStage(null, boardOf([], {}, NOW)), "backlog");
});

test("the board reads open pull requests in every repository an open work item is linked to, each once", () => {
  const items = [
    { state: "open", repos: [{ path: "acme/web" }, { path: "acme/api" }] },
    { state: "open", repos: [{ path: "Acme/Web" }, { path: "acme/repo-21" }] },
    // A closed item's repositories are not read: Done does not need its pull requests.
    { state: "closed", repos: [{ path: "acme/old" }] },
    // A repository deleted before work items kept no path.
    { state: "open", repos: [{ path: "" }] },
  ];
  assert.deepEqual(pullRepos(items), ["acme/web", "acme/api", "acme/repo-21"]);
  // However many there are: none is left out past a limit.
  const many = Array.from({ length: 30 }, (_, index) => ({ state: "open", repos: [{ path: `acme/r${index}` }] }));
  assert.equal(pullRepos(many).length, 30);
});
