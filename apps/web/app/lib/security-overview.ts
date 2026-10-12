/**
 * A repository's Security overview: one row per feature, each with a
 * status word, a line of what it does, and the one thing to do about it.
 * Pure, so the rows are tested apart from the page (routes/repo/security-overview.tsx).
 */

export type FeatureStatus = "enabled" | "disabled" | "needs_setup" | "coming";

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  needs_setup: "Needs setup",
  coming: "Coming",
};

/** The Badge tone each status word is shown in. */
export const STATUS_TONE: Record<FeatureStatus, "success" | "neutral" | "warn" | "info"> = {
  enabled: "success",
  disabled: "neutral",
  needs_setup: "warn",
  coming: "info",
};

export type RowGroup = "policy" | "findings" | "reporting";

/** The one thing to do about a feature: a page to open, or a form to post. */
export type RowAction =
  | { kind: "link"; label: string; to: string }
  | { kind: "post"; label: string; action: string; intent?: string; pending: string }
  | { kind: "switch"; label: string; intent: string; on: boolean };

export type OverviewRow = {
  key: string;
  group: RowGroup;
  title: string;
  status: FeatureStatus;
  about: string;
  /** A short hint for the status, shown on hover, when the word alone is not enough. */
  hint?: string;
  action: RowAction | null;
};

export type OverviewFacts = {
  /** Under the project: `/acme/rocket`. */
  base: string;
  /** Whether a SECURITY.md is on the default branch, and where. */
  policyPath: string | null;
  /** Private vulnerability reporting. */
  reporting: boolean;
  /** Published advisories. */
  advisories: number;
  /** Security updates. */
  upkeep: boolean;
  codeScanning: { configured: boolean; analyses: number; entitled: boolean };
  /** Alerts for secrets found in the history. Push protection is always on. */
  historyAlerts: boolean;
  /** Whether the viewer may change settings (Admin), and push (for the policy's pull request). */
  canManage: boolean;
  canPush: boolean;
};

/** Where a security policy may be: the first found is the one. */
export const POLICY_PATHS = ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"];

/** The rows, in the order the page shows them. */
export function overviewRows(facts: OverviewFacts): OverviewRow[] {
  const { base } = facts;
  const code = facts.codeScanning;
  return [
    {
      key: "policy",
      group: "policy",
      title: "Security policy",
      status: facts.policyPath ? "enabled" : "needs_setup",
      about: facts.policyPath
        ? `${facts.policyPath} on the default branch tells people how to report a vulnerability and which versions are supported.`
        : "A SECURITY.md on the default branch tells people how to report a vulnerability and which versions are supported.",
      action: facts.policyPath
        ? { kind: "link", label: "View policy", to: `${base}/blob/HEAD/${facts.policyPath}` }
        : facts.canPush
          ? { kind: "post", label: "Set up a security policy", action: `${base}/security/policy/setup`, pending: "Opening a pull request…" }
          : null,
    },
    {
      key: "advisories",
      group: "reporting",
      title: "Security advisories",
      status: "enabled",
      about:
        facts.advisories === 0
          ? "Publish what this repository knows about vulnerabilities in what it ships, so people who depend on it can act."
          : `${facts.advisories} published ${facts.advisories === 1 ? "advisory tells" : "advisories tell"} people who depend on this repository what to do.`,
      action: { kind: "link", label: facts.canManage ? "Manage advisories" : "View advisories", to: `${base}/security/advisories` },
    },
    {
      key: "reporting",
      group: "reporting",
      title: "Private vulnerability reporting",
      status: facts.reporting ? "enabled" : "disabled",
      about: facts.reporting
        ? "Anyone who can see this repository can report a vulnerability to its maintainers privately, from its Security tab."
        : "Let anyone who can see this repository report a vulnerability to its maintainers privately, instead of in an issue.",
      action: facts.canManage ? { kind: "switch", label: "Private vulnerability reporting", intent: "reporting", on: facts.reporting } : null,
    },
    {
      key: "dependency_alerts",
      group: "findings",
      title: "Dependency alerts",
      status: "enabled",
      about: "Every package the lockfiles resolve is checked for known vulnerabilities, on every push to the default branch and daily.",
      action: { kind: "link", label: "View alerts", to: `${base}/security/vulnerabilities` },
    },
    {
      key: "security_updates",
      group: "findings",
      title: "Security updates",
      status: facts.upkeep ? "enabled" : "disabled",
      about: "A pull request upgrades each vulnerable dependency that has a fix; it lands through the branch's required checks.",
      action: facts.canManage ? { kind: "switch", label: "Security updates", intent: "upkeep", on: facts.upkeep } : null,
    },
    {
      key: "code_scanning",
      group: "findings",
      title: "Code scanning",
      status: code.analyses > 0 ? "enabled" : "needs_setup",
      about:
        code.analyses > 0
          ? "Your static analysis tools' results, uploaded as SARIF: alerts on the default branch and a check on pull requests."
          : "Upload your static analysis tools' SARIF results from a workflow: alerts on the default branch and a check on pull requests.",
      hint: !code.entitled ? "On a private repository, code scanning comes with the g1t plan." : undefined,
      action:
        code.analyses > 0 || code.configured
          ? { kind: "link", label: "View alerts", to: `${base}/security/code-scanning` }
          : facts.canManage && code.entitled
            ? { kind: "post", label: "Set up code scanning", action: `${base}/security/code-scanning/setup`, pending: "Opening a pull request…" }
            : { kind: "link", label: "Learn more", to: `${base}/security/code-scanning` },
    },
    {
      key: "secret_scanning",
      group: "findings",
      title: "Secret scanning",
      status: "enabled",
      about: facts.historyAlerts
        ? "Push protection refuses every push that adds a secret, and secrets already in the history open alerts."
        : "Push protection refuses every push that adds a secret. Alerts for secrets already in the history are off.",
      hint: "Push protection is always on.",
      action: { kind: "link", label: "View alerts", to: `${base}/security/secret-scanning` },
    },
    {
      key: "code_quality",
      group: "findings",
      title: "Code quality",
      status: "coming",
      about: "Maintainability and reliability findings beside the security ones. Not built yet.",
      action: null,
    },
  ];
}

/** The rows of one group, in order. */
export function rowsIn(rows: OverviewRow[], group: RowGroup): OverviewRow[] {
  return rows.filter((row) => row.group === group);
}

/**
 * The SECURITY.md "Set up a security policy" proposes: how to report, and
 * which versions are supported, for the maintainers to finish.
 */
export function securityPolicyTemplate(repo: string, reporting: boolean, base: string): string {
  const report = reporting
    ? `Report it privately at https://g1t.sh${base}/security/report. You can report without an account; leave an email address so the maintainers can answer you.`
    : `Email the maintainers (fill in the address here) rather than opening an issue, so the problem is not public before a fix is.`;
  return `# Security policy

## Reporting a vulnerability

If you find a vulnerability in ${repo}, do not open an issue about it.

${report}

Say what is affected, how to reproduce it and, if you can, how bad you think it is. We aim to answer within a few days and will keep you informed as we work on a fix. If you want to be credited in the advisory, say so.

## Supported versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

Fill in which releases get security fixes.
`;
}

/** The pull request's body for the policy. */
export function securityPolicyPullBody(path: string): string {
  return `Adds \`${path}\`, which tells people how to report a vulnerability and which versions get security fixes. Edit the address and the versions before merging.`;
}

/** A branch name for the policy that is not taken. */
export function securityPolicyBranch(taken: string[]): string {
  let name = "add-security-policy";
  for (let n = 2; taken.includes(name); n++) name = `add-security-policy-${n}`;
  return name;
}
