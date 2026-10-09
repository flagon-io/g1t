import { test } from "node:test";
import assert from "node:assert/strict";

import { assemble } from "./assemble.ts";
import { extract } from "./extract.ts";
import { aspirational, bulletsOf, classify, harvestable, planLike, sentencesOf, wholeSentences } from "./harvest.ts";

const ctx = { project: "g1t", siblings: [] };

test("memory comes from docs on how to work here, never plans, feedback or history", () => {
  for (const path of ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]) {
    const role = path.startsWith("README") ? "readme" : path.startsWith("CONTRIBUTING") ? "contributing" : "agents";
    assert.ok(harvestable(path, role), path);
  }
  for (const path of ["docs/DEPLOYING.md", "docs/testing.md", "docs/architecture.md", "docs/SELF_HOSTING.md", "runbooks/restore.md", "docs/getting-started.md"]) {
    assert.ok(harvestable(path, "doc"), path);
  }
  for (const path of ["docs/PLAN.md", "docs/CLOUDFLARE_FEEDBACK.md", "docs/CHANGELOG.md", "docs/roadmap.md", "docs/DEMO.md", "docs/INCIDENTS.md", "docs/PERFORMANCE.md", "docs/release-notes.md"]) {
    assert.ok(!harvestable(path, "doc"), path);
  }
  // project.yml adds a doc, or leaves one out, and leaving out wins.
  assert.ok(harvestable("docs/PERFORMANCE.md", "doc", { docs: ["docs/PERFORMANCE.md"], skip: [] }));
  assert.ok(harvestable("docs/notes/x.md", "doc", { docs: ["docs/notes/*"], skip: [] }));
  assert.ok(!harvestable("README.md", "readme", { docs: [], skip: ["README.md"] }));
  assert.ok(!harvestable("docs/testing.md", "doc", { docs: ["docs/testing.md"], skip: ["docs/*"] }));
});

const FEEDBACK = `# Building a platform: a field report

### A1. What is a billable operation? (blocking)

- **What we tried.** Price from cost: pass storage through to each workspace with a modest
  uniform overhead, so a bill tracks what it really costs us.
- **What we hit.** Pricing defines operations only loosely.
- **What it means.** Our capacity model gives a 15x spread.
- **Ask.** A table: each binding method and each endpoint, billable or not.

### Conventions we would like

- **Ask.** Metrics with the same event names as the invoice, per repository.
`;

const PLAN = `# Plan

## For people who do not write code

- **Roles.** A person can plan and approve work without ever cloning a
  repo. The roles that were sketched here map onto the five repository
  roles that are built.

### Rules every automation obeys

- **Deduplication.** The same Sentry issue firing 500 times maps to one
  issue.
- **Loop protection.** Work started by an automation cannot retrigger the
  same automation without a person in between.

## Roadmap

## Later

- g1t will learn from docs.
`;

test("a doc that reads as feedback or a plan says nothing, whatever its name", () => {
  assert.ok(planLike(FEEDBACK));
  assert.deepEqual(extract("CONTRIBUTING.md", FEEDBACK, ctx).hints, []);
  assert.ok(planLike(PLAN));
  assert.deepEqual(extract("docs/testing.md", PLAN, ctx).hints, []);
  const files = [
    { path: "docs/PLAN.md", facts: extract("docs/PLAN.md", "# Working on g1t\n\n## Conventions\n\n- Run the whole suite before you push, every time.\n", ctx) },
    { path: "docs/CLOUDFLARE_FEEDBACK.md", facts: extract("docs/CLOUDFLARE_FEEDBACK.md", FEEDBACK, ctx) },
  ];
  const project = { id: "p", workspace: "w", slug: "g1t", name: "g1t", description: null, private: false, repoId: "r", repo: { namespace: "w", name: "g1t" }, rootDir: "", defaultBranch: "main" };
  const around = { owners: [], dependsOn: [], deploy: null, integrations: [] };
  assert.deepEqual(assemble(project, files, around).hints, [], "docs/PLAN.md is not a source of memory");
  // Unless project.yml says it is.
  const withConfig = [...files, { path: ".g1t/project.yml", facts: extract(".g1t/project.yml", "memory:\n  docs:\n    - docs/PLAN.md\n", ctx) }];
  assert.deepEqual(assemble(project, withConfig, around).hints.map((hint) => hint.path), ["docs/PLAN.md"]);
});

