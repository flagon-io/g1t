import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { AlertActivity, AlertState, DismissReason, SecretFinding, Severity, SeverityCounts, Vulnerability } from "./security";

/**
 * The security service's paid suite: custom secret patterns, push
 * protection bypasses and their review, validity checks, code scanning
 * from SARIF, the dependency graph with its SBOM and dependency review,
 * and the workspace's overview. Mirrors `g1t_contracts::security_suite`.
 *
 * Free everywhere: secret scanning, push protection, vulnerability alerts
 * and security updates. Free on public repositories: everything here. On a
 * private repository the features in `PaidFeature` need the workspace's
 * Security and quality activation (billing's `security` feature); a refusal
 * is a `payment_required` failure saying how to turn it on.
 */

export type PaidFeature =
  | "custom_patterns"
  | "validity_checks"
  | "delegated_bypass"
  | "code_scanning"
  | "dependency_review"
  | "security_overview";

export type AlertType = "secret_scanning" | "code_scanning" | "vulnerability";

/** When a pull request's `Code scanning` check fails. */
export type CodeScanningGate = "none" | "errors" | "critical" | "high" | "medium" | "any";

export const CODE_SCANNING_GATES: { gate: CodeScanningGate; label: string }[] = [
  { gate: "none", label: "Never" },
  { gate: "errors", label: "Errors only" },
  { gate: "critical", label: "Critical, and errors" },
  { gate: "high", label: "High or higher, and errors" },
  { gate: "medium", label: "Medium or higher, and errors" },
  { gate: "any", label: "Any security result, and errors" },
];

export type ReviewFailOn = "critical" | "high" | "medium" | "low" | "none";

/** The checks the suite reports on pull requests. */
export const CODE_SCANNING_CHECK = "Code scanning";
export const DEPENDENCY_REVIEW_CHECK = "Dependency review";
/** The starter workflow "Set up code scanning" adds. */
export const STARTER_WORKFLOW_PATH = ".g1t/workflows/code-scanning.yml";

export type RepoSecuritySettings = {
  codeScanningGate: CodeScanningGate;
  dependencyReview: boolean;
  reviewFailOn: ReviewFailOn;
  reviewDenyLicenses: string[];
  reviewComment: boolean;
};

export type WorkspaceSecuritySettings = {
  delegatedBypass: boolean;
  validityChecks: boolean;
};

export type SecuritySettingsView = {
  settings: RepoSecuritySettings;
  workspace: WorkspaceSecuritySettings;
  private: boolean;
  /** Public, or the workspace has the activation. */
  entitled: boolean;
  upkeep: boolean;
};

export type WorkspaceSecurityView = { settings: WorkspaceSecuritySettings; activated: boolean };

export type CustomPattern = {
  id: string;
  scope: "repository" | "workspace";
  workspace: string;
  repo: string | null;
  name: string;
  pattern: string;
  before: string | null;
  after: string | null;
  testStrings: string[];
  state: "draft" | "published";
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  openAlerts: number;
};

export type PatternList = { patterns: CustomPattern[]; entitled: boolean };
export type SavedPattern = { pattern: CustomPattern; tests: ([number, number] | null)[] };

export type PatternMatch = { path: string; line: number; preview: string };
export type DryRunRepo = { name: string; filesScanned: number; matches: PatternMatch[]; truncated: boolean; commit: string | null };
export type DryRun = { repos: DryRunRepo[] };

export type PatternInput = {
  id?: string;
  name: string;
  pattern: string;
  before?: string | null;
  after?: string | null;
  testStrings?: string[];
  publish?: boolean;
};

export type BypassReason = "false_positive" | "used_in_tests" | "will_fix_later";

export const BYPASS_REASONS: { reason: BypassReason; label: string; about: string }[] = [
  { reason: "false_positive", label: "It's a false positive", about: "It is not a secret. The alert is closed as a false positive." },
  { reason: "used_in_tests", label: "It's used in tests", about: "A value made for tests. The alert is closed as used in tests." },
  { reason: "will_fix_later", label: "I'll fix it later", about: "It is real. The alert stays open until it is rotated." },
];

export type SecretLocation = { path: string; line: number; commit: string; source: "push" | "history"; foundAt: string };

