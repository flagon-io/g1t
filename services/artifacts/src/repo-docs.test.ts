import assert from "node:assert/strict";
import { test } from "node:test";

import { isRepoDoc, pickRepoDocs, repoDocTitle } from "./repo-docs.ts";

test("a project's docs are Markdown under docs/ and the README at the root", () => {
  assert.ok(isRepoDoc("README.md"));
  assert.ok(isRepoDoc("docs/guide/setup.md"));
  assert.ok(isRepoDoc("docs/a.mdx"));
  assert.ok(!isRepoDoc("src/README.md"));
  assert.ok(!isRepoDoc("docs/logo.png"));
  assert.ok(!isRepoDoc("documentation/a.md"));
  assert.deepEqual(
    pickRepoDocs([{ path: "docs/b.md" }, { path: "src/x.ts" }, { path: "docs/a.md" }, { path: "README.md" }]).map((f) => f.path),
    ["README.md", "docs/a.md", "docs/b.md"],
  );
});

test("a file's title is its front matter's, its first heading, or its name", () => {
  assert.equal(repoDocTitle("docs/a.md", "---\ntitle: \"Setting up\"\n---\n# Other"), "Setting up");
  assert.equal(repoDocTitle("docs/a.md", "Intro\n\n# The **real** title\n"), "The real title");
  assert.equal(repoDocTitle("docs/getting-started.md", "no heading"), "Getting started");
  assert.equal(repoDocTitle("README.md", "text"), "README");
  assert.equal(repoDocTitle("docs/deploy/README.md", "text"), "deploy");
});
