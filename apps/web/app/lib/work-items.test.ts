import assert from "node:assert/strict";
import { test } from "node:test";

import type { ItemRepo } from "@g1t/contracts";

import {
  closeSubItemsOf,
  filterCount,
  emptyListTitle,
  filtered,
  itemNumberOf,
  listPage,
  movedWorkPath,
  newItemPath,
  pageQuery,
  repoChips,
  repoFilter,
  repoWorkPath,
  movedSessionsPath,
  sessionPath,
  sessionsPath,
  shortPath,
  subItemsDone,
  subItemsShare,
  workFilters,
  workListPath,
  workQuery,
} from "./work-items.ts";

const query = (text: string) => new URLSearchParams(text);

test("the Work list's filters come from its address", () => {
  assert.deepEqual(workFilters(query("")), { state: "open", horizon: null, label: "", milestone: null, assignee: "", repo: "", role: null, parent: null });
  assert.deepEqual(workFilters(query("state=closed&label=Bug&milestone=3&assignee=ana&repo=web&role=target")), {
    state: "closed",
    horizon: null,
    label: "bug",
    milestone: 3,
    assignee: "ana",
    repo: "web",
    role: "target",
    parent: null,
  });
  // The same written as a query, which wins over the plain parameters.
  assert.deepEqual(workFilters(query("label=docs&q=is:closed label:bug repo:acme/api role:origin assignee:@bo")), {
    state: "closed",
    horizon: null,
    label: "bug",
    milestone: null,
    assignee: "bo",
    repo: "acme/api",
    role: "origin",
    parent: null,
  });
  // A role says how a repository is linked: without one it is dropped, and an unknown one is none.
  assert.equal(workFilters(query("role=target")).role, null);
  assert.equal(workFilters(query("repo=web&role=owner")).role, null);
  // `@me` is kept for the page to read as the viewer.
  assert.equal(workFilters(query("assignee=@me")).assignee, "@me");
});

test("a horizon of the plan filters the list, written as a parameter or in the query, with a milestone too", () => {
  assert.equal(workFilters(query("horizon=now")).horizon, "now");
  assert.equal(workFilters(query("q=horizon:Next")).horizon, "next");
  assert.equal(workFilters(query("q=is:triage")).horizon, "triage");
  assert.equal(workFilters(query("q=horizon:set-aside")).horizon, "set_aside");
  assert.equal(workFilters(query("horizon=soon")).horizon, null);
  // A horizon holds only open work items.
  assert.deepEqual(workFilters(query("state=closed&horizon=now")).state, "open");
  const both = workFilters(query("q=horizon:next milestone:3"));
  assert.deepEqual([both.horizon, both.milestone], ["next", 3]);
  assert.equal(workQuery(both), "horizon=next&milestone=3");
  assert.equal(workListPath("acme", both, { horizon: null }), "/acme/-/work/all?milestone=3");
  assert.equal(filterCount(both), 2);
  assert.equal(emptyListTitle(workFilters(query("horizon=now")), null), "Nothing in Now");
  assert.equal(emptyListTitle(both, null), "No open work items match these filters");
});

test("the list pages down by the lowest number shown, and back up one page at a time", () => {
  const filters = workFilters(query("label=bug"));
  const first = listPage(query("label=bug"));
  assert.deepEqual(first, { before: null, newer: [] });
  assert.equal(pageQuery(filters, first, { older: 420 }), "?label=bug&before=420");
  const second = listPage(query("label=bug&before=420"));
  assert.deepEqual(second, { before: 420, newer: [] });
  assert.equal(pageQuery(filters, second, { older: 300 }), "?label=bug&before=300&newer=420");
  const third = listPage(query("before=300&newer=420"));
  assert.equal(pageQuery(filters, third, { older: 180 }), "?label=bug&before=180&newer=420.300");
  // Newer: one page up, to the first page from the second.
  assert.equal(pageQuery(filters, listPage(query("before=180&newer=420.300")), "newer"), "?label=bug&before=300&newer=420");
  assert.equal(pageQuery(filters, third, "newer"), "?label=bug&before=420");
  assert.equal(pageQuery(filters, second, "newer"), "?label=bug");
  // Nonsense, or a page above that is not above, is dropped.
  assert.deepEqual(listPage(query("before=x&newer=500")), { before: null, newer: [] });
  assert.deepEqual(listPage(query("before=300&newer=200.abc.400")), { before: 300, newer: [400] });
});

