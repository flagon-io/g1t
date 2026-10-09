import { test } from "node:test";
import assert from "node:assert/strict";

import { chunk, extract, interesting, packageManager, parseJsonc, parseToml } from "./extract.ts";

const ctx = { project: "web", siblings: ["package.json", "pnpm-lock.yaml", "tsconfig.json"] };

test("only manifests, docs, workflows and ownership are read", () => {
  for (const path of ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "README.md", "AGENTS.md", "docs/deploy.md", ".g1t/workflows/ci.yml", ".github/workflows/test.yaml", "openapi.yaml", "wrangler.jsonc", ".g1t/project.yml", "CODEOWNERS"]) {
    assert.ok(interesting(path), path);
  }
  for (const path of ["src/index.ts", "docs/img.png", "node_modules/x/package.json", "apps/web/package.json", "docs/deep/nested.md"]) {
    assert.ok(!interesting(path), path);
  }
});

test("package.json gives the package, its language, its package manager and its scripts", () => {
  const facts = extract(
    "package.json",
    JSON.stringify({
      name: "@acme/web",
      version: "1.2.0",
      scripts: { test: "vitest run", typecheck: "tsc -p .", dev: "vite" },
      dependencies: { react: "^19" },
      devDependencies: { typescript: "^5" },
      workspaces: ["apps/*", "packages/*"],
    }),
    ctx,
  );
  assert.deepEqual(facts.languages, ["TypeScript"]);
  assert.equal(facts.packages[0].name, "@acme/web");
  assert.deepEqual(facts.packages[0].dependencies, ["react", "typescript"]);
  assert.deepEqual(facts.packages[0].members, ["apps/*", "packages/*"]);
  const texts = facts.hints.map((hint) => hint.text);
  assert.ok(texts.some((text) => text.includes("uses pnpm") && text.includes("not npm or yarn or bun")), texts.join("\n"));
  assert.ok(texts.some((text) => text.includes("`pnpm test` runs the tests: `vitest run`")));
  assert.ok(texts.some((text) => text.includes("`pnpm run typecheck`")));
  assert.ok(!texts.some((text) => text.includes("dev")), "dev servers are not worth remembering");
  assert.ok(texts.some((text) => text.includes("monorepo")));
  // Facts read from a manifest are certain enough to keep.
  assert.ok(facts.hints.every((hint) => hint.confidence >= 0.85));
});

test("Cargo.toml gives a crate or a workspace", () => {
  const crate = extract(
    "Cargo.toml",
    `[package]\nname = "g1t-work" # the work service\nversion = "0.1.0"\n\n[dependencies]\nserde = { workspace = true }\nworker.workspace = true\n\n[dev-dependencies]\npretty = "1"\n`,
    ctx,
  );
  assert.deepEqual(crate.languages, ["Rust"]);
  assert.equal(crate.packages[0].name, "g1t-work");
  assert.equal(crate.packages[0].version, "0.1.0");
  assert.deepEqual(crate.packages[0].dependencies, ["serde", "worker.workspace", "pretty"]);
  const workspace = extract("Cargo.toml", `[workspace]\nmembers = [\n  "crates/a",\n  "services/b",\n]\n`, ctx);
  assert.deepEqual(workspace.packages[0].members, ["crates/a", "services/b"]);
  // Where crates live, not each one, so adding a crate says nothing new.
  assert.match(workspace.hints[0].text, /Cargo workspace \(crates\/\*, services\/\*\)/);
  const grown = extract("Cargo.toml", `[workspace]\nmembers = ["crates/a", "crates/c", "services/b"]\n`, ctx);
  assert.equal(grown.hints[0].text, workspace.hints[0].text);
});

test("go.mod and pyproject.toml", () => {
  const go = extract("go.mod", "module github.com/acme/api\n\ngo 1.23\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.12\n)\n", ctx);
  assert.equal(go.packages[0].name, "github.com/acme/api");
  assert.deepEqual(go.packages[0].dependencies, ["github.com/go-chi/chi/v5"]);
  const py = extract("pyproject.toml", `[project]\nname = "ml"\nversion = "0.3"\ndependencies = ["numpy>=2", "pytest"]\n`, ctx);
  assert.deepEqual(py.languages, ["Python"]);
  assert.deepEqual(py.packages[0].dependencies, ["numpy", "pytest"]);
  assert.ok(py.hints.some((hint) => hint.text.includes("pytest")));
});

