import assert from "node:assert/strict";
import { test } from "node:test";

import { repositoryOfPage, stillPublic } from "./public-cache.ts";

test("a project page names its repository", () => {
  assert.equal(repositoryOfPage("/flagon-io/hello"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/flagon-io/hello.data"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/Flagon-IO/Hello/issues/4"), "flagon-io/hello");
  assert.equal(repositoryOfPage("/flagon-io/hello/blob/main/src/lib.rs"), "flagon-io/hello");
});

test("pages that are not a repository's name none", () => {
  assert.equal(repositoryOfPage("/"), null);
  assert.equal(repositoryOfPage("/pricing"), null);
  assert.equal(repositoryOfPage("/flagon-io"), null);
  assert.equal(repositoryOfPage("/flagon-io/-"), null);
});

test("only a repository that is there and public is served from the cache", () => {
  assert.equal(stillPublic([{ path: "a/b", is_private: false }], "a/b"), true);
  assert.equal(stillPublic([{ path: "a/b", is_private: true }], "a/b"), false);
  // Deleted or never there: repos leaves it out.
  assert.equal(stillPublic([], "a/b"), false);
  assert.equal(stillPublic(null, "a/b"), false);
  assert.equal(stillPublic([{ path: "a/c", is_private: false }], "a/b"), false);
});
