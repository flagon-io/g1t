import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_QUERY,
  type Listed,
  PAGE_SIZE,
  facetsOf,
  filterProjects,
  isFiltered,
  nextRow,
  pageOf,
  projectQueryString,
  readProjectQuery,
} from "./project-list.ts";

function project(slug: string, more: Partial<Listed> = {}): Listed {
  return {
    id: `prj_${slug}`,
    slug,
    name: slug,
    description: null,
    private: false,
    archived: false,
    kind: "app",
    ecosystem: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    pushedAt: null,
    activity: 0,
    deploying: false,
    ...more,
  };
}

const q = (search: string) => readProjectQuery(new URLSearchParams(search));

test("an empty address is the default list", () => {
  assert.deepEqual(q(""), DEFAULT_QUERY);
  assert.equal(projectQueryString(DEFAULT_QUERY), "");
  assert.equal(isFiltered(DEFAULT_QUERY), false);
});

test("what the address says is read, and nonsense is the default", () => {
  const query = q("q=%20api%20&visibility=private&kind=library&language=Rust&deployments=on&archived=only&sort=active&view=grid&page=3");
  assert.deepEqual(query, {
    q: "api",
    visibility: "private",
    kind: "library",
    language: "Rust",
    deployments: true,
    archived: "only",
    sort: "active",
    view: "grid",
    page: 3,
  });
  assert.deepEqual(q("visibility=secret&sort=random&page=-2&view=table"), DEFAULT_QUERY);
});

test("the address round-trips, and a change goes back to page one", () => {
  const query = q("q=web&sort=name&page=4");
  assert.equal(projectQueryString(query, { page: 4 }), "?q=web&sort=name&page=4");
  assert.equal(projectQueryString(query, { kind: "library" }), "?q=web&kind=library&sort=name");
  assert.deepEqual(q(projectQueryString(query, { page: 4 }).slice(1)), query);
});

test("archived projects are left out unless asked for", () => {
  const list = [project("live"), project("old", { archived: true })];
  assert.deepEqual(filterProjects(list, DEFAULT_QUERY).map((p) => p.slug), ["live"]);
  assert.deepEqual(filterProjects(list, { ...DEFAULT_QUERY, archived: "only" }).map((p) => p.slug), ["old"]);
  assert.equal(filterProjects(list, { ...DEFAULT_QUERY, archived: "include" }).length, 2);
});

test("filters narrow by visibility, kind, language and deployments", () => {
  const list = [
    project("site", { deploying: true, ecosystem: "npm" }),
    project("lib", { kind: "library", ecosystem: "cargo", private: true }),
    project("tool", { ecosystem: "go" }),
  ];
  const slugs = (change: object) => filterProjects(list, { ...DEFAULT_QUERY, ...change }).map((p) => p.slug).sort();
  assert.deepEqual(slugs({ visibility: "private" }), ["lib"]);
  assert.deepEqual(slugs({ visibility: "public" }), ["site", "tool"]);
  assert.deepEqual(slugs({ kind: "library" }), ["lib"]);
  assert.deepEqual(slugs({ language: "Rust" }), ["lib"]);
  assert.deepEqual(slugs({ language: "JavaScript" }), ["site"]);
  assert.deepEqual(slugs({ deployments: true }), ["site"]);
});

test("search matches every word, in the name, slug or description, names that start with it first", () => {
  const list = [
    project("docs-site", { name: "Docs site", description: "The API reference" }),
    project("api", { name: "API" }),
    project("billing", { description: "charges cards" }),
  ];
  assert.deepEqual(filterProjects(list, { ...DEFAULT_QUERY, q: "api" }).map((p) => p.slug), ["api", "docs-site"]);
  assert.deepEqual(filterProjects(list, { ...DEFAULT_QUERY, q: "api reference" }).map((p) => p.slug), ["docs-site"]);
  assert.deepEqual(filterProjects(list, { ...DEFAULT_QUERY, q: "CARDS" }).map((p) => p.slug), ["billing"]);
});

test("each sort orders as it says, ties by name", () => {
  const list = [
    project("b", { updatedAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-05T00:00:00Z", activity: 1 }),
    project("a", { updatedAt: "2026-10-03T00:00:00Z", activity: 9 }),
    project("c", { updatedAt: "2026-10-02T00:00:00Z", pushedAt: "2026-10-04T00:00:00Z", activity: 1 }),
  ];
  const order = (sort: string) => filterProjects(list, { ...DEFAULT_QUERY, sort: sort as never }).map((p) => p.slug);
  assert.deepEqual(order("name"), ["a", "b", "c"]);
  // Updated is the later of its own changes and its last push.
  assert.deepEqual(order("updated"), ["b", "c", "a"]);
  assert.deepEqual(order("pushed"), ["b", "c", "a"]);
  assert.deepEqual(order("active"), ["a", "b", "c"]);
});

test("pages hold PAGE_SIZE, and a page past the end is the last", () => {
  const list = Array.from({ length: 412 }, (_, i) => i);
  const first = pageOf(list, 1);
  assert.equal(first.items.length, PAGE_SIZE);
  assert.equal(first.pages, 14);
  assert.deepEqual([first.from, first.to], [1, 30]);
  const last = pageOf(list, 99);
  assert.equal(last.page, 14);
  assert.deepEqual([last.from, last.to], [391, 412]);
  assert.deepEqual(pageOf([], 1), { items: [], page: 1, pages: 1, from: 0, to: 0 });
});

test("facets count the whole workspace", () => {
  const facets = facetsOf([
    project("a", { ecosystem: "npm", deploying: true }),
    project("b", { ecosystem: "npm", private: true, kind: "library" }),
    project("c", { ecosystem: "go", archived: true }),
  ]);
  assert.deepEqual(facets.visibility, { public: 2, private: 1 });
  assert.deepEqual(facets.kind, { app: 2, library: 1 });
  assert.deepEqual(facets.languages, [{ name: "JavaScript", count: 2 }, { name: "Go", count: 1 }]);
  assert.equal(facets.deploying, 1);
  assert.equal(facets.archived, 1);
});

test("the keyboard moves through rows and stops at the ends", () => {
  assert.equal(nextRow("ArrowDown", -1, 3), 0);
  assert.equal(nextRow("j", 0, 3), 1);
  assert.equal(nextRow("ArrowDown", 2, 3), 2);
  assert.equal(nextRow("k", 0, 3), 0);
  assert.equal(nextRow("End", 0, 3), 2);
  assert.equal(nextRow("Home", 2, 3), 0);
  assert.equal(nextRow("x", 0, 3), null);
  assert.equal(nextRow("ArrowDown", 0, 0), null);
});
