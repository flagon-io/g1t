import assert from "node:assert/strict";
import { test } from "node:test";

import { detectStacks, freeBranch, starterDescription, starterWorkflow } from "./starter-workflow.ts";

test("each stack is found by what is at the root", () => {
  const cases: [string[], string[]][] = [
    [["package.json", "package-lock.json"], ["npm"]],
    [["package.json", "pnpm-lock.yaml"], ["pnpm"]],
    [["package.json", "yarn.lock"], ["yarn"]],
    [["package.json", "bun.lock"], ["bun"]],
    [["Cargo.toml", "Cargo.lock", "src"], ["rust"]],
    [["go.mod", "main.go"], ["go"]],
    [["pyproject.toml", "uv.lock"], ["uv"]],
    [["requirements.txt"], ["python"]],
    [["Gemfile", "Rakefile"], ["ruby"]],
    [["pom.xml"], ["maven"]],
    [["build.gradle.kts", "gradlew"], ["gradle"]],
    [["App.sln"], ["dotnet"]],
    [["Makefile", "main.c"], ["make"]],
    [["README.md"], []],
    // A monorepo: Node and Rust, each with a job.
    [["package.json", "package-lock.json", "Cargo.toml", "Makefile"], ["npm", "rust"]],
  ];
  for (const [names, stacks] of cases) assert.deepEqual(detectStacks({ names }), stacks, names.join(" "));
});

test("a Node project's workflow runs the scripts it has", () => {
  const { yaml, stacks } = starterWorkflow(
    {
      names: ["package.json", "package-lock.json"],
      packageJson: JSON.stringify({ scripts: { test: "node --test", build: "tsc", start: "node ." } }),
    },
    "main",
  );
  assert.deepEqual(stacks, ["npm"]);
  assert.match(yaml, /^name: CI$/m);
  assert.match(yaml, /^ {2}pull_request:$/m);
  assert.match(yaml, /^ {4}branches: \["main"\]$/m);
  assert.match(yaml, /^ {2}merge_group:$/m);
  assert.match(yaml, /- run: npm ci/);
  assert.match(yaml, /- run: npm run build/);
  assert.match(yaml, /- run: npm run test/);
  assert.doesNotMatch(yaml, /npm run lint/);
  assert.match(yaml, / {8}with:\n {10}node-version: 24\n {10}cache: npm/);
});

test("an unreadable package.json runs the usual scripts only if present", () => {
  const { yaml } = starterWorkflow({ names: ["package.json"], packageJson: "{ not json" }, "trunk");
  assert.match(yaml, /- run: npm install/);
  assert.match(yaml, /- run: npm run test --if-present/);
  assert.match(yaml, /branches: \["trunk"\]/);
});

test("Rust, Go and an unknown project each get a workflow", () => {
  assert.match(starterWorkflow({ names: ["Cargo.toml"] }, "main").yaml, /cargo test --all-targets/);
  assert.match(starterWorkflow({ names: ["go.mod"] }, "main").yaml, /go-version-file: go.mod[\s\S]*go test \.\/\.\.\./);
  const unknown = starterWorkflow({ names: ["README.md"] }, "main");
  assert.deepEqual(unknown.stacks, []);
  assert.match(unknown.yaml, /Add the commands that build and test this project/);
  assert.match(starterDescription([], "main"), /placeholder/);
  assert.match(starterDescription(["rust"], "main"), /found Rust/);
});

test("the workflow is well-formed: one job per stack, steps under each", () => {
  const { yaml } = starterWorkflow({ names: ["package.json", "pnpm-lock.yaml", "Cargo.toml"], packageJson: '{"scripts":{"lint":"x"}}' }, "main");
  const jobs = yaml.split("\n").filter((line) => /^ {2}[a-z]+:$/.test(line) && !line.includes("pull_request") && !line.includes("push") && !line.includes("merge_group"));
  assert.deepEqual(jobs, ["  node:", "  rust:"]);
  // Every line is indented by an even number of spaces, as YAML here wants.
  for (const line of yaml.split("\n")) assert.equal((line.match(/^ */)?.[0].length ?? 0) % 2, 0, line);
  assert.match(yaml, /pnpm\/action-setup@v4[\s\S]*pnpm install --frozen-lockfile[\s\S]*pnpm run lint/);
});

test("a branch name is found that is free", () => {
  assert.equal(freeBranch([]), "add-ci");
  assert.equal(freeBranch(["main", "add-ci"]), "add-ci-2");
  assert.equal(freeBranch(["add-ci", "add-ci-2"]), "add-ci-3");
});
