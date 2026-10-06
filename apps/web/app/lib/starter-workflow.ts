/**
 * A first CI workflow for a repository that has none, worked out from what
 * is at its root: one job per stack found (Node, Rust, Go, Python, Ruby,
 * Java, .NET), each installing, linting where the project says how,
 * building and testing as that stack usually does. Pure, so it is tested on
 * its own; `add-ci.server.ts` reads the repository and opens the pull
 * request.
 *
 * The workflow is named `CI`: that is the check it reports, and the name a
 * branch requires. It runs on pull requests, on pushes to the default
 * branch, and on the merge queue's states (`merge_group`), so that a
 * required `CI` can pass everywhere a merge waits for it.
 */

/** Where the workflow goes. */
export const STARTER_PATH = ".g1t/workflows/ci.yml";
/** The check it reports. */
export const STARTER_CHECK = "CI";

export type Stack = "bun" | "pnpm" | "yarn" | "npm" | "rust" | "go" | "uv" | "python" | "ruby" | "maven" | "gradle" | "dotnet" | "make";

/** What the root of a repository says about how it is built. */
export type RootFacts = {
  /** The names of the files and directories at the root. */
  names: string[];
  /** The text of `package.json`, when there is one and it could be read. */
  packageJson?: string | null;
};

const LABELS: Record<Stack, string> = {
  bun: "Bun",
  pnpm: "Node (pnpm)",
  yarn: "Node (Yarn)",
  npm: "Node (npm)",
  rust: "Rust",
  go: "Go",
  uv: "Python (uv)",
  python: "Python",
  ruby: "Ruby",
  maven: "Java (Maven)",
  gradle: "Java (Gradle)",
  dotnet: ".NET",
  make: "Make",
};

/** A stack's name, for people. */
export function stackLabel(stack: Stack): string {
  return LABELS[stack];
}

/** The stacks at a repository's root, most telling first; at most three. */
export function detectStacks({ names }: RootFacts): Stack[] {
  const has = (name: string) => names.includes(name);
  const any = (test: (name: string) => boolean) => names.some(test);
  const found: Stack[] = [];
  if (has("package.json")) {
    if (has("bun.lockb") || has("bun.lock")) found.push("bun");
    else if (has("pnpm-lock.yaml")) found.push("pnpm");
    else if (has("yarn.lock")) found.push("yarn");
    else found.push("npm");
  }
  if (has("Cargo.toml")) found.push("rust");
  if (has("go.mod")) found.push("go");
  if (has("uv.lock")) found.push("uv");
  else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) found.push("python");
  if (has("Gemfile")) found.push("ruby");
  if (has("pom.xml")) found.push("maven");
  else if (has("build.gradle") || has("build.gradle.kts")) found.push("gradle");
  if (any((name) => name.endsWith(".sln") || name.endsWith(".csproj") || name.endsWith(".fsproj"))) found.push("dotnet");
  if (found.length === 0 && (has("Makefile") || has("makefile"))) found.push("make");
  return found.slice(0, 3);
}

/** The scripts a `package.json` names, or null when it cannot be read. */
function scripts(packageJson: string | null | undefined): Set<string> | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return null;
  }
}

/** One step, as YAML lines indented for a job's `steps:`. */
type Step = string[];

const uses = (action: string, name?: string, with_?: Record<string, string>): Step => [
  ...(name ? [`- name: ${name}`, `  uses: ${action}`] : [`- uses: ${action}`]),
  ...(with_ ? ["  with:", ...Object.entries(with_).map(([key, value]) => `    ${key}: ${value}`)] : []),
];
const run = (command: string, name?: string): Step => (name ? [`- name: ${name}`, `  run: ${command}`] : [`- run: ${command}`]);

/** The steps that lint, build and test a Node project, with the runner it uses. */
function nodeSteps(stack: "bun" | "pnpm" | "yarn" | "npm", facts: RootFacts): Step[] {
  const known = scripts(facts.packageJson);
  // Only the scripts it has; when they cannot be read, the ones that exist run.
  const wanted = ["lint", "typecheck", "build", "test"].filter((script) => !known || known.has(script));
  const missing = known != null && wanted.length === 0;
  const steps: Step[] = [];
  if (stack === "bun") {
    steps.push(uses("oven-sh/setup-bun@v2"));
    steps.push(run("bun install --frozen-lockfile"));
    for (const script of wanted) steps.push(run(`bun run ${script}`));
  } else {
    if (stack === "pnpm") steps.push(uses("pnpm/action-setup@v4"));
    steps.push(uses("actions/setup-node@v5", undefined, { "node-version": "24", cache: stack }));
    const install =
      stack === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : stack === "yarn"
          ? "yarn install --frozen-lockfile"
          : facts.names.includes("package-lock.json")
            ? "npm ci"
            : "npm install";
    steps.push(run(install));
    for (const script of wanted) {
      steps.push(
        run(
          stack === "npm"
            ? known
              ? `npm run ${script}`
              : `npm run ${script} --if-present`
            : stack === "pnpm"
              ? known
                ? `pnpm run ${script}`
                : `pnpm run --if-present ${script}`
              : `yarn run ${script}`,
        ),
      );
    }
  }
  if (missing) steps.push(run('echo "package.json has no lint, build or test script yet: add the ones this project needs."'));
  return steps;
}

