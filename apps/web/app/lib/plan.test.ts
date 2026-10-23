import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, WorkItem, WorkspaceSession } from "@g1t/contracts";

import {
  type PlanView,
  acceptForm,
  allItemsPath,
  applyMove,
  blockersToRead,
  budgetText,
  canAccept,
  capState,
  daysSince,
  duplicateComment,
  dropPosition,
  groupSubItems,
  hillStep,
  listRedirect,
  menuHorizons,
  moreText,
  moveDown,
  moveForm,
  moveFrom,
  moveUp,
  onItems,
  parseBudget,
  planInput,
  planOptions,
  planOptionsPath,
  planPath,
  progressOf,
  quietLine,
  quietText,
  setAsideLine,
  setAsidePath,
  suggestionText,
  triageLine,
  triagePath,
  waitingLabel,
  waitingOn,
} from "./plan.ts";

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
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    pullCount: 0,
    commentCount: 0,
    assignees: [],
    blockedBy: [],
    agent: null,
    repos: [],
    horizon: "next",
    appetite: null,
    budgetUsd: null,
    urgent: false,
    plannedAt: null,
    ...more,
  };
}

function view(more: Partial<PlanView> = {}): PlanView {
  return {
    now: [item(1, { horizon: "now" }), item(2, { horizon: "now" })],
    next: [item(3), item(4), item(5)],
    nextTotal: 3,
    laterTotal: 4,
    later: [
      { repo: "acme/web", count: 3 },
      { repo: null, count: 1 },
    ],
    setAsideTotal: 0,
    triageTotal: 2,
    ...more,
  };
}

const numbers = (items: WorkItem[]) => items.map((one) => one.number);

test("the Plan, Triage and All items have their own addresses", () => {
  assert.equal(planPath("Acme"), "/acme/-/work");
  assert.equal(planPath("acme", "all=1"), "/acme/-/work?all=1");
  assert.equal(triagePath("acme"), "/acme/-/work/triage");
  assert.equal(allItemsPath("acme", "state=closed"), "/acme/-/work/all?state=closed");
  assert.equal(setAsidePath("acme"), "/acme/-/work/all?q=horizon%3Aset_aside");
});

test("an old link to the list with filters goes to All items with the same query", () => {
  const at = (query: string) => listRedirect("acme", new URLSearchParams(query));
  assert.equal(at(""), null);
  assert.equal(at("all=1"), null);
  assert.equal(at("_routes=x"), null);
  assert.equal(at("state=closed"), "/acme/-/work/all?state=closed");
  assert.equal(at("repo=web&label=bug"), "/acme/-/work/all?repo=web&label=bug");
  assert.equal(at("q=is%3Aclosed+label%3Abug"), "/acme/-/work/all?q=is%3Aclosed+label%3Abug");
  assert.equal(at("assignee=ana"), "/acme/-/work/all?assignee=ana");
  assert.equal(at("milestone=3&_routes=x"), "/acme/-/work/all?milestone=3");
  assert.equal(at("group=1&all=1"), null);
  assert.equal(at("parent=212"), "/acme/-/work/all?parent=212");
});

test("Now's cap says how full it is and warns only past it", () => {
  assert.deepEqual(capState(3, 6), { count: 3, cap: 6, share: 0.5, full: false, over: false });
  assert.deepEqual(capState(6, 6), { count: 6, cap: 6, share: 1, full: true, over: false });
  assert.deepEqual(capState(8, 6), { count: 8, cap: 6, share: 1, full: true, over: true });
  assert.equal(capState(0, 0).cap, 1);
});

test("a drop lands before the row under it, or after the last", () => {
  const list = [3, 4, 5];
  // From outside the list.
  assert.deepEqual(dropPosition(list, 0, 9), { before: 3 });
  assert.deepEqual(dropPosition(list, 2, 9), { before: 5 });
  assert.deepEqual(dropPosition(list, 3, 9), { after: 5 });
  assert.deepEqual(dropPosition([], 0, 9), {});
  // Within the list: where it is already is no move.
  assert.equal(dropPosition(list, 0, 3), null);
  assert.equal(dropPosition(list, 1, 3), null);
  assert.deepEqual(dropPosition(list, 3, 3), { after: 5 });
  assert.deepEqual(dropPosition(list, 2, 3), { before: 5 });
  assert.deepEqual(dropPosition(list, 0, 5), { before: 3 });
  assert.deepEqual(dropPosition(list, 1, 5), { before: 4 });
  assert.equal(dropPosition([3], 1, 3), null);
});

