import assert from "node:assert/strict";
import { test } from "node:test";

import { type MissingKind, missingKind, notFoundCopy } from "./not-found.ts";

test("the kind a loader names wins over the address", () => {
  assert.equal(missingKind({ kind: "project" }, "/acme/web/blob/main/x"), "project");
  assert.equal(missingKind({ kind: "pull" }, "/acme/web/pull/7"), "pull");
  // Anything else a loader put there is ignored.
  assert.equal(missingKind({ kind: "secret" }, "/acme/web"), "project");
  assert.equal(missingKind("Issue not found.", "/acme/web/issues/3"), "issue");
});

test("without one, the shape of the address decides", () => {
  const cases: [string, MissingKind][] = [
    ["/acme", "workspace"],
    ["/acme/web", "project"],
    ["/acme/web/issues/12", "issue"],
    ["/acme/web/pull/12", "pull"],
    ["/acme/web/issues", "page"],
    ["/acme/web/settings", "page"],
    ["/acme/-/billing", "page"],
    ["/u/ada", "person"],
    ["/explore/nothing", "page"],
    ["/", "page"],
  ];
  for (const [path, kind] of cases) assert.equal(missingKind(null, path), kind, path);
});

const KINDS: [MissingKind, string][] = [
  ["project", "project"],
  ["issue", "issue"],
  ["pull", "pull request"],
  ["workspace", "workspace"],
  ["page", "page"],
];

test("signed out: sign in to see it, which may be private or missing", () => {
  for (const [kind, noun] of KINDS) {
    const copy = notFoundCopy(kind, null);
    assert.equal(copy.title, `Sign in to see this ${noun}`);
    assert.equal(copy.body, "It may be private, or it may not exist.");
    assert.equal(copy.signIn, true);
    assert.equal(copy.signedInAs, null);
    assert.equal(copy.askOwner, false);
  }
});

test("signed in: it does not exist or you cannot see it, and who you are", () => {
  for (const [kind, noun] of KINDS) {
    const copy = notFoundCopy(kind, "ada");
    assert.equal(copy.title, `This ${noun} doesn't exist, or you don't have access to it`);
    assert.equal(copy.signIn, false);
    assert.equal(copy.signedInAs, "ada");
    assert.equal(copy.askOwner, true);
  }
});

test("a missing person is simply no one, signed in or not", () => {
  for (const viewer of [null, "ada"]) {
    const copy = notFoundCopy("person", viewer);
    assert.equal(copy.title, "No one goes by that name");
    assert.equal(copy.signIn, false);
    assert.equal(copy.askOwner, false);
  }
});

test("the page depends only on the kind and the viewer", () => {
  // The same inputs for a private project and a missing one: the loader
  // throws the same kind, at the same address, so the copy is identical.
  const privateOne = notFoundCopy(missingKind({ kind: "project" }, "/acme/secret"), null);
  const missingOne = notFoundCopy(missingKind({ kind: "project" }, "/acme/secret"), null);
  assert.deepEqual(privateOne, missingOne);
});