test("the filters go back into the address in one order, leaving out what is unset", () => {
  assert.equal(workQuery({ state: "open" }), "");
  assert.equal(
    workQuery({ state: "closed", label: "bug", repo: "web", role: "target", milestone: 2, assignee: "ana" }),
    "state=closed&repo=web&role=target&label=bug&milestone=2&assignee=ana",
  );
  // A role without a repository means nothing.
  assert.equal(workQuery({ role: "target" }), "");
  const current = workFilters(query("repo=web&label=bug"));
  assert.equal(workListPath("Acme", current), "/acme/-/work/all?repo=web&label=bug");
  assert.equal(workListPath("acme", current, { label: "" }), "/acme/-/work/all?repo=web");
  assert.equal(workListPath("acme", current, { repo: "", role: null }), "/acme/-/work/all?label=bug");
  assert.equal(workListPath("acme", current, { state: "closed" }), "/acme/-/work/all?state=closed&repo=web&label=bug");
});

test("how many filters are on, for the phone's Filters button", () => {
  assert.equal(filterCount(workFilters(query("state=closed"))), 0);
  assert.equal(filtered(workFilters(query("state=closed"))), false);
  assert.equal(filterCount(workFilters(query("repo=web&role=target&label=bug&assignee=ana"))), 3);
  assert.equal(filtered(workFilters(query("milestone=1"))), true);
});

test("the list filters to one item's sub-items, written as parent:N or parent:#N", () => {
  assert.equal(workFilters(query("parent=212")).parent, 212);
  assert.equal(workFilters(query("q=parent:212")).parent, 212);
  assert.equal(workFilters(query("q=is:closed parent:#212")).parent, 212);
  // The query wins, and what is not a number is no filter.
  assert.equal(workFilters(query("parent=5&q=parent:#7")).parent, 7);
  assert.equal(workFilters(query("q=parent:abc")).parent, null);
  assert.equal(workFilters(query("parent=0")).parent, null);
  const subs = workFilters(query("q=parent:#212"));
  assert.equal(workQuery(subs), "parent=212");
  assert.equal(workListPath("acme", subs, { parent: null }), "/acme/-/work/all");
  assert.equal(filterCount(subs), 1);
  assert.equal(filtered(subs), true);
  assert.equal(emptyListTitle(subs, null), "No open sub-items of #212");
  assert.equal(emptyListTitle(workFilters(query("parent=212&label=bug")), null), "No open work items match these filters");
});

test("a work item's number as a person types it", () => {
  assert.equal(itemNumberOf("#212"), 212);
  assert.equal(itemNumberOf(" 212 "), 212);
  assert.equal(itemNumberOf(""), null);
  assert.equal(itemNumberOf(undefined), null);
  assert.equal(itemNumberOf("#"), null);
  assert.equal(itemNumberOf("12a"), undefined);
  assert.equal(itemNumberOf("0"), undefined);
});

test("a parent's progress, and what closing it does with its open sub-items", () => {
  assert.equal(subItemsDone({ done: 3, total: 7 }), "3 of 7 done");
  assert.equal(subItemsShare({ done: 3, total: 7 }), 43);
  assert.equal(subItemsShare({ done: 0, total: 0 }), 0);
  const form = (fields: Record<string, string>) => new URLSearchParams(fields);
  assert.equal(closeSubItemsOf(form({})), null);
  assert.deepEqual(closeSubItemsOf(form({ sub_items: "leave" })), { subItems: "leave" });
  assert.deepEqual(closeSubItemsOf(form({ sub_items: "close", move_to: "9" })), { subItems: "close" });
  assert.deepEqual(closeSubItemsOf(form({ sub_items: "move", move_to: "#212" })), { subItems: "move", moveTo: 212 });
  assert.equal(typeof closeSubItemsOf(form({ sub_items: "move", move_to: "" })), "string");
  assert.equal(closeSubItemsOf(form({ sub_items: "drop" })), null);
});

