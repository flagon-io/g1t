import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, ItemRepo, WorkItem, WorkspaceSession } from "@g1t/contracts";

import { type ItemPull, boardOf, cappedNotes, pullRepos, pullsByItem, readPages, shownStage, stageOf } from "./board.ts";

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

/** Pull requests of these statuses, each its own, closing the item unless `part`. */
const pr = (...statuses: (ItemPull["status"] | `part:${ItemPull["status"]}`)[]): ItemPull[] =>
  statuses.map((status, index) => {
    const part = status.startsWith("part:");
    return { key: `acme/web#${index + 100}`, status: (part ? status.slice(5) : status) as ItemPull["status"], part };
  });

const claim = (number: number, who: string): Claim =>
  ({ id: `clm_${number}`, item: number, workspace: "acme", state: "active", actor: { id: "usr_9", username: who } }) as Claim;

test("each work item's stage is the first that holds: done, landing, review, progress, backlog", () => {
  assert.equal(stageOf(item(1), {}, NOW), "backlog");
  assert.equal(stageOf(item(2, { assignees: ["ana"] }), {}, NOW), "progress");
  assert.equal(stageOf(item(3), { claimed: true }, NOW), "progress");
  assert.equal(stageOf(item(4), { live: true }, NOW), "progress");
  assert.equal(stageOf(item(5), { pulls: pr("draft") }, NOW), "progress");
  assert.equal(stageOf(item(6, { assignees: ["ana"] }), { pulls: pr("draft", "open") }, NOW), "review");
  // Landed in one target, not yet the other: Landing, even with a pull request open.
  const landing = item(7, { repos: [repo("acme/web", "target", true), repo("acme/api", "target")] });
  assert.equal(stageOf(landing, { pulls: pr("open") }, NOW), "landing");
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
    {
      claims: [claim(2, "cy")],
      sessions: [live(3, { pull: 9, pullStatus: "open" }), live(1, { state: "ended" })],
      pulls: pullsByItem([
        { repo: "acme/web", number: 20, item: 4, status: "draft" },
        { repo: "acme/web", number: 21, item: null, status: "open" },
      ]),
    },
    NOW,
  );
  assert.deepEqual(
    board.backlog.map((card) => card.item.number),
    [1],
  );
  assert.deepEqual(
    board.progress.map((card) => card.item.number),
    [2, 4],
  );
  assert.deepEqual(board.progress[0]!.on.people, ["cy"]);
  // A live session's open pull request puts its item in review, the session on the card.
  assert.deepEqual(
    board.review.map((card) => card.item.number),
    [3],
  );
  assert.deepEqual(
    board.review[0]!.on.sessions.map((session) => session.id),
    ["ses_3"],
  );
  assert.deepEqual(board.review[0]!.on.people, ["bo"]);
  // Done: the most recently closed first.
  assert.deepEqual(
    board.done.map((card) => card.item.number),
    [5, 6],
  );
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
    // One deleted and not yet purged keeps its path, and has nothing to read.
    { state: "open", repos: [{ path: "acme/hello", deleted: true }] },
  ];
  assert.deepEqual(pullRepos(items), ["acme/web", "acme/api", "acme/repo-21"]);
  // However many there are: none is left out past a limit.
  const many = Array.from({ length: 30 }, (_, index) => ({ state: "open", repos: [{ path: `acme/r${index}` }] }));
  assert.equal(pullRepos(many).length, 30);
});

test("closed as not planned, a duplicate among them, is not Done: it did not ship", () => {
  const closed = { state: "closed" as const, closedAt: new Date(NOW - DAY).toISOString() };
  assert.equal(stageOf(item(1, { ...closed, reason: "completed" }), {}, NOW), "done");
  assert.equal(stageOf(item(2, { ...closed, reason: "not_planned" }), {}, NOW), null);
  const board = boardOf([item(1, { ...closed, reason: "completed" }), item(2, { ...closed, reason: "not_planned" })], {}, NOW);
  assert.deepEqual(
    board.done.map((card) => card.item.number),
    [1],
  );
});

