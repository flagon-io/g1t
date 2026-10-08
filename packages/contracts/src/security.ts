import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { BumpPackage, BumpRegistry, VersionUpdatesState } from "./updates";

export * from "./updates";

/**
 * The security service: secrets found in pushes and in history, vulnerable
 * dependencies, and the upgrade issues g1t opens for them. Members of a
 * workspace see its findings; nobody else does. Mirrors
 * `g1t_contracts::security`.
 */

/**
 * Where a secret stands. `open`: in history, to be rotated. `blocked`: a
 * push carrying it was refused, so it never landed. `allowed`: someone said
 * it is not a real secret, and pushes carrying it go through. `resolved`:
 * rotated or removed.
 */
export type SecretStatus = "open" | "blocked" | "allowed" | "resolved";

/**
 * Where an alert stands, as the Security page's filters and the API put it.
 * `open`: needs someone. `dismissed`: someone said why it can stay.
 * `fixed`: a secret revoked, or a dependency no longer vulnerable.
 */
export type AlertState = "open" | "dismissed" | "fixed";

/** Why a person dismissed an alert. */
export type DismissReason =
  | "false_positive"
  | "used_in_tests"
  | "revoked"
  | "wont_fix"
  | "fix_started"
  | "no_bandwidth"
  | "tolerable_risk"
  | "inaccurate"
  | "not_used";

/** The reasons a secret alert can be dismissed with, as people read them. */
export const SECRET_DISMISS_REASONS: { reason: DismissReason; label: string; about: string }[] = [
  { reason: "false_positive", label: "False positive", about: "It is not a secret." },
  { reason: "used_in_tests", label: "Used in tests", about: "A value made for tests or examples." },
  { reason: "revoked", label: "Revoked", about: "It was real and has been revoked or rotated." },
  { reason: "wont_fix", label: "Won't fix", about: "It is real, and accepted as it is." },
];

/** The reasons a dependency alert can be dismissed with, as people read them. */
export const DEPENDENCY_DISMISS_REASONS: { reason: DismissReason; label: string; about: string }[] = [
  { reason: "fix_started", label: "A fix has already been started", about: "Someone is upgrading it." },
  { reason: "no_bandwidth", label: "No bandwidth to fix this", about: "Nobody can get to it now." },
  { reason: "tolerable_risk", label: "Risk is tolerable to this project", about: "It does not matter for how this project uses it." },
  { reason: "inaccurate", label: "This alert is inaccurate or incorrect", about: "The advisory is wrong about this package or version." },
  { reason: "not_used", label: "Vulnerable code is not actually used", about: "The vulnerable code is never called." },
];

/** A reason's label. */
export function dismissLabel(reason: DismissReason): string {
  return [...SECRET_DISMISS_REASONS, ...DEPENDENCY_DISMISS_REASONS].find((r) => r.reason === reason)?.label ?? reason;
}

export type SecretFinding = {
  id: string;
  repoId: string;
  /** `aws_access_key`, `github_token`, … */
  kind: string;
  /** "an AWS access key". */
  label: string;
  path: string;
  line: number;
  commit: string;
  /** Enough of the secret to recognise it; the secret itself is never kept. */
  preview: string;
  status: SecretStatus;
  source: "push" | "history";
  foundBy: string | null;
  /** RFC 3339. */
  foundAt: string;
  /** Who dismissed it (allowed or resolved it). */
  decidedBy: string | null;
  /** The comment given when it was dismissed. */
  reason: string | null;
  decidedAt: string | null;
  /** Why it was dismissed; absent on open alerts and older decisions. */
  dismissedReason?: DismissReason | null;
  /**
   * Why the value looks made for tests or documentation, when it does. Such
   * an alert never stops a push and is never counted as critical.
   */
  testValue?: string | null;
  state: AlertState;
  /** What its issuer said when last asked: active, inactive, unknown or unsupported. */
  validity?: "active" | "inactive" | "unknown" | "unsupported" | null;
  validityCheckedAt?: string | null;
  /** How it got past push protection, when someone bypassed it. */
  bypass?: {
    reason: "false_positive" | "used_in_tests" | "will_fix_later";
    comment: string | null;
    by: string;
    at: string;
    approvedBy: string | null;
  } | null;
  /** The custom pattern that found it, for a `custom_pattern` finding. */
  patternId?: string | null;
  patternName?: string | null;
  /** How many places it was found in. */
  locations?: number;
};

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];

export type Vulnerability = {
  id: string;
  repoId: string;
  /** `npm`, `crates.io`, `Go`, `PyPI`. */
  ecosystem: string;
  package: string;
  version: string;
  /** The lockfile that resolves it. */
  manifest: string;
  /** Its GHSA id when it has one. */
  advisory: string;
  osvId: string;
  summary: string;
  severity: Severity;
  fixedVersion: string | null;
  status: "open" | "fixed" | "dismissed";
  /** The issue opened for g1t, when upgrading needs code changes. */
  issue: number | null;
  foundAt: string;
  fixedAt: string | null;
  state: AlertState;
  dismissedBy?: string | null;
  dismissedReason?: DismissReason | null;
  dismissedComment?: string | null;
  dismissedAt?: string | null;
  /** The security update for its package, if g1t has started one. */
  update?: SecurityUpdate | null;
};

/**
 * Where a security update stands. `requested`: a sandbox is making the
 * change. `open`: its pull request is going through the required checks.
 * `superseded`: a newer update replaced it, or the package is no longer
 * vulnerable. `needs_code`: the version could not be raised without code
 * changes, so g1t has an issue for it. `failed`: see `error`.
 */
export type UpdateState = "requested" | "open" | "merged" | "closed" | "superseded" | "needs_code" | "failed";