test("a repository's Work tab, and a new work item filed from it", () => {
  assert.equal(repoWorkPath("acme", "web"), "/acme/-/work/all?repo=web");
  assert.equal(sessionsPath("Acme"), "/acme/-/chat/sessions");
  assert.equal(sessionsPath("acme", { repo: "web", person: null }), "/acme/-/chat/sessions?repo=web");
  assert.equal(sessionPath("Acme", "ses_1"), "/acme/-/chat/sessions/ses_1");
  assert.equal(newItemPath("Acme"), "/acme/-/work/new");
  assert.equal(newItemPath("acme", "web"), "/acme/-/work/new?repo=web");
  assert.equal(newItemPath("acme", "web", 212), "/acme/-/work/new?repo=web&parent=212");
  assert.equal(newItemPath("acme", null, 212), "/acme/-/work/new?parent=212");
  assert.deepEqual(repoFilter("acme", "web"), { namespace: "acme", name: "web" });

  test("sessions' addresses from when they were Work's go to Chat, filters and all", () => {
    assert.equal(movedSessionsPath("/Acme/-/work/sessions"), "/acme/-/chat/sessions");
    assert.equal(movedSessionsPath("/acme/-/work/sessions/", "?state=recent"), "/acme/-/chat/sessions?state=recent");
    assert.equal(movedSessionsPath("/acme/-/work/sessions/ses_1"), "/acme/-/chat/sessions/ses_1");
    assert.equal(movedSessionsPath("/acme/-/work/sessions/ses_1/entries"), null);
    assert.equal(movedSessionsPath("/acme/-/work"), null);
  });
  assert.deepEqual(repoFilter("acme", "Beta/api"), { namespace: "beta", name: "api" });
  assert.equal(repoFilter("acme", "a/b/c"), null);
  assert.equal(shortPath("acme/web", "acme"), "web");
  assert.equal(shortPath("beta/web", "acme"), "beta/web");
});

test("an item's repositories fit a phone: two, then how many more", () => {
  const repo = (path: string, role: ItemRepo["role"]): ItemRepo => ({ repoId: path, path, role, legacyNumber: null, landed: false });
  const repos = [repo("acme/web", "origin"), repo("acme/api", "target"), repo("acme/docs", "target"), repo("acme/cli", "touched")];
  assert.deepEqual(repoChips(repos), { shown: repos.slice(0, 2), more: 2 });
  assert.deepEqual(repoChips(repos.slice(0, 1)), { shown: repos.slice(0, 1), more: 0 });
  assert.deepEqual(repoChips([]), { shown: [], more: 0 });
});

test("old addresses of a repository's issues, labels, milestones and Work page lead on", () => {
  assert.equal(movedWorkPath("/acme/web/issues"), "/acme/-/work/all?repo=web");
  // Its filters come along.
  assert.equal(movedWorkPath("/Acme/web/issues", "?state=closed&label=bug&_routes=x"), "/acme/-/work/all?repo=web&state=closed&label=bug");
  assert.equal(movedWorkPath("/acme/web/issues/new"), "/acme/-/work/new?repo=web");
  // An old issue's number is read in the repository, which only the work service can do.
  assert.deepEqual(movedWorkPath("/acme/web/issues/12"), { resolve: 12 });
  assert.deepEqual(movedWorkPath("/acme/web/issues/12.data"), { resolve: 12 });
  assert.equal(movedWorkPath("/acme/web/issues/0"), null);
  assert.equal(movedWorkPath("/acme/web/issues/x"), null);
  assert.equal(movedWorkPath("/acme/web/issues/12/extra"), null);
  assert.equal(movedWorkPath("/acme/web/labels"), "/acme/-/work/labels");
  // Milestones were numbered again in the workspace: an old one leads to the list.
  assert.equal(movedWorkPath("/acme/web/milestones"), "/acme/-/work/milestones");
  assert.equal(movedWorkPath("/acme/web/milestones/3"), "/acme/-/work/milestones");
  // A repository's old Work and Sessions pages are gone: Sessions is the workspace's.
  assert.equal(movedWorkPath("/acme/web/work"), null);
  assert.equal(movedWorkPath("/acme/web/work/sessions/ses_123"), null);
  assert.equal(movedWorkPath("/acme/web/pulls"), null);
  assert.equal(movedWorkPath("/acme/-/issues"), null);
});

test("an empty Work list names the repository it is filtered to, when that is all it is filtered by", () => {
  const query = (text: string) => workFilters(new URLSearchParams(text));
  assert.equal(emptyListTitle(query("repo=web"), "web"), "No open work items linked to web");
  assert.equal(emptyListTitle(query("repo=web&state=closed&role=target"), "web"), "No closed work items linked to web");
  assert.equal(emptyListTitle(query("repo=web&label=bug"), "web"), "No open work items match these filters");
  assert.equal(emptyListTitle(query("label=bug"), null), "No open work items match these filters");
  assert.equal(emptyListTitle(query(""), null), "No open work items");
  assert.equal(emptyListTitle(query("state=closed"), null), "No closed work items");
});
