/**
 * Scorecards: a few rules every project should meet, each checked from the
 * catalog and the project's deployments, and each failing one ready to
 * become an issue an agent can fix. Pure: given what is known, the same
 * card.
 */

import type { RuleResult, ScoreRule } from "@g1t/contracts";

export type CardInput = {
  name: string;
  /** Owners named in its files or found among its authors. */
  owners: string[];
  /** The paths of its docs, relative to its root. */
  docs: string[];
  /** Whether one of its workflows runs tests. */
  tests: boolean;
  /** Its test command, when its manifests say. */
  testCommand: string | null;
  deploy: {
    enabled: boolean;
    production: { url: string } | null;
    latest: { kind: string; status: string; error: string | null } | null;
  } | null;
  /** Open secret findings, or null when nothing reports them. */
  secretFindings: number | null;
};

export const RULE_TITLES: Record<ScoreRule, string> = {
  has_owner: "Has an owner",
  has_readme: "Has a README",
  has_agents_md: "Has an AGENTS.md",
  tests_in_ci: "Tests run in checks",
  production_green: "Production deploy is green",
  no_secret_findings: "No open secret findings",
};

const isReadme = (path: string) => /^readme(\.(md|markdown|txt))?$/i.test(path);
const isAgents = (path: string) => /^(agents|claude)\.md$/i.test(path);

export function evaluate(card: CardInput): RuleResult[] {
  const result = (rule: ScoreRule, status: RuleResult["status"], detail: string, fix: RuleResult["fix"] = null): RuleResult => ({
    rule,
    title: RULE_TITLES[rule],
    status,
    detail,
    fix: status === "fail" ? fix : null,
  });
  const rules: RuleResult[] = [];

  rules.push(
    card.owners.length
      ? result("has_owner", "pass", `Owned by ${card.owners.join(", ")}.`)
      : result("has_owner", "fail", "No owner is named, and no member wrote most of it.", {
          title: `Name the owners of ${card.name}`,
          body: [
            `${card.name} has no owner in g1t's catalog. Add an \`owners\` list to \`.g1t/project.yml\` (create it if it is missing) naming the workspace members who own this project, for example:`,
            "",
            "```yaml",
            "owners:",
            "  - ana",
            "```",
            "",
            "Pick the people from the history of the project: who wrote and reviewed most of it recently.",
          ].join("\n"),
          checks: ["grep -q '^owners:' .g1t/project.yml"],
        }),
  );

  rules.push(
    card.docs.some(isReadme)
      ? result("has_readme", "pass", "It has a README.")
      : result("has_readme", "fail", "There is no README at its root.", {
          title: `Write a README for ${card.name}`,
          body: `${card.name} has no README. Write \`README.md\` at its root: what it is and who uses it, how to run it locally, how to test it, and how it is deployed. Take the commands from its manifests and workflows, not from guesses.`,
          checks: ["test -f README.md"],
        }),
  );

  rules.push(
    card.docs.some(isAgents)
      ? result("has_agents_md", "pass", "It has instructions for agents.")
      : result("has_agents_md", "fail", "There is no AGENTS.md telling agents how to work here.", {
          title: `Add an AGENTS.md to ${card.name}`,
          body: `${card.name} has no AGENTS.md. Write one at its root for agents working here: how to build and test (exact commands), the conventions the code follows, where things live, and what not to touch. Keep each point to one line; g1t keeps what it says as memory.`,
          checks: ["test -f AGENTS.md"],
        }),
  );

  rules.push(
    card.tests
      ? result("tests_in_ci", "pass", "A workflow runs its tests.")
      : result("tests_in_ci", "fail", "No workflow in .g1t/workflows or .github/workflows runs tests.", {
          title: `Run ${card.name}'s tests on every push`,
          body: `Add a workflow under \`.g1t/workflows/\` that runs ${card.name}'s tests on every push and pull request${
            card.testCommand ? ` (\`${card.testCommand}\`)` : ""
          }. If it has no tests yet, add a first meaningful one with it.`,
          checks: ["grep -rqsiE 'test' .g1t/workflows .github/workflows"],
        }),
  );

  const deploy = card.deploy;
  if (!deploy?.enabled) {
    rules.push(result("production_green", "na", "It does not deploy on g1t."));
  } else if (deploy.latest?.kind === "production" && deploy.latest.status === "failed") {
    rules.push(
      result("production_green", "fail", `The latest production build failed${deploy.latest.error ? `: ${deploy.latest.error}` : "."}`, {
        title: `Fix ${card.name}'s production build`,
        body: `The latest production build of ${card.name} failed${deploy.latest.error ? ` with:\n\n\`\`\`\n${deploy.latest.error}\n\`\`\`\n` : "."} Find out why from the build's log on the project's Deployments page, fix it, and make sure the build passes.`,
        checks: [],
      }),
    );
  } else if (!deploy.production) {
    rules.push(result("production_green", "fail", "Deployments are on, but production is not live.", {
      title: `Get ${card.name} live in production`,
      body: `Deployments are on for ${card.name}, but nothing is live in production. Make the default branch build and serve, then check the project's Deployments page.`,
      checks: [],
    }));
  } else {
    rules.push(result("production_green", "pass", `Live at ${deploy.production.url}.`));
  }

  rules.push(
    card.secretFindings == null
      ? result("no_secret_findings", "na", "Secret scanning has not reported on it yet.")
      : card.secretFindings === 0
        ? result("no_secret_findings", "pass", "No open secret findings.")
        : result("no_secret_findings", "fail", `${card.secretFindings} open secret finding${card.secretFindings === 1 ? "" : "s"}.`, {
            title: `Remove the secrets found in ${card.name}`,
            body: `Secret scanning found ${card.secretFindings} secret${card.secretFindings === 1 ? "" : "s"} in ${card.name}. Take each out of the code and read it from a secret instead (Settings, Secrets and variables). Say in the pull request which credentials must be rotated; do not paste them.`,
            checks: [],
          }),
  );
  return rules;
}
