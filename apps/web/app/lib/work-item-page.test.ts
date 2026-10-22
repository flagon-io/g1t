import assert from "node:assert/strict";
import { test } from "node:test";

import type { Claim, WorkItem, WorkSession } from "@g1t/contracts";

import {
  ITEM_KEYS,
  activityCounts,
  activityFilterOf,
  activityParts,
  budgetOf,
  itemCommandOf,
  itemStage,
  keyFor,
  neighbours,
  planSummary,
  sameSet,
  toggled,
  trailOf,
  trailState,
  typedNumber,
  typedUsername,
} from "./work-item-page.ts";

test("each property has its key, and the page's keys are letters alone", () => {
  assert.equal(itemCommandOf({ key: "a" }, false), "assignee");
  assert.equal(itemCommandOf({ key: "p" }, false), "project");
  assert.equal(itemCommandOf({ key: "h" }, false), "plan");
  assert.equal(itemCommandOf({ key: "m" }, false), "milestone");
  assert.equal(itemCommandOf({ key: "l" }, false), "labels");
  assert.equal(itemCommandOf({ key: "b" }, false), "blocked");
  assert.equal(itemCommandOf({ key: "d" }, false), "agent");
  assert.equal(itemCommandOf({ key: "e" }, false), "edit");
  assert.equal(itemCommandOf({ key: "i" }, false), "claim");
  assert.equal(itemCommandOf({ key: "j" }, false), "next");
  assert.equal(itemCommandOf({ key: "k" }, false), "previous");
  // Caps Lock on still means the key.
  assert.equal(itemCommandOf({ key: "A" }, false), "assignee");
  assert.equal(itemCommandOf({ key: "x" }, false), null);
  assert.equal(itemCommandOf({ key: "Enter" }, false), null);
});

test("Shift C closes, and Shift with any other letter does nothing", () => {
  assert.equal(itemCommandOf({ key: "C", shiftKey: true }, false), "close");
  assert.equal(itemCommandOf({ key: "c" }, false), null);
  assert.equal(itemCommandOf({ key: "A", shiftKey: true }, false), null);
});

test("no key fires while typing, with a modifier held, or held down", () => {
  assert.equal(itemCommandOf({ key: "a" }, true), null);
  assert.equal(itemCommandOf({ key: "C", shiftKey: true }, true), null);
  assert.equal(itemCommandOf({ key: "k", metaKey: true }, false), null);
  assert.equal(itemCommandOf({ key: "k", ctrlKey: true }, false), null);
  assert.equal(itemCommandOf({ key: "j", altKey: true }, false), null);
  assert.equal(itemCommandOf({ key: "j", repeat: true }, false), null);
});

test("every command the keys give is listed for the shortcuts dialog", () => {
  for (const key of "aphmlbdeijk") {
    const command = itemCommandOf({ key }, false);
    assert.ok(command && ITEM_KEYS.some((one) => one.command === command), key);
    assert.equal(keyFor(command!), key.toUpperCase());
  }
  assert.equal(keyFor("close"), "Shift C");
});

test("the list an item was opened from travels in its link's state and comes back clean", () => {
  const trail = { numbers: [12, 14, 12, 9], label: "All items", href: "/acme/-/work/all" };
  const state = trailState(trail);
  assert.deepEqual(state, { workTrail: { numbers: [12, 14, 9], label: "All items", href: "/acme/-/work/all" } });
  assert.deepEqual(trailOf(state), { numbers: [12, 14, 9], label: "All items", href: "/acme/-/work/all" });
  assert.equal(trailState({ ...trail, numbers: [] }), undefined);
  assert.equal(trailState(null), undefined);
});

test("anything else in the location state is no list", () => {
  assert.equal(trailOf(null), null);
  assert.equal(trailOf("12,14"), null);
  assert.equal(trailOf({ workTrail: { numbers: "12", label: "x", href: "/" } }), null);
  assert.equal(trailOf({ workTrail: { numbers: [0, -1, 1.5], label: "x", href: "/" } }), null);
  assert.deepEqual(trailOf({ workTrail: { numbers: [3, "4", 5], label: "x", href: "/" } }), { numbers: [3, 5], label: "x", href: "/" });
});

test("J and K step to the next and previous item, and stop at the ends", () => {
  assert.deepEqual(neighbours([12, 14, 9], 14), { previous: 12, next: 9, index: 2, total: 3 });
  assert.deepEqual(neighbours([12, 14, 9], 12), { previous: null, next: 14, index: 1, total: 3 });
  assert.deepEqual(neighbours([12, 14, 9], 9), { previous: 14, next: null, index: 3, total: 3 });
  assert.equal(neighbours([12, 14, 9], 30), null);
});

const comment = (id: string, kind: "comment" | "event") => ({ id, kind });

