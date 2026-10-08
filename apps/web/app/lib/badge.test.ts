import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowRun } from "@g1t/contracts";

import { badgeMarkdown, badgeState, badgeSvg, badgeUrl, textWidth } from "./badge.ts";

const run = (status: WorkflowRun["status"], conclusion: WorkflowRun["conclusion"]) => ({ status, conclusion }) as WorkflowRun;

test("a badge says how the newest finished run went", () => {
  assert.equal(badgeState([]), "no status");
  assert.equal(badgeState([run("in_progress", null), run("completed", "success")]), "passing");
  assert.equal(badgeState([run("completed", "failure"), run("completed", "success")]), "failing");
  assert.equal(badgeState([run("completed", "cancelled")]), "cancelled");
  assert.equal(badgeState([run("completed", "skipped")]), "passing");
  assert.equal(badgeState([run("queued", null)]), "no status");
});

test("the badge is an SVG with its label and state, escaped", () => {
  const svg = badgeSvg("CI <main>", "passing");
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /<title>CI &lt;main&gt;: passing<\/title>/);
  assert.match(svg, /fill="#2ea043"/);
  assert.doesNotMatch(svg, /<main>/);
  assert.ok(textWidth("failing") > textWidth("ill"));
  assert.match(badgeSvg("x".repeat(80), "failing"), /x{59}…/);
});

test("its address and Markdown name the workflow file, and a branch or event when chosen", () => {
  assert.equal(badgeUrl("https://g1t.sh", "acme/web", "ci.yml"), "https://g1t.sh/acme/web/actions/workflows/ci.yml/badge.svg");
  assert.equal(
    badgeUrl("https://g1t.sh", "acme/web", "ci.yml", { branch: "release/1.x", event: "push" }),
    "https://g1t.sh/acme/web/actions/workflows/ci.yml/badge.svg?branch=release%2F1.x&event=push",
  );
  assert.equal(
    badgeMarkdown("https://g1t.sh", "acme/web", { name: "CI [main]", file: "ci.yml" }),
    "[![CI main](https://g1t.sh/acme/web/actions/workflows/ci.yml/badge.svg)](https://g1t.sh/acme/web/actions?workflow=ci.yml)",
  );
});