/** The pull request g1t opens itself to upgrade one vulnerable package. */
export type SecurityUpdate = {
  state: UpdateState;
  /** The version it upgrades to. */
  target: string;
  /** `g1t/security/<package>-<version>`. */
  branch: string | null;
  pull: number | null;
  issue: number | null;
  error: string | null;
  updatedAt: string;
};

/** Secret alerts by where they stand. */
export type SecretCounts = {
  /** In the history and looking real: rotate these. */
  open: number;
  /** Stopped at a push, so never landed, and looking real. */
  blocked: number;
  /** Open or blocked, but likely test values. */
  testValues: number;
  dismissed: number;
  fixed: number;
};

/** One thing that happened to an alert. */
export type AlertActivity = {
  id: string;
  alertId: string;
  /**
   * `dismissed`, `reopened`, `update_requested`, `update_opened`,
   * `update_merged`, `update_closed`, `update_superseded`,
   * `update_needs_code` or `update_failed`.
   */
  action: string;
  /** A person's username, or `g1t`. */
  actor: string | null;
  reason: DismissReason | null;
  comment: string | null;
  /** The pull request or issue it concerns. */
  number: number | null;
  at: string;
};

export type SeverityCounts = Record<Severity, number>;

export type ScanState = {
  /** `pending`, `running`, `done`, or `stopped` at the workspace's limit. */
  history: "pending" | "running" | "done" | "stopped";
  commitsScanned: number;
  historyFinishedAt: string | null;
  dependenciesScannedAt: string | null;
  dependenciesError: string | null;
  lockfiles: string[];
};

export type SecurityOverview = {
  repoId: string;
  /**
   * Open alerts by severity: vulnerabilities open and not dismissed, and
   * secrets in the history that look real, as critical. Blocked secrets
   * and likely test values are not counted.
   */
  counts: SeverityCounts;
  secretCounts: SecretCounts;
  secrets: SecretFinding[];
  vulnerabilities: Vulnerability[];
  /** What happened to the alerts, newest first. */
  activity: AlertActivity[];
  scan: ScanState;
  /** Security updates: whether g1t opens a pull request for each vulnerable dependency with a fix. */
  upkeep: boolean;
  versionUpdates: VersionUpdatesState;
};

/** The alert `dismiss` or `reopen` changed, as it is now. */
export type AlertChange = {
  secret: SecretFinding | null;
  vulnerability: Vulnerability | null;
};

export type RepoSecurity = {
  repoId: string;
  name: string;
  counts: SeverityCounts;
  secrets: number;
  vulnerabilities: number;
  upkeep: boolean;
  dependenciesScannedAt: string | null;
};

export interface SecurityApi {
  overview(repo: RepoPath, viewer: Viewer): Promise<Result<SecurityOverview>>;
  /**
   * Dismisses an alert (a secret takes Admin, a dependency Write) with a
   * reason and an optional comment.
   */
  dismiss(actor: User, repo: RepoPath, id: string, reason: DismissReason, comment: string): Promise<Result<AlertChange>>;
  /** Opens a dismissed alert again. */
  reopen(actor: User, repo: RepoPath, id: string): Promise<Result<AlertChange>>;
  rescan(actor: User, repo: RepoPath): Promise<Result<ScanState>>;
  setUpkeep(actor: User, repo: RepoPath, enabled: boolean): Promise<Result<boolean>>;
  workspace(workspace: string, viewer: Viewer): Promise<Result<RepoSecurity[]>>;
  /** Checks one `updates` entry of the dependency update file for new versions now. Write and up. */
  checkUpdates(actor: User, repo: RepoPath, entry: string): Promise<Result<VersionUpdatesState>>;
}

export function securityClient(service: ServiceBinding): SecurityApi {
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
    overview: (repo, viewer) => call("overview", { repo, viewer }),
    dismiss: (actor, repo, id, reason, comment) => call("dismiss", { actor, repo, id, reason, comment }),
    reopen: (actor, repo, id) => call("reopen", { actor, repo, id }),
    rescan: (actor, repo) => call("rescan", { actor, repo }),
    setUpkeep: (actor, repo, enabled) => call("set_upkeep", { actor, repo, enabled }),
    workspace: (workspace, viewer) => call("workspace", { workspace, viewer }),
    checkUpdates: (actor, repo, entry) => call("check_updates", { actor, repo, entry }),
  };
}

/**
 * The runner's `bump`: makes a security update in a sandbox. It clones the
 * default branch, raises `package` to `version` in each lockfile with the
 * ecosystem's own tool, commits that as g1t and pushes it to `branch`
 * (`g1t/security/…`). The push tells the security service to open the pull
 * request. Mirrors `g1t_contracts::security::BumpArgs`.
 */
export type BumpArgs = {
  repo: RepoPath;
  /** OSV's name for the ecosystem: `npm`, `crates.io`, `Go` or `PyPI`. */
  ecosystem: string;
  package: string;
  version: string;
  /** The lockfiles that resolve a vulnerable version, from the root. */
  lockfiles: string[];
  branch: string;
  /** The commit's message. */
  message: string;
  /** `version` for a version update, whose branch is any but the default one. */
  kind?: "version";
  /** Several packages raised in one commit, for a grouped update. */
  packages?: BumpPackage[];
  /** `increase` (default), `increase-if-necessary`, `widen` or `lockfile-only`. */
  strategy?: string;
  /** Replace the branch if it is there already: a rebase or a recreate. */
  force?: boolean;
  /** Private registries the tools may read, with their credentials. */
  registries?: BumpRegistry[];
  /**
   * The branch to start from, which its pull request merges into
   * (`target-branch`): the default branch when absent.
   */
  base?: string;
};

/** The prefix every security update's branch starts with. */
export const UPDATE_BRANCH_PREFIX = "g1t/security/";