export type BypassRequest = {
  id: string;
  repoId: string;
  workspace: string;
  repo: string;
  secretId: string;
  label: string;
  path: string;
  line: number;
  preview: string;
  requester: string;
  reason: BypassReason;
  comment: string | null;
  state: "pending" | "approved" | "denied" | "cancelled";
  reviewer: string | null;
  reviewComment: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type SecretAlertDetail = {
  secret: SecretFinding;
  locations: SecretLocation[];
  activity: AlertActivity[];
  requests: BypassRequest[];
  checkable: boolean;
  canBypass: boolean;
  canRequestBypass: boolean;
};

export type BypassResult = { secret: SecretFinding; request: BypassRequest | null };

export type CodeAlert = {
  id: string;
  number: number;
  repoId: string;
  tool: string;
  category: string;
  ruleId: string;
  ruleName: string | null;
  ruleDescription: string | null;
  help: string | null;
  helpUri: string | null;
  tags: string[];
  level: "error" | "warning" | "note" | "none";
  securitySeverity: Severity | null;
  severity: Severity;
  message: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  startColumn: number | null;
  endColumn: number | null;
  state: AlertState;
  fingerprint: string;
  firstCommit: string;
  lastCommit: string;
  createdAt: string;
  updatedAt: string;
  fixedAt: string | null;
  dismissedBy: string | null;
  dismissedReason: DismissReason | null;
  dismissedComment: string | null;
  dismissedAt: string | null;
  issue: number | null;
};

export const CODE_DISMISS_REASONS: { reason: DismissReason; label: string; about: string }[] = [
  { reason: "false_positive", label: "False positive", about: "The tool is wrong about this code." },
  { reason: "wont_fix", label: "Won't fix", about: "It is real, and accepted as it is." },
  { reason: "used_in_tests", label: "Used in tests", about: "The code is only in tests." },
];

export type Analysis = {
  id: string;
  repoId: string;
  sarifId: string;
  tool: string;
  toolVersion: string | null;
  category: string;
  commitSha: string;
  gitRef: string;
  pull: number | null;
  results: number;
  newAlerts: number;
  fixedAlerts: number;
  dropped: number;
  createdAt: string;
};

export type CodeScanning = { alerts: CodeAlert[]; analyses: Analysis[]; entitled: boolean; private: boolean; configured: boolean };
export type CodeAlertDetail = { alert: CodeAlert; activity: AlertActivity[]; analyses: Analysis[] };

export type PullResult = {
  tool: string;
  ruleId: string;
  level: string;
  severity: Severity;
  securitySeverity: Severity | null;
  message: string;
  path: string | null;
  line: number | null;
  new: boolean;
  onChangedLine: boolean;
  failing: boolean;
};

export type ReviewVulnerability = { advisory: string; osvId: string; summary: string; severity: Severity; fixedVersion: string | null; url: string };

export type ReviewChange = {
  changeType: "added" | "removed";
  manifest: string;
  ecosystem: string;
  name: string;
  version: string;
  relationship: "direct" | "transitive" | "unknown";
  development: boolean;
  license: string | null;
  purl: string;
  vulnerabilities: ReviewVulnerability[];
  deniedLicense: boolean;
  failing: boolean;
};

export type DependencyReview = {
  base: string;
  head: string;
  changes: ReviewChange[];
  passed: boolean;
  headline: string;
  failOn: string;
  denyLicenses: string[];
};

export type PullScanning = {
  commit: string | null;
  results: PullResult[];
  review: DependencyReview | null;
  codeStatus: string | null;
  codeDescription: string | null;
};

export type AlertFix = { issue: number; started: boolean; message: string | null };

export type GraphDependency = {
  ecosystem: string;
  name: string;
  version: string;
  manifest: string;
  relationship: "direct" | "transitive" | "unknown";
  development: boolean;
  license: string | null;
  purl: string;
  vulnerabilities: number;
};

export type GraphManifest = { path: string; ecosystem: string; dependencies: number; direct: number };
export type DependencyGraph = { commit: string | null; manifests: GraphManifest[]; dependencies: GraphDependency[] };

export type TypeTotals = { alertType: AlertType; open: SeverityCounts; opened: number; closed: number };
export type TrendPoint = { day: string; secretScanning: number; codeScanning: number; vulnerability: number };
export type RepoCoverage = {
  repoId: string;
  name: string;
  private: boolean;
  customPatterns: number;
  validityChecks: boolean;
  codeScanningAt: string | null;
  dependencyReview: boolean;
  securityUpdates: boolean;
  lockfiles: number;
  secrets: SeverityCounts;
  code: SeverityCounts;
  vulnerabilities: SeverityCounts;
};
export type WorkspaceOverview = {
  activated: boolean;
  privateHidden: number;
  totals: TypeTotals[];
  trend: TrendPoint[];
  repos: RepoCoverage[];
};

export type WorkspaceAlert = { repo: string; secret?: SecretFinding | null; code?: CodeAlert | null; vulnerability?: Vulnerability | null };

export interface SecuritySuiteApi {
  settings(repo: RepoPath, viewer: Viewer): Promise<Result<SecuritySettingsView>>;
  setSettings(actor: User, repo: RepoPath, settings: RepoSecuritySettings): Promise<Result<SecuritySettingsView>>;
  workspaceSettings(workspace: string, viewer: Viewer): Promise<Result<WorkspaceSecurityView>>;
  setWorkspaceSettings(actor: User, workspace: string, settings: WorkspaceSecuritySettings): Promise<Result<WorkspaceSecurityView>>;
  patterns(workspace: string, repo: RepoPath | null, viewer: Viewer): Promise<Result<PatternList>>;
  savePattern(actor: User, workspace: string, repo: RepoPath | null, pattern: PatternInput): Promise<Result<SavedPattern>>;
  deletePattern(actor: User, workspace: string, repo: RepoPath | null, id: string): Promise<Result<boolean>>;
  dryRun(actor: User, workspace: string, repo: RepoPath | null, pattern: { pattern: string; before?: string | null; after?: string | null }, repos?: string[]): Promise<Result<DryRun>>;
  secretAlert(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<SecretAlertDetail>>;
  bypass(actor: User, repo: RepoPath, id: string, reason: BypassReason, comment: string): Promise<Result<BypassResult>>;
  bypassRequests(workspace: string, viewer: Viewer, state?: string | null): Promise<Result<BypassRequest[]>>;
  reviewBypass(actor: User, workspace: string, id: string, decision: "approve" | "deny" | "cancel", comment: string): Promise<Result<BypassRequest>>;
  checkValidity(actor: User, repo: RepoPath, id: string): Promise<Result<SecretFinding>>;
  codeScanning(repo: RepoPath, viewer: Viewer): Promise<Result<CodeScanning>>;
  codeAlert(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<CodeAlertDetail>>;
  setCodeAlertState(actor: User, repo: RepoPath, number: number, state: "open" | "dismissed", reason: DismissReason | null, comment: string): Promise<Result<CodeAlert>>;
  pullScanning(repo: RepoPath, number: number, viewer: Viewer): Promise<Result<PullScanning>>;
  fixAlert(actor: User, repo: RepoPath, id: string): Promise<Result<AlertFix>>;
  dependencyGraph(repo: RepoPath, viewer: Viewer): Promise<Result<DependencyGraph>>;
  sbom(repo: RepoPath, viewer: Viewer): Promise<Result<unknown>>;
  overview(workspace: string, viewer: Viewer, days?: number): Promise<Result<WorkspaceOverview>>;
}

export function securitySuiteClient(service: ServiceBinding): SecuritySuiteApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    settings: (repo, viewer) => call("security_settings", { repo, viewer }),
    setSettings: (actor, repo, settings) => call("set_security_settings", { actor, repo, settings }),
    workspaceSettings: (workspace, viewer) => call("workspace_security_settings", { workspace, viewer }),
    setWorkspaceSettings: (actor, workspace, settings) => call("set_workspace_security_settings", { actor, workspace, settings }),
    patterns: (workspace, repo, viewer) => call("custom_patterns", { workspace, repo, viewer }),
    savePattern: (actor, workspace, repo, pattern) =>
      call("save_custom_pattern", {
        actor,
        workspace,
        repo,
        id: pattern.id ?? null,
        name: pattern.name,
        pattern: pattern.pattern,
        before: pattern.before ?? null,
        after: pattern.after ?? null,
        testStrings: pattern.testStrings ?? [],
        publish: pattern.publish ?? false,
      }),
    deletePattern: (actor, workspace, repo, id) => call("delete_custom_pattern", { actor, workspace, repo, id }),
    dryRun: (actor, workspace, repo, pattern, repos = []) =>
      call("dry_run_pattern", { actor, workspace, repo, repos, pattern: pattern.pattern, before: pattern.before ?? null, after: pattern.after ?? null }),
    secretAlert: (repo, id, viewer) => call("secret_alert", { repo, id, viewer }),
    bypass: (actor, repo, id, reason, comment) => call("bypass", { actor, repo, id, reason, comment }),
    bypassRequests: (workspace, viewer, state = null) => call("bypass_requests", { workspace, viewer, state }),
    reviewBypass: (actor, workspace, id, decision, comment) => call("review_bypass", { actor, workspace, id, decision, comment }),
    checkValidity: (actor, repo, id) => call("check_validity", { actor, repo, id }),
    codeScanning: (repo, viewer) => call("code_scanning", { repo, viewer }),
    codeAlert: (repo, number, viewer) => call("code_alert", { repo, number, viewer }),
    setCodeAlertState: (actor, repo, number, state, reason, comment) =>
      call("set_code_alert_state", { actor, repo, number, state, reason, comment }),
    pullScanning: (repo, number, viewer) => call("pull_code_scanning", { repo, number, viewer }),
    fixAlert: (actor, repo, id) => call("fix_alert", { actor, repo, id }),
    dependencyGraph: (repo, viewer) => call("dependency_graph", { repo, viewer }),
    sbom: (repo, viewer) => call("sbom", { repo, viewer }),
    overview: (workspace, viewer, days) => call("security_overview", { workspace, viewer, days: days ?? null }),
  };
}

/** Whether a result failed for want of the Security and quality activation. */
export function needsActivation(result: Result<unknown>): boolean {
  return !result.ok && result.error.code === "payment_required";
}
