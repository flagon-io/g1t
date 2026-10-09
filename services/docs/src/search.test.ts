import assert from "node:assert/strict";
import { test } from "node:test";

import { ftsQuery, inProject, projectRef, searchSpaces } from "./search.ts";

test("queries are quoted word by word, the last a prefix", () => {
  assert.equal(ftsQuery("deploy run"), '"deploy" "run"*');
  assert.equal(ftsQuery('NEAR(a b) OR "x" -y'), '"near" "a" "b" "or" "x" "y"*');
  assert.equal(ftsQuery("  -- "), null);
});

test("a search looks only in spaces the reader can read", () => {
  assert.deepEqual(searchSpaces(["s1", "s2"], null), ["s1", "s2"]);
  assert.deepEqual(searchSpaces(["s1", "s2"], "s2"), ["s2"]);
  assert.deepEqual(searchSpaces(["s1"], "s3"), []);
});

test("a project filter matches the page's projects or its space's", () => {
  assert.equal(inProject("acme/web", ["acme/web"], []), true);
  assert.equal(inProject("acme/web", [], ["Acme/Web"]), true);
  assert.equal(inProject("acme/web", ["acme/api"], []), false);
  assert.equal(inProject(null, [], []), true);
  assert.equal(projectRef(" Acme/Web/ "), "acme/web");
  assert.equal(projectRef("nope"), null);
});