test("Activity's filter keeps comments, events or both", () => {
  const comments = [comment("c1", "comment"), comment("e1", "event"), comment("c2", "comment")];
  const extras = [{ id: "ses_1" }, { id: "claim_1" }];
  assert.deepEqual(activityParts(comments, extras, "all"), { comments, extras });
  assert.deepEqual(activityParts(comments, extras, "comments"), { comments: [comments[0], comments[2]], extras: [] });
  assert.deepEqual(activityParts(comments, extras, "events"), { comments: [comments[1]], extras });
  assert.deepEqual(activityCounts(comments, extras.length), { all: 5, comments: 2, events: 3 });
  assert.equal(activityFilterOf("events"), "events");
  assert.equal(activityFilterOf("everything"), "all");
  assert.equal(activityFilterOf(null), "all");
});

const item = (over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: "wki_1",
    workspace: "acme",
    number: 12,
    title: "Item page",
    body: "",
    labels: [],
    state: "open",
    reason: null,
    resolutions: [],
    author: { id: "usr_1", username: "ana" },
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
    horizon: "now",
    appetite: null,
    budgetUsd: null,
    urgent: false,
    plannedAt: null,
    ...over,
  }) as WorkItem;

const now = Date.parse("2026-10-21T00:00:00Z");

test("the stage says why: a pull request open is in review", () => {
  const stage = itemStage(item(), { repos: [{ path: "acme/web", pulls: [{ number: 318, status: "open" }] }] }, now);
  assert.deepEqual(stage, { stage: "review", label: "In review", why: "#318 open in acme/web" });
});

test("claimed, a session on it, or a draft is in progress, saying which", () => {
  const claim = { state: "active", actor: { username: "ana" } } as Claim;
  const session = { state: "active", parentId: null } as WorkSession;
  const stage = itemStage(item(), { claims: [claim], sessions: [session], repos: [{ path: "acme/web", pulls: [{ number: 4, status: "draft" }] }] }, now);
  assert.equal(stage.stage, "progress");
  assert.equal(stage.why, "Claimed by ana, a session on it, #4 draft in acme/web");
  assert.equal(itemStage(item({ assignees: ["bo"] }), {}, now).why, "Assigned to bo");
});

test("nobody on it is up next; landing names what is still to land; closed ones say how", () => {
  assert.deepEqual(itemStage(item(), {}, now), { stage: "next", label: "Up next", why: "Nobody is on it yet" });
  const landing = item({
    repos: [
      { repoId: "r1", path: "acme/web", role: "target", landed: true },
      { repoId: "r2", path: "acme/api", role: "target", landed: false },
    ] as WorkItem["repos"],
  });
  assert.equal(itemStage(landing, {}, now).why, "Still to land in acme/api");
  const done = item({
    state: "closed",
    reason: "completed",
    closedAt: "2026-10-20T00:00:00Z",
    resolutions: [{ repo: "acme/web", pull: 3 }] as WorkItem["resolutions"],
  });
  assert.deepEqual(itemStage(done, {}, now), { stage: "done", label: "Done", why: "Landed in acme/web" });
  assert.equal(itemStage(item({ state: "closed", reason: "not_planned", closedAt: "2026-10-20T00:00:00Z" }), {}, now).why, "Closed as not planned");
});

test("the pickers read a budget, a number and a username from what is typed", () => {
  assert.equal(budgetOf("5"), 5);
  assert.equal(budgetOf("$12.50"), 12.5);
  assert.equal(budgetOf("none"), null);
  assert.equal(budgetOf("now"), undefined);
  assert.equal(budgetOf("0"), undefined);
  assert.equal(budgetOf("1.234"), undefined);
  assert.equal(typedNumber("#212"), 212);
  assert.equal(typedNumber("212"), 212);
  assert.equal(typedNumber("#0"), null);
  assert.equal(typedNumber("fix 212"), null);
  assert.equal(typedUsername("@Ana"), "ana");
  assert.equal(typedUsername("bo-2"), "bo-2");
  assert.equal(typedUsername("two words"), null);
  assert.equal(typedUsername(""), null);
});

test("a multi-choice picker toggles and saves only a change", () => {
  assert.deepEqual(toggled(["a", "b"], "b"), ["a"]);
  assert.deepEqual(toggled(["a"], "b"), ["a", "b"]);
  assert.equal(sameSet(["a", "b"], ["b", "a"]), true);
  assert.equal(sameSet(["a"], ["a", "b"]), false);
});

test("the plan reads as one line", () => {
  const label = (h: string) => ({ now: "Now", next: "Next" })[h as "now"] ?? h;
  assert.equal(planSummary({ horizon: "now", appetite: "medium", budgetUsd: 5, urgent: false }, label), "Now · M · $5");
  assert.equal(planSummary({ horizon: "next", appetite: null, budgetUsd: 2.5, urgent: true }, label), "Next · $2.50 · Urgent");
});