test("moving up and down is before the one above, after the one below", () => {
  assert.deepEqual(moveUp([3, 4, 5], 4), { before: 3 });
  assert.equal(moveUp([3, 4, 5], 3), null);
  assert.deepEqual(moveDown([3, 4, 5], 4), { after: 5 });
  assert.equal(moveDown([3, 4, 5], 5), null);
  assert.equal(moveDown([3, 4, 5], 9), null);
});

test("a move shows at once where it lands", () => {
  // Within Next.
  assert.deepEqual(numbers(applyMove(view(), { number: 5, horizon: "next", top: true }).next), [5, 3, 4]);
  assert.deepEqual(numbers(applyMove(view(), { number: 3, horizon: "next", after: 4 }).next), [4, 3, 5]);
  // From Next into Now, before a row.
  const into = applyMove(view(), { number: 4, horizon: "now", before: 2 });
  assert.deepEqual(numbers(into.now), [1, 4, 2]);
  assert.equal(into.now[1]!.horizon, "now");
  assert.deepEqual(numbers(into.next), [3, 5]);
  assert.equal(into.nextTotal, 2);
  // Out of Now to the bottom of Next, all of which is shown.
  const out = applyMove(view(), { number: 1, horizon: "next" });
  assert.deepEqual(numbers(out.next), [3, 4, 5, 1]);
  assert.equal(out.nextTotal, 4);
  // To the bottom of a Next that shows only its top: only counted.
  const deep = applyMove(view({ nextTotal: 30 }), { number: 1, horizon: "next" });
  assert.deepEqual(numbers(deep.next), [3, 4, 5]);
  assert.equal(deep.nextTotal, 31);
  // To Later: counted in its group.
  const later = applyMove(view(), { number: 3, horizon: "later" });
  assert.deepEqual(numbers(later.next), [4, 5]);
  assert.equal(later.laterTotal, 5);
  assert.deepEqual(later.later, [
    { repo: "acme/web", count: 3 },
    { repo: null, count: 2 },
  ]);
  const filed = item(6, { repos: [{ repoId: "rep_1", path: "acme/api", role: "origin", legacyNumber: null, landed: false }] });
  assert.deepEqual(applyMove(view({ next: [filed], nextTotal: 1 }), { number: 6, horizon: "later" }).later.at(-1), { repo: "acme/api", count: 1 });
  // Filed in a deleted repository: counted with the workspace's, as the plan counts it.
  const orphan = item(8, { repos: [{ repoId: "rep_2", path: "acme/gone", role: "origin", legacyNumber: null, landed: false, deleted: true }] });
  assert.deepEqual(applyMove(view({ next: [orphan], nextTotal: 1 }), { number: 8, horizon: "later" }).later, [
    { repo: "acme/web", count: 3 },
    { repo: null, count: 2 },
  ]);
  // From an open Later group into Next: it leaves Later's count and its group.
  const fromLater = item(7, { horizon: "later" });
  const pulled = applyMove(view(), { number: 7, horizon: "next", before: 4 }, fromLater);
  assert.deepEqual(numbers(pulled.next), [3, 7, 4, 5]);
  assert.equal(pulled.laterTotal, 3);
  assert.deepEqual(pulled.later, [{ repo: "acme/web", count: 3 }]);
  const same = view();
  assert.equal(applyMove(same, { number: 7, horizon: "later" }, fromLater), same);
  // Set aside and Triage.
  assert.equal(applyMove(view(), { number: 3, horizon: "set_aside" }).setAsideTotal, 1);
  assert.equal(applyMove(view(), { number: 2, horizon: "triage" }).triageTotal, 3);
});

test("a row's menu offers Now only to who may move work into or out of it", () => {
  assert.deepEqual(menuHorizons("next", true), ["triage", "now", "later", "set_aside"]);
  assert.deepEqual(menuHorizons("next", false), ["triage", "later", "set_aside"]);
  assert.deepEqual(menuHorizons("now", false), []);
  assert.deepEqual(menuHorizons("now", true), ["triage", "next", "later", "set_aside"]);
});

