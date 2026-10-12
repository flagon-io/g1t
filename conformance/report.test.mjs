import assert from "node:assert/strict";
import { test } from "node:test";

import { kind, layout, shape, variables } from "./report.mjs";

test("a value's shape is its key paths and types, not its values", () => {
  assert.deepEqual(shape({ a: 1, b: { c: "x", d: [ { e: true } ] }, f: null }), {
    a: "number",
    b: "object",
    "b.c": "string",
    "b.d": "array",
    "b.d[]": "object",
    "b.d[].e": "boolean",
    f: "null",
  });
});

test("variables are kept by kind, and only GitHub's", () => {
  assert.deepEqual(
    variables({ GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "42", GITHUB_SERVER_URL: "https://g1t.sh", RUNNER_TEMP: "/home/runner/work/_temp", CI: "true", PATH: "/bin", SECRET: "x" }),
    { GITHUB_SHA: "sha", GITHUB_RUN_ID: "integer", GITHUB_SERVER_URL: "url", RUNNER_TEMP: "path", CI: "boolean" },
  );
  assert.equal(kind("refs/heads/main"), "ref");
  assert.equal(kind(""), "empty");
});

test("the layout says where the workspace is, as GitHub lays it out", () => {
  const on = layout({ RUNNER_WORKSPACE: "/home/runner/work/web", GITHUB_WORKSPACE: "/home/runner/work/web/web", RUNNER_TEMP: "/home/runner/work/_temp" });
  assert.equal(on.workspace_under_runner_workspace, true);
  assert.equal(on.workspace_is_repo_twice, true);
  assert.equal(layout({ GITHUB_WORKSPACE: "/home/runner/work/repo" }).workspace_is_repo_twice, false);
});

test("the diff names what g1t lacks or has differently, and what it adds", async () => {
  const { compare } = await import("../scripts/conformance-diff.mjs");
  const github = { variables: { GITHUB_SHA: "sha", ImageOS: "text" }, layout: { a: true }, contexts: { github: { sha: "string", "event.ref": "string" } }, event: { ref: "string" }, checks: { format: "a-1-{2}" } };
  const g1t = { variables: { GITHUB_SHA: "sha", G1T: "boolean" }, layout: { a: false }, contexts: { github: { sha: "string", "event.ref": "number" } }, event: { ref: "string" }, checks: { format: "a-1-{2}" } };
  const found = compare(github, g1t);
  assert.deepEqual(found.missing, ["variable ImageOS (text)"]);
  assert.deepEqual(found.different, ["layout a: GitHub true, g1t false", 'github. event.ref: GitHub "string", g1t "number"']);
  assert.deepEqual(found.extra, ["variable G1T (boolean)"]);
});