test("wrangler config and OpenAPI become APIs", () => {
  const worker = extract(
    "wrangler.jsonc",
    `{\n  // the API\n  "name": "g1t-api", "$schema": "https://example.com/x.json",\n  "routes": [{ "pattern": "api.g1t.sh", "custom_domain": true },],\n}`,
    ctx,
  );
  assert.equal(worker.apis[0].name, "g1t-api");
  assert.deepEqual(worker.apis[0].routes, ["api.g1t.sh"]);
  const spec = extract("openapi.yaml", "openapi: 3.1.0\ninfo:\n  title: Billing API\n  version: '2'\npaths:\n  /invoices:\n    get: {}\n    post: {}\n", ctx);
  assert.equal(spec.apis[0].name, "Billing API");
  assert.deepEqual(spec.apis[0].routes, ["GET /invoices", "POST /invoices"]);
});

test("AGENTS.md conventions are kept; a README's setup commands wait for review", () => {
  const agents = extract(
    "AGENTS.md",
    "# Working here\n\n- Components live in src/components/ui; import from there.\n- Never edit generated.rs by hand.\n- [Docs](https://x)\n\n```sh\nnpm run db:reset\n```\n",
    ctx,
  );
  assert.equal(agents.doc?.role, "agents");
  const kinds = agents.hints.map((hint) => [hint.kind, hint.text, hint.confidence]);
  assert.deepEqual(kinds, [
    ["fact", "In web, for working here: `npm run db:reset`.", 0.9],
    ["convention", "Components live in src/components/ui; import from there.", 0.9],
    ["gotcha", "Never edit generated.rs by hand.", 0.9],
  ]);
  const readme = extract("README.md", "# Web\n\nThe storefront.\n\n## Testing\n\n```\n$ TZ=UTC npm test\nnpm test\n```\n\n## Features\n\n- Lots of features that are really great\n", ctx);
  assert.equal(readme.doc?.title, "Web");
  assert.equal(readme.doc?.summary, "The storefront.");
  assert.deepEqual(
    readme.hints.map((hint) => [hint.text, hint.confidence]),
    [["In web, for testing: `npm test`.", 0.7]],
  );
});

test("owners come from project.yml and CODEOWNERS; workflows say whether they test", () => {
  assert.deepEqual(extract(".g1t/project.yml", "owners:\n  - ana\n  - '@bo'\ndependsOn: [api]\n", ctx).owners, ["ana", "bo"]);
  assert.deepEqual(extract("CODEOWNERS", "# owners\n* @ana @acme/platform\n/docs @cy\n", ctx).owners, ["ana", "cy"]);
  assert.equal(extract(".g1t/workflows/ci.yml", "jobs:\n  t:\n    steps:\n      - run: npm test\n", ctx).tests, true);
  assert.equal(extract(".g1t/workflows/deploy.yml", "jobs:\n  d:\n    steps:\n      - run: wrangler deploy\n", ctx).tests, false);
});

test("a file that does not parse says nothing", () => {
  assert.deepEqual(extract("package.json", "{ nope", ctx).packages, []);
});

test("parsers and helpers", () => {
  assert.deepEqual(parseJsonc('{"a": "http://x//y", /* c */ "b": [1,],}'), { a: "http://x//y", b: [1] });
  assert.deepEqual(parseToml('x = 1\n[a]\nb = "c" # d\nlist = ["e", \'f\']').a, { b: "c", list: ["e", "f"] });
  assert.equal(packageManager(["yarn.lock"]), "yarn");
  assert.equal(packageManager([]), null);
  const pieces = chunk(`# T\n\nintro\n\n## A\n\n${"a".repeat(2000)}\n\n## B\n\nb`, "T");
  assert.equal(pieces.length, 4);
  assert.ok(pieces[2].startsWith("A (continued)"));
  assert.ok(pieces.every((piece) => piece.length <= 1500 + 40));
});