test("who is on an item: assignees, claimants and live sessions, each once", () => {
  const claim = { item: 3, state: "active", actor: { id: "usr_2", username: "bo" } } as Claim;
  const ended = { item: 3, state: "released", actor: { id: "usr_3", username: "cy" } } as Claim;
  const live = { id: "ses_1", item: 3, state: "active", actor: "ana" } as WorkspaceSession;
  const gone = { id: "ses_2", item: 3, state: "ended", actor: "di" } as WorkspaceSession;
  const on = onItems([item(3, { assignees: ["ana"] }), item(4)], [claim, ended], [live, gone]);
  assert.deepEqual(on[3]!.people, ["ana", "bo"]);
  assert.deepEqual(on[3]!.sessions, [live]);
  assert.deepEqual(on[4], { people: [], sessions: [] });
});

test("what an item waits on", () => {
  const items = [item(3, { blockedBy: [1, 7] }), item(4, { blockedBy: [7, 8] })];
  assert.deepEqual(blockersToRead(items, new Set([1])), [7, 8]);
  assert.deepEqual(blockersToRead(items, new Set(), 2), [1, 7]);
  assert.deepEqual(waitingOn(items[1]!, new Set([8])), [7]);
  assert.equal(waitingLabel([7, 8]), "waiting on #7, #8");
});

test("a move from a form", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  assert.deepEqual(planInput(form({ horizon: "now", before: "4" })), { horizon: "now", before: 4 });
  assert.deepEqual(planInput(form({ horizon: "next", after: "9" })), { horizon: "next", after: 9 });
  assert.deepEqual(planInput(form({ horizon: "next", top: "1", before: "4" })), { horizon: "next", top: true });
  assert.deepEqual(planInput(form({ appetite: "none" })), { appetite: null });
  assert.deepEqual(planInput(form({ appetite: "medium", budget: "$1,200" })), { appetite: "medium", budget_usd: 1200 });
  assert.deepEqual(planInput(form({ budget: "" })), { budget_usd: null });
  assert.deepEqual(planInput(form({ urgent: "1" })), { urgent: true });
  assert.deepEqual(planInput(form({ urgent: "0" })), { urgent: false });
  assert.equal(typeof planInput(form({ horizon: "someday" })), "string");
  assert.equal(typeof planInput(form({ before: "x" })), "string");
  assert.equal(typeof planInput(form({ appetite: "huge" })), "string");
  // And back: a move as its fetcher posts it.
  assert.deepEqual(moveForm({ number: 4, horizon: "now", before: 2 }), { action: "plan", number: "4", horizon: "now", before: "2" });
  assert.deepEqual(moveForm({ number: 4, horizon: "next", top: true }), { action: "plan", number: "4", horizon: "next", top: "1" });
  assert.deepEqual(moveForm({ number: 4, horizon: "later" }), { action: "plan", number: "4", horizon: "later" });
  assert.deepEqual(moveFrom(form(moveForm({ number: 4, horizon: "now", before: 2 }))), { number: 4, horizon: "now", before: 2 });
  assert.deepEqual(moveFrom(form(moveForm({ number: 4, horizon: "next", after: 9 }))), { number: 4, horizon: "next", after: 9 });
  assert.deepEqual(moveFrom(form(moveForm({ number: 4, horizon: "next", top: true }))), { number: 4, horizon: "next", top: true });
  assert.deepEqual(moveFrom(form({ number: "4", horizon: "later" })), { number: 4, horizon: "later" });
  assert.equal(moveFrom(form({ number: "4", appetite: "small" })), null);
});

test("budgets", () => {
  assert.equal(parseBudget("40"), 40);
  assert.equal(parseBudget(" $12.345 "), 12.35);
  assert.equal(parseBudget(""), null);
  assert.equal(typeof parseBudget("0"), "string");
  assert.equal(typeof parseBudget("-5"), "string");
  assert.equal(typeof parseBudget("200000"), "string");
  assert.equal(typeof parseBudget("ten"), "string");
  assert.equal(budgetText(40), "$40");
  assert.equal(budgetText(12.5), "$12.50");
  assert.equal(budgetText(1200), "$1,200");
});

test("n more", () => {
  assert.equal(moreText(10, 10), null);
  assert.equal(moreText(10, 1234), "1,224 more");
});

test("a hill's stage, in its four steps", () => {
  assert.deepEqual((["figuring_out", "decided", "building", "landing"] as const).map(hillStep), [0, 1, 2, 3]);
});