test("a bullet is taken whole, with the lines it wraps onto", () => {
  const bullets = bulletsOf(
    "## Conventions\n\n- **Loop protection.** Work started by an automation cannot retrigger the\n  same automation without a person in between.\n- Short one.\n\nA paragraph.\n\n```\n- not a bullet\n```\n",
  );
  assert.deepEqual(bullets, [
    { text: "**Loop protection.** Work started by an automation cannot retrigger the same automation without a person in between.", heading: "Conventions" },
    { text: "Short one.", heading: "Conventions" },
  ]);
  // Bullets in a plan section, and its subsections, are left out.
  assert.deepEqual(bulletsOf("## Roadmap\n\n### Next\n\n- One.\n\n## Testing\n\n- Two.\n").map((b) => b.text), ["Two."]);
});

test("never cut inside a sentence: whole sentences up to the limit, or nothing", () => {
  assert.deepEqual(sentencesOf("Run `npm test` first. It reads README.md, e.g. the setup. Done!"), [
    "Run `npm test` first.",
    "It reads README.md, e.g. the setup.",
    "Done!",
  ]);
  assert.equal(wholeSentences("Short and whole", 40), "Short and whole");
  assert.equal(wholeSentences("First sentence is here. Second sentence pushes it past the limit.", 30), "First sentence is here.");
  assert.equal(wholeSentences("One very long sentence that never ends before the limit is reached at all", 30), null);
});

test("plans and wishes are not memory; kinds are earned, not assumed", () => {
  assert.ok(aspirational("g1t will learn from docs.", "doc"));
  assert.ok(aspirational("Tests should run on every push.", "contributing"));
  assert.ok(aspirational("**Ask.** A usage endpoint.", "doc"));
  assert.ok(aspirational("**What we tried.** Pass storage through.", "doc"));
  assert.ok(!aspirational("Run `cargo test` in the crate you changed.", "contributing"));
  // In AGENTS.md "should" states a rule.
  assert.ok(!aspirational("You should run the formatter before committing.", "agents"));
  assert.ok(aspirational("TODO: document the release flow.", "agents"));

  assert.deepEqual(classify("Never edit generated files by hand.", "Conventions", "contributing"), { kind: "gotcha", confidence: 0.6 });
  assert.deepEqual(classify("Use the shared client for every call.", "Conventions", "contributing"), { kind: "convention", confidence: 0.6 });
  assert.deepEqual(classify("The API lives in apps/api and serves api.g1t.sh.", "Conventions", "readme"), { kind: "fact", confidence: 0.5 });
});

test("CONTRIBUTING's before-you-push bullets are suggested whole; nothing is cut", () => {
  const facts = extract(
    "CONTRIBUTING.md",
    "# Contributing\n\n## Before you push\n\n- `cargo test` in the crate or service you changed.\n- `npx tsc -b --force` in `apps/web` (the incremental build misses changes\n  in `packages/contracts`).\n- Look at what you changed in a browser. Screenshots catch what type\n  checks do not.\n\n## Deploying\n\nPushes to `main` deploy themselves.\n",
    ctx,
  );
  assert.deepEqual(
    facts.hints.map((hint) => [hint.kind, hint.text, hint.confidence]),
    [
      ["fact", "`cargo test` in the crate or service you changed.", 0.5],
      ["fact", "`npx tsc -b --force` in `apps/web` (the incremental build misses changes in `packages/contracts`).", 0.5],
      ["convention", "Look at what you changed in a browser. Screenshots catch what type checks do not.", 0.6],
    ],
  );
  for (const hint of facts.hints) assert.match(hint.text, /[.!?)`]$/);
});
