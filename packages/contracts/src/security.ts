import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

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
  decidedBy: string | null;
  reason: string | null;
  decidedAt: string | null;
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
  status: "open" | "fixed";
  /** The upgrade issue opened for the package. */
  issue: number | null;
  foundAt: string;
  fixedAt: string | null;
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
  /** Open vulnerabilities by severity; open and blocked secrets count as critical. */
  counts: SeverityCounts;
  secrets: SecretFinding[];
  vulnerabilities: Vulnerability[];
  scan: ScanState;
  /** Whether g1t opens upgrade issues and puts its agent on them. */
  upkeep: boolean;
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

export type SecretDecision = "allow" | "resolve" | "reopen";

export interface SecurityApi {
  overview(repo: RepoPath, viewer: Viewer): Promise<Result<SecurityOverview>>;
  decideSecret(
    actor: User,
    repo: RepoPath,
    id: string,
    decision: SecretDecision,
    reason: string,
  ): Promise<Result<SecretFinding>>;
  rescan(actor: User, repo: RepoPath): Promise<Result<ScanState>>;
  setUpkeep(actor: User, repo: RepoPath, enabled: boolean): Promise<Result<boolean>>;
  workspace(workspace: string, viewer: Viewer): Promise<Result<RepoSecurity[]>>;
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
    decideSecret: (actor, repo, id, decision, reason) =>
      call("decide_secret", { actor, repo, id, decision, reason }),
    rescan: (actor, repo) => call("rescan", { actor, repo }),
    setUpkeep: (actor, repo, enabled) => call("set_upkeep", { actor, repo, enabled }),
    workspace: (workspace, viewer) => call("workspace", { workspace, viewer }),
  };
}