/** Each stack's job: its key, its name, and its steps after the checkout. */
function job(stack: Stack, facts: RootFacts): { key: string; name: string; steps: Step[] } {
  const has = (name: string) => facts.names.includes(name);
  switch (stack) {
    case "bun":
    case "pnpm":
    case "yarn":
    case "npm":
      return { key: "node", name: "Node", steps: nodeSteps(stack, facts) };
    case "rust":
      return {
        key: "rust",
        name: "Rust",
        steps: [
          uses("dtolnay/rust-toolchain@stable", undefined, { components: "clippy" }),
          uses("Swatinem/rust-cache@v2"),
          run("cargo clippy --all-targets"),
          run("cargo test --all-targets"),
        ],
      };
    case "go":
      return {
        key: "go",
        name: "Go",
        steps: [
          uses("actions/setup-go@v5", undefined, { "go-version-file": "go.mod" }),
          run("go vet ./..."),
          run("go build ./..."),
          run("go test ./..."),
        ],
      };
    case "uv":
      return {
        key: "python",
        name: "Python",
        steps: [uses("astral-sh/setup-uv@v6"), run("uv sync"), run("uv run pytest")],
      };
    case "python": {
      const install = has("requirements.txt")
        ? "pip install -r requirements.txt pytest"
        : "pip install -e . pytest";
      return {
        key: "python",
        name: "Python",
        steps: [uses("actions/setup-python@v5", undefined, { "python-version": '"3.12"', cache: "pip" }), run(install), run("pytest")],
      };
    }
    case "ruby":
      return {
        key: "ruby",
        name: "Ruby",
        steps: [
          uses("ruby/setup-ruby@v1", undefined, { "bundler-cache": "true" }),
          run(has("Rakefile") ? "bundle exec rake" : "bundle exec rspec"),
        ],
      };
    case "maven":
      return {
        key: "java",
        name: "Java",
        steps: [uses("actions/setup-java@v4", undefined, { distribution: "temurin", "java-version": '"21"', cache: "maven" }), run("mvn -B verify")],
      };
    case "gradle":
      return {
        key: "java",
        name: "Java",
        steps: [
          uses("actions/setup-java@v4", undefined, { distribution: "temurin", "java-version": '"21"' }),
          uses("gradle/actions/setup-gradle@v4"),
          run(has("gradlew") ? "./gradlew build" : "gradle build"),
        ],
      };
    case "dotnet":
      return {
        key: "dotnet",
        name: ".NET",
        steps: [
          uses("actions/setup-dotnet@v4", undefined, { "dotnet-version": "8.0.x" }),
          run("dotnet restore"),
          run("dotnet build --no-restore"),
          run("dotnet test --no-build"),
        ],
      };
    case "make":
      return { key: "build", name: "Build", steps: [run("make"), run("make test")] };
  }
}

/** The starter workflow for a repository, and the stacks it was made for. */
export function starterWorkflow(facts: RootFacts, defaultBranch: string): { yaml: string; stacks: Stack[] } {
  const stacks = detectStacks(facts);
  const jobs = stacks.map((stack) => job(stack, facts));
  const lines = [
    `# ${STARTER_CHECK}: what g1t checks on every pull request before it can merge.`,
    "# Generated for this repository; change the steps to match how you build and test.",
    `# Require it in Settings > Branches and merging once it has run.`,
    `name: ${STARTER_CHECK}`,
    "",
    "on:",
    "  pull_request:",
    "  push:",
    `    branches: [${JSON.stringify(defaultBranch)}]`,
    "  merge_group:",
    "",
    "jobs:",
  ];
  if (jobs.length === 0) {
    lines.push(
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v5",
      "      # g1t could not tell how this project is built. Replace this step",
      "      # with the commands that build and test it.",
      '      - run: echo "Add the commands that build and test this project." && exit 1',
    );
  }
  for (const { key, name, steps } of jobs) {
    lines.push(`  ${key}:`, `    name: ${name}`, "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v5");
    for (const step of steps) for (const line of step) lines.push(`      ${line}`);
  }
  return { yaml: `${lines.join("\n")}\n`, stacks };
}

/** What the pull request that adds it says. */
export function starterDescription(stacks: Stack[], defaultBranch: string): string {
  const found = stacks.length > 0 ? `g1t found ${stacks.map(stackLabel).join(", ")} at the root and wrote a job for each.` : "g1t could not tell how this project is built, so the job is a placeholder: replace its last step with the commands that build and test it.";
  return [
    `Adds \`${STARTER_PATH}\`, a workflow named **${STARTER_CHECK}** that runs on every pull request, on pushes to \`${defaultBranch}\`, and on the merge queue. ${found}`,
    "Its runs are this repository's checks: they show on every pull request, whoever opened it, and an agent whose change fails them is sent back with what the failing jobs printed.",
    `Once this has run, require **${STARTER_CHECK}** in Settings, Branches and merging, so that nothing merges into \`${defaultBranch}\` unless it passes.`,
  ].join("\n\n");
}

/** A branch name for the pull request that is not one of `taken`. */
export function freeBranch(taken: string[], base = "add-ci"): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) if (!names.has(`${base}-${n}`)) return `${base}-${n}`;
}