test("a merged pull request keeps an open item on the board: Landing with a target to land, else In progress", () => {
  const target = [repo("acme/web", "origin"), repo("acme/api", "target")];
  // It closes the item and merged, but not in the target: still to land there.
  assert.equal(stageOf(item(1, { repos: target }), { pulls: pr("merged") }, NOW), "landing");
  // Only part of it merged: more work to come.
  assert.equal(stageOf(item(2, { repos: target }), { pulls: pr("part:merged") }, NOW), "progress");
  // No target left to land, still open (merged into another branch, or reopened).
  assert.equal(stageOf(item(3), { pulls: pr("merged") }, NOW), "progress");
  // An open pull request beside a merged part: In review.
  assert.equal(stageOf(item(4), { pulls: pr("part:merged", "open") }, NOW), "review");
  // Nothing merged or open: where its claims put it.
  assert.equal(stageOf(item(5, { repos: target }), { pulls: pr("closed") }, NOW), "backlog");
});

test("a pull request counts for its item, the items it closes and those it is part of, once each", () => {
  const by = pullsByItem([
    { repo: "acme/web", number: 158, item: 7, status: "merged", closes: [7, 8], parts: [9, 8] },
    { repo: "Acme/Web", number: 158, item: 7, status: "merged", closes: [7] },
    { repo: "acme/api", number: 3, item: null, status: "open", parts: [9] },
  ]);
  assert.deepEqual(by[7], [{ key: "acme/web#158", status: "merged", part: false }]);
  assert.deepEqual(by[8], [{ key: "acme/web#158", status: "merged", part: false }]);
  assert.deepEqual(by[9], [
    { key: "acme/web#158", status: "merged", part: true },
    { key: "acme/api#3", status: "open", part: true },
  ]);
});

test("a card says how many of its pull requests merged, counting a live session's once", () => {
  const items = [item(1), item(2, { state: "closed", closedAt: new Date(NOW).toISOString() })];
  const pulls = pullsByItem([
    { repo: "acme/web", number: 30, item: 1, status: "merged" },
    { repo: "acme/web", number: 31, item: null, status: "merged", parts: [1] },
    { repo: "acme/web", number: 32, item: 2, status: "merged" },
  ]);
  const board = boardOf(items, { sessions: [live(1, { pull: 30, pullStatus: "merged" })], pulls }, NOW);
  assert.equal(board.progress[0]!.merged, 2);
  // A closed one's are not counted: it is Done.
  assert.equal(board.done[0]!.merged, 0);
});

test("every page is read, each below the last one's lowest number, up to a ceiling the board then names", async () => {
  const numbers = Array.from({ length: 250 }, (_, index) => ({ number: 250 - index }));
  const asked: (number | undefined)[] = [];
  const read = async (before: number | undefined) => {
    asked.push(before);
    return numbers.filter((row) => before == null || row.number < before).slice(0, 100);
  };
  const all = await readPages(read, 100, 10);
  assert.equal(all.rows.length, 250);
  assert.equal(all.capped, false);
  assert.deepEqual(asked, [undefined, 151, 51]);
  const some = await readPages(read, 100, 2);
  assert.equal(some.rows.length, 200);
  assert.equal(some.capped, true);
  // An exact page then nothing: one more read says it is the end.
  const exact = await readPages(async (before) => (before == null ? numbers.slice(0, 100) : []), 100, 10);
  assert.deepEqual([exact.rows.length, exact.capped], [100, false]);
});

test("what the board read only in part, it says", () => {
  assert.deepEqual(cappedNotes({ items: null, done: null, pulls: [] }), []);
  assert.deepEqual(cappedNotes({ items: 1000, done: 100, pulls: ["acme/web"] }), [
    "Showing the newest 1,000 open work items. Older ones are on the Work list.",
    "Done shows the 100 most recently closed.",
    "Only the newest pull requests in acme/web were read, so some work items may stand a column early.",
  ]);
  assert.match(cappedNotes({ items: null, done: null, pulls: ["acme/web", "acme/api"] })[0]!, /in 2 repositories/);
});