test("a quiet row says for how long, from the last time anything happened on it", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(daysSince("2026-10-13T11:00:00Z", now), 6);
  assert.equal(daysSince(null, now), null);
  assert.equal(daysSince("2026-10-20T00:00:00Z", now), 0);
  assert.equal(quietText({ quiet: true, activeAt: "2026-10-13T11:00:00Z" }, now), "Quiet for 6 days");
  assert.equal(quietText({ quiet: true, activeAt: "2026-10-18T11:00:00Z" }, now), "Quiet for 1 day");
  assert.equal(quietText({ quiet: true, activeAt: null }, now), "Quiet");
  assert.equal(quietText({ quiet: false, activeAt: "2026-10-01T00:00:00Z" }, now), null);
});

test("the week: what went quiet, what was let go, and Triage waiting", () => {
  assert.equal(quietLine(0), null);
  assert.equal(quietLine(1), "1 in Now has gone quiet, with nothing happening on it for 5 days or more.");
  assert.equal(quietLine(3), "3 in Now have gone quiet, with nothing happening on them for 5 days or more.");
  assert.equal(setAsideLine(0), null);
  assert.equal(setAsideLine(4), "4 set aside in the last 30 days, untouched for 90 days in Later");
  assert.equal(triageLine(1, 0), "1 new work item waits in Triage to be placed.");
  assert.equal(triageLine(5, 2), "5 new work items wait in Triage to be placed. 2 of them have waited more than a week.");
  assert.equal(triageLine(3, 3), "3 new work items wait in Triage to be placed. All have waited more than a week.");
  assert.equal(triageLine(1, 1), "1 new work item waits in Triage to be placed. It has waited more than a week.");
  assert.deepEqual(progressOf([{ number: 4, hill: "building" }]), { 4: { number: 4, hill: "building" } });
});

test("accepting a suggestion moves it where it says, at the bottom, with its appetite", () => {
  const next = { horizon: "next" as const, appetite: "medium" as const };
  assert.equal(suggestionText(next), "Next · M");
  assert.equal(suggestionText({ horizon: "later", appetite: null }), "Later");
  assert.deepEqual(acceptForm(next), { horizon: "next", appetite: "medium" });
  assert.deepEqual(acceptForm({ horizon: "later", appetite: null }), { horizon: "later" });
  // It is a plan move as the form posts it: no position, so the horizon puts it at the bottom.
  assert.deepEqual(planInput(new URLSearchParams(acceptForm(next))), { horizon: "next", appetite: "medium" });
  assert.equal(canAccept({ horizon: "now" }, false), false);
  assert.equal(canAccept({ horizon: "now" }, true), true);
  assert.equal(canAccept({ horizon: "next" }, false), true);
  assert.equal(duplicateComment(12), "Duplicate of #12");
});

test("the Plan keeps its options in its address", () => {
  assert.deepEqual(planOptions(new URLSearchParams("")), { all: false, group: false });
  assert.deepEqual(planOptions(new URLSearchParams("all=1&group=1")), { all: true, group: true });
  assert.equal(planOptionsPath("acme", { all: false, group: false }, { group: true }), "/acme/-/work?group=1");
  assert.equal(planOptionsPath("acme", { all: true, group: true }, { all: false }), "/acme/-/work?group=1");
  assert.equal(planOptionsPath("acme", { all: true, group: true }, { group: false }), "/acme/-/work?all=1");
});

test("grouped, a sub-item sits under its parent when both are in the horizon, and the rest stay in order", () => {
  const rows = (items: WorkItem[]) => groupSubItems(items).map((row) => [row.item.number, row.depth, row.index]);
  // #3 is under #1, #4 under #3; #5's parent is not in this horizon, so it stays where it is.
  const items = [item(1), item(2), item(3, { parent: 1 }), item(4, { parent: 3 }), item(5, { parent: 99 })];
  assert.deepEqual(rows(items), [
    [1, 0, 0],
    [3, 1, 2],
    [4, 2, 3],
    [2, 0, 1],
    [5, 0, 4],
  ]);
  // A sub-item ranked above its parent still goes under it.
  assert.deepEqual(rows([item(7, { parent: 8 }), item(8)]), [
    [8, 0, 1],
    [7, 1, 0],
  ]);
  // A loop starts from its first item rather than being lost.
  assert.deepEqual(rows([item(1, { parent: 2 }), item(2, { parent: 1 })]), [
    [1, 0, 0],
    [2, 1, 1],
  ]);
});
