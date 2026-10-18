import assert from "node:assert/strict";
import { test } from "node:test";

import { itemPath, parseRef, refHref, repoRefPath } from "./refs.ts";

test("a reference's written form", () => {
  assert.deepEqual(parseRef(undefined, undefined, "12"), { scope: "here", number: 12 });
  assert.deepEqual(parseRef("Acme", "web", "3"), { scope: "repo", namespace: "acme", name: "web", number: 3 });
  assert.deepEqual(parseRef("Beta", undefined, "4"), { scope: "workspace", workspace: "beta", number: 4 });
  assert.equal(parseRef(undefined, undefined, "0"), null);
  assert.equal(parseRef(undefined, undefined, "1234567890"), null);
});

test("#N in a repository goes through its ref page; in a workspace, to its work item", () => {
  const here = parseRef(undefined, undefined, "12")!;
  assert.equal(refHref(here, { repo: { namespace: "acme", name: "web" } }), "/acme/web/ref/12");
  assert.equal(refHref(here, { workspace: "Acme" }), "/acme/-/work/12");
  assert.equal(refHref(here, null), null);
  // `owner/name#N` is read in that repository, `workspace#N` in that workspace, wherever they are written.
  assert.equal(refHref(parseRef("beta", "api", "7")!, { workspace: "acme" }), "/beta/api/ref/7");
  assert.equal(refHref(parseRef("beta", undefined, "7")!, { repo: { namespace: "acme", name: "web" } }), "/beta/-/work/7");
  assert.equal(itemPath("Acme", 3), "/acme/-/work/3");
  assert.equal(repoRefPath({ namespace: "Acme", name: "Web" }, 3), "/acme/Web/ref/3");
});
