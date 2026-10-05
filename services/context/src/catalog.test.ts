import { test } from "node:test";
import assert from "node:assert/strict";

import { assemble, authorsOf } from "./assemble.ts";
import { extract } from "./extract.ts";
import { composeRunContext, HEADER } from "./runcontext.ts";
import { evaluate } from "./scorecards.ts";
import { indexFilter, merge, readable, allowedKinds } from "./visibility.ts";

const project = {
  id: "prj_1",
  workspace: "acme",
  slug: "web",
  name: "web",
  description: "The storefront.",
  private: true,
  repoId: "rep_1",
  repo: { namespace: "acme", name: "web" },
  rootDir: "",
  defaultBranch: "main",
};
const ctx = { project: "web", siblings: ["package-lock.json"] };

test("a project's entities and relations come from its files and surroundings", () => {
  const files = [
    { path: "package.json", facts: extract("package.json", JSON.stringify({ name: "@acme/web", scripts: { test: "vitest" }, dependencies: { "@acme/ui": "*" } }), ctx) },
    { path: "README.md", facts: extract("README.md", "# Web\n\nThe storefront.", ctx) },
    { path: "wrangler.jsonc", facts: extract("wrangler.jsonc", '{"name":"web","routes":["shop.acme.com/*"]}', ctx) },
    { path: ".g1t/workflows/ci.yml", facts: extract(".g1t/workflows/ci.yml", "run: npm test", ctx) },
  ];
  const built = assemble(project, files, {
    owners: ["ana"],
    dependsOn: [{ slug: "api", as: "API_URL" }],
    deploy: { enabled: true, production: { url: "https://web--acme.g1t.page", commit: "abcdef1234", deployedAt: "2026-10-01T00:00:00Z" }, previews: 2, latest: null },
    integrations: [{ id: "int_1", provider: "sentry", name: "Sentry", kind: "alerts", repo: "acme/web" }],
  });
  const keys = built.entities.map((entity) => `${entity.kind}:${entity.key}`);
  for (const key of ["project:web", "owner:ana", "language:javascript", "package:npm:@acme/web", "doc:web:README.md", "api:web:worker:web", "app:web", "environment:web/production", "environment:web/preview"]) {
    assert.ok(keys.includes(key), `${key} in ${keys.join(", ")}`);
  }
  const relations = built.relations.map((r) => `${r.from.kind}:${r.from.key} ${r.kind} ${r.to.kind}:${r.to.key}`);
  for (const relation of [
    "project:web depends_on project:api",
    "project:web owned_by owner:ana",
    "project:web documented_by doc:web:README.md",
    "project:web exposes package:npm:@acme/web",
    "package:npm:@acme/web depends_on package:npm:@acme/ui",
    "app:web deploys_to environment:web/production",
    "app:web exposes api:web:worker:web",
    "project:web uses language:javascript",
    "project:web uses integration:int_1",
  ]) {
    assert.ok(relations.includes(relation), relation);
  }
  assert.equal(built.tests, true);
  const entry = built.entities.find((entity) => entity.kind === "project")!;
  assert.match(entry.summary!, /The storefront\. Written in JavaScript\. .*Uses api\. Owned by ana\./);
  assert.equal(entry.data.productionUrl, "https://web--acme.g1t.page");
});

test("the same inputs build the same catalog", () => {
  const files = [{ path: "go.mod", facts: extract("go.mod", "module x/y\n", ctx) }];
  const around = { owners: [], dependsOn: [], deploy: null, integrations: [] };
  assert.deepEqual(assemble(project, files, around), assemble(project, files, around));
  // Without deployments there is no app or environment.
  assert.ok(!assemble(project, files, around).entities.some((entity) => entity.kind === "app" || entity.kind === "environment"));
});

test("owners are the members who wrote a fifth or more of the recent commits", () => {
  const commit = (name: string, email = `${name}@example.com`) => ({ author: { name, email } });
  const commits = [...Array(6)].map(() => commit("Ana")).concat([commit("someone", "bo@acme.com"), commit("bot"), commit("bot"), commit("cy")]);
  assert.deepEqual(authorsOf(commits, ["ana", "bo", "cy"]), ["ana"]);
  assert.deepEqual(authorsOf([commit("x", "bo@acme.com")], ["bo"]), ["bo"]);
  assert.deepEqual(authorsOf([], ["ana"]), []);
});

