import assert from "node:assert/strict";
import { test } from "node:test";

import type { ItemRepo } from "@g1t/contracts";

import {
  filterCount,
  filtered,
  movedWorkPath,
  newItemPath,
  repoChips,
  repoFilter,
  repoWorkPath,
  sessionPath,
  sessionsPath,
  shortPath,
  workFilters,
  workListPath,
  workQuery,
} from "./work-items.ts";

const query = (text: string) => new URLSearchParams(text);

test("the Work list's filters come from its address", () => {
  assert.deepEqual(workFilters(query("")), { state: "open", label: "", milestone: null, assignee: "", repo: "", role: null });
  assert.deepEqual(workFilters(query("state=closed&label=Bug&milestone=3&assignee=ana&repo=web&role=target")), {
    state: "closed",
    label: "bug",
    milestone: 3,
    assignee: "ana",
    repo: "web",
    role: "target",
  });
  // The same written as a query, which wins over the plain parameters.
  assert.deepEqual(workFilters(query("label=docs&q=is:closed label:bug repo:acme/api role:origin assignee:@bo")), {
    state: "closed",
    label: "bug",
    milestone: null,
    assignee: "bo",
    repo: "acme/api",
    role: "origin",
  });
  // A role says how a repository is linked: without one it is dropped, and an unknown one is none.
  assert.equal(workFilters(query("role=target")).role, null);
  assert.equal(workFilters(query("repo=web&role=owner")).role, null);
  // `@me` is kept for the page to read as the viewer.
  assert.equal(workFilters(query("assignee=@me")).assignee, "@me");
});

test("the filters go back into the address in one order, leaving out what is unset", () => {
  assert.equal(workQuery({ state: "open" }), "");
  assert.equal(workQuery({ state: "closed", label: "bug", repo: "web", role: "target", milestone: 2, assignee: "ana" }), "state=closed&repo=web&role=target&label=bug&milestone=2&assignee=ana");
  // A role without a repository means nothing.
  assert.equal(workQuery({ role: "target" }), "");
  const current = workFilters(query("repo=web&label=bug"));
  assert.equal(workListPath("Acme", current), "/acme/-/work?repo=web&label=bug");
  assert.equal(workListPath("acme", current, { label: "" }), "/acme/-/work?repo=web");
  assert.equal(workListPath("acme", current, { repo: "", role: null }), "/acme/-/work?label=bug");
  assert.equal(workListPath("acme", current, { state: "closed" }), "/acme/-/work?state=closed&repo=web&label=bug");
});

test("how many filters are on, for the phone's Filters button", () => {
  assert.equal(filterCount(workFilters(query("state=closed"))), 0);
  assert.equal(filtered(workFilters(query("state=closed"))), false);
  assert.equal(filterCount(workFilters(query("repo=web&role=target&label=bug&assignee=ana"))), 3);
  assert.equal(filtered(workFilters(query("milestone=1"))), true);
});

test("a repository's Work tab, and a new work item filed from it", () => {
  assert.equal(repoWorkPath("acme", "web"), "/acme/-/work?repo=web");
  assert.equal(sessionsPath("Acme"), "/acme/-/work/sessions");
  assert.equal(sessionsPath("acme", { repo: "web", person: null }), "/acme/-/work/sessions?repo=web");
  assert.equal(sessionPath("Acme", "ses_1"), "/acme/-/work/sessions/ses_1");
  assert.equal(newItemPath("Acme"), "/acme/-/work/new");
  assert.equal(newItemPath("acme", "web"), "/acme/-/work/new?repo=web");
  assert.deepEqual(repoFilter("acme", "web"), { namespace: "acme", name: "web" });
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
  assert.equal(movedWorkPath("/acme/web/issues"), "/acme/-/work?repo=web");
  // Its filters come along.
  assert.equal(movedWorkPath("/Acme/web/issues", "?state=closed&label=bug&_routes=x"), "/acme/-/work?repo=web&state=closed&label=bug");
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