test("scorecards pass, fail with a fix, or do not apply", () => {
  const rules = evaluate({
    name: "web",
    owners: [],
    docs: ["README.md"],
    tests: false,
    testCommand: "npm test",
    deploy: { enabled: true, production: null, latest: { kind: "production", status: "failed", error: "build failed" } },
    secretFindings: null,
  });
  const by = Object.fromEntries(rules.map((rule) => [rule.rule, rule]));
  assert.equal(by.has_owner.status, "fail");
  assert.deepEqual(by.has_owner.fix?.checks, ["grep -q '^owners:' .g1t/project.yml"]);
  assert.equal(by.has_readme.status, "pass");
  assert.equal(by.has_readme.fix, null);
  assert.equal(by.has_agents_md.fix?.title, "Add an AGENTS.md to web");
  assert.match(by.tests_in_ci.fix!.body, /`npm test`/);
  assert.equal(by.production_green.status, "fail");
  assert.match(by.production_green.detail, /build failed/);
  assert.equal(by.no_secret_findings.status, "na");
  const quiet = evaluate({ name: "lib", owners: ["ana"], docs: ["readme.md", "CLAUDE.md"], tests: true, testCommand: null, deploy: null, secretFindings: 0 });
  assert.deepEqual(quiet.map((rule) => rule.status), ["pass", "pass", "pass", "pass", "na", "pass"]);
});

test("the run context marks its sources and keeps to its budget", () => {
  const input = {
    projects: [
      {
        slug: "web",
        name: "web",
        repo: "acme/web",
        rootDir: "",
        languages: ["TypeScript"],
        packages: ["@acme/web"],
        testCommands: ["npm test"],
        owners: ["ana"],
        dependsOn: [{ slug: "api", as: "API_URL", url: "https://api--acme.g1t.page" }],
        usedBy: [],
        environments: [{ name: "Production", url: "https://web--acme.g1t.page", status: "ready" }],
        docs: ["README.md"],
      },
    ],
    memories: [{ id: "mem_1", kind: "gotcha", text: "Tests need TZ=UTC.", source: "AGENTS.md" }],
    decisions: [{ id: "mem_2", kind: "decision", text: "Decided in #12: keep v1 webhooks.", source: "#12" }],
    budget: 4000,
  };
  const { text, sources } = composeRunContext(input);
  assert.ok(text!.startsWith(HEADER));
  assert.match(text!, /Project web \(acme\/web\) \[source: catalog\]:/);
  assert.match(text!, /Uses: api at https:\/\/api--acme\.g1t\.page \(its address is in API_URL\)/);
  assert.match(text!, /\[gotcha\] Tests need TZ=UTC\. \[source: AGENTS\.md\]/);
  assert.match(text!, /Recent decisions:\n- Decided in #12: keep v1 webhooks\. \[source: #12\]/);
  assert.deepEqual(sources.sort(), ["catalog:web", "memory:mem_1", "memory:mem_2"]);
  const tight = composeRunContext({ ...input, budget: HEADER.length + 120 });
  assert.ok(tight.text!.length <= HEADER.length + 120);
  assert.deepEqual(composeRunContext({ projects: [], memories: [], decisions: [], budget: 4000 }), { text: null, sources: [] });
});

test("search reads one workspace, and only what a reader may see", () => {
  const member = { workspace: "acme", member: true, visible: new Set<string>() };
  const outsider = { workspace: "acme", member: false, visible: new Set(["site"]) };
  assert.deepEqual(indexFilter(member, {}), { workspace: "acme" });
  assert.deepEqual(indexFilter(outsider, { project: "site", kinds: ["memory", "doc"] }), { workspace: "acme", private: false, project: "site", kind: { $in: ["doc"] } });
  assert.ok(!(allowedKinds(outsider) ?? []).includes("memory"));
  const row = { workspace: "acme", kind: "doc", project: "site", private: false };
  assert.ok(readable(row, outsider));
  assert.ok(!readable({ ...row, workspace: "other" }, member), "never another workspace");
  assert.ok(!readable({ ...row, private: true }, outsider));
  assert.ok(!readable({ ...row, kind: "memory" }, outsider), "memory is for members");
  assert.ok(!readable({ ...row, project: "made-private-since" }, outsider));
  assert.ok(readable({ ...row, kind: "memory", private: true }, member));
});

test("semantic hits come first, without repeats", () => {
  const hit = (id: string, score: number) => ({ kind: "doc" as const, id, title: id, snippet: "", project: null, url: null, score, source: "doc", by: null, updatedAt: null });
  assert.deepEqual(
    merge([hit("a", 0.5), hit("b", 0.9)], [hit("a", 0.2), hit("c", 0.2)], 10).map((h) => h.id),
    ["b", "a", "c"],
  );
  assert.equal(merge([hit("a", 1)], [hit("b", 1)], 1).length, 1);
});
